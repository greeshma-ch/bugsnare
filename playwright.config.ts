import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results";

export default defineConfig({
  // The repo root so both the example suite and generated specs in
  // bugsnare-output/ are discoverable by a plain `npx playwright test`.
  testDir: ".",
  outputDir,
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  // `bugsnare verify` points BASE_URL at an app it expects to already be
  // running, so starting the buggy webserver would be wrong there.
  ...(process.env.BASE_URL === undefined
    ? {
        webServer: {
          command: "npx http-server examples/shop-app -p 3000 -s",
          url: "http://localhost:3000",
          reuseExistingServer: true,
        },
      }
    : {}),
});