// Independent reviewer browser probe (TASK-0014). Read-only against the product build.
// Run as:  node - < probe.cjs   with cwd = review worktree, STAGE = output directory.
// It is fed through stdin on purpose: Playwright records the caller file of every API
// call into the trace, and a stdin script is recorded as "[stdin]" instead of a local path.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const { chromium, webkit } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const STAGE = process.env.STAGE;
if (!STAGE) throw new Error("STAGE missing");
const PROJECTS = [
  { name: "chromium-mac-1440x900", group: "mac", browserName: "chromium", viewport: { width: 1440, height: 900 } },
  { name: "chromium-macbook-1512x982", group: "mac", browserName: "chromium", viewport: { width: 1512, height: 982 } },
  { name: "webkit-iphone-390x844", group: "iphone", browserName: "webkit", viewport: { width: 390, height: 844 } },
  { name: "webkit-iphone-393x852", group: "iphone", browserName: "webkit", viewport: { width: 393, height: 852 } },
];
const EXPANDED_TEXT = "SNSへの自動投稿は行いません。";

function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

async function interactiveElements(page) {
  return page.evaluate(() => [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex], [role=button], [role=link]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      name: (element.getAttribute("aria-label") || element.textContent || "").trim(),
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
    };
  }));
}
const overflow = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
const activeElement = (page) => page.evaluate(() => {
  const element = document.activeElement;
  const style = element ? getComputedStyle(element) : null;
  return { tag: element?.tagName.toLowerCase() ?? null, text: (element?.textContent ?? "").trim(), outlineStyle: style?.outlineStyle ?? null, outlineWidth: style?.outlineWidth ?? null, boxShadow: style?.boxShadow ?? null };
});

