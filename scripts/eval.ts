import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent, type AgentStatus } from "../src/agent/loop";
import { BASE_URL, ensureServer, sleep, stopServer } from "./lib/server";

const ISSUE_DIR = "examples/shop-app/issues";
const EXPECTATIONS_FILE = join(ISSUE_DIR, "expectations.json");
const REPORT_FILE = "eval-results.md";
const FAILED_REPORT_FILE = "eval-results.failed.md";
const DEFAULT_RUNS = 1;
const DEFAULT_DELAY_MS = 2_000;
const MAX_STEPS = 15;

type Expected = "reproduced" | "gave_up";

interface RunOutcome {
  status: AgentStatus | "error";
  steps: number;
  seconds: number;
  tokens: number;
  calls: number;
  error?: string;
}

interface IssueOutcome {
  issue: string;
  expected: Expected;
  runs: RunOutcome[];
  logs: string[];
}

interface EvalArgs {
  runs: number;
  delayMs: number;
  verbose: boolean;
  only?: string;
}

function parseArgs(argv: string[]): EvalArgs {
  let runs = DEFAULT_RUNS;
  let delayMs = DEFAULT_DELAY_MS;
  let verbose = false;
  let only: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg === "--runs") {
      runs = Number.parseInt(argv[++index] ?? "", 10);
    } else if (arg.startsWith("--runs=")) {
      runs = Number.parseInt(arg.slice("--runs=".length), 10);
    } else if (arg === "--delay") {
      delayMs = Number.parseInt(argv[++index] ?? "", 10);
    } else if (arg.startsWith("--delay=")) {
      delayMs = Number.parseInt(arg.slice("--delay=".length), 10);
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--issue") {
      only = argv[++index];
    } else if (arg.startsWith("--issue=")) {
      only = arg.slice("--issue=".length);
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer.");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("--delay must be a non-negative number of milliseconds.");
  }

  return { runs, delayMs, verbose, only };
}

/** Runs the agent with its logging captured, so the report stays readable. */
async function runQuiet<T>(operation: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { value: await operation(), logs };
  } finally {
    console.log = original;
  }
}

function renderTable(outcomes: IssueOutcome[]): string {
  const header = [
    "| issue | expected | actual | steps | seconds | tokens | pass/fail |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  const rows = outcomes.map((outcome) => {
    const statuses = outcome.runs.map((run) => run.status);
    const allSame = statuses.every((status) => status === statuses[0]);
    const actual =
      allSame && statuses.length > 1 ? `${statuses[0]} x${statuses.length}` : statuses.join(", ");
    const steps = outcome.runs.map((run) => String(run.steps)).join(", ");
    const seconds = outcome.runs
      .reduce((total, run) => total + run.seconds, 0)
      .toFixed(1);

    // Average over the runs that actually reached the model; error runs report
    // no usage and would drag the mean down.
    const billedRuns = outcome.runs.filter((run) => run.calls > 0);
    const tokens =
      billedRuns.length === 0
        ? "-"
        : String(
            Math.round(
              billedRuns.reduce((total, run) => total + run.tokens, 0) / billedRuns.length,
            ),
          );

    const hits = outcome.runs.filter((run) => run.status === outcome.expected).length;
    const verdict = `${hits}/${outcome.runs.length} ${hits === outcome.runs.length ? "PASS" : "FAIL"}`;

    return `| ${outcome.issue} | ${outcome.expected} | ${actual} | ${steps} | ${seconds}s | ${tokens} | ${verdict} |`;
  });

  return [...header, ...rows].join("\n");
}

