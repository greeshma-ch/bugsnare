import { expect, test } from "@playwright/test";

test("flaky place order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Place flaky order" }).click();
  await expect(page.locator("#flaky-result").getByRole("status")).toHaveText("Flaky order placed");
});