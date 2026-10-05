import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { availablePort, PROJECTS } from "./ci-contract.mjs";

const productRoot = process.env.SNS_CI_PRODUCT_ROOT;
const output = process.env.SNS_CI_OUTPUT;
if (!productRoot || !output) throw new Error("Trusted axe environment missing");
const requireProduct = createRequire(join(productRoot, "package.json"));
const { chromium, webkit } = requireProduct("@playwright/test");
const AxeBuilder = requireProduct("@axe-core/playwright").default;
const { preview } = await import(requireProduct.resolve("vite"));
const port = await availablePort();
const baseURL = `http://127.0.0.1:${port}`;
const server = await preview({ configFile: join(productRoot, "vite.config.ts"), preview: { host: "127.0.0.1", port, strictPort: true } });
const probes = [];
try {
  for (const project of PROJECTS) {
    const browser = await ({ chromium, webkit }[project.browserName]).launch();
    const context = await browser.newContext({ viewport: project.viewport, ...(project.browserName === "webkit" ? { deviceScaleFactor: 2, hasTouch: true, isMobile: true } : {}) });
    const errors = [];
    const network = [];
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    page.on("requestfailed", (request) => errors.push(`failed: ${request.url()}`));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL) { errors.push(`external: ${url.origin}`); await route.abort(); } else await route.continue();
    });
    page.on("response", (response) => { network.push({ url: response.url(), status: response.status() }); if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    try {
      const response = await page.goto(baseURL);
      await page.getByRole("button", { name: "確認項目を表示" }).click();
      const axe = await new AxeBuilder({ page }).analyze();
      const viewport = page.viewportSize();
      await page.screenshot({ path: join(output, `${project.name}.png`), fullPage: true });
      probes.push({ project: project.name, browserName: project.browserName, viewport, httpStatus: response?.status(), errors, network, axe });
    } finally {
      await context.tracing.stop({ path: join(output, `${project.name}.trace.zip`) });
      await browser.close();
    }
  }
} finally {
  await writeFile(join(output, "accessibility.json"), `${JSON.stringify({ baseURL, probes }, null, 2)}\n`, { flag: "wx" });
  await new Promise((done, fail) => server.httpServer.close((error) => error ? fail(error) : done()));
}
