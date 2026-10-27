import "dotenv/config";
import Groq from "groq-sdk";
import { BrowserSession } from "../browser";
import { agentActionSchema, type AgentAction, type Assertion } from "../actions";
import { SYSTEM_PROMPT } from "./prompt";

const RECENT_ACTION_LIMIT = 5;
const SNAPSHOT_CHAR_LIMIT = 4_000;
const MAX_COMPLETION_TOKENS = 300;
const MAX_RATE_LIMIT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;

export type AgentStatus = "reproduced" | "gave_up" | "max_steps";

export interface TraceEntry {
  step: number;
  action: AgentAction;
  ok: boolean;
  result: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface AgentModels {
  /** Model that picks the next action. */
  agent: string;
  /** Model reserved for the critic step; defaults to the agent model. */
  critic: string;
}

export interface AgentResult {
  status: AgentStatus;
  /** First heading (or line) of the bug report, used for emitted test headers. */
  issueTitle: string;
  /** The URL the agent was pointed at, used to emit origin-relative navigations. */
  targetUrl: string;
  trace: TraceEntry[];
  /** Tokens spent on model calls during this run. */
  usage: TokenUsage;
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

function oneLine(text: string, limit = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 3)}...` : single;
}

/** Lines that carry something the model can act on. */
const INTERACTIVE_LINE =
  /^\s*-\s*(button|link|textbox|searchbox|spinbutton|checkbox|radio|switch|combobox|option|slider|tab|menuitem|alert|status|heading|dialog|listitem|cell|gridcell)\b/;

/**
 * Keeps a huge accessibility tree inside the budget by dropping structural
 * lines first, so every button, link, input and alert survives.
 */
export function truncateSnapshot(snapshot: string): string {
  if (snapshot.length <= SNAPSHOT_CHAR_LIMIT) return snapshot;

  const [urlLine = "", ...rest] = snapshot.split("\n");
  const kept = rest.filter((line) => INTERACTIVE_LINE.test(line));
  const budget = SNAPSHOT_CHAR_LIMIT - urlLine.length - 40;

  let body = kept.join("\n");
  if (body.length > budget) {
    body = body.slice(0, Math.max(0, budget));
    const lastNewline = body.lastIndexOf("\n");
    if (lastNewline > 0) body = body.slice(0, lastNewline);
  }

  const omitted = rest.length - body.split("\n").length;
  const marker = omitted > 0 ? `\n... ${omitted} line(s) omitted` : "";
  return `${urlLine}\n${body}${marker}`;
}

function buildUserMessage(
  issueText: string,
  targetUrl: string,
  recent: TraceEntry[],
  snapshot: string,
): string {
  // History is action + outcome only: no accumulated snapshots, no old reasons.
  const history =
    recent.length === 0
      ? "(no actions taken yet)"
      : recent
          .map(
            (entry) =>
              `${entry.step}: ${describeAction(entry.action)} -> ${entry.ok ? "ok" : "failed"}: ${oneLine(entry.result)}`,
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
    truncateSnapshot(snapshot),
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

/** Model per role: the agent picks actions, the critic (future) judges them. */
export function resolveModels(): AgentModels {
  const agent = process.env.GROQ_MODEL;
  if (!agent) {
    throw new Error("GROQ_MODEL is not set. Add the Groq model ID to .env in the project root.");
  }
  const critic = process.env.GROQ_CRITIC_MODEL ?? agent;
  return { agent, critic };
}

/** True when the API rejected the request only because of reasoning_effort. */
function rejectsReasoningEffort(error: unknown): boolean {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (status !== 400) return false;
  return /reasoning_effort/i.test(errorMessage(error));
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

  const models = resolveModels();
  const model = models.agent;

  // The loop owns retry policy; the SDK's built-in retries would stack on top.
  // A request timeout keeps a stalled call from hanging the whole run.
  const groq = new Groq({ apiKey, maxRetries: 0, timeout: 60_000 });
  const session = new BrowserSession();
  const trace: TraceEntry[] = [];
  const issueTitle = issueTitleFrom(issueText);
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };

  // Reasoning models spend completion tokens on hidden reasoning; with a small
  // max_tokens cap they can run out before writing the JSON. Low effort keeps
  // the reply inside the budget. Not every model accepts the parameter, so the
  // first rejection switches it off for the rest of the run.
  let reasoningMode: "unknown" | "low" | "off" = "unknown";

  const ask = async (userText: string): Promise<string> => {
    const params = {
      model,
      temperature: 0,
      max_tokens: MAX_COMPLETION_TOKENS,
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: userText },
      ],
    };

    let completion;
    if (reasoningMode === "off") {
      completion = await withRateLimitRetry(() => groq.chat.completions.create(params));
    } else {
      try {
        completion = await withRateLimitRetry(() =>
          groq.chat.completions.create({ ...params, reasoning_effort: "low" }),
        );
        reasoningMode = "low";
      } catch (error) {
        if (reasoningMode === "unknown" && rejectsReasoningEffort(error)) {
          reasoningMode = "off";
          completion = await withRateLimitRetry(() => groq.chat.completions.create(params));
        } else {
          throw error;
        }
      }
    }

    usage.calls += 1;
    usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
    usage.completionTokens += completion.usage?.completion_tokens ?? 0;
    usage.totalTokens += completion.usage?.total_tokens ?? 0;

    return completion.choices[0]?.message?.content ?? "";
  };

  const base = { issueTitle, targetUrl, usage };

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
        return { ...base, status: "gave_up", trace };
      }

      const action = parsed.action;
      console.log(`[step ${step}/${maxSteps}] action: ${describeAction(action)}`);
      console.log(`[step ${step}/${maxSteps}] reason: ${action.reason}`);

      if (action.action === "give_up") {
        console.log(`[step ${step}/${maxSteps}] result: gave up - ${action.reason}`);
        return { ...base, status: "gave_up", trace };
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
        return { ...base, status: "reproduced", trace, assertion };
      }

      const outcome = await session.execute(action);
      trace.push({ step, action, ok: outcome.ok, result: outcome.result });
      console.log(
        `[step ${step}/${maxSteps}] result: ${outcome.ok ? "ok" : "failed"} - ${outcome.result}`,
      );
    }

    console.log(`Reached the ${maxSteps}-step limit without reproducing the bug.`);
    return { ...base, status: "max_steps", trace };
  } finally {
    await session.close();
  }
}