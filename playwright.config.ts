import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./examples/shop-app/tests",
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