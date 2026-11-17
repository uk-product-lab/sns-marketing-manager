import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const PROJECTS = [
  { name: "chromium-mac-1440x900", browserName: "chromium", viewport: { width: 1440, height: 900 } },
  { name: "chromium-macbook-1512x982", browserName: "chromium", viewport: { width: 1512, height: 982 } },
  { name: "webkit-iphone-390x844", browserName: "webkit", viewport: { width: 390, height: 844 } },
  { name: "webkit-iphone-393x852", browserName: "webkit", viewport: { width: 393, height: 852 } },
];
const allSpecs = (suites = []) => suites.flatMap((s) => [...(s.specs ?? []), ...allSpecs(s.suites)]);
let total = 0; const out = [];
for (const [gate, browser] of [["e2e-chromium", "chromium"], ["e2e-webkit-mobile", "webkit"]]) {
  const dir = join(root, gate);
  const data = JSON.parse(readFileSync(join(dir, "playwright.json"), "utf8"));
  const expected = PROJECTS.filter((p) => p.browserName === browser);
  const tests = allSpecs(data.suites).flatMap((spec) => spec.tests.map((t) => ({ ...t, title: spec.title, file: spec.file, line: spec.line })));
  const names = data.config.projects.map((p) => p.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected.map((p) => p.name).sort())) throw new Error("project mismatch " + gate);
  if (data.errors.length) throw new Error("global errors " + gate);
  if (data.config.workers !== 1 || data.config.projects.some((p) => p.retries !== 0 || p.repeatEach !== 1)) throw new Error("workers/retries " + gate);
  for (const t of tests) {
    const r = t.results;
    if (t.status !== "expected" || t.expectedStatus !== "passed" || r.length !== 1 || r[0].status !== "passed" || r[0].retry !== 0 || r[0].errors.length) throw new Error("test not clean pass: " + t.title);
    const trace = r[0].attachments.find((a) => a.name === "trace");
    if (!trace || !existsSync(trace.path) || statSync(trace.path).size === 0) throw new Error("trace missing: " + t.title);
    out.push(`${gate}\t${t.projectName}\t${t.file}:${t.line}\t${r[0].status}\tretry=${r[0].retry}\t${r[0].duration}ms\ttrace=${statSync(trace.path).size}B`);
  }
  const vp = JSON.parse(readFileSync(join(dir, "viewports.json"), "utf8"));
  if (vp.status !== "passed" || vp.tests.length !== tests.length) throw new Error("viewports " + gate);
  for (const e of expected) {
    const entries = vp.tests.filter((t) => t.project === e.name);
    if (!entries.length || entries.some((t) => JSON.stringify(t.viewport) !== JSON.stringify(e.viewport) || t.browserName !== e.browserName || t.retry !== 0 || t.status !== "passed")) throw new Error("viewport entry " + e.name);
  }
  const junit = readFileSync(join(dir, "test-results.xml"), "utf8");
  const m = junit.match(/<testsuites[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*skipped="(\d+)"[^>]*errors="(\d+)"/);
  out.push(`${gate}\tjunit tests=${m[1]} failures=${m[2]} skipped=${m[3]} errors=${m[4]}\tstats=${JSON.stringify(data.stats)}`.replace(/"startTime":"[^"]*",?/, ""));
  if (m[1] !== String(tests.length) || m[2] !== "0" || m[3] !== "0" || m[4] !== "0") throw new Error("junit " + gate);
  if (data.stats.expected !== tests.length || data.stats.skipped || data.stats.unexpected || data.stats.flaky) throw new Error("stats " + gate);
  total += tests.length;
}
const axe = JSON.parse(readFileSync(join(root, "accessibility", "accessibility.json"), "utf8"));
if (axe.probes.length !== 4) throw new Error("axe probes");
for (const e of PROJECTS) {
  const p = axe.probes.find((x) => x.project === e.name);
  const bad = p.axe.violations.filter((v) => ["critical", "serious"].includes(v.impact));
  if (!p || JSON.stringify(p.viewport) !== JSON.stringify(e.viewport) || p.httpStatus !== 200 || p.errors.length || !p.network.length || bad.length || !p.axe.passes.length) throw new Error("axe " + e.name);
  out.push(`accessibility\t${e.name}\thttp=${p.httpStatus}\terrors=${p.errors.length}\tviolations=${p.axe.violations.length}\tcritical+serious=${bad.length}\tpasses=${p.axe.passes.length}\tincomplete=${p.axe.incomplete.length}\taxe=${p.axe.testEngine.version}\tnetwork=${p.network.length}`);
}
console.log(out.join("\n")); console.log(`RUN_A_OK e2e=${total} axeProbes=4`);
