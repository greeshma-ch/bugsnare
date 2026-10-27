import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BUGGY_URL, ensureServer, stopServer } from "./lib/server";

const FIXED_URL = "http://localhost:3001";
const ISSUE_FILE = "examples/shop-app/issues/cart-total.md";
const OUTPUT_DIR = "bugsnare-output";

interface Stage {
  name: string;
  ok: boolean;
  detail: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function banner(text: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(text);
  console.log("=".repeat(72));
}

/** The newest generated spec in bugsnare-output/, used when the agent cannot run. */
async function newestExistingSpec(): Promise<string | undefined> {
  let files: string[];
  try {
    files = await readdir(OUTPUT_DIR);
  } catch {
    return undefined;
  }

  const specs = files.filter((file) => file.endsWith(".spec.ts"));
  if (specs.length === 0) return undefined;

  const withTimes = await Promise.all(
    specs.map(async (file) => ({
      file,
      time: (await stat(join(OUTPUT_DIR, file))).mtimeMs,
    })),
  );
  withTimes.sort((a, b) => b.time - a.time);
  return join(OUTPUT_DIR, withTimes[0]!.file);
}

async function main(): Promise<void> {
  const stages: Stage[] = [];

  banner("Bugsnare demo: reproduce, then verify the fix");
  console.log(`Buggy app: ${BUGGY_URL}`);
  console.log(`Fixed app: ${FIXED_URL}`);

  const buggyServer = await ensureServer({
    url: BUGGY_URL,
    command: "npm run serve:buggy",
    label: "buggy",
  });
  const fixedServer = await ensureServer({
    url: FIXED_URL,
    command: "npm run serve:fixed",
    label: "fixed",
  });

  try {
    // Step 1 - reproduce the bug on the buggy app.
    banner("Step 1: repro the issue on the buggy app");
    const repro = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "repro",
      ISSUE_FILE,
      "--target",
      BUGGY_URL,
    ]);
    console.log(repro.stdout.trim());
    if (repro.stderr.trim()) console.log(repro.stderr.trim());

    const wrote = /^Wrote\s+(.+)$/m.exec(repro.stdout)?.[1]?.trim();
    let specFile = wrote;

    if (!specFile) {
      specFile = await newestExistingSpec();
      if (specFile) {
        console.log("");
        console.log(
          `The agent did not produce a spec in this run, so the demo reuses the existing ${specFile}.`,
        );
      }
    }

    if (!specFile) {
      stages.push({ name: "repro", ok: false, detail: "no spec was generated" });
      report(stages);
      process.exitCode = 1;
      return;
    }

    stages.push({
      name: "repro",
      ok: repro.code === 0,
      detail: repro.code === 0 ? `wrote ${specFile}` : `agent exit code ${repro.code}`,
    });

    // Step 2 - the spec must still fail against the buggy app.
    banner("Step 2: verify the spec on the buggy app (expect STILL FAILING)");
    const buggy = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "verify",
      specFile,
      "--target",
      BUGGY_URL,
    ]);
    console.log(buggy.stdout.trim());
    if (buggy.stderr.trim()) console.log(buggy.stderr.trim());

    const stillFailing = buggy.code === 1 && buggy.stdout.includes("STILL FAILING");
    stages.push({
      name: "verify on buggy app",
      ok: stillFailing,
      detail: stillFailing ? "reported STILL FAILING (exit 1)" : `exit code ${buggy.code}`,
    });

    // Step 3 - the same spec must pass against the fixed app.
    banner("Step 3: verify the spec on the fixed app (expect FIXED)");
    const fixed = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "verify",
      specFile,
      "--target",
      FIXED_URL,
    ]);
    console.log(fixed.stdout.trim());
    if (fixed.stderr.trim()) console.log(fixed.stderr.trim());

    const isFixed = fixed.code === 0 && fixed.stdout.includes("FIXED");
    stages.push({
      name: "verify on fixed app",
      ok: isFixed,
      detail: isFixed ? "reported FIXED (exit 0)" : `exit code ${fixed.code}`,
    });

    report(stages);
    process.exitCode = stages.every((stage) => stage.ok) ? 0 : 1;
  } finally {
    if (buggyServer) stopServer(buggyServer);
    if (fixedServer) stopServer(fixedServer);
  }
}

function report(stages: Stage[]): void {
  banner("Demo summary");
  for (const stage of stages) {
    console.log(`${stage.ok ? "PASS" : "FAIL"}  ${stage.name} - ${stage.detail}`);
  }
  const failed = stages.filter((stage) => !stage.ok).length;
  console.log("");
  console.log(failed === 0 ? "Demo completed successfully." : `Demo finished with ${failed} failed stage(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});