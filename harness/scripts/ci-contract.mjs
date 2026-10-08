import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EVIDENCE_FILE_LIMIT, standardLibraryCheck } from "./ci-evidence-parser.mjs";

export const PROJECTS = [
  { name: "chromium-mac-1440x900", browserName: "chromium", viewport: { width: 1440, height: 900 } },
  { name: "chromium-macbook-1512x982", browserName: "chromium", viewport: { width: 1512, height: 982 } },
  { name: "webkit-iphone-390x844", browserName: "webkit", viewport: { width: 390, height: 844 } },
  { name: "webkit-iphone-393x852", browserName: "webkit", viewport: { width: 393, height: 852 } },
];
export const REQUIRED_SCRIPTS = ["typecheck", "lint", "test:unit", "test:migration", "build", "test:smoke", "test:boundaries"];

export function assertRuntime(nodeVersion, npmVersion, packageJson) {
  if (!/^v?24\./.test(nodeVersion) || npmVersion !== "11.12.1") throw new Error("CI requires Node 24 and npm 11.12.1");
  if (packageJson.engines?.node !== ">=24 <25" || packageJson.packageManager !== "npm@11.12.1") throw new Error("Product runtime contract changed");
  for (const name of REQUIRED_SCRIPTS) if (typeof packageJson.scripts?.[name] !== "string" || !packageJson.scripts[name].trim()) throw new Error(`Missing product script ${name}`);
}

export function assertQualityCommands(productPackage, trustedPackage) {
  for (const name of REQUIRED_SCRIPTS) {
    const command = trustedPackage.scripts?.[name];
    if (typeof command !== "string" || !command.trim() || productPackage.scripts?.[name] !== command) throw new Error(`Quality command ${name} differs from trusted default-branch package; requires a separate governance contract`);
  }
}

export function cleanEnvironment(input = process.env) {
  const result = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH"]) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return { ...result, CI: "true", TZ: "Asia/Tokyo", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", npm_config_audit: "false", npm_config_fund: "false" };
}

export async function nonemptyFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty evidence: ${path}`);
  return readFile(path);
}
export async function readJson(path) { return JSON.parse((await nonemptyFile(path)).toString("utf8")); }

export async function capture(command, args, { cwd, output, label, env = cleanEnvironment(), timeoutMs = 300_000 }) {
  const startedAt = new Date().toISOString();
  const log = await open(join(output, `${label}.log`), "wx");
  let exitCode = 1;
  let timedOut = false;
  let spawnError = null;
  let logError = null;
  let cleanupError = null;
  let pending = Promise.resolve();
  const append = (chunk) => { pending = pending.then(() => log.write(chunk)).catch((error) => { logError ??= error; }); };
  await log.write(`${JSON.stringify({ command, args, cwd, startedAt })}\n`);
  try {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { append(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { append(chunk); process.stderr.write(chunk); });
    const terminate = () => {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Process already stopped. */ }
    };
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true; terminate();
      killTimer = setTimeout(() => { try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already stopped. */ } }, 2000);
    }, timeoutMs);
    exitCode = await new Promise((done) => {
      child.on("error", (error) => { spawnError = error.message; });
      child.on("close", (code) => { clearTimeout(timer); clearTimeout(killTimer); done(code ?? 1); });
    });
    if (process.platform !== "win32") {
      const exists = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
      try {
        if (exists()) {
          process.kill(-child.pid, "SIGTERM");
          const limit = Date.now() + 2000;
          while (exists() && Date.now() < limit) await new Promise((done) => setTimeout(done, 50));
          if (exists()) process.kill(-child.pid, "SIGKILL");
          const killLimit = Date.now() + 2000;
          while (exists() && Date.now() < killLimit) await new Promise((done) => setTimeout(done, 50));
          if (exists()) throw new Error("Child process group survived termination");
        }
      } catch (error) { cleanupError = error.message; }
    }
    await pending;
    const record = { command, args, cwd, startedAt, endedAt: new Date().toISOString(), exitCode, timedOut, spawnError, cleanupError, logError: logError?.message ?? null };
    await log.write(`\n${JSON.stringify(record)}\n`);
    await writeFile(join(output, `${label}.command.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    if (exitCode !== 0 || timedOut || spawnError || cleanupError || logError) { const error = new Error(`Command ${label} failed (exit ${exitCode}${timedOut ? ", timeout" : ""}${cleanupError ? ", process cleanup failure" : ""}${logError ? ", log write failure" : ""})`); error.record = record; throw error; }
    return record;
  } finally { await log.close(); }
}

export async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

