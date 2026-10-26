import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const BASE_URL = "http://localhost:3000";
export const SERVER_COMMAND = "npx http-server examples/shop-app -p 3000 -s";

export async function serverIsUp(url = BASE_URL): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForServer(timeoutMs = 15_000, url = BASE_URL): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverIsUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Reuses an already-running server, otherwise starts one and returns it. */
export async function ensureServer(url = BASE_URL): Promise<ChildProcess | undefined> {
  if (await serverIsUp(url)) {
    console.log(`Reusing the server already listening on ${url}`);
    return undefined;
  }

  const server = spawn(SERVER_COMMAND, { shell: true, stdio: "ignore" });
  if (!(await waitForServer(15_000, url))) {
    stopServer(server);
    throw new Error(`Shop app did not start at ${url} within 15s`);
  }
  console.log(`Started the shop app at ${url}`);
  return server;
}

export function stopServer(server: ChildProcess): void {
  if (server.pid === undefined || server.exitCode !== null) return;
  if (process.platform === "win32") {
    // The server runs under a shell, so kill the whole tree to avoid orphans.
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    server.kill();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
