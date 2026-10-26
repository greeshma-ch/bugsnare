import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { BrowserSession } from "../src/browser";
import type { Action } from "../src/actions";

const BASE_URL = "http://localhost:3000";
const SERVER_COMMAND = "npx http-server examples/shop-app -p 3000 -s";

const STEPS: Action[] = [
  { action: "goto", url: "/" },
  { action: "click", role: "button", name: "Add Widget" },
  { action: "fill", role: "spinbutton", name: "Quantity for Widget", value: "3" },
];

async function serverIsUp(): Promise<boolean> {
  try {
    const response = await fetch(BASE_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverIsUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Reuses an already-running server, otherwise starts one for this script. */
async function ensureServer(): Promise<ChildProcess | undefined> {
  if (await serverIsUp()) {
    console.log(`Reusing the server already listening on ${BASE_URL}`);
    return undefined;
  }

  const server = spawn(SERVER_COMMAND, { shell: true, stdio: "ignore" });
  if (!(await waitForServer())) {
    stopServer(server);
    throw new Error(`Shop app did not start at ${BASE_URL} within 15s`);
  }
  return server;
}

function stopServer(server: ChildProcess): void {
  if (server.pid === undefined || server.exitCode !== null) return;
  if (process.platform === "win32") {
    // The server runs under a shell, so kill the whole tree to avoid orphans.
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    server.kill();
  }
}

const server = await ensureServer();
const session = new BrowserSession();

try {
  await session.start(BASE_URL, true);

  for (const [index, action] of STEPS.entries()) {
    console.log(`\n=== Step ${index + 1}: ${JSON.stringify(action)}`);

    const outcome = await session.execute(action);
    console.log(`${outcome.ok ? "ok" : "failed"}: ${outcome.result}`);
    console.log(await session.snapshot());

    if (!outcome.ok) {
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await session.close();
  if (server) stopServer(server);
}