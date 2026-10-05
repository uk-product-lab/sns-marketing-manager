import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorkspaceLock, assertAxe, assertJUnit, assertPlaywright, assertQualityCommands, assertRuntime, assertUnit, availablePort, capture, cleanEnvironment, evidenceManifest, parseArgs, PROJECTS, REQUIRED_SCRIPTS } from "../scripts/ci-contract.mjs";
import { parserRuntime, standardLibraryCheck } from "../scripts/ci-evidence-parser.mjs";
import CIUnitReporter from "../scripts/ci-unit-reporter.mjs";

const projectRoot = new URL("../..", import.meta.url).pathname;
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
async function fixture() { return mkdtemp(join(tmpdir(), "sns-ci-fixture-")); }
async function json(root, path, data) { await writeFile(join(root, path), JSON.stringify(data)); }
function generatedFixture(mode, value) {
  return execFileSync("python3", ["-I", "-c", String.raw`
import base64, copy, hashlib, io, json, struct, sys, zipfile, zlib
mode, value = sys.argv[1], json.loads(sys.argv[2])
if mode == "png":
    width, height = value["width"], value["height"]
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\x00" + b"\x00" * (width * 3)) * height)) + chunk(b"IEND", b""))
else:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zipped:
        if mode == "trace":
            events = [{"type": "context-options", "browserName": value["browserName"], "options": {"viewport": value["viewport"]}}, {"type": "before", "apiName": "synthetic.fixture"}, {"type": "after", "apiName": "synthetic.fixture"}]
            zipped.writestr("trace.trace", "\n".join(json.dumps(event) for event in events))
        elif mode == "zip":
            for item in value:
                info = zipfile.ZipInfo(item["name"])
                info.compress_type = zipfile.ZIP_DEFLATED
                if item.get("symlink"): info.external_attr = 0o120777 << 16
                zipped.writestr(info, item.get("data", "synthetic") * item.get("repeat", 1))
        else:
            entries, mutation = (value["tests"], value.get("mutation")) if isinstance(value, dict) else (value, None)
            stats = lambda count: {"total": count, "expected": count, "unexpected": 0, "flaky": 0, "skipped": 0, "ok": True}
            files, summaries = {}, []
            for name in sorted({test["location"]["file"] for test in entries}):
                file_id = hashlib.sha1(name.encode()).hexdigest()[:20]
                tests = [{**{key: test[key] for key in ("testId", "title", "projectName", "location")}, "duration": test["result"]["duration"], "annotations": [], "tags": [], "path": ["synthetic suite"], "ok": True, "outcome": "expected", "results": [{**test["result"], "steps": [], "annotations": [], "attachments": [{"name": "trace", "contentType": "application/zip", "path": "data/synthetic.zip"}]}]} for test in entries if test["location"]["file"] == name]
                detail = {"fileId": file_id, "fileName": name, "tests": tests}
                files[file_id + ".json"] = detail
                brief = copy.deepcopy(detail)
                brief["stats"] = stats(len(tests))
                for test in brief["tests"]:
                    test["results"] = [{key: result[key] for key in ("attachments", "startTime", "workerIndex")} for result in test["results"]]
                summaries.append(brief)
            report = {"projectNames": sorted({test["projectName"] for test in entries}), "errors": [], "stats": stats(len(entries)), "files": summaries}
            first_name = summaries[0]["fileId"] + ".json"
            detail, brief = files[first_name]["tests"][0], summaries[0]["tests"][0]
            result = detail["results"][0]
            if mutation == "missingDetail": del files[first_name]
            elif mutation == "extraDetail": files["01234567890123456789.json"] = copy.deepcopy(files[first_name])
            elif mutation == "duplicateFile": summaries.append(copy.deepcopy(summaries[0]))
            elif mutation == "duplicateSummaryTest": summaries[0]["tests"].append(copy.deepcopy(brief))
            elif mutation == "duplicateDetailTest": files[first_name]["tests"].append(copy.deepcopy(detail))
            elif mutation == "missingDetailTest": files[first_name]["tests"] = []
            elif mutation == "extraDetailTest": files[first_name]["tests"].append({**copy.deepcopy(detail), "testId": "synthetic-extra"})
            elif mutation in {"detailFileId", "detailFileName"}: files[first_name]["fileId" if mutation == "detailFileId" else "fileName"] = "synthetic-wrong"
            elif mutation in {"testId", "title", "projectName"}: detail[mutation] = "synthetic-wrong"
            elif mutation == "location": detail["location"]["line"] += 1
            elif mutation == "boolLocation": detail["location"]["line"] = True; brief["location"]["line"] = True
            elif mutation == "retry": result["retry"] = 1
            elif mutation == "boolRetry": result["retry"] = False
            elif mutation == "stringRetry": result["retry"] = "0"
            elif mutation == "missingRetry": del result["retry"]
            elif mutation in {"failed", "skipped", "timedOut", "interrupted"}: result["status"] = mutation
            elif mutation == "errors": result["errors"] = [{"message": "synthetic hidden error"}]
            elif mutation == "missingErrors": del result["errors"]
            elif mutation == "singularError": result["error"] = {"message": "synthetic hidden error"}
            elif mutation == "missingResultField": del result["steps"]
            elif mutation == "multipleAttempts": detail["results"].append(copy.deepcopy(result))
            elif mutation == "missingResults": detail["results"] = []
            elif mutation == "outcome": detail["outcome"] = "flaky"
            elif mutation == "ok": detail["ok"] = False
            elif mutation == "repeat": detail["repeatEachIndex"] = 1; brief["repeatEachIndex"] = 1
            elif mutation == "duration": result["duration"] += 1
            elif mutation == "testBoolDuration": detail["duration"] = True; brief["duration"] = True
            elif mutation == "summaryBoolDuration": brief["duration"] = True
            elif mutation == "summaryBoolLocation": brief["location"]["line"] = True
            elif mutation == "startTime": result["startTime"] = "synthetic-wrong"
            elif mutation == "workerIndex": result["workerIndex"] += 1
            elif mutation == "boolWorker": result["workerIndex"] = False; brief["results"][0]["workerIndex"] = False
            elif mutation == "summaryBoolWorker": brief["results"][0]["workerIndex"] = False
            elif mutation == "summaryResult": brief["results"][0]["attachments"] = []
            elif mutation == "fileStats": summaries[0]["stats"]["total"] += 1
            elif mutation == "reportStats": report["stats"]["total"] += 1
            elif mutation == "boolStats": report["stats"]["unexpected"] = False
            elif mutation == "nonfinite": result["duration"] = float("nan")
            elif mutation == "reorderedNormal": summaries.reverse(); [file["tests"].reverse() for file in files.values()]
            elif mutation not in {None, "duplicateKey"}: raise ValueError("Unknown synthetic HTML mutation")
            for name, data in {**files, "report.json": report}.items():
                serialized = json.dumps(data)
                if mutation == "duplicateKey" and name == first_name: serialized = serialized.replace('"retry": 0', '"retry": 1, "retry": 0', 1)
                zipped.writestr(name, serialized)
    data = stream.getvalue()
    if mode == "html": data = ("<!DOCTYPE html><html><head><title>Playwright Test Report</title></head><body><template id=\"playwrightReportBase64\">data:application/zip;base64," + base64.b64encode(data).decode() + "</template></body></html>").encode()
    sys.stdout.buffer.write(data)
`, mode, JSON.stringify(value)], { maxBuffer: 20 * 1024 * 1024 });
}
function htmlEntry(project, index = 0) {
  return { testId: `synthetic-test-${index}`, title: `synthetic-${index}`, projectName: project.name, location: { file: "synthetic.spec.ts", line: index + 1, column: 1 }, result: { status: "passed", retry: 0, errors: [], duration: 1, startTime: "2026-10-02T00:00:00.000Z", workerIndex: index } };
}
function htmlEntries(specs) {
  return specs.flatMap(spec => spec.tests.map(item => ({ testId: spec.id, title: spec.title, projectName: item.projectName, location: { file: spec.file, line: spec.line, column: spec.column }, result: Object.fromEntries(["status", "retry", "errors", "duration", "startTime", "workerIndex"].map(key => [key, item.results[0][key]])) })));
}
async function unitFixture(root) {
  const data = { success: true, numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numFailedTests: 0, testResults: [{ name: "synthetic.unit.ts", assertionResults: [{ status: "passed", ancestorTitles: [], title: "synthetic" }] }] };
  await json(root, "unit.json", data);
  await json(root, "unit-history.json", { reason: "passed", unhandledErrors: 0, tests: [{ id: "synthetic-test", file: "synthetic.unit.ts", ancestors: [], title: "synthetic", status: "passed", retryCount: 0, repeatCount: 0, flaky: false, errors: 0 }] });
  await writeFile(join(root, "unit.xml"), '<testsuites><testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="synthetic"/></testsuite></testsuites>');
  return data;
}
async function playwrightFixture(root) {
  const expected = PROJECTS.slice(0, 2);
  const config = { workers: 1, projects: expected.map((project) => ({ name: project.name, retries: 0, repeatEach: 1 })) };
  const specs = [];
  await mkdir(join(root, "test-results"));
  for (const [index, project] of expected.entries()) {
    const path = join(root, "test-results", `trace-${index}.zip`);
    await writeFile(path, generatedFixture("trace", project));
    specs.push({ id: `synthetic-test-${index}`, title: `synthetic-${index}`, file: "synthetic.spec.ts", line: index + 1, column: 1, tests: [{ projectName: project.name, status: "expected", expectedStatus: "passed", results: [{ ...htmlEntry(project, index).result, attachments: [{ name: "trace", path }] }] }] });
  }
  const data = { config, errors: [], suites: [{ specs }] };
  const viewport = { status: "passed", tests: expected.map((project, index) => ({ testId: `synthetic-test-${index}`, title: `synthetic-${index}`, location: { file: "synthetic.spec.ts", line: index + 1, column: 1 }, project: project.name, viewport: structuredClone(project.viewport), browserName: project.browserName, retry: 0, status: "passed" })) };
  await json(root, "playwright.json", data); await json(root, "viewports.json", viewport);
  await writeFile(join(root, "test-results.xml"), '<testsuites><testsuite tests="2" failures="0" skipped="0"><testcase/><testcase/></testsuite></testsuites>');
  await mkdir(join(root, "playwright-report")); await writeFile(join(root, "playwright-report", "index.html"), generatedFixture("html", htmlEntries(specs)));
  return { data, viewport, expected };
}
async function axeFixture(root) {
  const data = { probes: PROJECTS.map((project) => ({ project: project.name, viewport: project.viewport, browserName: project.browserName, httpStatus: 200, errors: [], network: [{ status: 200 }], axe: { testEngine: { version: "fixture" }, timestamp: "synthetic", violations: [], passes: [{ id: "synthetic" }] } })) };
  for (const project of PROJECTS) { const scale = project.browserName === "webkit" ? 2 : 1; await writeFile(join(root, `${project.name}.png`), generatedFixture("png", { width: project.viewport.width * scale, height: project.viewport.height * scale })); await writeFile(join(root, `${project.name}.trace.zip`), generatedFixture("trace", project)); }
  await json(root, "accessibility.json", data); return data;
}

