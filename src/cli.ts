#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent } from "./agent/loop";
import { emitTest, slugifyIssueTitle } from "./emit-test";
import { isTargetReachable, replaySpec } from "./verify";

const USAGE = [
  "Usage:",
  "  bugsnare repro <issue-file> --target <url> [--max-steps <n>]",
  "  bugsnare verify <spec-file> --target <url> [--repeat <n>]",
].join("\n");

const DEFAULT_REPEAT = 5;
const REPRO_REPLAYS = 3;

type Command = "repro" | "verify";

interface CliArgs {
  command: Command;
  file: string;
  targetUrl: string;
  maxSteps?: number;
  repeat: number;
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "repro" && command !== "verify") {
    throw new Error(`Unknown command "${command ?? ""}".`);
  }

  let file: string | undefined;
  let targetUrl: string | undefined;
  let maxSteps: number | undefined;
  let repeat = DEFAULT_REPEAT;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;

    if (arg === "--target" || arg === "-t") {
      targetUrl = rest[++index];
    } else if (arg.startsWith("--target=")) {
      targetUrl = arg.slice("--target=".length);
    } else if (arg === "--max-steps" || arg.startsWith("--max-steps=")) {
      if (command !== "repro") {
        throw new Error("--max-steps is only valid with repro.");
      }
      const raw = arg === "--max-steps" ? rest[++index] ?? "" : arg.slice("--max-steps=".length);
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error("--max-steps must be a positive integer.");
      }
      maxSteps = parsed;
    } else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      if (command !== "verify") {
        throw new Error("--repeat is only valid with verify.");
      }
      const raw = arg === "--repeat" ? rest[++index] ?? "" : arg.slice("--repeat=".length);
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error("--repeat must be a positive integer.");
      }
      repeat = parsed;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}".`);
    }
  }

  if (!file) throw new Error(command === "repro" ? "Missing <issue-file>." : "Missing <spec-file>.");
  if (!targetUrl) throw new Error("Missing --target <url>.");

  return { command, file, targetUrl, maxSteps, repeat };
}

async function runRepro(args: CliArgs): Promise<void> {
  const issueText = await readFile(resolve(args.file), "utf8");

  console.log(`Issue:  ${args.file}`);
  console.log(`Target: ${args.targetUrl}`);
  console.log("");

  const result = await runAgent({
    issueText,
    targetUrl: args.targetUrl,
    maxSteps: args.maxSteps,
  });

  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`tokens: ${result.usage.totalTokens}`);
  if (result.explanation) console.log(`Explanation: ${result.explanation}`);
  if (result.assertion) {
    const target = result.assertion.name
      ? `${result.assertion.role} "${result.assertion.name}"`
      : result.assertion.role;
    console.log(`Assertion: ${target} expected "${result.assertion.expected}", actual "${result.assertion.actual}"`);
  }

  if (result.status === "reproduced" && result.assertion) {
    const outPath = join("bugsnare-output", `${slugifyIssueTitle(result.issueTitle)}.spec.ts`);
    await emitTest(result, outPath);
    console.log(`Wrote ${outPath}`);

    // A repro that only fails sometimes is not a reliable regression test.
    const replay = await replaySpec({
      specFile: outPath,
      targetUrl: args.targetUrl,
      repeat: REPRO_REPLAYS,
    });

    if (replay.noTests) {
      console.log("Could not replay the generated spec.");
    } else if (replay.failures < REPRO_REPLAYS) {
      console.log(`repro is flaky or unstable (${replay.failures}/${REPRO_REPLAYS})`);
      await markFlakyRepro(outPath, replay.failures, REPRO_REPLAYS);
    } else {
      console.log(`Replay: failed ${replay.failures}/${REPRO_REPLAYS} (stable repro)`);
    }
  }

  console.log(JSON.stringify(result, null, 2));

  process.exitCode = result.status === "reproduced" ? 0 : 1;
}

/** Prepends a warning so the unstable spec is obvious to whoever reads it. */
async function markFlakyRepro(outPath: string, failures: number, total: number): Promise<void> {
  const source = await readFile(outPath, "utf8");
  const comment = `// FLAKY REPRO: only ${failures} of ${total} replays failed when this spec was generated.\n`;
  await writeFile(outPath, comment + source, "utf8");
}

async function runVerify(args: CliArgs): Promise<void> {
  try {
    await access(resolve(args.file));
  } catch {
    console.error(`Spec file not found: ${args.file}`);
    process.exitCode = 2;
    return;
  }

  if (!(await isTargetReachable(args.targetUrl))) {
    console.error(`Cannot reach ${args.targetUrl}.`);
    console.error("Start the app first: npm run serve:buggy (port 3000) or npm run serve:fixed (port 3001).");
    process.exitCode = 2;
    return;
  }

  console.log(`Spec:   ${args.file}`);
  console.log(`Target: ${args.targetUrl}`);
  console.log(`Repeat: ${args.repeat}`);
  console.log("");

  const outcome = await replaySpec({
    specFile: args.file,
    targetUrl: args.targetUrl,
    repeat: args.repeat,
  });

  if (outcome.noTests) {
    console.error(`No tests ran for ${args.file}. Check the path and the Playwright testDir.`);
    process.exitCode = 2;
    return;
  }

  const { total, failures } = outcome;

  if (failures === total) {
    console.log(`REPRODUCIBLE (${total}/${total})`);
    if (outcome.mostCommonMessage) console.log(`  failure: ${outcome.mostCommonMessage}`);
    console.log(`  artifacts: ${outcome.artifactDir}`);
    process.exitCode = 1;
    return;
  }

  if (failures === 0) {
    console.log(`NOT REPRODUCED / FIXED (0/${total} failures)`);
    process.exitCode = 0;
    return;
  }

  const rate = Math.round((failures / total) * 100);
  console.log(`FLAKY (${failures}/${total} failures)`);
  console.log(`  failure rate: ${rate}%`);
  if (outcome.mostCommonMessage) console.log(`  most common failure: ${outcome.mostCommonMessage}`);
  console.log(`  artifacts: ${outcome.artifactDir}`);
  process.exitCode = 3;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (args.command === "repro") {
    await runRepro(args);
  } else {
    await runVerify(args);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});