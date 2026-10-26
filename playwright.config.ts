import { defineConfig } from "@playwright/test";

export default defineConfig({
  // The repo root so both the example suite and generated specs in
  // bugsnare-output/ are discoverable by a plain `npx playwright test`.
  testDir: ".",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npx http-server examples/shop-app -p 3000 -s",
    url: "http://localhost:3000",
    reuseExistingServer: true,
  },
});