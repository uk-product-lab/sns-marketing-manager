import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { monitorUnexpectedHttpResponses } from "./http-response-policy";

test.describe("foundation app shell", () => {
  test("renders and operates without external requests, overflow, or serious accessibility violations", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    const failedRequests: string[] = [];
    const externalRequests: string[] = [];
    const unexpectedHttpResponses = monitorUnexpectedHttpResponses(page);

    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        externalRequests.push(request.url());
      }
    });

    const response = await page.goto("/");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle("SNS Marketing Manager");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "SNS Marketing Manager",
    );
    await expect(page.getByRole("status")).toContainText("現在は基盤準備中です");

    await page.keyboard.press("Tab");
    const toggle = page.getByRole("button", { name: "確認項目を表示" });
    await expect(toggle).toBeFocused();

    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);

    await page.keyboard.press("Enter");
    await expect(page.getByText("SNSへの自動投稿は行いません。")).toBeVisible();
    await expect(page.getByRole("button", { name: "確認項目を閉じる" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const accessibility = await new AxeBuilder({ page }).analyze();
    const seriousViolations = accessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(seriousViolations).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(unexpectedHttpResponses).toEqual([]);
  });

  test("detects a synthetic HTTP 500 response", async ({ page }) => {
    const unexpectedHttpResponses = monitorUnexpectedHttpResponses(page);

    await page.route("**/__synthetic-http-error", async (route) => {
      await route.fulfill({
        body: "synthetic error",
        contentType: "text/plain",
        status: 500,
      });
    });
    await page.goto("/");

    const status = await page.evaluate(async () => {
      const response = await fetch("/__synthetic-http-error");
      return response.status;
    });

    expect(status).toBe(500);
    expect(unexpectedHttpResponses).toHaveLength(1);
    expect(unexpectedHttpResponses[0]).toMatch(
      /^GET 500 http:\/\/127\.0\.0\.1:\d+\/__synthetic-http-error$/u,
    );
  });
});