(async () => {
  for (const directory of ["traces", "screenshots/mac", "screenshots/iphone"]) mkdirSync(join(STAGE, directory), { recursive: true });
  const { preview } = await import(require.resolve("vite"));
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = await preview({ configFile: join(process.cwd(), "vite.config.ts"), preview: { host: "127.0.0.1", port, strictPort: true } });
  const results = [];
  const accessibility = [];
  const consoleLines = [];
  const networkLines = [];
  try {
    for (const project of PROJECTS) {
      const startedAt = new Date().toISOString();
      const mobile = project.browserName === "webkit";
      const browser = await ({ chromium, webkit }[project.browserName]).launch();
      const context = await browser.newContext({ viewport: project.viewport, ...(mobile ? { deviceScaleFactor: 2, hasTouch: true, isMobile: true } : {}) });
      const consoleMessages = [];
      const pageErrors = [];
      const failedRequests = [];
      const externalRequests = [];
      const requests = [];
      const badResponses = [];
      const checks = [];
      const check = (id, pass, observed) => checks.push({ id, result: pass ? "PASS" : "FAIL", observed });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      let tracing = true;
      const page = await context.newPage();
      page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== baseURL) { externalRequests.push(route.request().url()); await route.abort(); } else await route.continue();
      });
      page.on("response", (response) => {
        const entry = { method: response.request().method(), status: response.status(), url: response.url(), resourceType: response.request().resourceType() };
        requests.push(entry);
        if (entry.status >= 400) badResponses.push(entry);
      });
      let axeExpanded = null;
      let axeCollapsed = null;
      let zoom = null;
      try {
        // 1. load
        const response = await page.goto(baseURL + "/");
        await page.waitForLoadState("networkidle");
        check("load-http-200", response?.status() === 200, { status: response?.status() ?? null });
        const title = await page.title();
        check("title", title === "SNS Marketing Manager", { title });
        const h1 = await page.getByRole("heading", { level: 1 }).allTextContents();
        check("single-h1", h1.length === 1 && h1[0] === "SNS Marketing Manager", { h1 });
        const status = (await page.getByRole("status").textContent()) ?? "";
        check("status-region-text", status.includes("現在は基盤準備中です"), { status });
        check("viewport-applied", JSON.stringify(page.viewportSize()) === JSON.stringify(project.viewport), { viewport: page.viewportSize() });
        check("no-horizontal-overflow-initial", await overflow(page).then((value) => value.scrollWidth <= value.clientWidth), await overflow(page));
        await page.screenshot({ path: join(STAGE, "screenshots", project.group, `${project.name}-initial.png`) });

        // 2. keyboard: Tab reaches the toggle first, focus is visible
        await page.keyboard.press("Tab");
        const openToggle = page.getByRole("button", { name: "確認項目を表示" });
        const focusedOnToggle = await openToggle.evaluate((element) => element === document.activeElement);
        const focus = await activeElement(page);
        check("keyboard-tab-focuses-toggle", focusedOnToggle, focus);
        const focusVisible = (focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) > 0) || (focus.boxShadow && focus.boxShadow !== "none");
        check("focus-indicator-visible", Boolean(focusVisible), { outlineStyle: focus.outlineStyle, outlineWidth: focus.outlineWidth, boxShadow: focus.boxShadow });

        // 3. target size, names, nothing hidden outside the viewport
        const collapsedElements = await interactiveElements(page);
        check("touch-targets-44px-collapsed", collapsedElements.length > 0 && collapsedElements.every((element) => element.width >= 44 && element.height >= 44), collapsedElements);
        check("interactive-elements-have-names", collapsedElements.every((element) => element.name.length > 0), collapsedElements.map((element) => element.name));
        check("controls-inside-viewport-width", collapsedElements.every((element) => element.left >= 0 && element.right <= project.viewport.width), collapsedElements.map(({ left, right }) => ({ left, right })));

        // 4. keyboard: Enter opens
        await page.keyboard.press("Enter");
        const closeToggle = page.getByRole("button", { name: "確認項目を閉じる" });
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "visible", timeout: 5000 });
        const expandedAttribute = await closeToggle.getAttribute("aria-expanded");
        const controls = await closeToggle.getAttribute("aria-controls");
        const controlledExists = await page.evaluate((id) => Boolean(id && document.getElementById(id)), controls);
        check("keyboard-enter-opens-details", expandedAttribute === "true" && controlledExists, { ariaExpanded: expandedAttribute, ariaControls: controls, controlledExists });
        const items = await page.locator("#foundation-details li").allTextContents();
        check("details-list-three-items", items.length === 3, { items });
        check("focus-stays-on-toggle-after-open", await closeToggle.evaluate((element) => element === document.activeElement), await activeElement(page).then(({ tag, text }) => ({ tag, text })));
        check("no-horizontal-overflow-expanded", await overflow(page).then((value) => value.scrollWidth <= value.clientWidth), await overflow(page));
        const expandedElements = await interactiveElements(page);
        check("touch-targets-44px-expanded", expandedElements.every((element) => element.width >= 44 && element.height >= 44), expandedElements);

        // 5. keyboard: Enter closes, focus returns/stays on the toggle
        await page.keyboard.press("Enter");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "detached", timeout: 5000 });
        const reopened = page.getByRole("button", { name: "確認項目を表示" });
        check("keyboard-enter-closes-details", (await reopened.getAttribute("aria-expanded")) === "false", { ariaExpanded: await reopened.getAttribute("aria-expanded") });
        check("focus-stays-on-toggle-after-close", await reopened.evaluate((element) => element === document.activeElement), await activeElement(page).then(({ tag, text }) => ({ tag, text })));

        // 6. keyboard: Space also operates the button
        await page.keyboard.press("Space");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "visible", timeout: 5000 });
        await page.keyboard.press("Space");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "detached", timeout: 5000 });
        check("keyboard-space-toggles", true, { opened: true, closed: true });

        // 7. pointer: click (Mac) / tap (iPhone-sized touch context) opens
        if (mobile) await page.getByRole("button", { name: "確認項目を表示" }).tap(); else await page.getByRole("button", { name: "確認項目を表示" }).click();
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "visible", timeout: 5000 });
        check(mobile ? "tap-opens-details" : "click-opens-details", (await closeToggle.getAttribute("aria-expanded")) === "true", { ariaExpanded: await closeToggle.getAttribute("aria-expanded") });
        const guardrails = await page.locator(".guardrail-grid dt").allTextContents();
        check("guardrail-section-rendered", guardrails.length === 3, { guardrails });
        await page.screenshot({ path: join(STAGE, "screenshots", project.group, `${project.name}-expanded.png`), fullPage: true });
      } catch (error) {
        check("flow-completed", false, { error: String(error.message).split("\n")[0] });
      } finally {
        await context.tracing.stop({ path: join(STAGE, "traces", `${project.name}.zip`) });
        tracing = false;
      }

      // Accessibility (run after tracing stops so that the trace only records this script).
      try {
        axeExpanded = await new AxeBuilder({ page }).analyze();
        await page.getByRole("button", { name: "確認項目を閉じる" }).press("Enter");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "detached", timeout: 5000 });
        axeCollapsed = await new AxeBuilder({ page }).analyze();
        for (const [state, axe] of [["expanded", axeExpanded], ["collapsed", axeCollapsed]]) {
          const blocking = axe.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
          check(`axe-${state}-no-critical-serious`, blocking.length === 0, { violations: axe.violations.length, criticalOrSerious: blocking.length, passes: axe.passes.length, incomplete: axe.incomplete.length });
        }
        // Enlargement checks, all with the details expanded (the longest content).
        await page.getByRole("button", { name: "確認項目を表示" }).press("Enter");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "visible", timeout: 5000 });
        const layout = () => page.evaluate(() => {
          const root = document.documentElement;
          const textElements = [...document.querySelectorAll("h1, h2, h3, p, li, dt, dd, button")];
          window.scrollTo(100000, 0);
          const maxScrollX = window.scrollX;
          window.scrollTo(0, 0);
          return {
            scrollWidth: root.scrollWidth,
            clientWidth: root.clientWidth,
            maxScrollX,
            // elements whose box ends outside the scrollable page (unreachable even by scrolling)
            beyondPage: textElements.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < -0.5 || rect.right > root.scrollWidth + 0.5; }).length,
            // elements whose own text is cut off inside their box
            clippedText: textElements.filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible").length,
            // elements that need horizontal scrolling to be seen in full
            outsideViewport: textElements.filter((element) => element.getBoundingClientRect().right > root.clientWidth + 0.5).length,
            h1FontSizePx: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
            bodyTextFontSizePx: parseFloat(getComputedStyle(document.querySelector(".lead")).fontSize),
          };
        });
        const baseline = await layout();

        // (a) Reflow at 320 CSS px, the WCAG 2.2 SC 1.4.10 reference width and the product's CSS min-width.
        await page.setViewportSize({ width: 320, height: project.viewport.height });
        const reflow = await layout();
        check("reflow-320-css-px-no-horizontal-overflow", reflow.scrollWidth <= reflow.clientWidth && reflow.clippedText === 0, { cssViewport: { width: 320, height: project.viewport.height }, ...reflow });

        // (b) 200% page zoom equivalent: half the CSS viewport.
        //     >= 320 CSS px (Mac): must reflow without horizontal scrolling.
        //     <  320 CSS px (iPhone sizes): below the 1.4.10 reference width, so horizontal scrolling is
        //     recorded but not a failure; nothing may be lost: page no wider than 320, every element
        //     reachable by scrolling, no text cut off, the toggle still operable.
        const half = { width: Math.floor(project.viewport.width / 2), height: Math.floor(project.viewport.height / 2) };
        await page.setViewportSize(half);
        const pageZoom = await layout();
        const pageZoomToggle = page.getByRole("button", { name: "確認項目を閉じる" });
        await pageZoomToggle.press("Enter");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "detached", timeout: 5000 });
        await page.getByRole("button", { name: "確認項目を表示" }).press("Enter");
        await page.getByText(EXPANDED_TEXT).waitFor({ state: "visible", timeout: 5000 });
        const horizontalScrollNeeded = pageZoom.scrollWidth > pageZoom.clientWidth;
        const pageZoomPass = half.width >= 320
          ? !horizontalScrollNeeded && pageZoom.clippedText === 0 && pageZoom.outsideViewport === 0
          : pageZoom.scrollWidth <= 320 && pageZoom.maxScrollX >= pageZoom.scrollWidth - pageZoom.clientWidth - 1 && pageZoom.beyondPage === 0 && pageZoom.clippedText === 0;
        check("zoom-200-page-zoom-no-loss-of-content", pageZoomPass, { cssViewport: half, criterion: half.width >= 320 ? "no horizontal scrolling" : "below 320 CSS px: horizontal scrolling allowed, no content or function lost", horizontalScrollNeeded, toggleOperatedByKeyboard: true, ...pageZoom });
        await page.screenshot({ path: join(STAGE, "screenshots", project.group, `${project.name}-zoom200-page.png`) });
        await page.setViewportSize(project.viewport);

        // (c) 200% text-only enlargement at the real viewport (WCAG 2.2 SC 1.4.4): root font size doubled.
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        const textZoom = await layout();
        const textScale = Math.round((textZoom.bodyTextFontSizePx / baseline.bodyTextFontSizePx) * 100) / 100;
        check("zoom-200-text-only-no-loss-of-content", textScale > 1 && textZoom.scrollWidth <= textZoom.clientWidth && textZoom.clippedText === 0 && textZoom.beyondPage === 0, { cssViewport: project.viewport, criterion: "root font size doubled: text grows, no horizontal overflow, no cut-off text (the achieved scale is recorded; clamp() with a vw term limits it on wide viewports)", bodyTextScale: textScale, h1Scale: Math.round((textZoom.h1FontSizePx / baseline.h1FontSizePx) * 100) / 100, ...textZoom });
        await page.screenshot({ path: join(STAGE, "screenshots", project.group, `${project.name}-zoom200-text.png`) });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        zoom = { baseline, reflow320: reflow, pageZoom200: { cssViewport: half, horizontalScrollNeeded, ...pageZoom }, textZoom200: { bodyTextScale: textScale, ...textZoom } };
      } catch (error) {
        check("accessibility-completed", false, { error: String(error.message).split("\n")[0] });
      }

      const errorMessages = consoleMessages.filter((message) => message.type === "error");
      check("no-console-errors", errorMessages.length === 0 && pageErrors.length === 0, { consoleErrors: errorMessages.length, consoleWarnings: consoleMessages.filter((message) => message.type === "warning").length, pageErrors: pageErrors.length, consoleMessages: consoleMessages.length });
      check("no-failed-requests", failedRequests.length === 0, { failedRequests });
      check("no-http-4xx-5xx", badResponses.length === 0, { badResponses });
      check("no-external-requests", externalRequests.length === 0, { externalRequests });
      check("all-requests-local", requests.length > 0 && requests.every((entry) => new URL(entry.url).origin === baseURL), { requests: requests.length });
      const browserVersion = browser.version();
      await context.close();
      await browser.close();
      const endedAt = new Date().toISOString();

      consoleLines.push(`## ${project.name} (${project.browserName} ${browserVersion}, ${project.viewport.width}x${project.viewport.height})`);
      consoleLines.push(`console messages: ${consoleMessages.length} (error: ${errorMessages.length}, warning: ${consoleMessages.filter((message) => message.type === "warning").length}); uncaught page errors: ${pageErrors.length}`);
      for (const message of consoleMessages) consoleLines.push(`[${message.type}] ${message.text}`);
      for (const message of pageErrors) consoleLines.push(`[pageerror] ${message}`);
      consoleLines.push("");
      networkLines.push(`## ${project.name} (${project.browserName} ${browserVersion}, ${project.viewport.width}x${project.viewport.height})`);
      networkLines.push(`responses: ${requests.length}; HTTP>=400: ${badResponses.length}; failed requests: ${failedRequests.length}; external (non ${baseURL}) requests attempted: ${externalRequests.length}`);
      for (const entry of requests) networkLines.push(`${entry.method} ${entry.status} ${entry.resourceType} ${entry.url}`);
      for (const entry of failedRequests) networkLines.push(`FAILED ${entry}`);
      for (const entry of externalRequests) networkLines.push(`EXTERNAL-BLOCKED ${entry}`);
      networkLines.push("");
      accessibility.push({ project: project.name, browserName: project.browserName, browserVersion, viewport: project.viewport, states: { expanded: axeExpanded, collapsed: axeCollapsed }, zoom200: zoom });
      results.push({ project: project.name, browserName: project.browserName, browserVersion, viewport: project.viewport, mobileEmulation: mobile ? { deviceScaleFactor: 2, hasTouch: true, isMobile: true } : null, startedAt, endedAt, tracingStopped: !tracing, passed: checks.filter((item) => item.result === "PASS").length, failed: checks.filter((item) => item.result === "FAIL").length, checks });
      process.stdout.write(`${project.name}: ${checks.filter((item) => item.result === "PASS").length}/${checks.length} checks passed\n`);
      for (const item of checks.filter((entry) => entry.result === "FAIL")) process.stdout.write(`  FAIL ${item.id} ${JSON.stringify(item.observed)}\n`);
    }
  } finally {
    writeFileSync(join(STAGE, "browser-checks.json"), `${JSON.stringify({ baseURL, tool: "Playwright library (reviewer probe, separate from the product E2E suite)", projects: results }, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(STAGE, "accessibility.json"), `${JSON.stringify({ baseURL, engine: "axe-core via @axe-core/playwright", probes: accessibility }, null, 2)}\n`, { flag: "wx" });
    writeFileSync(join(STAGE, "console.log"), `# Browser console, reviewer probe, ${baseURL}\n\n${consoleLines.join("\n")}\n`, { flag: "wx" });
    writeFileSync(join(STAGE, "network.log"), `# Browser network, reviewer probe, ${baseURL}\n# format: METHOD STATUS RESOURCE-TYPE URL\n\n${networkLines.join("\n")}\n`, { flag: "wx" });
    await new Promise((done, fail) => server.httpServer.close((error) => (error ? fail(error) : done())));
  }
  if (results.length !== PROJECTS.length || results.some((entry) => entry.failed > 0)) process.exitCode = 1;
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
