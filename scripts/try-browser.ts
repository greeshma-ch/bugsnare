import { readFile } from "node:fs/promises";
import { BrowserSession } from "../src/browser";
import type { Action } from "../src/actions";
import { BASE_URL, ensureServer, stopServer } from "./lib/server";

const STEPS: Action[] = [
  { action: "goto", url: "/" },
  { action: "click", role: "button", name: "Add Widget" },
  { action: "fill", role: "spinbutton", name: "Quantity for Widget", value: "3" },
];

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
