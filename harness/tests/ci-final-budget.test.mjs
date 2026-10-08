import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { evidenceManifest } from "../scripts/ci-contract.mjs";

const projectRoot = new URL("../..", import.meta.url).pathname;
const cap = 20 * 1024 * 1024;
const fixedSha = "a".repeat(40);
const serializedResult = `${JSON.stringify({ status: "SELF_CHECK_OK", fixedSha }, null, 2)}\n`;
const serialize = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
const finalBytes = (manifest) => manifest.files.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(serialize(manifest)));
const fixture = () => mkdtemp(join(tmpdir(), "sns-ci-final-fixture-"));

test("final serialized result and manifest accept exactly 20 MiB and reject one extra byte", async () => {
  const root = await fixture();
  let rawBytes = cap - 2000;
  await writeFile(join(root, "raw.log"), Buffer.alloc(rawBytes));
  const initial = await evidenceManifest(root, fixedSha, serializedResult);
  rawBytes += cap - finalBytes(initial);
  await writeFile(join(root, "raw.log"), Buffer.alloc(rawBytes));
  const exact = await evidenceManifest(root, fixedSha, serializedResult);
  assert.equal(finalBytes(exact), cap);
  assert.equal(exact.files.find((file) => file.path === "result.json").bytes, Buffer.byteLength(serializedResult));
  await writeFile(join(root, "raw.log"), Buffer.alloc(rawBytes + 1));
  await assert.rejects(evidenceManifest(root, fixedSha, serializedResult), /including final result and manifest/);
});

test("final file budget includes result and manifest and accepts 500 but rejects 501", async () => {
  const root = await fixture();
  for (let index = 0; index < 498; index += 1) await writeFile(join(root, `raw-${index}.log`), "synthetic");
  assert.equal((await evidenceManifest(root, fixedSha, serializedResult)).files.length + 1, 500);
  await writeFile(join(root, "raw-extra.log"), "synthetic");
  await assert.rejects(evidenceManifest(root, fixedSha, serializedResult), /500-file/);
});

test("long escaped multibyte paths are counted by actual manifest UTF-8 bytes", async () => {
  const root = await fixture();
  const nested = join(root, '"\\' + "長".repeat(40));
  await mkdir(nested);
  let rawBytes = cap - 2000;
  await writeFile(join(nested, '"\\長-raw.log'), Buffer.alloc(rawBytes));
  const initial = await evidenceManifest(root, fixedSha, serializedResult);
  rawBytes += cap - finalBytes(initial);
  await writeFile(join(nested, '"\\長-raw.log'), Buffer.alloc(rawBytes));
  assert.equal(finalBytes(await evidenceManifest(root, fixedSha, serializedResult)), cap);
  await writeFile(join(nested, '"\\長-raw.log'), Buffer.alloc(rawBytes + 1));
  await assert.rejects(evidenceManifest(root, fixedSha, serializedResult), /20 MiB/);
});

test("large legitimate serialized result uses exact available space, not a fixed 100 KB reserve", async () => {
  const root = await fixture();
  await writeFile(join(root, "raw.log"), "synthetic");
  const large = `${JSON.stringify({ status: "SELF_CHECK_OK", diagnostic: "x".repeat(150_000) })}\n`;
  const manifest = await evidenceManifest(root, fixedSha, large);
  assert.equal(manifest.files.find((file) => file.path === "result.json").bytes, Buffer.byteLength(large));
  assert.ok(finalBytes(manifest) < cap);
  for (const invalid of [null, true, 1, {}, ""]) await assert.rejects(evidenceManifest(root, fixedSha, invalid), /serialized bytes/);
});

