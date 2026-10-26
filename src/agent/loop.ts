import "dotenv/config";
import Groq from "groq-sdk";
import { BrowserSession } from "../browser";
import { agentActionSchema, type AgentAction, type Assertion } from "../actions";
import { SYSTEM_PROMPT } from "./prompt";

const RECENT_ACTION_LIMIT = 5;
const MAX_RATE_LIMIT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;

export type AgentStatus = "reproduced" | "gave_up" | "max_steps";

export interface TraceEntry {
  step: number;
  action: AgentAction;
  ok: boolean;
  result: string;
}

export interface AgentResult {
  status: AgentStatus;
  /** First heading (or line) of the bug report, used for emitted test headers. */
  issueTitle: string;
  /** The URL the agent was pointed at, used to emit origin-relative navigations. */
  targetUrl: string;
  trace: TraceEntry[];
  assertion?: Assertion;
}

export interface RunAgentOptions {
  issueText: string;
  targetUrl: string;
  maxSteps?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRateLimited(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (status === 429) return true;
  }
  return /\b429\b|rate limit/i.test(errorMessage(error));
}

/** Retries only when Groq reports a rate limit, backing off exponentially. */
async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_ATTEMPTS) throw error;

      const delayMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      console.log(
        `  rate limited (429): retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RATE_LIMIT_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }
}

function extractJsonObject(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? reply).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("reply did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

type ParseResult = { ok: true; action: AgentAction } | { ok: false; error: string };

function parseAction(reply: string): ParseResult {
  try {
    const parsed = agentActionSchema.safeParse(extractJsonObject(reply));
    if (parsed.success) return { ok: true, action: parsed.data };

    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: issues };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function describeAction(action: AgentAction): string {
  switch (action.action) {
    case "goto":
      return `goto ${action.url}`;
    case "click":
      return `click ${action.role} "${action.name}"`;
    case "fill":
      return `fill ${action.role} "${action.name}" with "${action.value}"`;
    case "press":
      return `press "${action.key}"`;
    case "assert_fail":
      return `assert_fail ${action.role}${action.name ? ` "${action.name}"` : ""} expected "${action.expected}" got "${action.actual}"`;
    case "give_up":
      return "give_up";
  }
}

function buildUserMessage(
  issueText: string,
  targetUrl: string,
  recent: TraceEntry[],
  snapshot: string,
): string {
  const history =
    recent.length === 0
      ? "(no actions taken yet)"
      : recent
          .map(
            (entry) =>
              `step ${entry.step}: ${JSON.stringify(entry.action)} -> ${entry.ok ? "ok" : "failed"}: ${entry.result}`,
          )
          .join("\n");

  return [
    "Bug report:",
    issueText.trim(),
    "",
    `Target URL: ${targetUrl}`,
    "",
    "Last actions with results (oldest first):",
    history,
    "",
    "Current page state (URL + accessibility snapshot):",
    snapshot,
    "",
    "Reply with exactly one JSON object, no other text.",
  ].join("\n");
}

function issueTitleFrom(issueText: string): string {
  const lines = issueText.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#+\s+/.test(line));
  if (heading) return heading.replace(/^#+\s+/, "").trim();
  return lines.find((line) => line.length > 0) ?? "Untitled issue";
}

function toAssertion(action: Extract<AgentAction, { action: "assert_fail" }>): Assertion {
  return {
    role: action.role,
    expected: action.expected,
    actual: action.actual,
    ...(action.name === undefined ? {} : { name: action.name }),
  };
}

export async function runAgent({
  issueText,
  targetUrl,
  maxSteps = 15,
}: RunAgentOptions): Promise<AgentResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Add it to .env in the project root.");
  }

  const model = process.env.GROQ_MODEL;
  if (!model) {
    throw new Error("GROQ_MODEL is not set. Add the Groq model ID to .env in the project root.");
  }

  // The loop owns retry policy; the SDK's built-in retries would stack on top.
  const groq = new Groq({ apiKey, maxRetries: 0 });
  const session = new BrowserSession();
  const trace: TraceEntry[] = [];
  const issueTitle = issueTitleFrom(issueText);

  const ask = async (userText: string): Promise<string> => {
    const completion = await withRateLimitRetry(() =>
      groq.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
      }),
    );
    return completion.choices[0]?.message?.content ?? "";
  };

  try {
    await session.start(targetUrl, true);

    for (let step = 1; step <= maxSteps; step++) {
      const snapshot = await session.snapshot();
      const userText = buildUserMessage(
        issueText,
        targetUrl,
        trace.slice(-RECENT_ACTION_LIMIT),
        snapshot,
      );

      let parsed = parseAction(await ask(userText));
      if (!parsed.ok) {
        console.log(`[step ${step}/${maxSteps}] invalid reply (${parsed.error}); retrying once`);
        parsed = parseAction(
          await ask(
            `${userText}\n\nYour previous reply was invalid: ${parsed.error}. Reply again with exactly one valid JSON object and nothing else.`,
          ),
        );
      }

      if (!parsed.ok) {
        console.log(`[step ${step}/${maxSteps}] gave up: no valid action after retry (${parsed.error})`);
        return { status: "gave_up", issueTitle, targetUrl, trace };
      }

      const action = parsed.action;
      console.log(`[step ${step}/${maxSteps}] action: ${describeAction(action)}`);
      console.log(`[step ${step}/${maxSteps}] reason: ${action.reason}`);

      if (action.action === "give_up") {
        console.log(`[step ${step}/${maxSteps}] result: gave up - ${action.reason}`);
        return { status: "gave_up", issueTitle, targetUrl, trace };
      }

      if (action.action === "assert_fail") {
        const assertion = toAssertion(action);
        trace.push({
          step,
          action,
          ok: true,
          result: `assertion recorded: expected "${assertion.expected}", actual "${assertion.actual}"`,
        });
        console.log(
          `[step ${step}/${maxSteps}] result: reproduced - expected "${assertion.expected}", actual "${assertion.actual}"`,
        );
        return { status: "reproduced", issueTitle, targetUrl, trace, assertion };
      }

      const outcome = await session.execute(action);
      trace.push({ step, action, ok: outcome.ok, result: outcome.result });
      console.log(
        `[step ${step}/${maxSteps}] result: ${outcome.ok ? "ok" : "failed"} - ${outcome.result}`,
      );
    }

    console.log(`Reached the ${maxSteps}-step limit without reproducing the bug.`);
    return { status: "max_steps", issueTitle, targetUrl, trace };
  } finally {
    await session.close();
  }
}