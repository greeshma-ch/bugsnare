import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { actionSchema, type Action } from "./actions";

const ACTION_TIMEOUT_MS = 5_000;

export type ActionOutcome = { ok: boolean; result: string };

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Rejects with a single readable line instead of Playwright's multi-line
 * message plus call log, so a failure can be fed straight back to the model.
 */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "Unknown error";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "action";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  async start(baseUrl: string, headless = true): Promise<void> {
    await this.close();

    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({ baseURL: baseUrl });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
    // Open on the target so the first snapshot describes the app, not about:blank.
    await this.page.goto(baseUrl, { timeout: ACTION_TIMEOUT_MS });
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  /** The current URL followed by the accessibility tree of `<body>`. */
  async snapshot(): Promise<string> {
    const page = this.requirePage();
    const aria = await page.locator("body").ariaSnapshot();
    return `${page.url()}\n${aria}`;
  }

  async execute(input: unknown): Promise<ActionOutcome> {
    const page = this.page;
    if (!page) {
      return { ok: false, result: "Browser session is not started." };
    }

    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, result: `Invalid action: ${formatIssues(parsed.error)}` };
    }

    try {
      return await this.perform(page, parsed.data);
    } catch (error) {
      return { ok: false, result: shortError(error) };
    }
  }

  private async perform(page: Page, action: Action): Promise<ActionOutcome> {
    switch (action.action) {
      case "goto":
        await page.goto(action.url, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, result: `navigated to ${page.url()}` };

      case "click":
        await this.locate(page, action.role, action.name).click({ timeout: ACTION_TIMEOUT_MS });
        return { ok: true, result: `clicked ${action.role} "${action.name}"` };

      case "fill":
        await this.locate(page, action.role, action.name).fill(action.value, {
          timeout: ACTION_TIMEOUT_MS,
        });
        return {
          ok: true,
          result: `filled ${action.role} "${action.name}" with "${action.value}"`,
        };

      case "press":
        await page.keyboard.press(action.key);
        return { ok: true, result: `pressed "${action.key}"` };

      default: {
        const unreachable: never = action;
        return { ok: false, result: `Unsupported action: ${JSON.stringify(unreachable)}` };
      }
    }
  }

  private locate(page: Page, role: string, name: string) {
    // The schema accepts any string so callers can pass any ARIA role; Playwright
    // narrows the value to its known role union, and an unknown role surfaces as
    // a caught error rather than a crash.
    return page.getByRole(role as AriaRole, { name });
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser session is not started. Call start() first.");
    }
    return this.page;
  }
}