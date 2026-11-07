import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { evidenceManifest } from "../scripts/ci-contract.mjs";

const projectRoot = new URL("../..", import.meta.url).pathname;
const workflow = await readFile(join(projectRoot, ".github/workflows/quality-gates.yml"), "utf8");
const budgetSource = await readFile(join(projectRoot, "harness/scripts/ci-upload-budget.mjs"), "utf8");
const budgetStart = workflow.indexOf("      - name: Check combined upload size without truncating evidence\n");
const uploadStart = workflow.indexOf("      - name: Upload bounded real evidence including failures\n", budgetStart);
assert.ok(budgetStart >= 0 && uploadStart > budgetStart, "Real budget/upload steps must exist");
const budgetStep = workflow.slice(budgetStart, uploadStart);
const uploadStep = workflow.slice(uploadStart);
const runMatch = budgetStep.match(/        run: \|\n([\s\S]+)$/);
assert.ok(runMatch, "Actual budget must use a literal shell block for fail-closed preflight");
const budgetRun = runMatch[1].split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
const guardMatch = budgetRun.match(/<<'SNS_CI_PACKAGING_GUARD'\n([\s\S]+?)\nSNS_CI_PACKAGING_GUARD\n/);
assert.ok(guardMatch, "Tests execute the real workflow's inline source, not a substitute validator");
const guard = guardMatch[1];
const guardSha256 = createHash("sha256").update(guard).digest("hex");
const pathMatch = uploadStep.match(/          path: \|\n([\s\S]+?)          if-no-files-found:/);
assert.ok(pathMatch);
const pathTemplates = pathMatch[1].trim().split("\n").map(line => line.trim().replace(/\/$/, ""));
const gates = ["static", "unit", "e2e-chromium", "e2e-webkit-mobile", "accessibility"];
const cap = 20 * 1024 * 1024;
const refusal = "CI upload evidence packaging refused.\n";
const fixedSha = "a".repeat(40);
const canonical = (status = "passed", failedTests = []) => JSON.stringify({ status, failedTests }, undefined, 2);
const testId = (index) => `${index.toString(16).padStart(20, "0")}-${(index + 1).toString(16).padStart(20, "0")}`;
const rootInputs = (gate) => pathTemplates.map(path => path.replaceAll("${{ matrix.gate }}", gate));
const cases = [];
function check(id, name, execute) { cases.push({ id, name, execute }); }
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function fixture(gate = "e2e-chromium", { roots = true, raw = true, metadata = false, temporaryBase = tmpdir() } = {}) {
  const cwd = await mkdtemp(join(temporaryBase, "sns-ci-packaging-"));
  const inputs = rootInputs(gate);
  const paths = inputs.map(path => join(cwd, path));
  if (roots) for (const path of paths) await mkdir(path, { recursive: true });
  if (roots && raw) await put(join(paths[2], "raw.log"), "synthetic first-attempt evidence\n");
  if (metadata) await put(join(paths[2], "test-results/.last-run.json"), canonical());
  await put(join(cwd, "trusted/harness/scripts/ci-upload-budget.mjs"), budgetSource);
  return { cwd, gate, inputs, paths };
}
const runGuard = (f, gate = f.gate, inputs = f.inputs) => spawnSync(process.execPath, ["--input-type=module", "-", gate, ...inputs], { cwd: f.cwd, input: guard, encoding: "utf8", timeout: 10_000 });
const runBudget = (f) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", budgetRun.replaceAll("${{ matrix.gate }}", f.gate)], { cwd: f.cwd, encoding: "utf8", timeout: 10_000 });
function report(t, id, fixtureKind, expected, result) {
  t.diagnostic(JSON.stringify({ caseId: id, fixture: fixtureKind, workflowGuardSha256: guardSha256, expected, actual: { exitCode: result.status, signal: result.signal, error: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr } }));
}
function guarded(t, id, f, expected, result = runGuard(f), kind = id) {
  report(t, id, kind, { exitCode: expected, rejectionLog: expected ? "fixed generic text only" : null }, result);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, expected ? refusal : "");
  return result;
}
async function inventory(root, prefix = "") {
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), item = prefix ? prefix + "/" + name : name, info = await lstat(path);
    if (info.isDirectory()) entries.push(...await inventory(path, item));
    else if (info.isFile()) {
      const bytes = await readFile(path);
      entries.push({ path: item, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else entries.push({ path: item, type: info.isSymbolicLink() ? "symlink" : "special" });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function modelFiles(f, includeHidden) {
  // A bounded LOCAL model of pinned upload-artifact's documented dot-name
  // selection and three paths' least common ancestor; never a live upload.
  const result = [];
  for (const path of f.paths) {
    if (!(await stat(path).catch(() => null))) continue;
    for (const item of await inventory(path)) {
      const artifactPath = relative(join(f.cwd, "artifacts/ci"), path).replaceAll("\\", "/") + "/" + item.path;
      if (!includeHidden && artifactPath.split("/").some(part => part.startsWith("."))) continue;
      result.push({ ...item, path: artifactPath });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function sameOriginals(expected, actual) {
  assert.deepEqual(actual, expected, "Packaging must retain every exact path, byte count and SHA-256; no missing/extra/tampered original");
}
async function manifestFixture() {
  const f = await fixture("e2e-chromium", { raw: false });
  for (const [index, path] of f.paths.entries()) {
    await put(join(path, "raw.log"), "synthetic immutable raw stage " + index + "\n");
    if (index === 2) await put(join(path, "test-results/.last-run.json"), canonical());
    const serializedResult = JSON.stringify({ status: "SELF_CHECK_OK", fixedSha }, null, 2) + "\n";
    const manifest = await evidenceManifest(path, fixedSha, serializedResult);
    await put(join(path, "result.json"), serializedResult);
    await put(join(path, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  return f;
}
async function manifestOriginals(f) {
  const records = [];
  for (const path of f.paths) {
    const manifestPath = join(path, "manifest.json"), bytes = await readFile(manifestPath), manifest = JSON.parse(bytes.toString("utf8"));
    assert.equal(manifest.fixedSha, fixedSha);
    const prefix = relative(join(f.cwd, "artifacts/ci"), path).replaceAll("\\", "/");
    for (const item of manifest.files) records.push({ ...item, path: prefix + "/" + item.path });
    records.push({ path: prefix + "/manifest.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

check("PACK-005-contract", "real workflow keeps paths, budget/upload gating, pins, runtime and free-operation bounds", async (t, id) => {
  assert.deepEqual(pathTemplates, ["artifacts/ci/install-${{ matrix.gate }}", "artifacts/ci/browsers-${{ matrix.gate }}", "artifacts/ci/${{ matrix.gate }}"]);
  assert.match(workflow, /gate: \[static, unit, e2e-chromium, e2e-webkit-mobile, accessibility\]/);
  assert.match(budgetStep, /        id: budget\n        if: \$\{\{ always\(\) \}\}\n/);
  assert.match(uploadStep, /if: \$\{\{ always\(\) && steps\.budget\.outcome == 'success' \}\}/);
  assert.match(uploadStep, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(uploadStep, /          include-hidden-files: true\n/);
  assert.match(uploadStep, /          retention-days: 1\n/);
  assert.match(uploadStep, /          if-no-files-found: error\n/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /node-version: 24\.15\.0/);
  assert.match(workflow, /python-version: 3\.12\.14/);
  assert.ok(budgetRun.indexOf("SNS_CI_PACKAGING_GUARD\n") < budgetRun.indexOf("node trusted/harness/scripts/ci-upload-budget.mjs"));
  assert.equal(gates.length * cap, 100 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ caseId: id, actual: { paths: pathTemplates, guardSha256, perJobBytes: cap, perJobFiles: 500, maximumFiveJobBytes: 100 * 1024 * 1024, retentionDays: 1, packagingModel: "LOCAL-only, not GitHub ZIP proof" } }));
});

for (const gate of gates) check(`PACK-001-${gate}`, `real ${gate} three-root selection accepts nonhidden original evidence`, async (t, id) => {
  const f = await fixture(gate);
  guarded(t, id, f, 0);
  const result = runBudget(f);
  report(t, id, "nonempty regular evidence", { exitCode: 0, realBudgetExecuted: true }, result);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Upload evidence budget checked: 1 files/);
});
for (const [kind, modify] of [
  ["unknown-gate", f => ["unregistered-gate", f.inputs]],
  ["absolute-root", f => [f.gate, [join(f.cwd, f.inputs[0]), ...f.inputs.slice(1)]]],
  ["parent-root", f => [f.gate, ["artifacts/ci", ...f.inputs.slice(1)]]],
  ["workspace-root", f => [f.gate, [".", ...f.inputs.slice(1)]]],
  ["other-gate-root", f => [f.gate, [f.inputs[0], f.inputs[1], "artifacts/ci/unit"]]],
  ["additional-root", f => [f.gate, [...f.inputs, "other"]]],
  ["missing-root-argument", f => [f.gate, f.inputs.slice(1)]],
  ["reordered-roots", f => [f.gate, [...f.inputs].reverse()]],
]) check(`PACK-001-reject-${kind}`, `actual inline guard rejects ${kind} without echoing arguments`, async (t, id) => {
  const f = await fixture(), [gate, inputs] = modify(f);
  guarded(t, id, f, 1, runGuard(f, gate, inputs), kind);
});

for (const gate of ["e2e-chromium", "e2e-webkit-mobile"]) for (const status of ["passed", "failed", "timedout", "interrupted"]) {
  check(`PACK-003-${gate}-${status}`, `actual inline guard retains canonical ${gate} ${status} metadata without declaring quality PASS`, async (t, id) => {
    const f = await fixture(gate), path = join(f.paths[2], "test-results/.last-run.json"), bytes = canonical(status, status === "passed" ? [] : [testId(1)]);
    await put(path, bytes);
    guarded(t, id, f, 0);
    assert.equal(await readFile(path, "utf8"), bytes);
    const result = runBudget(f);
    report(t, id, "canonical metadata + raw", { exitCode: 0, qualityVerdict: "not issued" }, result);
    assert.equal(result.status, 0);
  });
}
check("PACK-003-id-boundary-500", "canonical metadata accepts exactly 500 unique locked-Playwright shaped IDs", async (t, id) => {
  const f = await fixture();
  await put(join(f.paths[2], "test-results/.last-run.json"), canonical("failed", Array.from({ length: 500 }, (_, index) => testId(index))));
  guarded(t, id, f, 0);
});
const malformedMetadata = [
  ["empty", Buffer.alloc(0)],
  ["oversize", Buffer.alloc(64 * 1024 + 1, 32)],
  ["malformed-json", '{"status":'],
  ["array-json", "[]"],
  ["unsupported-status", canonical("private-canary")],
  ["unknown-key", JSON.stringify({ status: "passed", failedTests: [], note: "private-canary" }, null, 2)],
  ["missing-status", JSON.stringify({ failedTests: [] }, null, 2)],
  ["missing-failedTests", JSON.stringify({ status: "passed" }, null, 2)],
  ["not-array", JSON.stringify({ status: "failed", failedTests: "private-canary" }, null, 2)],
  ["non-string-id", canonical("failed", [1])],
  ["uppercase-id", canonical("failed", ["A".repeat(20) + "-" + "b".repeat(20)])],
  ["short-id", canonical("failed", ["abc-def"])],
  ["url-id", canonical("failed", ["https://example.invalid/private-canary"])],
  ["sentence-id", canonical("failed", ["synthetic private-canary sentence"])],
  ["duplicate-id", canonical("failed", [testId(1), testId(1)])],
  ["too-many-ids", canonical("failed", Array.from({ length: 501 }, (_, index) => testId(index)))],
  ["duplicate-status-key", '{\n  "status": "private-canary",\n  "status": "passed",\n  "failedTests": []\n}'],
  ["duplicate-failedTests-key", '{\n  "status": "passed",\n  "failedTests": ["private-canary"],\n  "failedTests": []\n}'],
  ["reordered-keys", JSON.stringify({ failedTests: [], status: "passed" }, null, 2)],
  ["compact-json", JSON.stringify({ status: "passed", failedTests: [] })],
  ["trailing-newline", canonical() + "\n"],
  ["trailing-whitespace", canonical() + " "],
  ["trailing-garbage", canonical() + "private-canary"],
  ["malformed-utf8", Buffer.concat([Buffer.from(canonical()), Buffer.from([0xc0, 0xaf])])],
  ["utf8-bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical())])],
];
for (const [kind, bytes] of malformedMetadata) check(`PACK-003-reject-${kind}`, `actual inline guard rejects ${kind} metadata and preserves every original`, async (t, id) => {
  const f = await fixture();
  await put(join(f.paths[2], "test-results/.last-run.json"), bytes);
  const before = await inventory(join(f.cwd, "artifacts"));
  guarded(t, id, f, 1, runGuard(f), kind);
  sameOriginals(before, await inventory(join(f.cwd, "artifacts")));
});

for (const [kind, gate, index, path, isDirectory = false] of [
  ["inside-env", "e2e-chromium", 2, ".env"],
  ["unknown-hidden", "e2e-chromium", 2, ".private-canary"],
  ["hidden-directory", "e2e-chromium", 2, ".cache/raw.log"],
  ["nested-hidden-directory", "e2e-chromium", 2, "nested/.private-canary/raw.log"],
  ["root-last-run", "e2e-chromium", 2, ".last-run.json"],
  ["nested-last-run", "e2e-chromium", 2, "nested/test-results/.last-run.json"],
  ["install-last-run", "e2e-chromium", 0, "test-results/.last-run.json"],
  ["browsers-last-run", "e2e-chromium", 1, "test-results/.last-run.json"],
  ["unit-last-run", "unit", 2, "test-results/.last-run.json"],
  ["static-last-run", "static", 2, "test-results/.last-run.json"],
  ["accessibility-last-run", "accessibility", 2, "test-results/.last-run.json"],
  ["directory-last-run", "e2e-chromium", 2, "test-results/.last-run.json", true],
]) check(`PACK-002-reject-${kind}`, `actual inline guard rejects ${kind} hidden entry with generic non-echoed error`, async (t, id) => {
  const f = await fixture(gate), target = join(f.paths[index], path);
  if (isDirectory) await mkdir(target, { recursive: true }); else await put(target, path.endsWith(".last-run.json") ? canonical() : "synthetic private-canary\n");
  const before = await inventory(join(f.cwd, "artifacts"));
  guarded(t, id, f, 1, runGuard(f), kind);
  const combined = runBudget(f);
  report(t, id, kind, { exitCode: 1, budgetNotExecuted: true, uploadAllowed: false }, combined);
  assert.equal(combined.status, 1);
  assert.equal(combined.stderr, refusal);
  assert.equal(combined.stdout, "");
  sameOriginals(before, await inventory(join(f.cwd, "artifacts")));
});

for (const kind of ["artifacts-ancestor", "ci-ancestor", "selected-root", "internal-file", "internal-directory", "dangling-entry", "last-run-file"]) {
  check(`PACK-001-reject-symlink-${kind}`, `actual inline guard refuses ${kind} symlink without following or changing originals`, async (t, id) => {
    const f = await fixture();
    if (kind.endsWith("ancestor") || kind === "selected-root") {
      const target = kind === "artifacts-ancestor" ? join(f.cwd, "artifacts") : kind === "ci-ancestor" ? join(f.cwd, "artifacts/ci") : f.paths[2];
      const moved = join(f.cwd, "synthetic-original-" + kind);
      await rename(target, moved);
      await symlink(moved, target);
    } else {
      const target = kind === "last-run-file" ? join(f.paths[2], "test-results/.last-run.json") : join(f.paths[2], "linked-original");
      await mkdir(dirname(target), { recursive: true });
      const original = join(f.cwd, "synthetic-outside-original");
      if (kind === "internal-directory") { await mkdir(original); await put(join(original, "raw.log"), "synthetic private-canary"); }
      else if (kind !== "dangling-entry") await put(original, kind === "last-run-file" ? canonical() : "synthetic private-canary");
      await symlink(original, target);
    }
    const before = await inventory(f.cwd);
    guarded(t, id, f, 1, runGuard(f), kind);
    sameOriginals(before, await inventory(f.cwd));
  });
}
check("PACK-001-reject-fifo", "actual inline guard rejects a FIFO without opening it", async (t, id) => {
  const f = await fixture();
  execFileSync("mkfifo", [join(f.paths[2], "synthetic-pipe")]);
  guarded(t, id, f, 1);
});
check("PACK-001-reject-socket", "actual inline guard rejects a Unix-domain socket without opening it", async (t, id) => {
  const f = await fixture("e2e-chromium", { temporaryBase: "/tmp" }), server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(join(f.paths[2], "synthetic-socket"), done); });
  try { guarded(t, id, f, 1); }
  finally { await new Promise((done, fail) => server.close(error => error ? fail(error) : done())); }
});

check("PACK-004-pre-e2e-failure", "early E2E failure without last-run metadata preserves available failure originals, not a quality verdict", async (t, id) => {
  const f = await fixture();
  await put(join(f.paths[2], "failure.json"), JSON.stringify({ status: "FAIL", reason: "synthetic failure before Playwright begins" }));
  const before = await inventory(join(f.cwd, "artifacts"));
  const result = runBudget(f);
  report(t, id, "failure before metadata exists", { exitCode: 0, qualityVerdict: "not issued", absentMetadataNotFabricated: true }, result);
  assert.equal(result.status, 0);
  await assert.rejects(stat(join(f.paths[2], "test-results/.last-run.json")), { code: "ENOENT" });
  sameOriginals(before, await inventory(join(f.cwd, "artifacts")));
});
check("PACK-007-no-roots", "absent output roots remain rejected by the unchanged real nonempty budget", async (t, id) => {
  const f = await fixture("unit", { roots: false }), result = runBudget(f);
  report(t, id, "no output exists", { exitCode: 1, uploadAllowed: false }, result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Upload refused: 0 files \/ 0 bytes/);
});
check("PACK-007-empty-original", "empty normal original remains rejected and is not deleted", async (t, id) => {
  const f = await fixture("unit", { raw: false }), path = join(f.paths[2], "empty.log");
  await put(path, Buffer.alloc(0));
  const result = runBudget(f);
  report(t, id, "zero-byte original", { exitCode: 1, uploadAllowed: false }, result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Upload evidence is empty/);
  assert.equal((await stat(path)).size, 0);
});

for (const count of [500, 501]) check(`PACK-007-files-${count}`, `unchanged real budget ${count === 500 ? "accepts" : "rejects"} ${count} combined original files`, async (t, id) => {
  const f = await fixture("unit", { raw: false });
  for (let index = 0; index < count; index += 1) await put(join(f.paths[index % 3], "raw-" + index + ".log"), "x");
  const before = await inventory(join(f.cwd, "artifacts")), result = runBudget(f);
  report(t, id, `${count} files spread over all three outputs`, { exitCode: count === 500 ? 0 : 1, originalCount: count }, result);
  assert.equal(result.status, count === 500 ? 0 : 1);
  assert.match(result.stdout + result.stderr, new RegExp(count + " files"));
  sameOriginals(before, await inventory(join(f.cwd, "artifacts")));
});
for (const bytes of [cap, cap + 1]) check(`PACK-007-bytes-${bytes}`, `unchanged real budget ${bytes === cap ? "accepts exactly 20 MiB" : "rejects one extra precompression byte"}`, async (t, id) => {
  const f = await fixture("unit", { raw: false }), path = join(f.paths[2], "large.log");
  await put(path, Buffer.alloc(bytes, 120));
  const result = runBudget(f);
  report(t, id, "compressible real bytes still use uncompressed cap", { exitCode: bytes === cap ? 0 : 1, originalBytes: bytes }, result);
  assert.equal(result.status, bytes === cap ? 0 : 1);
  assert.equal((await stat(path)).size, bytes);
  assert.match(result.stdout + result.stderr, new RegExp(bytes + " bytes"));
});
check("PACK-007-combined-bytes", "three individually small stages remain rejected when combined exceeds 20 MiB", async (t, id) => {
  const f = await fixture("unit", { raw: false });
  for (const path of f.paths) await put(join(path, "raw.log"), Buffer.alloc(8 * 1024 * 1024, 120));
  const result = runBudget(f);
  report(t, id, "three 8 MiB roots", { exitCode: 1, combinedBytes: 24 * 1024 * 1024 }, result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Upload refused: 3 files \/ 25165824 bytes/);
  for (const path of f.paths) assert.equal((await stat(join(path, "raw.log"))).size, 8 * 1024 * 1024);
});

check("PACK-005-old-false-counterexample", "pinned Action's old default-false model omits last-run and fails original-manifest comparison", async (t, id) => {
  const f = await manifestFixture(), expected = await manifestOriginals(f), selected = await modelFiles(f, false);
  assert.equal(expected.length - selected.length, 1);
  assert.ok(expected.some(item => item.path.endsWith("test-results/.last-run.json")));
  assert.ok(!selected.some(item => item.path.endsWith("test-results/.last-run.json")));
  assert.throws(() => sameOriginals(expected, selected));
  t.diagnostic(JSON.stringify({ caseId: id, expected: "old-default selection is incomplete", actual: { expectedFiles: expected.length, selectedFiles: selected.length, missing: ["e2e-chromium/test-results/.last-run.json"], comparisonRejected: true }, model: "fixed Action documented rules, LOCAL only" }));
});
check("PACK-005-true-without-guard-counterexample", "true alone would include an internal env original; actual workflow rejects it before upload", async (t, id) => {
  const f = await fixture();
  await put(join(f.paths[2], ".env"), "synthetic private-canary\n");
  const selected = await modelFiles(f, true);
  assert.ok(selected.some(item => item.path === "e2e-chromium/.env"));
  guarded(t, id, f, 1);
  t.diagnostic(JSON.stringify({ caseId: id, counterexample: "true without the actual guard is unsafe", actual: { envWouldBeSelectedWithoutGuard: true, actualGuardRefused: true } }));
});
check("PACK-006-outside-env", "exact three-root model never selects workspace env, sources or private draft outside the outputs", async (t, id) => {
  const f = await fixture("e2e-chromium", { metadata: true });
  await put(join(f.cwd, ".env"), "synthetic private-canary\n");
  await put(join(f.cwd, "sources/private-draft.md"), "synthetic unapproved draft");
  await put(join(f.cwd, "artifacts/ci/other-gate/.env"), "synthetic private-canary\n");
  guarded(t, id, f, 0);
  const selected = await modelFiles(f, true);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(item => item.path), ["e2e-chromium/raw.log", "e2e-chromium/test-results/.last-run.json"]);
});
check("PACK-006-archive-roundtrip", "guarded local archive restores every manifest original plus each manifest byte-identically", async (t, id) => {
  const f = await manifestFixture();
  guarded(t, id, f, 0);
  const expected = await manifestOriginals(f), selected = await modelFiles(f, true);
  sameOriginals(expected, selected);
  const archive = join(f.cwd, "synthetic-bounded-evidence.tgz"), restored = await mkdtemp(join(tmpdir(), "sns-ci-packaging-restore-"));
  execFileSync("tar", ["-czf", archive, "-C", join(f.cwd, "artifacts/ci"), "--", ...selected.map(item => item.path)], { stdio: "pipe" });
  execFileSync("tar", ["-xzf", archive, "-C", restored], { stdio: "pipe" });
  const actual = await inventory(restored);
  sameOriginals(expected, actual);
  t.diagnostic(JSON.stringify({ caseId: id, expected: "all path/byte/hash exact", actual: { originalCount: expected.length, restoredCount: actual.length, exact: true }, scope: "LOCAL synthetic tar; not real GitHub ZIP or old missing-file recovery" }));
});
for (const mutation of ["missing", "extra", "tampered"]) check(`PACK-006-reject-${mutation}`, `local model original comparison refuses ${mutation} evidence without changing the original manifest`, async (t, id) => {
  const f = await manifestFixture(), expected = await manifestOriginals(f), selected = await modelFiles(f, true);
  sameOriginals(expected, selected);
  const altered = selected.map(item => ({ ...item }));
  if (mutation === "missing") altered.pop();
  else if (mutation === "extra") altered.push({ path: "e2e-chromium/unregistered-original.log", bytes: 1, sha256: createHash("sha256").update("x").digest("hex") });
  else altered[0].sha256 = "0".repeat(64);
  altered.sort((a, b) => a.path.localeCompare(b.path));
  assert.throws(() => sameOriginals(expected, altered));
  sameOriginals(expected, await manifestOriginals(f));
  t.diagnostic(JSON.stringify({ caseId: id, expected: "comparison rejects altered package", actual: { mutation, rejected: true, originalManifestUnchanged: true } }));
});

assert.equal(new Set(cases.map(item => item.id)).size, cases.length, "Every required case has an independent unique registration");
export const PACKAGING_CASES = cases.map(({ id, name }) => ({ id, name }));
for (const { id, name, execute } of cases) test(`${id}: ${name}`, async (t) => execute(t, id));
