import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parserRuntime } from "./ci-evidence-parser.mjs";
import { acquireWorkspaceLock, assertAxe, assertPlaywright, assertQualityCommands, assertRuntime, assertUnit, availablePort, capture, cleanEnvironment, evidenceManifest, parseArgs, PROJECTS } from "./ci-contract.mjs";

const { productRoot, output, gate, fixedSha } = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false }); // Never overwrite or retry into prior evidence.
const env = cleanEnvironment();
const trustedRunner = fileURLToPath(import.meta.url);
const environment = { gate, fixedSha, startedAt, node: process.version, npm: null, actualSha: null, platform: process.platform, arch: process.arch, trustedRunner, runnerSha256: createHash("sha256").update(await readFile(trustedRunner)).digest("hex"), configuredProjects: PROJECTS, limitations: "LOCAL CI contract probe; not real CI/Linux, physical Safari, Repository Gate or product PASS" };
environment.trustedRunnerCommitSha = execFileSync("git", ["-C", fileURLToPath(new URL("../..", import.meta.url)), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
environment.trustedFiles = [];
for (const path of ["ci-contract.mjs", "ci-evidence-parser.mjs", "ci-parser-observation.mjs", "ci-unit-reporter.mjs", "ci-quality.mjs", "ci-playwright.config.mjs", "ci-viewport-reporter.mjs", "ci-axe-probe.mjs", "../../package.json"]) environment.trustedFiles.push({ path, sha256: createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex") });
let release;
let failure;
const commands = [];
async function run(command, args, label, extraEnv = {}) {
  try { commands.push(await capture(command, args, { cwd: productRoot, output, label, env: { ...env, ...extraEnv } })); }
  catch (error) { if (error.record) commands.push(error.record); throw error; }
}
try {
  environment.parserRuntime = parserRuntime({ observationRoot: join(output, "parser-observations") });
  environment.actualSha = execFileSync("git", ["-C", productRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (environment.actualSha !== fixedSha) throw new Error("Product HEAD must equal fixed SHA");
  const packageJson = JSON.parse(await readFile(join(productRoot, "package.json"), "utf8"));
  environment.npm = execFileSync("npm", ["--version"], { encoding: "utf8", env }).trim();
  assertRuntime(process.version, environment.npm, packageJson);
  const trustedPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assertQualityCommands(packageJson, trustedPackage);
  if (execFileSync("git", ["-C", productRoot, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("Product tracked checkout must be clean");
  release = await acquireWorkspaceLock(productRoot);
  if (gate === "install") await run("npm", ["ci"], "npm-ci");
  else if (gate === "browsers") await run(process.execPath, [join(productRoot, "node_modules", "@playwright", "test", "cli.js"), "install", ...(process.platform === "linux" ? ["--with-deps"] : []), "chromium", "webkit"], "browser-install");
  else if (gate === "static") for (const script of ["test:boundaries", "typecheck", "lint", "test:migration", "build"]) await run("npm", ["run", script], script.replaceAll(":", "-"));
  else if (gate === "unit") {
    await run("npm", ["run", "test:unit", "--", "--retry=0", "--reporter=json", "--reporter=junit", `--reporter=${fileURLToPath(new URL("./ci-unit-reporter.mjs", import.meta.url))}`, `--outputFile.json=${join(output, "unit.json")}`, `--outputFile.junit=${join(output, "unit.xml")}`], "unit", { SNS_CI_OUTPUT: output });
    await assertUnit(output);
  } else if (gate.startsWith("e2e-")) {
    await run("npm", ["run", "build"], "build");
    const expected = PROJECTS.filter((project) => project.browserName === (gate === "e2e-chromium" ? "chromium" : "webkit"));
    const cli = join(productRoot, "node_modules", "@playwright", "test", "cli.js");
    await run(process.execPath, [cli, "test", "--config", fileURLToPath(new URL("./ci-playwright.config.mjs", import.meta.url)), ...expected.map((project) => `--project=${project.name}`), "--workers=1", "--retries=0", "--forbid-only", "--trace=on", `--output=${join(output, "test-results")}`], "playwright", { SNS_CI_PRODUCT_ROOT: productRoot, SNS_CI_OUTPUT: output, SNS_CI_BROWSER: expected[0].browserName, SNS_E2E_PORT: String(await availablePort()) });
    await assertPlaywright(output, expected);
  } else if (gate === "accessibility") {
    await run("npm", ["run", "build"], "build");
    await run(process.execPath, [fileURLToPath(new URL("./ci-axe-probe.mjs", import.meta.url))], "axe", { SNS_CI_PRODUCT_ROOT: productRoot, SNS_CI_OUTPUT: output });
    await assertAxe(output);
  } else if (gate === "smoke") {
    await run("npm", ["run", "test:boundaries"], "boundaries");
    await run("npm", ["run", "test:smoke"], "smoke");
    if (!(await readFile(join(output, "smoke.log"), "utf8")).includes("Smoke test passed: HTTP 200, text/html")) throw new Error("Missing real smoke HTTP 200 result");
  }
  if (execFileSync("git", ["-C", productRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== fixedSha || execFileSync("git", ["-C", productRoot, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("Product fixed SHA/clean tracked tree changed during gate");
} catch (error) { failure = error; }
finally {
  // A surviving process group must not allow another build to reuse this workspace.
  if (release && !commands.some((record) => record.cleanupError)) try { await release(); } catch (error) { failure ??= error; }
  try { await writeFile(join(output, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { failure ??= error; }
  const serializeResult = () => `${JSON.stringify({ gate, fixedSha, startedAt, endedAt: new Date().toISOString(), status: failure ? "FAIL" : "SELF_CHECK_OK", failure: failure?.message ?? null, parserFailure: failure?.observation ?? null, commands }, null, 2)}\n`;
  let staging;
  let committed = false;
  try {
    const resultBytes = serializeResult();
    const manifest = await evidenceManifest(output, fixedSha, resultBytes);
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    // Stage complete bytes on this filesystem, outside the intended upload set.
    // Exclusive links cannot overwrite a colliding original. Publish result last:
    // interruption or a manifest save failure cannot emit this successful result.
    staging = await mkdtemp(join(dirname(output), ".sns-ci-final-"));
    await writeFile(join(staging, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "result.json"), resultBytes, { flag: "wx", mode: 0o600 });
    await link(join(staging, "manifest.json"), join(output, "manifest.json"));
    await link(join(staging, "result.json"), join(output, "result.json"));
    committed = true;
  } catch (error) {
    failure ??= error;
    try { await writeFile(join(output, "result.json"), serializeResult(), { flag: "wx" }); }
    catch (saveError) {
      const fallback = { gate, fixedSha, startedAt, endedAt: new Date().toISOString(), status: "FAIL", finalizationFailed: true, publicAttestationEligible: false, failure: "Final evidence could not be saved; colliding originals and private raw are retained, not a qualified upload", saveError: { name: saveError.name, code: saveError.code ?? null } };
      try { await writeFile(join(output, `finalization-failure-${randomUUID()}.json`), `${JSON.stringify(fallback, null, 2)}\n`, { flag: "wx" }); }
      catch { process.stderr.write("Final failure record could not be saved; gate remains nonzero\n"); }
    }
  } finally {
    if (staging) {
      for (const name of ["manifest.json", "result.json"]) try { await unlink(join(staging, name)); } catch (error) { if (error.code !== "ENOENT") failure ??= error; }
      try { await rmdir(staging); } catch (error) { failure ??= error; }
      // Cleanup after complete publication is distinct from a metadata save failure.
      // It still prevents gate success; immutable committed bytes are not rewritten.
      if (committed && failure) process.stderr.write("Evidence publication completed, but gate/cleanup failure remains; no qualification\n");
    }
  }
}
if (failure) { process.stderr.write(`${failure.stack}\n`); process.exitCode = 1; }