test("runtime and all existing product scripts are required", () => {
  assert.doesNotThrow(() => assertRuntime("v24.15.0", "11.12.1", packageJson));
  assert.throws(() => assertRuntime("v22.0.0", "11.12.1", packageJson));
  assert.throws(() => assertRuntime("v24.15.0", "10.0.0", packageJson));
  for (const name of REQUIRED_SCRIPTS) { const copy = structuredClone(packageJson); delete copy.scripts[name]; assert.throws(() => assertRuntime("v24.15.0", "11.12.1", copy)); }
});
test("all seven real quality commands reject constant-green substitutions", () => {
  assert.doesNotThrow(() => assertQualityCommands(packageJson, packageJson));
  for (const name of REQUIRED_SCRIPTS) {
    for (const fake of ["echo synthetic-green", "node -e 'process.exit(0)'"]) {
      const product = structuredClone(packageJson); product.scripts[name] = fake;
      assert.throws(() => assertQualityCommands(product, packageJson), /differs from trusted/);
    }
  }
});
test("unknown, duplicated, stale/missing SHA and invalid gate arguments fail", () => {
  const valid = ["--product-root", projectRoot, "--output", "/tmp/synthetic-evidence", "--gate", "unit", "--fixed-sha", "a".repeat(40)];
  assert.equal(parseArgs(valid).gate, "unit");
  assert.throws(() => parseArgs([...valid, "--retry", "1"]));
  assert.throws(() => parseArgs([...valid, "--gate", "static"]));
  assert.throws(() => parseArgs(valid.slice(0, -2)));
});
test("credential sentinel is excluded from real child environment", async () => {
  const root = await fixture();
  const env = cleanEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: "SYNTHETIC_CREDENTIAL", NODE_AUTH_TOKEN: "SYNTHETIC_CREDENTIAL", GATEKEEPER_APP_PRIVATE_KEY: "SYNTHETIC_CREDENTIAL", AWS_SECRET_ACCESS_KEY: "SYNTHETIC_CREDENTIAL" });
  await capture(process.execPath, ["-e", 'if(Object.values(process.env).includes("SYNTHETIC_CREDENTIAL"))process.exit(2); console.log("synthetic child checked credential absence")'], { cwd: projectRoot, output: root, label: "clean-env", env });
  assert.equal(JSON.parse(await readFile(join(root, "clean-env.command.json"), "utf8")).exitCode, 0);
});
test("real child failure is nonzero and preserves first raw result", async () => {
  const root = await fixture();
  await assert.rejects(capture(process.execPath, ["-e", 'console.error("synthetic first failure"); process.exit(7)'], { cwd: projectRoot, output: root, label: "failed" }));
  assert.equal(JSON.parse(await readFile(join(root, "failed.command.json"), "utf8")).exitCode, 7);
  await assert.rejects(capture(process.execPath, ["-e", "process.exit(0)"], { cwd: projectRoot, output: root, label: "failed" }), /EEXIST/);
  assert.match(await readFile(join(root, "failed.log"), "utf8"), /synthetic first failure/);
});
test("real child timeout, missing executable and log creation failure reject", async () => {
  const root = await fixture();
  await assert.rejects(capture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: projectRoot, output: root, label: "timeout", timeoutMs: 20 }));
  assert.equal(JSON.parse(await readFile(join(root, "timeout.command.json"), "utf8")).timedOut, true);
  await assert.rejects(capture("/nonexistent-synthetic-command", [], { cwd: projectRoot, output: root, label: "missing" }));
  await assert.rejects(capture(process.execPath, ["-e", "process.exit(0)"], { cwd: projectRoot, output: join(root, "nonexistent"), label: "bad-log" }));
});
test("leader exit cannot leave a SIGTERM-ignoring descendant alive", async () => {
  const root = await fixture();
  const childCode = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const code = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});console.log(child.pid);setTimeout(()=>process.exit(0),100);`;
  let error;
  try { await capture(process.execPath, ["-e", code], { cwd: projectRoot, output: root, label: "descendant" }); } catch (caught) { error = caught; }
  const log = await readFile(join(root, "descendant.log"), "utf8");
  const pid = Number(log.split("\n").find((line) => /^\d+$/.test(line)));
  assert.ok(pid > 0);
  // If the OS still exposes a reaping zombie, the runner must reject rather than unlock a success.
  let alive = false; try { process.kill(pid, 0); alive = true; } catch (caught) { assert.equal(caught.code, "ESRCH"); }
  if (alive) assert.match(error?.message ?? "", /cleanup failure/);
  else if (error) assert.match(error.message, /cleanup failure/);
});
test("workspace lock rejects concurrent work and releases explicitly", async () => {
  const root = await fixture(); execFileSync("git", ["init", "--quiet", root]);
  const release = await acquireWorkspaceLock(root);
  await assert.rejects(acquireWorkspaceLock(root), /Workspace busy/);
  await release(); const second = await acquireWorkspaceLock(root); await second();
});
test("available port is a valid loopback ephemeral port", async () => { const port = await availablePort(); assert.ok(port > 0 && port <= 65535); });
test("real runner rejects stale SHA and dirty tracked product with failure JSON", async () => {
  const root = await fixture();
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Synthetic Fixture"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  await json(root, "package.json", packageJson);
  execFileSync("git", ["-C", root, "add", "package.json"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "Synthetic fixture"]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runner = join(projectRoot, "harness/scripts/ci-quality.mjs");
  for (const [kind, candidate] of [["stale", "a".repeat(40)], ["dirty", sha]]) {
    if (kind === "dirty") await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`);
    const output = join(root, `evidence-${kind}`);
    assert.throws(() => execFileSync(process.execPath, [runner, "--product-root", root, "--fixed-sha", candidate, "--gate", "unit", "--output", output], { stdio: "pipe" }));
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    assert.equal(result.status, "FAIL"); assert.match(result.failure, kind === "stale" ? /HEAD/ : /clean/);
  }
});
test("combined upload budget rejects missing, empty, oversize and symlink output", async () => {
  const root = await fixture(); const runner = join(projectRoot, "harness/scripts/ci-upload-budget.mjs");
  assert.throws(() => execFileSync(process.execPath, [runner, root], { stdio: "pipe" }));
  await writeFile(join(root, "raw.log"), "synthetic evidence");
  assert.match(execFileSync(process.execPath, [runner, root], { encoding: "utf8" }), /budget checked/);
  await writeFile(join(root, "raw.log"), ""); assert.throws(() => execFileSync(process.execPath, [runner, root], { stdio: "pipe" }));
  await writeFile(join(root, "raw.log"), Buffer.alloc(20 * 1024 * 1024 + 1)); assert.throws(() => execFileSync(process.execPath, [runner, root], { stdio: "pipe" }));
  const linkRoot = await fixture(); const { symlink } = await import("node:fs/promises"); await symlink(join(root, "raw.log"), join(linkRoot, "link")); assert.throws(() => execFileSync(process.execPath, [runner, linkRoot], { stdio: "pipe" }));
});
test("nonempty actual unit/JUnit fixture succeeds", async () => { const root = await fixture(); await unitFixture(root); assert.equal(await assertUnit(root), 1); });
for (const kind of ["zero", "skipped", "failed", "missingAssertions", "invalidJson", "empty", "missing"]) test(`unit evidence rejects ${kind}`, async () => {
  const root = await fixture(); const data = await unitFixture(root);
  if (kind === "zero") data.numTotalTests = data.numPassedTests = 0;
  if (kind === "skipped") data.numPendingTests = 1;
  if (kind === "failed") data.testResults[0].assertionResults[0].status = "failed";
  if (kind === "missingAssertions") data.testResults = [];
  await json(root, "unit.json", data);
  if (["invalidJson", "empty"].includes(kind)) await writeFile(join(root, "unit.json"), kind === "empty" ? "" : "{");
  if (kind === "missing") { const { unlink } = await import("node:fs/promises"); await unlink(join(root, "unit.xml")); }
  await assert.rejects(assertUnit(root));
});
test("JUnit failure, skip and zero testcase reject", async () => { const root = await fixture(); for (const xml of ['<testsuites/>', '<testsuites><testcase><skipped/></testcase></testsuites>', '<testsuites failures="1"><testcase/></testsuites>']) { await writeFile(join(root, "bad.xml"), xml); await assert.rejects(assertJUnit(join(root, "bad.xml"), 1)); } });
test("standard XML parser accepts reporter-shaped JUnit, comments/CDATA and single quotes", async () => {
  const root = await fixture();
  for (const xml of [
    '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="1" failures="0" errors="0"><testsuite tests="1" skipped="0"><properties><property name="synthetic" value="fixture"/></properties><testcase name="synthetic"><system-out><![CDATA[<testcase/><failure/> <!DOCTYPE text>]]></system-out></testcase></testsuite></testsuites>',
    "<testsuite tests='1' failures='0' errors='0' skipped='0'><!-- <testcase/> --><testcase/></testsuite>",
  ]) { await writeFile(join(root, "normal.xml"), xml); await assertJUnit(join(root, "normal.xml"), 1); }
  assert.equal(parserRuntime().isolated, true);
});
for (const [kind, xml] of Object.entries({
  unclosed: '<testsuites><testcase/>BROKEN', multipleRoots: '<testsuite tests="1"><testcase/></testsuite><testsuite/>', duplicateAttribute: '<testsuite tests="1" tests="1"><testcase/></testsuite>',
  wrongRoot: '<wrapper><testsuite tests="1"><testcase/></testsuite></wrapper>', wrongHierarchy: '<testsuites tests="1"><testcase/></testsuites>', namespace: '<testsuite xmlns="synthetic" tests="1"><testcase/></testsuite>',
  falseCommentCount: '<testsuite tests="1"><!-- <testcase/> --></testsuite>', falseCDataCount: '<testsuite tests="1"><system-out><![CDATA[<testcase/>]]></system-out></testsuite>',
  wrongSuiteCount: '<testsuite tests="2"><testcase/></testsuite>', wrongRootCount: '<testsuites tests="2"><testsuite tests="1"><testcase/></testsuite></testsuites>',
  singleQuoteFailure: "<testsuite tests='1' failures='1'><testcase/></testsuite>", negative: '<testsuite tests="1" errors="-1"><testcase/></testsuite>', decimal: '<testsuite tests="1" skipped="0.0"><testcase/></testsuite>', exponent: '<testsuite tests="1e0"><testcase/></testsuite>', nan: '<testsuite tests="NaN"><testcase/></testsuite>',
  doctype: '<!DOCTYPE testsuite><testsuite tests="1"><testcase/></testsuite>', externalEntity: '<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///synthetic-forbidden">]><testsuite tests="1"><testcase><system-out>&x;</system-out></testcase></testsuite>',
  internalEntity: '<!DOCTYPE testsuite [<!ENTITY x "synthetic">]><testsuite tests="1"><testcase><system-out>&x;</system-out></testcase></testsuite>',
  failure: '<testsuite tests="1"><testcase><failure/></testcase></testsuite>', error: '<testsuite tests="1"><testcase><error/></testcase></testsuite>', skip: '<testsuite tests="1"><testcase><skipped/></testcase></testsuite>', retry: '<testsuite tests="1"><testcase><rerunFailure/></testcase></testsuite>',
})) test(`JUnit actual XML rejects ${kind}`, async () => { const root = await fixture(); await writeFile(join(root, "invalid.xml"), xml); await assert.rejects(assertJUnit(join(root, "invalid.xml"), 1)); });
test("XML invalid UTF-8, zero expected count, oversize and missing Python fail closed", async () => {
  const root = await fixture(); const path = join(root, "invalid.xml");
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(assertJUnit(path, 1)); await assert.rejects(assertJUnit(path, 0));
  await writeFile(path, Buffer.alloc(20 * 1024 * 1024 + 1)); await assert.rejects(assertJUnit(path, 1), /20 MiB/);
  const runner = new URL("../scripts/ci-evidence-parser.mjs", import.meta.url).href;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `import {parserRuntime} from ${JSON.stringify(runner)};parserRuntime();`], { env: { PATH: "/synthetic-no-python" }, stdio: "pipe" }));
});
test("ZIP, PNG and HTML actual artifacts reject prefixes, truncation, CRC and identity mismatch", () => {
  const project = PROJECTS[0]; const trace = generatedFixture("trace", project);
  assert.ok(standardLibraryCheck("trace", trace, [JSON.stringify(project)]).entries);
  for (const bad of [Buffer.from([0x50, 0x4b, 0x03, 0x04]), trace.subarray(0, 30)]) assert.throws(() => standardLibraryCheck("trace", bad, [JSON.stringify(project)]));
  const badTrace = Buffer.from(trace); const central = badTrace.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central > 0); badTrace[central + 16] ^= 1; assert.throws(() => standardLibraryCheck("trace", badTrace, [JSON.stringify(project)]));
  assert.throws(() => standardLibraryCheck("trace", trace, [JSON.stringify(PROJECTS[1])]));
  const viewport = project.viewport; const png = generatedFixture("png", viewport);
  assert.equal(standardLibraryCheck("png", png, [JSON.stringify(viewport)]).width, viewport.width);
  const corrupted = Buffer.from(png); corrupted[32] ^= 1;
  for (const bad of [Buffer.from("not PNG"), png.subarray(0, 32), corrupted]) assert.throws(() => standardLibraryCheck("png", bad, [JSON.stringify(viewport)]));
  const entries = [htmlEntry(project)]; const html = generatedFixture("html", entries);
  assert.equal(standardLibraryCheck("html", html, [JSON.stringify(entries)]).tests, 1);
  for (const bad of [Buffer.from("not HTML"), Buffer.from('<html><title>Playwright Test Report</title></html>'), html.subarray(0, html.length - 7)]) assert.throws(() => standardLibraryCheck("html", bad, [JSON.stringify(entries)]));
  for (const bad of [html.toString().replace("<body>", '<body><div id="playwrightReportBase64"></div>'), html.toString().replace('id="playwrightReportBase64"', 'id="wrong" id="playwrightReportBase64"'), html.toString().replace('<template id=', '<template><template id=').replace('</template>', '</template></template>')]) assert.throws(() => standardLibraryCheck("html", Buffer.from(bad), [JSON.stringify(entries)]));
  assert.throws(() => standardLibraryCheck("html", html, [JSON.stringify([{ ...entries[0], projectName: "synthetic-mismatch" }])]));
});
test("HTML complete multi-file summary/detail and canonical results succeed regardless of ordering", () => {
  const entries = [htmlEntry(PROJECTS[0]), htmlEntry(PROJECTS[1], 1)];
  entries[1].location.file = "synthetic-other.spec.ts";
  for (const mutation of [undefined, "reorderedNormal"]) assert.equal(standardLibraryCheck("html", generatedFixture("html", { tests: entries, mutation }), [JSON.stringify(entries)]).tests, 2);
});
for (const mutation of ["missingDetail", "extraDetail", "duplicateFile", "duplicateSummaryTest", "duplicateDetailTest", "missingDetailTest", "extraDetailTest", "detailFileId", "detailFileName", "testId", "title", "projectName", "location", "boolLocation", "retry", "boolRetry", "stringRetry", "missingRetry", "failed", "skipped", "timedOut", "interrupted", "errors", "missingErrors", "singularError", "missingResultField", "multipleAttempts", "missingResults", "outcome", "ok", "repeat", "duration", "testBoolDuration", "summaryBoolDuration", "summaryBoolLocation", "startTime", "workerIndex", "boolWorker", "summaryBoolWorker", "summaryResult", "fileStats", "reportStats", "boolStats", "duplicateKey", "nonfinite"]) test(`HTML detail rejects ${mutation} while ZIP CRC is regenerated`, () => {
  const entries = [htmlEntry(PROJECTS[0]), htmlEntry(PROJECTS[1], 1)];
  const artifact = generatedFixture("html", { tests: entries, mutation });
  assert.throws(() => standardLibraryCheck("html", artifact, [JSON.stringify(entries)]));
});
test("HTML refuses canonical missing/duplicate/changed test IDs and results", () => {
  const entries = [htmlEntry(PROJECTS[0]), htmlEntry(PROJECTS[1], 1)]; const artifact = generatedFixture("html", entries);
  for (const mutation of ["missing", "duplicate", "changedId", "changedResult"]) {
    const expected = structuredClone(entries);
    if (mutation === "missing") delete expected[0].testId;
    if (mutation === "duplicate") expected[1].testId = expected[0].testId;
    if (mutation === "changedId") expected[0].testId = "synthetic-wrong";
    if (mutation === "changedResult") expected[0].result.duration += 1;
    assert.throws(() => standardLibraryCheck("html", artifact, [JSON.stringify(expected)]));
  }
});
test("ZIP rejects unsafe paths, symlinks, entries/bombs, malformed and empty execution traces", () => {
  const project = PROJECTS[0];
  for (const entries of [
    [{ name: "../outside.trace" }], [{ name: "/absolute.trace" }], [{ name: "trace.trace", symlink: true }], [{ name: "trace.trace" }, { name: "trace.trace" }],
    Array.from({ length: 501 }, (_, index) => ({ name: `synthetic-${index}.trace` })),
    [{ name: "bomb.trace", data: "x", repeat: 20 * 1024 * 1024 + 1 }],
    [{ name: "trace.trace", data: "{" }], [{ name: "trace.trace", data: JSON.stringify({ type: "context-options", browserName: project.browserName, options: { viewport: project.viewport } }) }],
  ]) assert.throws(() => standardLibraryCheck("trace", generatedFixture("zip", entries), [JSON.stringify(project)]));
});
test("trusted unit reporter records real diagnostics and unit rejects retry/missing/identity history", async () => {
  const root = await fixture(); await unitFixture(root);
  const history = JSON.parse(await readFile(join(root, "unit-history.json"), "utf8"));
  for (const kind of ["retry", "repeat", "flaky", "error", "identity", "missing"]) {
    const bad = structuredClone(history);
    if (kind === "retry") bad.tests[0].retryCount = 1;
    if (kind === "repeat") bad.tests[0].repeatCount = 1;
    if (kind === "flaky") bad.tests[0].flaky = true;
    if (kind === "error") bad.tests[0].errors = 1;
    if (kind === "identity") bad.tests[0].file = "wrong-synthetic.unit.ts";
    if (kind === "missing") bad.tests = [];
    await json(root, "unit-history.json", bad); await assert.rejects(assertUnit(root), /history/);
  }
  const reporter = new CIUnitReporter();
  reporter.onTestCaseResult({ id: "synthetic", module: { moduleId: "synthetic.unit.ts" }, parent: { type: "module" }, name: "synthetic", result: () => ({ state: "passed", errors: [] }), diagnostic: () => ({ retryCount: 1, repeatCount: 0, flaky: true }) });
  assert.equal(reporter.tests[0].retryCount, 1); assert.equal(reporter.tests[0].flaky, true);
});
test("real Vitest per-test retry is recorded and rejected even when standard reports pass", async () => {
  const root = await fixture();
  const config = join(root, "synthetic-vitest.config.mjs");
  await writeFile(config, 'export default { test: { environment: "node", include: ["synthetic.test.mjs"] } };');
  await writeFile(join(root, "synthetic.test.mjs"), `import { test, expect } from ${JSON.stringify(join(projectRoot, "node_modules/vitest/dist/index.js"))}; let tries=0; test("synthetic retry", {retry:1}, ()=>{tries++;expect(tries).toBe(2)});`);
  const result = execFileSync(process.execPath, [join(projectRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", root, "--config", config, "--retry=0", "--reporter=json", "--reporter=junit", `--reporter=${join(projectRoot, "harness/scripts/ci-unit-reporter.mjs")}`, `--outputFile.json=${join(root, "unit.json")}`, `--outputFile.junit=${join(root, "unit.xml")}`], { cwd: projectRoot, env: { ...cleanEnvironment(), SNS_CI_OUTPUT: root }, encoding: "utf8" });
  assert.match(result, /report written/);
  const data = JSON.parse(await readFile(join(root, "unit.json"), "utf8"));
  const history = JSON.parse(await readFile(join(root, "unit-history.json"), "utf8"));
  assert.equal(data.success, true); assert.equal(history.tests[0].retryCount, 1); assert.equal(history.tests[0].flaky, true);
  await assert.rejects(assertUnit(root), /history/);
});
test("Playwright two-project normal fixture succeeds", async () => { const root = await fixture(); const { expected } = await playwrightFixture(root); assert.equal(await assertPlaywright(root, expected), 2); });
for (const kind of ["zero", "missingProject", "skip", "retry", "flaky", "workers", "globalError", "missingTrace", "invalidTrace", "externalTrace", "symlinkTrace", "missingViewport", "wrongViewport", "wrongIdentity", "missingHtml"]) test(`Playwright rejects ${kind}`, async () => {
  const root = await fixture(); const { data, viewport, expected } = await playwrightFixture(root); const result = data.suites[0].specs[0].tests[0];
  if (kind === "zero") data.suites = [];
  if (kind === "missingProject") data.config.projects.pop();
  if (kind === "skip") result.results[0].status = "skipped";
  if (kind === "retry") result.results[0].retry = 1;
  if (kind === "flaky") result.status = "flaky";
  if (kind === "workers") data.config.workers = 2;
  if (kind === "globalError") data.errors.push({ message: "synthetic" });
  if (kind === "missingTrace") result.results[0].attachments = [];
  if (kind === "invalidTrace") await writeFile(join(root, "test-results", "trace-0.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (kind === "externalTrace") { const outside = await fixture(); const path = join(outside, "trace.zip"); await writeFile(path, Buffer.from([0x50, 0x4b])); result.results[0].attachments[0].path = path; }
  if (kind === "symlinkTrace") { const outside = await fixture(); const path = join(outside, "trace.zip"); await writeFile(path, Buffer.from([0x50, 0x4b])); const { symlink } = await import("node:fs/promises"); const link = join(root, "test-results", "link.zip"); await symlink(path, link); result.results[0].attachments[0].path = link; }
  if (kind === "missingViewport") viewport.tests.pop();
  if (kind === "wrongViewport") viewport.tests[0].viewport.width = 1;
  if (kind === "wrongIdentity") viewport.tests[0].location.file = "synthetic-wrong-file.ts";
  if (kind === "missingHtml") await writeFile(join(root, "playwright-report", "index.html"), "");
  await json(root, "playwright.json", data); await json(root, "viewports.json", viewport);
  await assert.rejects(assertPlaywright(root, expected));
});
test("real-shaped axe fixture succeeds and missing/serious/error viewports fail", async () => {
  const root = await fixture(); const data = await axeFixture(root); assert.equal(await assertAxe(root), 4);
  for (const kind of ["missing", "serious", "error", "emptyPasses", "wrongViewport", "invalidPNG", "invalidZIP"]) {
    const badRoot = await fixture(); await axeFixture(badRoot);
    const bad = structuredClone(data);
    if (kind === "missing") bad.probes.pop();
    if (kind === "serious") bad.probes[0].axe.violations.push({ impact: "serious" });
    if (kind === "error") bad.probes[0].errors.push("synthetic console error");
    if (kind === "emptyPasses") bad.probes[0].axe.passes = [];
    if (kind === "wrongViewport") bad.probes[0].viewport.height = 1;
    if (kind === "invalidPNG") await writeFile(join(badRoot, `${PROJECTS[0].name}.png`), "not a PNG");
    if (kind === "invalidZIP") await writeFile(join(badRoot, `${PROJECTS[0].name}.trace.zip`), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await json(badRoot, "accessibility.json", bad); await assert.rejects(assertAxe(badRoot));
  }
});
test("evidence hashes actual bytes, rejects empty/symlink/oversize", async () => {
  const root = await fixture(); await writeFile(join(root, "raw.log"), "synthetic raw evidence");
  assert.equal((await evidenceManifest(root, "a".repeat(40))).files.length, 1);
  await writeFile(join(root, "raw.log"), ""); await assert.rejects(evidenceManifest(root, "a".repeat(40)));
  await writeFile(join(root, "raw.log"), Buffer.alloc(20 * 1024 * 1024)); await assert.rejects(evidenceManifest(root, "a".repeat(40)), /20 MiB/);
  const linkRoot = await fixture(); const { symlink } = await import("node:fs/promises"); await symlink(join(root, "raw.log"), join(linkRoot, "link")); await assert.rejects(evidenceManifest(linkRoot, "a".repeat(40)), /symlinks/);
});
test("workflow trust, runtime, real commands, seven statuses and board isolation stay explicit", async () => {
  const quality = await readFile(join(projectRoot, ".github/workflows/quality-gates.yml"), "utf8");
  const independent = await readFile(join(projectRoot, ".github/workflows/independent-review.yml"), "utf8");
  const smoke = await readFile(join(projectRoot, ".github/workflows/post-merge-smoke.yml"), "utf8");
  for (const text of [quality, independent, smoke]) { assert.match(text, /node-version: 24\.15\.0/); assert.match(text, /npm@11\.12\.1/); assert.match(text, /package-manager-cache: false/); assert.match(text, /retention-days: 1/); assert.doesNotMatch(text, /npm run test:(?:migrate|e2e:chromium|e2e:webkit-mobile|a11y)\b/); }
  for (const text of [quality, independent, smoke]) { assert.match(text, /actions\/setup-python@83679a892e2d95755f2dac6acb0bfd1e9ac5d548/); assert.match(text, /python-version: 3\.12\.14/); assert.doesNotMatch(text, /^\s+cache: /m); }
  const verify = independent.split("  verify:")[1].split("  board:")[0];
  assert.match(verify, /node trusted\/harness\/scripts\/ci-quality.mjs/); assert.doesNotMatch(verify, /secrets\.|: write|github-token:/);
  assert.equal((verify.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.equal((quality.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(independent, /name: board-review/); assert.match(independent, /secrets.GATEKEEPER_APP_PRIVATE_KEY/);
  const contexts = independent.split("const contexts = [")[1].split("];", 1)[0];
  assert.equal((contexts.match(/"(?:governance|quality|review)\//g) ?? []).length, 7);
  assert.doesNotMatch(quality, /secrets\.|: write/);
  const runner = await readFile(join(projectRoot, "harness/scripts/ci-quality.mjs"), "utf8");
  assert.doesNotMatch(runner, /run-playwright\.mjs/); assert.match(runner, /--workers=1/); assert.match(runner, /--retries=0/); assert.match(runner, /--forbid-only/);
  assert.match(runner, /--retry=0/); assert.match(runner, /ci-unit-reporter\.mjs/); assert.match(runner, /environment\.parserRuntime = parserRuntime/);
});
