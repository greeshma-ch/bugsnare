#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "./agent/loop";

const USAGE = "Usage: bugsnare repro <issue-file> --target <url> [--max-steps <n>]";

interface CliArgs {
  issueFile: string;
  targetUrl: string;
  maxSteps?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "repro") {
    throw new Error(`Unknown command "${command ?? ""}".`);
  }

  let issueFile: string | undefined;
  let targetUrl: string | undefined;
  let maxSteps: number | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;

    if (arg === "--target" || arg === "-t") {
      targetUrl = rest[++index];
    } else if (arg.startsWith("--target=")) {
      targetUrl = arg.slice("--target=".length);
    } else if (arg === "--max-steps") {
      const parsed = Number.parseInt(rest[++index] ?? "", 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error("--max-steps must be a positive integer.");
      }
      maxSteps = parsed;
    } else if (arg.startsWith("--max-steps=")) {
      const parsed = Number.parseInt(arg.slice("--max-steps=".length), 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error("--max-steps must be a positive integer.");
      }
      maxSteps = parsed;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else if (issueFile === undefined) {
      issueFile = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}".`);
    }
  }

  if (!issueFile) throw new Error("Missing <issue-file>.");
  if (!targetUrl) throw new Error("Missing --target <url>.");

  return { issueFile, targetUrl, maxSteps };
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

  const issueText = await readFile(resolve(args.issueFile), "utf8");

  console.log(`Issue:  ${args.issueFile}`);
  console.log(`Target: ${args.targetUrl}`);
  console.log("");

  const result = await runAgent({
    issueText,
    targetUrl: args.targetUrl,
    maxSteps: args.maxSteps,
  });

  console.log("");
  console.log(`Status: ${result.status}`);
  if (result.assertion) {
    const target = result.assertion.name
      ? `${result.assertion.role} "${result.assertion.name}"`
      : result.assertion.role;
    console.log(`Assertion: ${target} expected "${result.assertion.expected}", actual "${result.assertion.actual}"`);
  }
  console.log(JSON.stringify(result, null, 2));

  process.exitCode = result.status === "reproduced" ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});