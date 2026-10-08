import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeParserProcess, PARSER_OUTPUT_LIMIT, PARSER_TIMEOUT_MS } from "../scripts/ci-parser-observation.mjs";
import { parserRuntime, standardLibraryCheck } from "../scripts/ci-evidence-parser.mjs";

const modulePath = fileURLToPath(new URL("../scripts/ci-evidence-parser.mjs", import.meta.url));
const fixture = () => mkdtemp(join(tmpdir(), "sns-ci-observation-fixture-"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const CHILD = String.raw`
import json, os, platform, pyexpat, sys, time
def emit(phase, **changes):
    item = {"version": 1, "callId": sys.argv[-1], "phase": phase, "pid": os.getpid(), "monotonicNs": str(time.monotonic_ns()), "wallTimeNs": str(time.time_ns())}
    if phase == "stdlib": item["runtime"] = {"python": platform.python_version(), "executable": sys.executable, "expat": pyexpat.EXPAT_VERSION, "isolated": bool(sys.flags.isolated)}
    item.update(changes)
    sys.stderr.write("SNS_PARSER_PHASE " + json.dumps(item) + "\n"); sys.stderr.flush()
emit("bootstrap")
emit("stdlib")
`;
const complete = 'emit("complete")\nprint(json.dumps({"synthetic": True}))\n';
function run(source, observationRoot, extra = {}) {
  return observeParserProcess({ source, observationRoot, modulePath, mode: "runtime", input: Buffer.alloc(0), args: [], requiredPhases: ["bootstrap", "stdlib", "complete"], ...extra });
}
async function records(root) {
  const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
  return Promise.all(files.map(async (name) => ({ name, data: JSON.parse(await readFile(join(root, name), "utf8")) })));
}
function rejected(callback) { let failure; try { callback(); } catch (error) { failure = error; } assert.ok(failure?.observation); return failure; }

test("formal runtime records immutable intent/result and actual runtime/identity", async () => {
  const root = await fixture();
  assert.equal(parserRuntime({ observationRoot: root }).isolated, true);
  const items = await records(root), start = items.find((item) => item.name.endsWith(".start.json")).data, end = items.find((item) => item.name.endsWith(".result.json")).data;
  assert.equal(items.length, 2); assert.equal(start.callId, end.callId); assert.equal(start.ended, null);
  assert.equal(start.process.childPid, null); assert.equal(end.process.parentPid, process.pid); assert.ok(end.process.childPid > 0);
  assert.equal(end.failure, null); assert.equal(end.process.timeoutMs, 10_000); assert.equal(end.process.maxBuffer, 65_536);
  assert.deepEqual(Object.keys(end.process.env).sort(), ["LANG", "LC_ALL", "PATH"]);
  assert.equal(end.childSelfReport.runtime.isolated, true); assert.match(end.childSelfReport.runtime.python, /^3\./);
  assert.deepEqual(end.childSelfReport.phases.map((item) => item.phase), ["bootstrap", "stdlib", "complete"]);
  assert.ok(end.childSelfReport.phases.every((item) => item.pid === end.process.childPid && item.callId === end.callId));
  assert.ok(BigInt(end.ended.monotonicNs) >= BigInt(start.started.monotonicNs));
  assert.equal(end.trusted.moduleSha256, hash(await readFile(modulePath)));
  assert.equal(end.process.argv[2].trustedSourceSha256, end.trusted.sourceSha256);
  assert.equal(end.stdout.validResultJson, true);
});
test("formal JUnit records real input path/hash/bytes and expected without copying input", async () => {
  const root = await fixture(), path = join(root, "synthetic.xml"), input = Buffer.from('<testsuite tests="1"><testcase name="synthetic"/></testsuite>');
  await writeFile(path, input);
  assert.deepEqual(standardLibraryCheck("junit", input, [1], { observationRoot: join(root, "observation"), inputPath: path }), { tests: 1 });
  const end = (await records(join(root, "observation"))).find((item) => item.name.endsWith(".result.json")).data;
  assert.deepEqual(end.input, { path, bytes: input.length, sha256: hash(input) }); assert.equal(end.expected, 1);
  assert.deepEqual(end.childSelfReport.phases.map((item) => item.phase), ["bootstrap", "stdlib", "stdin-start", "stdin-end", "parse-start", "parse-end", "complete"]);
  assert.ok(!JSON.stringify(end).includes("<testsuite"));
});
test("formal malformed evidence keeps failed child phase and does not expose traceback/input", async () => {
  const root = await fixture(), input = Buffer.from("synthetic-private-input");
  const error = rejected(() => standardLibraryCheck("junit", input, [1], { observationRoot: root }));
  assert.equal(error.observation.failure, "PARSER_PROCESS_FAILED"); assert.equal(error.observation.exit.status, 1);
  assert.ok(error.observation.stderr.nonPhaseBytes > 0); assert.equal(error.observation.childSelfReport.phases.at(-1).phase, "parse-start");
  assert.ok(!JSON.stringify(error.observation).includes(input.toString()));
  assert.equal((await records(root)).length, 2);
});
test("controlled child timeout keeps the exact official 10 second bound and SIGKILL evidence", async () => {
  const root = await fixture(), started = Date.now();
  const error = rejected(() => run(CHILD + "time.sleep(30)\n", root));
  assert.equal(PARSER_TIMEOUT_MS, 10_000); assert.equal(error.observation.failure, "PARSER_TIMEOUT");
  assert.equal(error.observation.exit.errorCode, "ETIMEDOUT"); assert.equal(error.observation.exit.timedOut, true);
  assert.equal(error.observation.exit.signal, "SIGKILL"); assert.equal(error.observation.exit.killRequested, "SIGKILL");
  assert.ok(Date.now() - started >= 10_000); assert.ok(error.observation.process.childPid > 0);
  assert.equal((await records(root)).length, 2);
});
for (const [name, suffix, failure] of [
  ["exit", "sys.stderr.write('synthetic error\\n'); sys.exit(7)\n", "PARSER_PROCESS_FAILED"],
  ["invalid stdout", 'emit("complete")\nprint("not JSON")\n', "PARSER_OUTPUT_INVALID"],
  ["stdout array", 'emit("complete")\nprint("[]")\n', "PARSER_OUTPUT_INVALID"],
  ["missing complete", 'print("{}")\n', "PARSER_PHASE_FAILED"],
  ["extra phase", 'emit("wrong")\n' + complete, "PARSER_PHASE_FAILED"],
  ["duplicate phase", 'emit("stdlib")\n' + complete, "PARSER_PHASE_FAILED"],
  ["mixed call", 'emit("complete", callId="synthetic-other-call")\nprint("{}")\n', "PARSER_PHASE_FAILED"],
  ["boolean pid", 'emit("complete", pid=True)\nprint("{}")\n', "PARSER_PHASE_FAILED"],
  ["numeric timestamp", 'emit("complete", monotonicNs=1)\nprint("{}")\n', "PARSER_PHASE_FAILED"],
  ["time regression", 'emit("complete", monotonicNs="0")\nprint("{}")\n', "PARSER_PHASE_FAILED"],
  ["foreign executable", '', "PARSER_PHASE_FAILED"],
  ["phase secret", 'emit("complete", secret="synthetic-private")\nprint("{}")\n', "PARSER_PHASE_FAILED"],
  ["output secret key", 'emit("complete")\nprint(json.dumps({"access_token":"short-canary"}))\n', "PARSER_OUTPUT_INVALID"],
  ["nonphase stderr", 'sys.stderr.write("synthetic noise\\n")\n' + complete, "PARSER_PHASE_FAILED"],
  ["output secret", 'emit("complete")\nprint(json.dumps({"message":"Bearer synthetic-private-token"}))\n', "PARSER_OUTPUT_INVALID"],
  ["bounded stdout", 'emit("complete")\nprint("x" * 100000)\n', "PARSER_PROCESS_FAILED"],
  ["bounded stderr", 'sys.stderr.write("x" * 100000)\n' + complete, "PARSER_PROCESS_FAILED"],
]) test(`controlled observation rejects ${name}`, async () => {
  const root = await fixture(), source = name === "foreign executable" ? CHILD.replace('"executable": sys.executable', '"executable": "/synthetic-other-python"') + complete : CHILD + suffix;
  const error = rejected(() => run(source, root));
  assert.equal(error.observation.failure, failure); assert.equal((await records(root)).length, 2);
  assert.ok(!JSON.stringify(error.observation).includes("synthetic-private"));
  assert.ok(!JSON.stringify(error.observation).includes("short-canary"));
  if (["extra phase", "duplicate phase", "mixed call", "boolean pid", "numeric timestamp", "time regression", "phase secret"].includes(name)) assert.deepEqual(error.observation.childSelfReport.phases.map((item) => item.phase), ["bootstrap", "stdlib"]);
});
test("phase reordering and unisolated runtime reject", async () => {
  for (const source of [CHILD.replace('emit("bootstrap")\nemit("stdlib")', 'emit("stdlib")\nemit("bootstrap")') + complete, CHILD.replace('bool(sys.flags.isolated)', "False") + complete]) {
    const root = await fixture(); assert.equal(rejected(() => run(source, root)).observation.failure, "PARSER_PHASE_FAILED");
  }
});
test("result save collision retains first file/intent and exposes sanitized parent failure", async () => {
  const root = await fixture();
  const source = CHILD + `open(${JSON.stringify(root)} + '/' + sys.argv[-1] + '.result.json', 'x').write('synthetic collision original')\n` + complete;
  const error = rejected(() => run(source, root));
  assert.equal(error.observation.failure, "PARSER_OBSERVATION_FAILED"); assert.equal(error.observation.observationFailure.code, "EEXIST");
  assert.equal(await readFile(join(root, `${error.observation.callId}.result.json`), "utf8"), "synthetic collision original");
  assert.ok(await readFile(join(root, `${error.observation.callId}.start.json`), "utf8"));
});
test("unwritable non-directory and symlink storage reject before child launch", async () => {
  const root = await fixture(), file = join(root, "file"), link = join(root, "link"); await writeFile(file, "synthetic original"); await symlink(root, link);
  for (const path of [file, link]) { const error = rejected(() => run(CHILD + complete, path)); assert.equal(error.observation.process.childPid, null); assert.equal(error.observation.failure, "PARSER_OBSERVATION_FAILED"); }
  assert.equal(await readFile(file, "utf8"), "synthetic original"); assert.deepEqual((await readdir(root)).sort(), ["file", "link"]);
});
test("metadata types/bounds/secret reject without echoing secret or running child", async () => {
  for (const extra of [{ input: "not buffer" }, { input: Buffer.alloc(20 * 1024 * 1024 + 1) }, { args: ["Bearer synthetic-private-token"] }, { args: [JSON.stringify({ access_token: "short-canary" })] }, { inputPath: "relative" }, { mode: true }, { requiredPhases: [true] }]) {
    const root = await fixture(), error = rejected(() => run(CHILD + complete, root, extra));
    assert.equal(error.observation.process.childPid, null); assert.ok(!JSON.stringify(error.observation).includes("synthetic-private"));
    assert.ok(!JSON.stringify(error.observation).includes("short-canary"));
  }
  assert.equal(PARSER_OUTPUT_LIMIT, 65_536);
});
test("formal parser has no synthetic source/timeout/phase/environment injection entry", async () => {
  for (const key of ["source", "command", "timeoutMs", "requiredPhases", "env"]) assert.throws(() => standardLibraryCheck("runtime", Buffer.alloc(0), [], { [key]: "synthetic" }), /Unknown parser observation option/);
  const source = await readFile(new URL("../scripts/ci-quality.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('"ci-parser-observation.mjs"')); assert.ok(source.includes("parserFailure: failure?.observation ?? null"));
  const root = await fixture(), original = process.env.SNS_PARSER_SOURCE; process.env.SNS_PARSER_SOURCE = "synthetic injected failure";
  try { assert.equal(parserRuntime({ observationRoot: root }).isolated, true); } finally { if (original === undefined) delete process.env.SNS_PARSER_SOURCE; else process.env.SNS_PARSER_SOURCE = original; }
  const end = (await records(root)).find((item) => item.name.endsWith(".result.json")).data;
  assert.equal(end.process.env.SNS_PARSER_SOURCE, undefined);
});
test("missing python spawn failure retains parent metadata with null unobserved runtime", async () => {
  const root = await fixture(), child = `import {parserRuntime} from ${JSON.stringify(new URL("../scripts/ci-evidence-parser.mjs", import.meta.url).href)}; try {parserRuntime({observationRoot:${JSON.stringify(root)}})} catch(e) {console.log(JSON.stringify(e.observation));process.exitCode=1}`;
  let error; try { execFileSync(process.execPath, ["--input-type=module", "-e", child], { env: { PATH: "/synthetic-no-python" }, stdio: "pipe" }); } catch (caught) { error = caught; }
  const end = JSON.parse(error.stdout); assert.equal(end.exit.errorCode, "ENOENT"); assert.equal(end.process.childPid, null); assert.equal(end.childSelfReport.runtime, null);
});
test("relative-only PATH cannot select an unrecorded executable", async () => {
  const root = await fixture(), child = `import {parserRuntime} from ${JSON.stringify(new URL("../scripts/ci-evidence-parser.mjs", import.meta.url).href)}; try {parserRuntime({observationRoot:${JSON.stringify(root)}})} catch(e) {console.log(JSON.stringify(e.observation));process.exitCode=1}`;
  let error; try { execFileSync(process.execPath, ["--input-type=module", "-e", child], { env: { PATH: "relative-python-directory" }, stdio: "pipe" }); } catch (caught) { error = caught; }
  const end = JSON.parse(error.stdout); assert.equal(end.process.resolvedExecutable, null); assert.equal(end.process.childPid, null); assert.equal(end.process.started, null); assert.equal(end.exit.errorCode, "ENOENT");
});

async function childObservation(root, envPath, expression = "parserRuntime") {
  const source = `import {parserRuntime,standardLibraryCheck} from ${JSON.stringify(new URL("../scripts/ci-evidence-parser.mjs", import.meta.url).href)};try {const result=${expression === "parserRuntime" ? `parserRuntime({observationRoot:${JSON.stringify(root)}})` : `standardLibraryCheck("junit",Buffer.from("synthetic malformed"),[1],{observationRoot:${JSON.stringify(root)}})`};console.log(JSON.stringify({accepted:true,result}));}catch(e){console.log(JSON.stringify({accepted:false,observation:e.observation,observationRoot:e.observationRoot}));process.exitCode=1}`;
  try { return { exit: 0, text: execFileSync(process.execPath, ["--input-type=module", "-e", source], { env: { PATH: envPath }, encoding: "utf8" }) }; }
  catch (error) { return { exit: error.status, text: error.stdout.toString() }; }
}
for (const canary of ["secret=synthetic-path-canary", "api_key=short-canary"]) test("resolved executable rejects synthetic secret pattern before record assignment: " + canary.split("=")[0], async () => {
  const root = await fixture(), bin = join(root, "clean-bin"), output = join(root, "records"), target = join(root, canary), marker = join(root, "executed");
  await mkdir(bin); await writeFile(target, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 7\n`); await chmod(target, 0o700); await symlink(target, join(bin, "python3"));
  const observed = await childObservation(output, bin), parent = JSON.parse(observed.text);
  assert.equal(observed.exit, 1); assert.equal(parent.accepted, false); assert.equal(parent.observation.process.resolvedExecutable, null); assert.equal(parent.observation.process.childPid, null); assert.equal(parent.observationRoot, null);
  assert.ok(!observed.text.includes(canary)); assert.deepEqual((await readdir(root)).sort(), ["clean-bin", canary].sort());
});
for (const expression of ["parserRuntime", "malformedJUnit"]) test("canonical observation path rejects secret metadata without parent leak: " + expression, async () => {
  const root = await fixture(), canary = "secret=synthetic-path-canary", target = join(root, canary), alias = join(root, "clean-alias"); await mkdir(target); await symlink(target, alias);
  const output = join(alias, "records"), observed = await childObservation(output, process.env.PATH, expression), parent = JSON.parse(observed.text);
  assert.equal(observed.exit, 1); assert.equal(parent.observation.failure, "PARSER_OBSERVATION_FAILED"); assert.equal(parent.observation.process.childPid, null); assert.equal(parent.observationRoot, null); assert.ok(!observed.text.includes(canary));
  assert.deepEqual(await readdir(output), []); // Directory preparation may occur; no intent/result or child launch.
});
test("safe canonical observation alias and safe executable symlink remain compatible", async () => {
  const root = await fixture(), target = join(root, "safe-target"), alias = join(root, "safe-alias"), bin = join(root, "clean-bin"); await mkdir(target); await mkdir(bin); await symlink(target, alias);
  const actual = parserRuntime().executable; await symlink(actual, join(bin, "python3"));
  const observed = await childObservation(join(alias, "records"), bin), parent = JSON.parse(observed.text);
  assert.equal(observed.exit, 0); assert.equal(parent.accepted, true); assert.equal(parent.result.executable, actual); assert.equal((await records(join(target, "records"))).length, 2);
});
test("unsafe initial observation path and invalid path types reject with sanitized failure", async () => {
  for (const observationRoot of [true, 1, {}, "relative-path", "/synthetic/secret=short-canary", "/" + "x".repeat(5000)]) {
    const error = rejected(() => parserRuntime({ observationRoot }));
    assert.equal(error.observationRoot, null); assert.equal(error.observation.process.childPid, null); assert.ok(!JSON.stringify(error.observation).includes("short-canary"));
  }
});