export async function acquireWorkspaceLock(productRoot) {
  const common = execFileSync("git", ["-C", productRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const root = await realpath(productRoot);
  const path = join(common, `sns-ci-${createHash("sha256").update(root).digest("hex")}.lock`);
  const file = await open(path, "wx").catch(() => { throw new Error("Workspace busy: install/build/E2E/axe/smoke must be sequential"); });
  await file.writeFile(`${JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() })}\n`);
  return async () => { await file.close(); const { unlink } = await import("node:fs/promises"); await unlink(path); };
}

export async function assertJUnit(path, expectedCount, observationRoot) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) throw new Error("JUnit expected count must be a positive safe integer");
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > EVIDENCE_FILE_LIMIT) throw new Error("JUnit missing/empty or exceeds 20 MiB");
  standardLibraryCheck("junit", await nonemptyFile(path), [expectedCount], { inputPath: path, ...(observationRoot ? { observationRoot } : {}) });
}

async function actualEvidence(mode, path, expected, output) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > EVIDENCE_FILE_LIMIT) throw new Error(`Invalid/oversize ${mode} evidence`);
  return standardLibraryCheck(mode, await nonemptyFile(path), [JSON.stringify(expected)], { inputPath: path, observationRoot: join(output, "parser-observations") });
}

export async function assertUnit(output) {
  const data = await readJson(join(output, "unit.json"));
  const assertions = data.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? [];
  if (data.success !== true || !Number.isInteger(data.numTotalTests) || data.numTotalTests <= 0 || data.numPassedTests !== data.numTotalTests || data.numPendingTests !== 0 || data.numFailedTests !== 0 || (data.numTodoTests ?? 0) !== 0 || assertions.length !== data.numTotalTests || assertions.some((test) => test.status !== "passed")) throw new Error("Unit evidence has zero, missing, failing or skipped tests");
  const history = await readJson(join(output, "unit-history.json"));
  const identities = data.testResults.flatMap((suite) => suite.assertionResults.map((item) => JSON.stringify([suite.name, item.ancestorTitles, item.title]))).sort();
  if (history.reason !== "passed" || history.unhandledErrors !== 0 || !Array.isArray(history.tests) || history.tests.length !== data.numTotalTests || history.tests.some((item) => !item.id || item.status !== "passed" || item.retryCount !== 0 || item.repeatCount !== 0 || item.flaky !== false || item.errors !== 0) || new Set(history.tests.map((item) => item.id)).size !== history.tests.length || JSON.stringify(history.tests.map((item) => JSON.stringify([item.file, item.ancestors, item.title])).sort()) !== JSON.stringify(identities)) throw new Error("Unit missing/mismatched history or failure/retry/repeat");
  await assertJUnit(join(output, "unit.xml"), data.numTotalTests, join(output, "parser-observations"));
  return data.numTotalTests;
}

function allSpecs(suites = []) { return suites.flatMap((suite) => [...(suite.specs ?? []), ...allSpecs(suite.suites)]); }
export async function assertPlaywright(output, expectedProjects) {
  const data = await readJson(join(output, "playwright.json"));
  const specs = allSpecs(data.suites);
  const tests = specs.flatMap((spec) => (spec.tests ?? []).map((test) => ({ ...test, specId: spec.id, title: spec.title, file: spec.file, line: spec.line, column: spec.column })));
  const actualProjects = data.config?.projects?.map((project) => project.name).sort();
  if (JSON.stringify(actualProjects) !== JSON.stringify(expectedProjects.map((project) => project.name).sort()) || !Array.isArray(data.errors) || data.errors.length || tests.length === 0) throw new Error("Playwright missing projects/tests or has global errors");
  if (data.config.workers !== 1 || data.config.projects.some((project) => project.retries !== 0 || project.repeatEach !== 1)) throw new Error("Playwright workers/retries/repeat contract changed");
  for (const test of tests) {
    if (test.status !== "expected" || test.expectedStatus !== "passed" || test.results?.length !== 1 || test.results[0].status !== "passed" || test.results[0].retry !== 0 || !Array.isArray(test.results[0].errors) || test.results[0].errors.length || !Number.isFinite(test.results[0].duration) || test.results[0].duration < 0 || typeof test.results[0].startTime !== "string" || !test.results[0].startTime || !Number.isInteger(test.results[0].workerIndex) || test.results[0].workerIndex < 0) throw new Error("Playwright failure, skip, flaky, retry or missing result identity");
    const trace = test.results[0].attachments?.find((attachment) => attachment.name === "trace");
    if (!trace?.path || !isAbsolute(trace.path) || relative(join(output, "test-results"), trace.path).startsWith("..")) throw new Error("Missing real trace attachment");
    const realTrace = await realpath(trace.path);
    const realTraceRoot = await realpath(join(output, "test-results"));
    if (relative(realTraceRoot, realTrace).startsWith("..") || relative(realTraceRoot, realTrace) !== relative(join(output, "test-results"), trace.path)) throw new Error("External or symlink trace forbidden");
    await actualEvidence("trace", trace.path, expectedProjects.find((project) => project.name === test.projectName), output);
  }
  const viewport = await readJson(join(output, "viewports.json"));
  if (viewport.status !== "passed" || viewport.tests?.length !== tests.length || viewport.tests.some((test) => !expectedProjects.some((project) => project.name === test.project))) throw new Error("Missing viewport execution evidence");
  for (const expected of expectedProjects) {
    const entries = viewport.tests.filter((test) => test.project === expected.name);
    if (!entries.length || entries.some((test) => JSON.stringify(test.viewport) !== JSON.stringify(expected.viewport) || test.browserName !== expected.browserName || test.retry !== 0 || test.status !== "passed")) throw new Error(`Missing/changed viewport ${expected.name}`);
  }
  const identities = new Set();
  for (const test of tests) {
    const identity = `${test.file}:${test.line}:${test.column}:${test.projectName}`;
    if (!test.specId || !test.file || !Number.isInteger(test.line) || !Number.isInteger(test.column) || !expectedProjects.some((project) => project.name === test.projectName) || identities.has(identity)) throw new Error("Missing, duplicate or unselected test identity");
    identities.add(identity);
    const matches = viewport.tests.filter((entry) => entry.testId && entry.project === test.projectName && entry.title === test.title && entry.location?.file === test.file && entry.location.line === test.line && entry.location.column === test.column);
    if (matches.length !== 1) throw new Error("Test/viewport identity mismatch");
  }
  await assertJUnit(join(output, "test-results.xml"), tests.length, join(output, "parser-observations"));
  await actualEvidence("html", join(output, "playwright-report", "index.html"), tests.map((test) => ({ testId: test.specId, title: test.title, projectName: test.projectName, location: { file: test.file, line: test.line, column: test.column }, result: Object.fromEntries(["status", "retry", "errors", "duration", "startTime", "workerIndex"].map((key) => [key, test.results[0][key]])) })), output);
  return tests.length;
}

