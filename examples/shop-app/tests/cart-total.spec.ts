import { expect, test } from "@playwright/test";

test("cart total reflects quantity", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add Widget" }).click();
  await page.getByLabel("Quantity for Widget").fill("3");

  await expect(page.getByRole("status")).toHaveText("$30");
});