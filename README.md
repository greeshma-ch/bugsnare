# Bugsnare

Bugsnare reproduces web-app bugs with an LLM agent driving Playwright, then turns what it observed into a plain Playwright regression test. The generated spec contains no LLM code: it replays the agent's steps and asserts the expected behaviour, so it fails while the bug is present.

## Setup

```bash
npm install
npx playwright install chromium
```

Create a `.env` in the project root:

```
GROQ_API_KEY=...
GROQ_MODEL=...            # agent model
GROQ_CRITIC_MODEL=...     # optional, defaults to GROQ_MODEL
```

## Example app

`examples/shop-app` is a small shop with four seeded bugs, each marked with a `// BUG (seeded, intentional)` comment:

- the cart subtotal ignores quantity
- `SAVE10` subtracts a flat $10 instead of 10%
- checkout accepts an invalid email without an alert
- a placed order redirects to the cart instead of the confirmation page

`examples/shop-app-fixed` is the same app with all four fixed, marked `// FIXED`. Its issue files are copies, so the buggy app stays the fixture for reproduction.

## Commands

| command | what it does |
| --- | --- |
| `npm run serve:buggy` | serve the buggy app on `http://localhost:3000` |
| `npm run serve:fixed` | serve the fixed app on `http://localhost:3001` |
| `npm run bugsnare -- repro <issue-file> --target <url>` | run the agent and write `bugsnare-output/<slug>.spec.ts` |
| `npm run bugsnare -- verify <spec-file> --target <url>` | replay a spec against a running app |
| `npm run demo` | the whole loop, end to end |
| `npm run eval` | run the agent over every issue in `examples/shop-app/issues` |
| `npm test` | run the example suite and every generated spec |

`verify` exits `0` and prints `FIXED: <test title>` when the spec passes, `1` and prints `STILL FAILING: <test title>` with the expected/received values and the artifact path when it fails, and `2` when the target is unreachable or the arguments are wrong.

On failure, verify keeps the Playwright trace and video in `bugsnare-output/artifacts/<slug>/` (git-ignored).

## Demo

```bash
npm run demo
```

The demo shows the full loop:

1. starts the buggy app on `:3000` and the fixed app on `:3001`
2. reproduces `examples/shop-app/issues/cart-total.md` against `:3000` and writes `bugsnare-output/cart-total-is-wrong-when-quantity-is-more-than-1.spec.ts`
3. verifies that spec against `:3000` - **STILL FAILING** (exit 1)
4. verifies the same spec against `:3001` - **FIXED** (exit 0)

If the agent cannot produce a spec in that run, the demo reuses the newest spec already in `bugsnare-output/` so the verification half still runs; it says so in its output.

## Token usage

Every run reports what it spent: `repro` prints `tokens: N` and the result JSON carries the prompt/completion/total split, and `npm run eval` adds an average-tokens column per issue.

To keep each step small, only the current page state is sent as a full snapshot (capped at ~4000 characters with non-interactive lines dropped first), history is reduced to action + outcome, and completions are capped at 300 tokens. Reasoning models spend that budget on hidden reasoning, so requests ask for low reasoning effort and fall back automatically if a model rejects the parameter.

## How it works

- `src/browser.ts` drives Chromium with a five-second timeout per action and returns ARIA snapshots.
- `src/agent/loop.ts` asks Groq for one JSON action per turn, validates it with zod, and stops on `assert_fail`, `give_up`, or the step limit.
- `src/emit-test.ts` replays successful traced actions as Playwright calls and ends with one `toHaveText` assertion on the expected value.
- `src/verify.ts` runs the spec with `BASE_URL` pointing at the chosen app and parses Playwright's JSON report.

The agent's model calls are not part of the generated tests, so verification and CI need only Playwright.