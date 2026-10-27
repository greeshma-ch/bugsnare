import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const PLAYWRIGHT_CLI = "node_modules/@playwright/test/cli.js";

export interface VerifyOptions {
  specFile: string;
  targetUrl: string;
  /** How many times to run the spec. */
  repeat?: number;
}

export interface SpecRun {
  passed: boolean;
  message?: string;
}

export interface VerifyOutcome {
  title: string;
  /** Number of spec runs Playwright reported. */
  total: number;
  /** Number of those runs that failed. */
  failures: number;
  messages: string[];
  mostCommonMessage?: string;
  artifactDir: string;
  /** True when Playwright matched no tests at all. */
  noTests: boolean;
}

interface RawResult {
  status?: string;
  error?: { message?: string };
}

interface RawTest {
  results?: RawResult[];
}

interface RawSpec {
  title?: string;
  tests?: RawTest[];
}

interface RawSuite {
  title?: string;
  suites?: RawSuite[];
  specs?: RawSpec[];
}

interface RawReport {
  suites?: RawSuite[];
  errors?: { message?: string }[];
}

interface PlaywrightRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Any HTTP response means the app is serving; only connection failures are unreachable. */
export async function isTargetReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

export function slugFromSpec(specFile: string): string {
  const slug = basename(specFile)
    .replace(/\.(spec|test)\.(ts|js|mts|cts|mjs|cjs)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "spec";
}

function runPlaywright(
  specFile: string,
  targetUrl: string,
  artifactDir: string,
  repeat: number,
): Promise<PlaywrightRun> {
  return new Promise((resolvePromise, reject) => {
    // Absolute path, forward slashes: the CLI treats the argument as a regex,
    // so Windows separators would be read as escapes. An argument array keeps
    // the space in the project path intact.
    const specArg = resolve(specFile).split(sep).join("/");

    // Call Playwright's CLI through node so no shell is involved (and Windows
    // can still run it without spawning `npx.cmd`).
    const child = spawn(
      process.execPath,
      [
        PLAYWRIGHT_CLI,
        "test",
        specArg,
        `--repeat-each=${repeat}`,
        "--retries=0",
        "--workers=1",
        "--reporter=json",
      ],
      {
        env: {
          ...process.env,
          BASE_URL: targetUrl,
          PLAYWRIGHT_OUTPUT_DIR: artifactDir,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function parseReport(stdout: string): RawReport | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as RawReport;
  } catch {
    return undefined;
  }
}

function collectSpecs(suite: RawSuite, out: RawSpec[]): void {
  if (suite.specs) out.push(...suite.specs);
  for (const child of suite.suites ?? []) collectSpecs(child, out);
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** One compact line: the assertion that failed plus the expected/received pair. */
function summariseFailure(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const text = stripAnsi(message);
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const expected = /^Expected:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const received = /^Received:\s*(.+)$/m.exec(text)?.[1]?.trim();

  const parts = [firstLine ?? "failed"];
  if (expected !== undefined) parts.push(`expected ${expected}`);
  if (received !== undefined) parts.push(`received ${received}`);
  return parts.join(": ");
}

function isFailure(status: string | undefined): boolean {
  return status === "failed" || status === "timedOut" || status === "interrupted";
}

function mostCommon(messages: string[]): string | undefined {
  if (messages.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  let best = messages[0]!;
  let bestCount = 0;
  for (const [message, count] of counts) {
    if (count > bestCount) {
      best = message;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Replays a spec `repeat` times with retries disabled. A spec that fails every
 * run is a solid repro; one that only fails sometimes is flaky.
 */
export async function replaySpec({
  specFile,
  targetUrl,
  repeat = 5,
}: VerifyOptions): Promise<VerifyOutcome> {
  const artifactDir = join("bugsnare-output", "artifacts", slugFromSpec(specFile));
  await mkdir(artifactDir, { recursive: true });

  const run = await runPlaywright(specFile, targetUrl, artifactDir, repeat);
  const report = parseReport(run.stdout);

  const specs: RawSpec[] = [];
  for (const suite of report?.suites ?? []) collectSpecs(suite, specs);

  const results = specs.flatMap((spec) => (spec.tests ?? []).flatMap((test) => test.results ?? []));
  const failures = results.filter((result) => isFailure(result.status));
  const messages = failures
    .map((result) => summariseFailure(result.error?.message))
    .filter((message): message is string => message !== undefined);

  const title = specs[0]?.title ?? basename(specFile);

  if (results.length === 0) {
    return {
      title,
      total: 0,
      failures: 0,
      messages: [],
      artifactDir,
      noTests: true,
    };
  }

  return {
    title,
    total: results.length,
    failures: failures.length,
    messages,
    mostCommonMessage: mostCommon(messages),
    artifactDir,
    noTests: false,
  };
}