import { createRequire } from "node:module";
import { join } from "node:path";
import { PROJECTS } from "./ci-contract.mjs";

const productRoot = process.env.SNS_CI_PRODUCT_ROOT;
const output = process.env.SNS_CI_OUTPUT;
const port = Number(process.env.SNS_E2E_PORT);
const browserName = process.env.SNS_CI_BROWSER;
if (!productRoot || !output || !["chromium", "webkit"].includes(browserName) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Trusted CI Playwright environment missing");
const { defineConfig } = createRequire(join(productRoot, "package.json"))("@playwright/test");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: join(productRoot, "e2e"),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: join(output, "test-results"),
  reporter: [
    ["list"], ["json", { outputFile: join(output, "playwright.json") }],
    ["junit", { outputFile: join(output, "test-results.xml") }],
    ["html", { open: "never", outputFolder: join(output, "playwright-report") }],
    [new URL("./ci-viewport-reporter.mjs", import.meta.url).pathname],
  ],
  use: { baseURL, trace: "on", screenshot: "on", video: "off" },
  webServer: { command: `npm run preview -- --port ${port} --strictPort`, cwd: productRoot, url: baseURL, reuseExistingServer: false, timeout: 120_000 },
  projects: PROJECTS.filter((project) => project.browserName === browserName).map(({ name, browserName, viewport }) => ({ name, use: { browserName, viewport, ...(browserName === "webkit" ? { deviceScaleFactor: 2, hasTouch: true, isMobile: true } : {}) } })),
});