function summarise(outcomes: IssueOutcome[]): string {
  const passed = outcomes.filter((outcome) => {
    const hits = outcome.runs.filter((run) => run.status === outcome.expected).length;
    return hits === outcome.runs.length;
  }).length;

  const totalRuns = outcomes.reduce((total, outcome) => total + outcome.runs.length, 0);
  const goodRuns = outcomes.reduce(
    (total, outcome) =>
      total + outcome.runs.filter((run) => run.status === outcome.expected).length,
    0,
  );

  return `${passed}/${outcomes.length} issues matched their expectation (${goodRuns}/${totalRuns} runs).`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const expectations = JSON.parse(await readFile(EXPECTATIONS_FILE, "utf8")) as Record<
    string,
    Expected
  >;

  const issueFiles = (await readdir(ISSUE_DIR))
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !args.only || file === args.only)
    .sort();

  if (issueFiles.length === 0) {
    throw new Error("No issue files found in " + ISSUE_DIR);
  }

  const missing = issueFiles.filter((file) => expectations[file] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing expectations for: ${missing.join(", ")}. Add them to ${EXPECTATIONS_FILE}.`,
    );
  }

  console.log(
    `Evaluating ${issueFiles.length} issue(s), ${args.runs} run(s) each, ${args.delayMs}ms between runs.`,
  );

  const server = await ensureServer();
  const outcomes: IssueOutcome[] = [];

  try {
    for (const issue of issueFiles) {
      const issueText = await readFile(join(ISSUE_DIR, issue), "utf8");
      const expected = expectations[issue]!;
      const runs: RunOutcome[] = [];
      const logs: string[] = [];

      for (let run = 1; run <= args.runs; run++) {
        const started = Date.now();
        let outcome: RunOutcome;

        try {
          const { value, logs: runLogs } = await runQuiet(() =>
            runAgent({ issueText, targetUrl: BASE_URL, maxSteps: MAX_STEPS }),
          );
          outcome = {
            status: value.status,
            steps: value.trace.length,
            seconds: (Date.now() - started) / 1000,
            tokens: value.usage.totalTokens,
            calls: value.usage.calls,
          };
          logs.push(...runLogs);
          if (args.verbose) console.log(runLogs.join("\n"));
        } catch (error) {
          // A flaky model call is a failed run, not a reason to abandon the eval.
          const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
          outcome = {
            status: "error",
            steps: 0,
            seconds: (Date.now() - started) / 1000,
            tokens: 0,
            calls: 0,
            error: message,
          };
          logs.push(`error: ${message}`);
        }

        runs.push(outcome);

        console.log(
          `  ${issue} run ${run}/${args.runs}: ${outcome.status} (${outcome.steps} steps, ${outcome.seconds.toFixed(1)}s, ${outcome.tokens} tokens)${outcome.error ? ` - ${outcome.error}` : ""}`,
        );

        if (run < args.runs) await sleep(args.delayMs);
      }

      outcomes.push({ issue, expected, runs, logs });
    }
  } finally {
    if (server) stopServer(server);
  }

  const table = renderTable(outcomes);
  const summary = summarise(outcomes);
  const errors = outcomes.flatMap((outcome) =>
    outcome.runs
      .filter((run) => run.error)
      .map((run) => `- ${outcome.issue}: ${run.error}`),
  );

  console.log("");
  console.log(table);
  console.log("");
  console.log(summary);
  if (errors.length > 0) {
    console.log("");
    console.log("Run errors:");
    console.log(errors.join("\n"));
  }

  const hasErrors = outcomes.some((outcome) => outcome.runs.some((run) => run.status === "error"));
  const reportFile = hasErrors ? FAILED_REPORT_FILE : REPORT_FILE;

  const report = [
    "# Bugsnare evaluation",
    "",
    `Generated ${new Date().toISOString()} - ${args.runs} run(s) per issue, ${args.delayMs}ms delay between runs.`,
    ...(hasErrors
      ? [
          "",
          `Some runs ended in an error, so this report went to ${FAILED_REPORT_FILE} and ${REPORT_FILE} was left untouched.`,
        ]
      : []),
    "",
    table,
    "",
    summary,
    ...(errors.length > 0 ? ["", "Run errors:", ...errors] : []),
    "",
  ].join("\n");

  await writeFile(reportFile, report, "utf8");
  console.log(
    `Saved ${reportFile}${hasErrors ? ` (${REPORT_FILE} left untouched)` : ""}`,
  );

  const failed = outcomes.some((outcome) => {
    const hits = outcome.runs.filter((run) => run.status === outcome.expected).length;
    return hits !== outcome.runs.length;
  });
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