async function syntheticRunner(kind) {
  // This npm shim is an isolated negative fixture, never a genuine install gate.
  const root = await fixture(), product = join(root, "product"), bin = join(root, "bin"), output = join(root, "output");
  await mkdir(product); await mkdir(bin);
  const packageBytes = await readFile(join(projectRoot, "package.json"));
  await writeFile(join(product, "package.json"), packageBytes);
  execFileSync("git", ["init", "--quiet", product]);
  execFileSync("git", ["-C", product, "config", "user.name", "Synthetic Final Budget Fixture"]);
  execFileSync("git", ["-C", product, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", product, "add", "package.json"]);
  execFileSync("git", ["-C", product, "commit", "--quiet", "-m", "Synthetic fixture"]);
  const sha = execFileSync("git", ["-C", product, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const shim = `${process.execPath ? "#!" + process.execPath : "#!/usr/bin/env node"}\n` + String.raw`
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const kind = ${JSON.stringify(kind)}, output = ${JSON.stringify(output)};
if (process.argv[2] === "--version") console.log("11.12.1");
else if (process.argv[2] === "ci") {
  if (kind === "metadata-overflow") {
    const nested = join(output, ...Array.from({ length: 4 }, (_, index) => index + "-" + "x".repeat(200)));
    await mkdir(nested, { recursive: true });
    for (let index = 0; index < 450; index += 1) await writeFile(join(nested, index + ".log"), index === 0 ? Buffer.alloc(20 * 1024 * 1024 - 235_000) : "synthetic");
  } else if (kind === "result-file" || kind === "manifest-file") await writeFile(join(output, kind === "result-file" ? "result.json" : "manifest.json"), "synthetic immutable original");
  else if (kind === "result-directory" || kind === "manifest-directory") await mkdir(join(output, kind === "result-directory" ? "result.json" : "manifest.json"));
  console.log("Synthetic fixture only; no npm install executed");
} else process.exitCode = 9;
`;
  await writeFile(join(bin, "npm"), shim); await chmod(join(bin, "npm"), 0o755);
  const preload = join(root, "synthetic-finalization-fault.mjs");
  // Process-local fs faults are isolated negative fixtures, not runner options or
  // SOURCE/phase/timeout injection. Genuine qualification never uses this preload.
  await writeFile(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";\nconst kind=${JSON.stringify(kind)};\n` + String.raw`
const originalWrite = fs.promises.writeFile, originalLink = fs.promises.link, originalUnlink = fs.promises.unlink;
const fault = () => Object.assign(new Error("Synthetic finalization filesystem failure"), { code: "EIO" });
fs.promises.writeFile = async (path, ...args) => {
  if (String(path).includes(".sns-ci-final-") && ((kind === "stage-manifest-write" && String(path).endsWith("manifest.json")) || (kind === "stage-result-write" && String(path).endsWith("result.json")))) throw fault();
  return originalWrite(path, ...args);
};
fs.promises.link = async (source, target) => {
  if ((kind === "manifest-link" && String(target).endsWith("manifest.json")) || (kind === "result-link" && String(target).endsWith("result.json"))) throw fault();
  const result = await originalLink(source, target);
  if (kind === "interrupted-after-manifest" && String(target).endsWith("manifest.json")) process.exit(17);
  return result;
};
fs.promises.unlink = async (path) => { if (kind === "cleanup-after-publication" && String(path).includes(".sns-ci-final-") && String(path).endsWith("result.json")) throw fault(); return originalUnlink(path); };
syncBuiltinESMExports();
`);
  let error;
  try { execFileSync(process.execPath, ["--import", preload, join(projectRoot, "harness/scripts/ci-quality.mjs"), "--product-root", product, "--fixed-sha", sha, "--gate", "install", "--output", output], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" }); }
  catch (caught) { error = caught; }
  return { root, product, output, sha, error };
}

test("formal runner rejects metadata overflow even when raw is below the former reserve", async () => {
  const { output, error } = await syntheticRunner("metadata-overflow");
  assert.equal(error?.status, 1);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  assert.equal(result.status, "FAIL"); assert.match(result.failure, /including final result and manifest/);
  await assert.rejects(stat(join(output, "manifest.json")), { code: "ENOENT" });
  const raw = join(output, ...Array.from({ length: 4 }, (_, index) => index + "-" + "x".repeat(200)), "0.log");
  assert.equal((await stat(raw)).size, cap - 235_000);
});

for (const kind of ["stage-manifest-write", "stage-result-write", "manifest-link", "result-link"]) test(`formal entry retains FAIL for isolated ${kind} filesystem fault`, async () => {
  const { output, error } = await syntheticRunner(kind);
  assert.equal(error?.status, 1);
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  assert.equal(result.status, "FAIL"); assert.match(result.failure, /Synthetic finalization filesystem failure/);
  if (kind === "result-link") {
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    const bytes = await readFile(join(output, "result.json"));
    assert.notEqual(manifest.files.find((file) => file.path === "result.json").bytes, bytes.length);
  } else await assert.rejects(stat(join(output, "manifest.json")), { code: "ENOENT" });
  assert.deepEqual((await readdir(dirname(output))).filter((name) => name.startsWith(".sns-ci-final-")), []);
});

test("interruption after manifest publication cannot publish a successful result", async () => {
  const { output, error } = await syntheticRunner("interrupted-after-manifest");
  assert.equal(error?.status, 17);
  assert.ok((await stat(join(output, "manifest.json"))).isFile());
  await assert.rejects(stat(join(output, "result.json")), { code: "ENOENT" });
  assert.equal((await readdir(dirname(output))).filter((name) => name.startsWith(".sns-ci-final-")).length, 1);
});

test("cleanup failure after complete publication preserves committed bytes but prevents qualification", async () => {
  const { output, error } = await syntheticRunner("cleanup-after-publication");
  assert.equal(error?.status, 1);
  assert.equal(JSON.parse(await readFile(join(output, "result.json"), "utf8")).status, "SELF_CHECK_OK");
  assert.match(error.stderr.toString("utf8"), /publication completed.*no qualification/);
  assert.equal((await readdir(dirname(output))).filter((name) => name.startsWith(".sns-ci-final-")).length, 1);
});

for (const kind of ["result-file", "manifest-file", "result-directory", "manifest-directory"]) test(`formal finalization preserves ${kind} collision and remains nonzero`, async () => {
  const { output, error } = await syntheticRunner(kind);
  assert.equal(error?.status, 1);
  const collided = join(output, kind.startsWith("result") ? "result.json" : "manifest.json");
  if (kind.endsWith("file")) assert.equal(await readFile(collided, "utf8"), "synthetic immutable original");
  else assert.ok((await stat(collided)).isDirectory());
  if (kind.startsWith("result")) {
    const failures = (await readdir(output)).filter((name) => name.startsWith("finalization-failure-"));
    assert.equal(failures.length, 1);
    const failure = JSON.parse(await readFile(join(output, failures[0]), "utf8"));
    assert.equal(failure.status, "FAIL"); assert.equal(failure.publicAttestationEligible, false);
  } else assert.equal(JSON.parse(await readFile(join(output, "result.json"), "utf8")).status, "FAIL");
  if (kind === "result-directory") {
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.ok(manifest.files.some((file) => file.path === "result.json"));
    // A staged success manifest without its result is incomplete, not qualified.
    assert.ok((await stat(join(output, "result.json"))).isDirectory());
  }
  assert.deepEqual((await readdir(dirname(output))).filter((name) => name.startsWith(".sns-ci-final-")), []);
});