export async function assertAxe(output) {
  const data = await readJson(join(output, "accessibility.json"));
  if (data.probes?.length !== PROJECTS.length) throw new Error("Missing axe viewports");
  for (const expected of PROJECTS) {
    const probe = data.probes.find((item) => item.project === expected.name);
    if (!probe || JSON.stringify(probe.viewport) !== JSON.stringify(expected.viewport) || probe.browserName !== expected.browserName || probe.httpStatus !== 200 || !Array.isArray(probe.errors) || probe.errors.length || !probe.network?.length || !probe.axe?.testEngine?.version || !Array.isArray(probe.axe.violations) || !probe.axe.passes?.length || !probe.axe.timestamp || probe.axe.violations.some((item) => ["critical", "serious"].includes(item.impact))) throw new Error(`Axe missing/invalid or serious violations: ${expected.name}`);
    const scale = expected.browserName === "webkit" ? 2 : 1;
    await actualEvidence("png", join(output, `${expected.name}.png`), { width: expected.viewport.width * scale, height: expected.viewport.height * scale }, output);
    await actualEvidence("trace", join(output, `${expected.name}.trace.zip`), expected, output);
  }
  return data.probes.length;
}

export async function evidenceManifest(output, fixedSha, resultBytes) {
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("Evidence symlinks forbidden");
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        const bytes = await nonemptyFile(path);
        files.push({ path: path.slice(output.length + 1), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await walk(output);
  if (files.some((file) => ["result.json", "manifest.json"].includes(file.path))) throw new Error("Reserved final evidence path already exists");
  if (resultBytes !== undefined) {
    if (typeof resultBytes !== "string" || !resultBytes.length) throw new Error("Final result must be nonempty serialized bytes");
    files.push({ path: "result.json", bytes: Buffer.byteLength(resultBytes), sha256: createHash("sha256").update(resultBytes).digest("hex") });
  }
  const manifest = { fixedSha, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  // Count the actual serialized result and manifest, not a fixed metadata reserve.
  // The manifest cannot hash itself, but its own file and UTF-8 bytes are included.
  const manifestBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
  if (files.length + 1 > 500 || files.reduce((sum, file) => sum + file.bytes, manifestBytes) > 20 * 1024 * 1024) throw new Error("Evidence exceeds 20 MiB / 500-file public attestation limit including final result and manifest");
  return manifest;
}

export function parseArgs(argv) {
  const allowed = new Set(["product-root", "output", "gate", "fixed-sha"]);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith("--") || !allowed.has(key) || !argv[i + 1] || args[key]) throw new Error("Unknown, duplicate or missing CI argument");
    args[key] = argv[i + 1];
  }
  if (!args["product-root"] || !args.output || !/^[a-f0-9]{40}$/.test(args["fixed-sha"] ?? "") || !["install", "browsers", "static", "unit", "e2e-chromium", "e2e-webkit-mobile", "accessibility", "smoke"].includes(args.gate)) throw new Error("Invalid CI contract arguments");
  return { productRoot: resolve(args["product-root"]), output: resolve(args.output), gate: args.gate, fixedSha: args["fixed-sha"] };
}
