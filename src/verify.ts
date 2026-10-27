import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

export interface VerifyOptions {
  specFile: string;
  targetUrl: string;
}

export interface VerifyOutcome {
  fixed: boolean;
  title: string;
  expected?: string;
  received?: string;
  detail?: string;
  artifactDir: string;
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

function runPlaywright(specFile: string, targetUrl: string, artifactDir: string): Promise<PlaywrightRun> {
  return new Promise((resolve, reject) => {
    // Call Playwright's CLI through node so no shell is involved (and Windows
    // can still run it without spawning `npx.cmd`).
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", specFile, "--reporter=json"],
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
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

function splitExpectation(message: string | undefined): {
  expected?: string;
  received?: string;
  detail?: string;
} {
  if (!message) return {};
  const text = stripAnsi(message);
  const expected = /^Expected:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const received = /^Received:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const detail =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? undefined;
  return { expected, received, detail };
}

/**
 * Replays a generated spec against a running app. A passing spec means the bug
 * is fixed there; a failing one means the reported behaviour is still present.
 */
export async function verifySpec({ specFile, targetUrl }: VerifyOptions): Promise<VerifyOutcome> {
  const artifactDir = join("bugsnare-output", "artifacts", slugFromSpec(specFile));
  await mkdir(artifactDir, { recursive: true });

  // Playwright matches the path filter as a regex, so Windows separators would
  // be read as escapes and match nothing.
  const specArg = specFile.replace(/\\/g, "/");
  const run = await runPlaywright(specArg, targetUrl, artifactDir);
  const report = parseReport(run.stdout);

  const specs: RawSpec[] = [];
  for (const suite of report?.suites ?? []) collectSpecs(suite, specs);

  const results = specs.flatMap((spec) => (spec.tests ?? []).flatMap((test) => test.results ?? []));
  const failedResults = results.filter(
    (result) => result.status === "failed" || result.status === "timedOut" || result.status === "interrupted",
  );

  const title = specs[0]?.title ?? basename(specFile);
  const fixed = report !== undefined && failedResults.length === 0 && run.code === 0;

  if (fixed) {
    return { fixed, title, artifactDir };
  }

  const failure = failedResults[0]?.error?.message ?? report?.errors?.[0]?.message;
  const { expected, received, detail } = splitExpectation(failure);

  return {
    fixed,
    title,
    expected,
    received,
    detail,
    artifactDir,
  };
}