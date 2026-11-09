import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as probe from "../scripts/board-actor-probe.mjs";

// All API responses, clocks, identities and archives below are synthetic LOCAL fixtures.
const NOW = Date.parse("2026-10-08T03:00:00.000Z"), SHA = "a".repeat(40), OTHER_SHA = "b".repeat(40);
const PROBE_ID = "00000000-0000-4000-8000-000000000006", SOURCE = 100, RECEIVER = 101, REPO_ID = 600, WORKFLOW_ID = 700;
const actor = { login: probe.BOARD_LOGIN, id: 80, type: "User" };
const bot = { login: "github-actions[bot]", id: 81, type: "Bot" };
const clone = (value) => structuredClone(value);
const digest = (buffer) => "sha256:" + createHash("sha256").update(buffer).digest("hex");
const instant = (delta = 0) => new Date(NOW + delta).toISOString();
const input = (mode = "dispatch") => ({ mode, probe_id: PROBE_ID, fixed_sha: SHA, source_run_id: mode === "receive" ? String(SOURCE) : "", source_attempt: mode === "receive" ? "1" : "", acknowledgement: "SYNTHETIC_PROBE_ONLY" });
const context = (mode = "dispatch") => ({ repository: probe.REPOSITORY, repositoryId: REPO_ID, runId: mode === "receive" ? RECEIVER : SOURCE,
  runAttempt: 1, eventName: "workflow_dispatch", ref: "refs/heads/main", sha: SHA,
  workflowRef: `${probe.REPOSITORY}/${probe.WORKFLOW}@refs/heads/main`, workflowSha: SHA,
  actor: mode === "receive" ? bot.login : actor.login, actorId: mode === "receive" ? bot.id : actor.id, triggeringActor: mode === "receive" ? bot.login : actor.login });
function run(mode, id) {
  const user = mode === "receive" ? bot : actor;
  return { id, workflow_id: WORKFLOW_ID, path: `${probe.WORKFLOW}@main`, event: "workflow_dispatch", head_branch: "main", head_sha: SHA,
    run_attempt: 1, repository: { id: REPO_ID, full_name: probe.REPOSITORY }, head_repository: { id: REPO_ID, full_name: probe.REPOSITORY },
    actor: clone(user), triggering_actor: clone(user), created_at: instant(mode === "receive" ? 0 : -20_000), status: "in_progress", conclusion: null,
    display_title: `board-actor-probe:${mode}:${PROBE_ID}`, url: `https://api.github.com/repos/${probe.REPOSITORY}/actions/runs/${id}`,
    html_url: `https://github.com/${probe.REPOSITORY}/actions/runs/${id}` };
}
function fixture(mode = "dispatch") {
  const calls = [], state = {
    repository: { id: REPO_ID, full_name: probe.REPOSITORY, default_branch: "main", private: false },
    branch: { name: "main", commit: { sha: SHA } }, workflow: { id: WORKFLOW_ID, path: probe.WORKFLOW, state: "active" },
    environment: { id: 900, name: probe.ENVIRONMENT, can_admins_bypass: false,
      protection_rules: [{ type: "branch_policy" }, { type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: clone(actor) }] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    policies: { total_count: 1, branch_policies: [{ id: 901, name: "main", type: "branch" }] },
    source: run(mode === "direct-negative" ? mode : "dispatch", SOURCE), receiver: run("receive", RECEIVER), artifacts: [],
    list: null, receiverCreated: mode === "receive", archive: null, history: [{ state: "approved", environments: [{ id: 900, name: probe.ENVIRONMENT }], user: clone(actor) }],
    dispatchResponse: { status: 200, data: { workflow_run_id: RECEIVER, run_url: `https://api.github.com/repos/${probe.REPOSITORY}/actions/runs/${RECEIVER}`, html_url: `https://github.com/${probe.REPOSITORY}/actions/runs/${RECEIVER}` } },
    readStatus: 200, override: null, now: NOW,
  };
  const api = {
    async request(route, params) {
      calls.push({ route, params: clone(params) });
      assert.equal(params.headers["X-GitHub-Api-Version"], probe.API_VERSION);
      assert.equal(params.owner + "/" + params.repo, probe.REPOSITORY);
      if (state.override) { const value = state.override(route, params); if (value !== undefined) return value; }
      if (route.startsWith("POST ")) { state.receiverCreated = true; return state.dispatchResponse; }
      let data;
      if (route === "GET /repos/{owner}/{repo}") data = state.repository;
      else if (route.endsWith("/branches/{branch}")) data = state.branch;
      else if (route.endsWith("/actions/workflows/{workflow_id}")) data = state.workflow;
      else if (route.endsWith("/environments/{environment_name}")) data = state.environment;
      else if (route.endsWith("/deployment-branch-policies")) data = state.policies;
      else if (route.endsWith("/actions/workflows/{workflow_id}/runs")) { const runs = state.list ?? [state.source, ...(state.receiverCreated ? [state.receiver] : [])]; data = { total_count: runs.length, workflow_runs: runs }; }
      else if (route.endsWith("/actions/runs/{run_id}")) { if (params.run_id !== SOURCE) assert.equal(state.receiverCreated, true); data = params.run_id === SOURCE ? state.source : state.receiver; }
      else if (route.endsWith("/artifacts")) data = { total_count: state.artifacts.length, artifacts: state.artifacts };
      else if (route.endsWith("/approvals")) data = state.history;
      else throw new Error("Unknown synthetic route");
      return { status: state.readStatus, data: clone(data) };
    },
    async download(id) { calls.push({ download: id }); assert.equal(id, 950); return state.archive; },
  };
  return { state, calls, api, context: context(mode), inputs: input(mode), options: { now: () => state.now } };
}

// Python's standard ZIP writer emits real stored/deflated entries; a non-seekable
// sink emits data descriptors just as the upload Action's streaming archiver does.
function zip(content, { name = "dispatch-receipt.json", compressed = false, stream = false, extra = false, attributes = null, creator = 3 } = {}) {
  const program = String.raw`
import io, sys, zipfile
class Sink(io.BytesIO):
    def seek(self, *args): raise OSError("nonseekable")
    def tell(self): raise OSError("nonseekable")
target = Sink() if sys.argv[3] == 'stream' else io.BytesIO()
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED if sys.argv[2] == 'deflated' else zipfile.ZIP_STORED) as out:
    name = sys.argv[1]
    if sys.argv[5]:
        name = zipfile.ZipInfo(name)
        name.create_system = int(sys.argv[6])
        name.external_attr = int(sys.argv[5])
        name.compress_type = out.compression
    out.writestr(name, sys.stdin.buffer.read())
    if sys.argv[4] == 'extra': out.writestr('unexpected.json', '{}')
sys.stdout.buffer.write(target.getvalue())
`;
  return execFileSync("python3", ["-I", "-c", program, name, compressed ? "deflated" : "stored", stream ? "stream" : "seekable", extra ? "extra" : "single", attributes === null ? "" : String(attributes), String(creator)], { input: content, maxBuffer: 1024 * 1024 });
}
function packageReceipt(f, receipt) {
  f.state.archive = zip(JSON.stringify(receipt, null, 2) + "\n", { stream: true });
  f.state.artifacts = [{ id: 950, name: probe.receiptName(SOURCE), size_in_bytes: f.state.archive.length, expired: false,
    digest: digest(f.state.archive), created_at: instant(), expires_at: instant(24 * 60 * 60 * 1000),
    workflow_run: { id: SOURCE, repository_id: REPO_ID, head_repository_id: REPO_ID, head_branch: "main", head_sha: SHA } }];
}
async function readyFixture() {
  const f = fixture(), dispatched = await probe.dispatchProbe(f.api, f.context, f.inputs, f.options);
  f.inputs = input("receive"); f.context = context("receive"); f.state.source.status = "completed"; f.state.source.conclusion = "success";
  packageReceipt(f, dispatched.receipt); f.receipt = dispatched.receipt; f.calls.length = 0;
  return f;
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error instanceof probe.ProbeError && (!code || error.code === code));

test("PROBE-002/003 dispatcher executes one fixed main POST and captures actual source/receiver identity", async () => {
  const f = fixture(); assert.equal(f.state.receiverCreated, false);
  const result = await probe.dispatchProbe(f.api, f.context, f.inputs, f.options); assert.equal(f.state.receiverCreated, true);
  const writes = f.calls.filter((item) => item.route?.startsWith("POST "));
  assert.equal(writes.length, 1); assert.equal(writes[0].params.ref, "main"); assert.equal(writes[0].params.workflow_id, "board-actor-probe.yml");
  assert.equal(writes[0].params.inputs.mode, "receive"); assert.equal(result.receipt.receiver.id, RECEIVER);
  assert.deepEqual(result.receipt.receiver.run.actor, bot); assert.equal(result.receipt.source.workflowSha, SHA);
  assert.equal(result.receipt.source.actor.id, actor.id); assert.equal(f.calls.some((item) => /secrets|variables|statuses|deployments\//.test(item.route ?? "")), false);
});
for (const [name, change, code] of [
  ["204", (f) => { f.state.dispatchResponse = { status: 204, data: null }; }, "DISPATCH_RESPONSE_INVALID_NO_RETRY"],
  ["malformed 200", (f) => { f.state.dispatchResponse.data = {}; }, "DISPATCH_BODY_INVALID"],
  ["string id", (f) => { f.state.dispatchResponse.data.workflow_run_id = String(RECEIVER); }, "DISPATCH_BINDING_INVALID"],
  ["unsafe id", (f) => { f.state.dispatchResponse.data.workflow_run_id = Number.MAX_SAFE_INTEGER + 1; }, "DISPATCH_BINDING_INVALID"],
  ["source id", (f) => { f.state.dispatchResponse.data.workflow_run_id = SOURCE; }, "DISPATCH_BINDING_INVALID"],
  ["wrong URL", (f) => { f.state.dispatchResponse.data.html_url += "?token=synthetic"; }, "DISPATCH_BINDING_INVALID"],
  ["unknown body key", (f) => { f.state.dispatchResponse.data.extra = "synthetic"; }, "DISPATCH_BODY_INVALID"],
  ["lost POST response", (f) => { f.state.override = (route) => { if (route.startsWith("POST ")) throw new Error("Bearer synthetic-credential"); }; }, "DISPATCH_RESPONSE_UNKNOWN_NO_RETRY"],
]) test("PROBE-003 dispatch rejects " + name + " without second POST", async () => {
  const f = fixture(); change(f); await rejectsCode(probe.dispatchProbe(f.api, f.context, f.inputs, f.options), code);
  assert.equal(f.calls.filter((item) => item.route?.startsWith("POST ")).length, 1);
});

for (const [name, change] of [
  ["unknown input", (f) => { f.inputs.url = "https://synthetic.invalid"; }],
  ["unknown mode", (f) => { f.inputs.mode = "schedule"; }],
  ["recursive provenance", (f) => { f.inputs.source_run_id = String(SOURCE); }],
  ["attempt2", (f) => { f.context.runAttempt = 2; }],
  ["feature ref", (f) => { f.context.ref = "refs/heads/feature"; }],
  ["tag ref", (f) => { f.context.ref = "refs/tags/main"; }],
  ["wrong repo", (f) => { f.context.repository = "synthetic/fork"; }],
  ["wrong workflow ref", (f) => { f.context.workflowRef += "-evil"; }],
  ["stale main", (f) => { f.state.branch.commit.sha = OTHER_SHA; }],
  ["wrong workflow SHA", (f) => { f.context.workflowSha = OTHER_SHA; }],
  ["wrong actor context", (f) => { f.context.actorId++; }],
  ["bot recursion", (f) => { f.state.source.actor = clone(bot); f.state.source.triggering_actor = clone(bot); f.context.actor = bot.login; f.context.actorId = bot.id; f.context.triggeringActor = bot.login; }],
  ["already receipted", (f) => { f.state.artifacts = [{ name: probe.receiptName(SOURCE) }]; }],
  ["duplicate request", (f) => { f.state.list = [f.state.source, { ...f.state.source, id: 102 }]; }],
]) test("PROBE-002/004 dispatcher rejects " + name + " before any POST", async () => {
  const f = fixture(); change(f); await rejectsCode(probe.dispatchProbe(f.api, f.context, f.inputs, f.options));
  assert.equal(f.calls.filter((item) => item.route?.startsWith("POST ")).length, 0);
});

test("PROBE-003 receiver binds receipt to actual API run; key ordering is immaterial", async () => {
  const f = await readyFixture(); f.inputs = Object.fromEntries(Object.entries(f.inputs).reverse());
  const result = await probe.receiveProbe(f.api, f.context, f.inputs, f.options);
  assert.equal(result.snapshot.run.id, RECEIVER); assert.equal(result.source.id, SOURCE); assert.equal(result.artifact.id, 950);
  assert.equal(f.calls.filter((item) => item.route?.startsWith("POST ")).length, 0);
});
test("PROBE-003 readiness polls only READs for producer preparation", async () => {
  const f = await readyFixture(); f.state.source.status = "in_progress"; f.state.source.conclusion = null; f.state.artifacts = [];
  const waits = [];
  await probe.receiveProbe(f.api, f.context, f.inputs, { now: () => f.state.now, sleep: async (ms) => {
    waits.push(ms); f.state.now += ms;
    if (waits.length === 2) { f.state.source.status = "completed"; f.state.source.conclusion = "success"; packageReceipt(f, f.receipt); }
  } });
  assert.deepEqual(waits, [3000, 3000]); assert.equal(f.calls.some((item) => item.route?.startsWith("POST ")), false);
});
test("PROBE-003 readiness has exact 120s bound and BLOCKED, with no dispatch/rerun", async () => {
  const f = await readyFixture(); f.state.source.status = "in_progress"; f.state.source.conclusion = null; f.state.artifacts = [];
  let waits = 0;
  await assert.rejects(probe.receiveProbe(f.api, f.context, f.inputs, { now: () => f.state.now, sleep: async (ms) => { assert.equal(ms, 3000); waits++; f.state.now += ms; } }),
    (error) => error.code === "RECEIPT_READINESS_TIMEOUT" && error.result === "BLOCKED");
  assert.equal(waits, 40); assert.equal(f.state.now - NOW, probe.READ_WAIT_MS);
});
test("PROBE-003 terminal failed producer is immediate, no preparation wait", async () => {
  const f = await readyFixture(); f.state.source.conclusion = "failure";
  await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, { ...f.options, sleep: () => { assert.fail("must not sleep"); } }), "SOURCE_TERMINAL_FAILURE");
});
test("PROBE-003 a completed producer missing receipt never polls", async () => {
  const f = await readyFixture(); f.state.artifacts = [];
  await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, { ...f.options, sleep: () => { assert.fail("must not sleep"); } }), "COMPLETED_SOURCE_RECEIPT_MISSING");
});
test("PROBE-003 slow readiness READ cannot extend the120second preparation allowance", async () => {
  const f = await readyFixture();
  f.state.override = (route) => { if (route.endsWith("/artifacts")) f.state.now += probe.READ_WAIT_MS + 1; };
  await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, f.options), "RECEIPT_READINESS_TIMEOUT");
});
test("PROBE-004 duplicate identity across differentSHA is still rejected", async () => {
  const f = fixture(); f.state.list = [f.state.source, { ...f.state.source, id: 102, head_sha: OTHER_SHA }];
  await rejectsCode(probe.dispatchProbe(f.api, f.context, f.inputs, f.options), "DUPLICATE_PROBE_REJECTED");
});
for (const [mode, priorMode, status, priorSha] of [
  ["dispatch", "direct-negative", "success", SHA],
  ["dispatch", "direct-negative", "failure", OTHER_SHA],
  ["dispatch", "receive", "cancelled", SHA],
  ["dispatch", "unknown:phase", "failure", SHA],
  ["direct-negative", "dispatch", "success", SHA],
  ["direct-negative", "receive", "failure", OTHER_SHA],
  ["direct-negative", "unknown:phase", "in_progress", SHA],
  ["receive", "direct-negative", "success", SHA],
  ["receive", "dispatch", "failure", OTHER_SHA],
  ["receive", "unknown:phase", "cancelled", SHA],
]) test(`PROBE-004/009 runtime rejects UUID reuse ${priorMode}->${mode}/${status}/${priorSha === SHA ? "sameSHA" : "otherSHA"}`, async () => {
  const f = mode === "receive" ? await readyFixture() : fixture(mode), previous = run("direct-negative", 102);
  previous.display_title = `board-actor-probe:${priorMode}:${PROBE_ID}`; previous.head_sha = priorSha;
  previous.status = status === "in_progress" ? status : "completed"; previous.conclusion = status === "in_progress" ? null : status;
  f.state.list = [f.state.source, ...(mode === "receive" ? [f.state.receiver] : []), previous];
  const root = await mkdtemp(join(tmpdir(), "board-probe-uuid-replay-")), stage = mode === "dispatch" ? "dispatch" : "guard";
  await rejectsCode(probe.runWorkflowStage(stage, { ...f, ...f.options, root }), "DUPLICATE_PROBE_REJECTED");
  const failure = JSON.parse(await readFile(join(root, "observation", "result.json"), "utf8"));
  assert.equal(failure.positiveMarker, false); assert.equal(failure.code, "DUPLICATE_PROBE_REJECTED");
  assert.equal(f.calls.some((item) => item.route?.startsWith("POST ") || item.download), false);
  assert.deepEqual(await readdir(root), ["observation"]); // No bound receipt or positive marker.
});
for (const mode of ["dispatch", "receive", "direct-negative"]) test("PROBE-004 legitimate lifecycle ignores unrelated UUID: " + mode, async () => {
  const f = mode === "receive" ? await readyFixture() : fixture(mode), unrelated = run("direct-negative", 102);
  unrelated.display_title = "board-actor-probe:direct-negative:00000000-0000-4000-8000-000000000007";
  f.state.list = [f.state.source, ...(mode === "receive" ? [f.state.receiver] : []), unrelated];
  if (mode === "dispatch") assert.equal((await probe.dispatchProbe(f.api, f.context, f.inputs, f.options)).receipt.receiver.id, RECEIVER);
  else if (mode === "receive") assert.equal((await probe.receiveProbe(f.api, f.context, f.inputs, f.options)).source.id, SOURCE);
  else assert.equal((await probe.directNegativePreflight(f.api, f.context, f.inputs, f.options)).positiveMarker, false);
});
for (const [name, change] of [
  ["wrong claimed parent", (f) => { f.inputs.source_run_id = "102"; }],
  ["extra current UUID child", (f) => { f.state.list = [f.state.source, f.state.receiver, run("receive", 102)]; }],
]) test("PROBE-004 receiver rejects lifecycle " + name, async () => {
  const f = await readyFixture(); change(f);
  await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, f.options), "DUPLICATE_PROBE_REJECTED");
  assert.equal(f.calls.some((item) => item.route?.startsWith("POST ") || item.download), false);
});
test("PROBE-004 protected final READ rejects cross-mode reuse observed during approval lookup", async () => {
  const f = await readyFixture(), guard = await probe.receiveProbe(f.api, f.context, f.inputs, f.options);
  f.state.override = (route) => { if (route.endsWith("/approvals")) f.state.list = [f.state.source, f.state.receiver, run("direct-negative", 102)]; };
  const root = await mkdtemp(join(tmpdir(), "board-probe-last-uuid-"));
  await rejectsCode(probe.runWorkflowStage("protected", { ...f, ...f.options, root, expectedEnvironment: guard.snapshot.environment }), "DUPLICATE_PROBE_REJECTED");
  const failure = JSON.parse(await readFile(join(root, "observation", "result.json"), "utf8"));
  assert.equal(failure.positiveMarker, false); assert.equal(failure.synthetic, undefined);
});
for (const malformed of [
  { total_count: 1001, workflow_runs: [] }, { total_count: 3, workflow_runs: [run("dispatch", SOURCE)] },
  { total_count: 2, workflow_runs: [run("dispatch", SOURCE), run("dispatch", SOURCE)] },
  { total_count: 2, workflow_runs: [run("dispatch", SOURCE), { id: 102 }] },
]) test("PROBE-004 malformed/incomplete runpagination is BLOCKED", async () => {
  const f = fixture(); f.state.override = (route) => route.endsWith("/workflows/{workflow_id}/runs") ? { status: 200, data: malformed } : undefined;
  await assert.rejects(probe.dispatchProbe(f.api, f.context, f.inputs, f.options), (error) => error.result === "BLOCKED");
});

for (const [name, change] of [
  ["forged receiver", (f) => { f.receipt.receiver.id++; packageReceipt(f, f.receipt); }],
  ["forged source", (f) => { f.receipt.source.actor.id++; packageReceipt(f, f.receipt); }],
  ["forged receipt repo", (f) => { f.receipt.repository = "synthetic/fork"; packageReceipt(f, f.receipt); }],
  ["forged receiver actor", (f) => { f.receipt.receiver.run.actor.id++; packageReceipt(f, f.receipt); }],
  ["forged phase", (f) => { f.receipt.source.mode = "receive"; packageReceipt(f, f.receipt); }],
  ["extra receipt key", (f) => { f.receipt.access_token = "short-canary"; packageReceipt(f, f.receipt); }],
  ["future receipt", (f) => { f.receipt.dispatchedAt = instant(1); packageReceipt(f, f.receipt); }],
  ["expired receipt", (f) => { f.receipt.dispatchedAt = instant(-probe.RECEIPT_TTL_MS - 1); packageReceipt(f, f.receipt); }],
  ["wrong source workflow", (f) => { f.state.source.path = ".github/workflows/independent-review.yml"; }],
  ["wrong source workflow id", (f) => { f.state.source.workflow_id++; }],
  ["producer attempt2", (f) => { f.state.source.run_attempt = 2; }],
  ["receiver attempt2", (f) => { f.state.receiver.run_attempt = 2; }],
  ["changed triggering actor", (f) => { f.state.receiver.triggering_actor = clone(actor); }],
  ["fork head", (f) => { f.state.receiver.head_repository.id++; }],
  ["wrong receiver SHA", (f) => { f.state.receiver.head_sha = OTHER_SHA; }],
  ["unknown receiver phase", (f) => { f.state.receiver.display_title = "synthetic"; }],
  ["human receiver", (f) => { f.state.receiver.actor = clone(actor); f.state.receiver.triggering_actor = clone(actor); f.context.actor = actor.login; f.context.actorId = actor.id; f.context.triggeringActor = actor.login; }],
  ["duplicate receiver", (f) => { f.state.list = [f.state.source, f.state.receiver, { ...f.state.receiver, id: 102 }]; }],
  ["invalid run timestamp", (f) => { f.state.source.created_at = "invalid"; }],
  ["impossible calendar date", (f) => { f.state.source.created_at = "2026-02-30T03:00:00Z"; }],
  ["future run timestamp", (f) => { f.state.source.created_at = instant(1); }],
  ["expired run", (f) => { f.state.source.created_at = instant(-probe.RECEIPT_TTL_MS - 1); }],
  ["missing digest", (f) => { delete f.state.artifacts[0].digest; }],
  ["wrong digest", (f) => { f.state.artifacts[0].digest = "sha256:" + "0".repeat(64); }],
  ["modified ZIP", (f) => { f.state.archive[50] ^= 1; }],
  ["wrong byte length", (f) => { f.state.artifacts[0].size_in_bytes++; }],
  ["wrong artifact owner", (f) => { f.state.artifacts[0].workflow_run.repository_id++; }],
  ["wrong artifact source", (f) => { f.state.artifacts[0].workflow_run.id++; }],
  ["wrong artifact SHA", (f) => { f.state.artifacts[0].workflow_run.head_sha = OTHER_SHA; }],
  ["expired artifact", (f) => { f.state.artifacts[0].expired = true; }],
  ["artifact before source", (f) => { f.state.artifacts[0].created_at = instant(-21_000); }],
  ["future artifact", (f) => { f.state.artifacts[0].created_at = instant(1); }],
  ["duplicate receipt", (f) => { f.state.artifacts.push(clone(f.state.artifacts[0])); }],
  ["overretained artifact", (f) => { f.state.artifacts[0].expires_at = instant(2 * 24 * 60 * 60 * 1000); }],
]) test("PROBE-003/004/008 receiver rejects " + name, async () => {
  const f = await readyFixture(); change(f); await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, { ...f.options, wait: false }));
  assert.equal(f.calls.some((item) => item.route?.startsWith("POST ")), false);
});
test("PROBE-008 expiration during ZIP download is rejected", async () => {
  const f = await readyFixture(); f.state.artifacts[0].expires_at = instant(1);
  f.api.download = async () => { f.state.now += 2; return f.state.archive; };
  await rejectsCode(probe.receiveProbe(f.api, f.context, f.inputs, f.options), "ARTIFACT_EXPIRED_DURING_DOWNLOAD");
});

for (const [name, change] of [
  ["missing environment", (f) => { f.state.environment = null; }],
  ["bypass", (f) => { f.state.environment.can_admins_bypass = true; }],
  ["missing bypass flag", (f) => { delete f.state.environment.can_admins_bypass; }],
  ["self review", (f) => { f.state.environment.protection_rules[1].prevent_self_review = false; }],
  ["second reviewer", (f) => { f.state.environment.protection_rules[1].reviewers.push({ type: "User", reviewer: clone(bot) }); }],
  ["Team masquerade", (f) => { f.state.environment.protection_rules[1].reviewers[0].type = "Team"; }],
  ["duplicate reviewer rule", (f) => { f.state.environment.protection_rules.push(clone(f.state.environment.protection_rules[1])); }],
  ["extra wait timer", (f) => { f.state.environment.protection_rules.push({ type: "wait_timer" }); }],
  ["tag main", (f) => { f.state.policies.branch_policies[0].type = "tag"; }],
  ["missing branch type", (f) => { delete f.state.policies.branch_policies[0].type; }],
  ["wildcard branch", (f) => { f.state.policies.branch_policies[0].name = "main*"; }],
  ["policy count mismatch", (f) => { f.state.policies.total_count = 2; }],
  ["second branch", (f) => { f.state.policies.branch_policies.push({ id: 902, name: "develop", type: "branch" }); f.state.policies.total_count = 2; }],
]) test("PROBE-005 preflight rejects " + name + " before dispatch", async () => {
  const f = fixture(); change(f); await rejectsCode(probe.dispatchProbe(f.api, f.context, f.inputs, f.options)); assert.equal(f.calls.some((item) => item.route?.startsWith("POST ")), false);
});
for (const status of [403, 404, 500]) test("PROBE-005 READ status " + status + " is BLOCKED and does not create Environment", async () => {
  const f = fixture(); f.state.readStatus = status;
  await assert.rejects(probe.dispatchProbe(f.api, f.context, f.inputs, f.options), (error) => error.result === "BLOCKED");
  assert.equal(f.calls.length, 1); assert.equal(f.calls.some((item) => item.route?.startsWith("POST ")), false);
});

test("PROBE-006 protected route revalidates receipt/Environment and records synthetic marker plus READ review history", async () => {
  const f = await readyFixture(), guard = await probe.receiveProbe(f.api, f.context, f.inputs, f.options);
  const marker = await probe.protectedProbe(f.api, f.context, f.inputs, guard.snapshot.environment, f.options);
  assert.equal(marker.synthetic, true); assert.equal(marker.humanOperationProven, false); assert.equal(marker.repositoryGatePass, false);
  assert.equal(marker.productPass, false); assert.equal(marker.run.id, RECEIVER); assert.equal(marker.review.user.id, actor.id);
});
test("PROBE-005 protected finalREAD catches main mutation during approval history lookup", async () => {
  const f = await readyFixture(), guard = await probe.receiveProbe(f.api, f.context, f.inputs, f.options);
  f.state.override = (route) => { if (route.endsWith("/approvals")) f.state.branch.commit.sha = OTHER_SHA; };
  await rejectsCode(probe.protectedProbe(f.api, f.context, f.inputs, guard.snapshot.environment, f.options), "MAIN_CHANGED");
});
for (const [name, change] of [
  ["no approval", (f) => { f.state.history = []; }],
  ["rejected", (f) => { f.state.history[0].state = "rejected"; }],
  ["other login", (f) => { f.state.history[0].user = clone(bot); }],
  ["other environment", (f) => { f.state.history[0].environments[0].id++; }],
  ["two decisions", (f) => { f.state.history.push(clone(f.state.history[0])); }],
  ["changed Environment id", (f) => { f.state.environment.id++; }],
  ["changed main", (f) => { f.state.branch.commit.sha = OTHER_SHA; }],
]) test("PROBE-005/006 protected route rejects " + name + " without marker", async () => {
  const f = await readyFixture(), guard = await probe.receiveProbe(f.api, f.context, f.inputs, f.options); change(f);
  await rejectsCode(probe.protectedProbe(f.api, f.context, f.inputs, guard.snapshot.environment, f.options));
});
test("PROBE-006 direct human negative path is entirely separate and can never produce positive marker", async () => {
  const f = fixture("direct-negative"), preflight = await probe.directNegativePreflight(f.api, f.context, f.inputs, f.options);
  assert.equal(preflight.positiveMarker, false); assert.equal(preflight.expected, "SELF_REVIEW_MUST_BE_DENIED");
  await rejectsCode(probe.negativeProtectedProbe(f.api, f.context, f.inputs, preflight.snapshot.environment, f.options), "SELF_REVIEW_NEGATIVE_UNEXPECTED_EXECUTION");
  await rejectsCode(probe.protectedProbe(f.api, f.context, f.inputs, preflight.snapshot.environment, f.options), "RECEIVER_MODE_INVALID");
  assert.equal(f.calls.some((item) => item.route?.endsWith("/approvals") || item.route?.startsWith("POST ")), false);
});

for (const compressed of [false, true]) for (const stream of [false, true]) test("PROBE-008 real standard-library ZIP interop stored/deflate with/without descriptor: " + [compressed, stream], () => {
  const text = JSON.stringify({ synthetic: true }, null, 2) + "\n", archive = zip(text, { compressed, stream });
  assert.deepEqual(probe.parseReceiptArchive(archive, digest(archive)), { synthetic: true });
});
const unixAttributes = (type, dos = 0) => (((type | 0o644) << 16) | dos) >>> 0;
const nonfileAttributes = [
  ["Unix directory without trailing slash", unixAttributes(0x4000), 3],
  ["DOS directory without trailing slash", 0x10, 0],
  ["Unix regular with DOS directory flag", unixAttributes(0x8000, 0x10), 3],
  ["Unix symlink", unixAttributes(0xa000), 3],
  ["Unix FIFO", unixAttributes(0x1000), 3],
];
for (const [name, attributes, creator] of nonfileAttributes) {
  test("PROBE-008 real ZIP writer rejects nonfile attributes: " + name, () => {
    const archive = zip(JSON.stringify({ synthetic: true }, null, 2) + "\n", { attributes, creator, compressed: true, stream: true });
    assert.throws(() => probe.parseReceiptArchive(archive, digest(archive)), (error) => error instanceof probe.ProbeError && error.code === "ZIP_ENTRY_INVALID");
  });
  test("PROBE-008/009 runtime receiver rejects correctly digested nonfile receipt: " + name, async () => {
    const f = await readyFixture();
    f.state.archive = zip(JSON.stringify(f.receipt, null, 2) + "\n", { attributes, creator, compressed: true, stream: true });
    f.state.artifacts[0].digest = digest(f.state.archive); f.state.artifacts[0].size_in_bytes = f.state.archive.length;
    const root = await mkdtemp(join(tmpdir(), "board-probe-nonfile-receipt-"));
    await rejectsCode(probe.runWorkflowStage("guard", { ...f, ...f.options, root }), "ZIP_ENTRY_INVALID");
    const failure = JSON.parse(await readFile(join(root, "observation", "result.json"), "utf8"));
    assert.equal(failure.positiveMarker, false); assert.equal(failure.code, "ZIP_ENTRY_INVALID");
    assert.equal(f.calls.filter((item) => item.download).length, 1); assert.equal(f.calls.some((item) => item.route?.startsWith("POST ")), false);
    assert.deepEqual(await readdir(root), ["observation"]);
  });
}
for (const [name, attributes, creator] of [["Unix regular", unixAttributes(0x8000), 3], ["DOS archive regular", 0x20, 0]]) test("PROBE-008 regular attributes retain ZIP writer compatibility: " + name, () => {
  const archive = zip(JSON.stringify({ synthetic: true }, null, 2) + "\n", { attributes, creator, compressed: true, stream: true });
  assert.deepEqual(probe.parseReceiptArchive(archive, digest(archive)), { synthetic: true });
});
for (const [name, options, content] of [
  ["traversal", { name: "../dispatch-receipt.json" }, "{}\n"],
  ["backslash", { name: "folder\\dispatch-receipt.json" }, "{}\n"],
  ["absolute", { name: "/dispatch-receipt.json" }, "{}\n"],
  ["extra file", { extra: true }, "{}\n"],
  ["noncanonical JSON", {}, '{"synthetic":true}\n'],
  ["duplicate JSON key", {}, '{"synthetic":true,"synthetic":false}\n'],
  ["malformed JSON", {}, "invalid"],
  ["inflation bound", { compressed: true }, "x".repeat(probe.RECEIPT_BYTES + 1)],
]) test("PROBE-008 ZIP parser rejects " + name, () => {
  const archive = zip(content, options); assert.throws(() => probe.parseReceiptArchive(archive, digest(archive)), probe.ProbeError);
});
test("PROBE-008 ZIP parser rejects CRC corruption, truncation, appended payload and encryption", () => {
  const archive = zip("{}\n");
  for (const changed of [Buffer.from(archive), archive.subarray(0, archive.length - 1), Buffer.concat([archive, Buffer.from("extra")])]) {
    if (changed.length === archive.length) changed[50] ^= 1;
    assert.throws(() => probe.parseReceiptArchive(changed, digest(changed)), probe.ProbeError);
  }
  const encrypted = Buffer.from(archive), central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => probe.parseReceiptArchive(encrypted, digest(encrypted)), probe.ProbeError);
  assert.throws(() => probe.parseReceiptArchive(Buffer.alloc(probe.ARCHIVE_BYTES + 1), "sha256:" + "0".repeat(64)), probe.ProbeError);
});

test("PROBE-008 download authenticates only fixed API request, never forwards token to signed storage URL", async () => {
  const calls = [], content = Buffer.from("synthetic ZIP"), signed = "https://synthetic.blob.core.windows.net/a?sig=synthetic-signed";
  const api = probe.createRuntimeApi({ request: () => { assert.fail(); } }, "synthetic-read-token", async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? { status: 302, headers: new Headers({ location: signed }) } : { status: 200, body: [content] };
  });
  assert.deepEqual(await api.download(950), content); assert.equal(calls[0].url, `https://api.github.com/repos/${probe.REPOSITORY}/actions/artifacts/950/zip`);
  assert.equal(calls[0].options.redirect, "manual"); assert.equal(calls[0].options.headers.Authorization, "Bearer synthetic-read-token");
  assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.redirect, "error");
});
for (const location of ["http://synthetic.blob.core.windows.net/a", "https://evil.invalid/a?sig=synthetic-canary", "https://user:password@synthetic.blob.core.windows.net/a", "https://synthetic.blob.core.windows.net:444/a"]) test("PROBE-008 signed redirect is bounded and sanitized: " + new URL(location).hostname, async () => {
  let calls = 0;
  const api = probe.createRuntimeApi({}, "synthetic-read-token", async () => { calls++; return { status: 302, headers: new Headers({ location }) }; });
  await assert.rejects(api.download(950), (error) => error.code === "ARCHIVE_DOWNLOAD_BLOCKED" && !error.message.includes("synthetic-canary") && !error.message.includes("password"));
  assert.equal(calls, 1);
});
test("PROBE-008 signed download failures cannot expose upstream URLs/credentials", async () => {
  const api = probe.createRuntimeApi({}, "synthetic-read-token", async () => { throw new Error("Bearer synthetic-read-token ?sig=synthetic-canary"); });
  await assert.rejects(api.download(950), (error) => error.message === "ARCHIVE_DOWNLOAD_BLOCKED");
});

test("PROBE-008 upload allocations enforce aggregate20MiB/500 without symlinks/empty files", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-probe-budget-")); await writeFile(join(root, "synthetic.json"), "{}\n");
  const budget = await probe.uploadBudget(root); assert.equal(budget.files, 1); assert.equal(budget.aggregateMaximumBytes, 20 * 1024 * 1024); assert.equal(budget.aggregateMaximumFiles, 500);
  await writeFile(join(root, "empty"), ""); await rejectsCode(probe.uploadBudget(root), "UPLOAD_FILE_INVALID");
  const oversized = await mkdtemp(join(tmpdir(), "board-probe-budget-large-")); await writeFile(join(oversized, "large"), Buffer.alloc(probe.UPLOAD_BYTES + 1));
  await rejectsCode(probe.uploadBudget(oversized), "UPLOAD_BUDGET_EXCEEDED");
  const linked = await mkdtemp(join(tmpdir(), "board-probe-budget-link-")); await symlink(root, join(linked, "link")); await rejectsCode(probe.uploadBudget(linked), "UPLOAD_SYMLINK_REJECTED");
});
test("PROBE-009 runtime stage wiring writes original receipt/guard/marker and sanitized failures without overwrites", async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), "board-probe-wiring-"));
  const dispatched = await probe.runWorkflowStage("dispatch", { ...f, ...f.options, root: join(root, "dispatch") });
  const saved = JSON.parse(await readFile(join(root, "dispatch", "receipt", "dispatch-receipt.json"), "utf8")); assert.deepEqual(saved, dispatched.receipt);
  f.context = context("receive"); f.inputs = input("receive"); f.state.source.status = "completed"; f.state.source.conclusion = "success"; packageReceipt(f, saved);
  const guard = await probe.runWorkflowStage("guard", { ...f, ...f.options, root: join(root, "guard") });
  await probe.runWorkflowStage("protected", { ...f, ...f.options, root: join(root, "protected"), expectedEnvironment: guard.snapshot.environment });
  const marker = JSON.parse(await readFile(join(root, "protected", "observation", "result.json"), "utf8")); assert.equal(marker.synthetic, true); assert.equal(marker.humanOperationProven, false);
  const negative = fixture("direct-negative"), negativeRoot = join(root, "negative"), expectedEnvironment = probe.validateEnvironment(negative.state.environment, negative.state.policies);
  await rejectsCode(probe.runWorkflowStage("negative", { ...negative, ...negative.options, root: negativeRoot, expectedEnvironment }), "SELF_REVIEW_NEGATIVE_UNEXPECTED_EXECUTION");
  const first = await readFile(join(negativeRoot, "observation", "result.json"), "utf8"); assert.equal(JSON.parse(first).positiveMarker, false);
  await rejectsCode(probe.runWorkflowStage("negative", { ...negative, ...negative.options, root: negativeRoot, expectedEnvironment }));
  assert.equal(await readFile(join(negativeRoot, "observation", "result.json"), "utf8"), first);
  await rejectsCode(probe.writeEvidence(join(root, "unsafe.json"), { message: "Bearer synthetic-secret" }), "PUBLIC_EVIDENCE_INVALID");
  assert.equal((await readdir(root)).includes("unsafe.json"), false);
});

test("PROBE-001/009 workflow runtime wiring, pins, permissions and upstream Environment guard are real", async () => {
  const path = new URL("../../.github/workflows/board-actor-probe.yml", import.meta.url);
  const workflow = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", 'print JSON.generate(YAML.load_file(ARGV[0]))', path.pathname], { encoding: "utf8" }));
  assert.deepEqual(Object.keys(workflow.on ?? workflow.true), ["workflow_dispatch"]); assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.dispatcher.needs, "boundary"); assert.equal(workflow.jobs.preflight.needs, "boundary");
  assert.deepEqual(workflow.jobs.dispatcher.permissions, { contents: "read", actions: "write" });
  let uploads = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    if (name !== "dispatcher") assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
    for (const step of job.steps) {
      assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) { assert.equal(step.with.ref, "${{ github.sha }}"); assert.equal(step.with["persist-credentials"], false); assert.equal(step.with["sparse-checkout"], "harness/scripts"); }
      if (step.uses.startsWith("actions/upload-artifact@")) { uploads++; assert.equal(step.with["retention-days"], 1); assert.equal(step.with.overwrite, false); assert.equal(step.with["if-no-files-found"], "error"); }
      if (step.with?.script) { const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor; new AsyncFunction("github", "context", "core", step.with.script); }
      assert.equal(step.uses.includes("cache"), false);
    }
  }
  assert.equal(uploads, probe.UPLOAD_SLOTS); assert.equal(workflow.jobs.preflight.environment, undefined);
  for (const name of ["protected_observation", "self_review_negative"]) { assert.equal(workflow.jobs[name].needs, "preflight"); assert.equal(workflow.jobs[name].environment, "board-review"); assert.ok(workflow.jobs[name].if.includes("outputs.verified == 'true'")); }
  const scripts = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.with?.script ?? "")).join("\n");
  for (const phase of ["dispatch", "guard", "protected", "negative"]) assert.ok(scripts.includes(`runWorkflowStage('${phase}'`));
  assert.equal(scripts.includes("secrets."), false); assert.equal(scripts.includes("statuses"), false); assert.equal(scripts.includes("approvePendingDeployment"), false);
  const negativeScript = workflow.jobs.self_review_negative.steps.find((step) => step.with?.script?.includes("runWorkflowStage"));
  assert.equal(negativeScript.with.script.includes("runWorkflowStage('protected'"), false);
});
test("PROBE-001 boundary embedded runtime rejects unsafe contexts before repository code checkout", async () => {
  const path = new URL("../../.github/workflows/board-actor-probe.yml", import.meta.url), workflow = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", 'print JSON.generate(YAML.load_file(ARGV[0]))', path.pathname], { encoding: "utf8" }));
  const script = workflow.jobs.boundary.steps[0].with.script, AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("github", "context", "process", script), env = { PROBE_RUN_ATTEMPT: "1", PROBE_WORKFLOW_REF: context().workflowRef, PROBE_WORKFLOW_SHA: SHA };
  const payload = { repo: { owner: "uk-product-lab", repo: "sns-marketing-manager" }, ref: "refs/heads/main", sha: SHA, eventName: "workflow_dispatch", payload: { inputs: input() } };
  let reads = 0; const github = { request: async () => { reads++; return { status: 200, data: { name: "main", commit: { sha: SHA } } }; } };
  await execute(github, payload, { env }); assert.equal(reads, 1);
  for (const change of [(x) => { x.ref = "refs/heads/feature"; }, (x) => { x.payload.inputs.mode = "unknown"; }, (x) => { x.payload.inputs.extra = "injected"; }]) {
    const bad = clone(payload); change(bad); await assert.rejects(execute(github, bad, { env }), /PROBE_CONTEXT_REJECTED/);
  }
  assert.equal(reads, 1);
});

// TASK-0008 executes the actual checkout-free boundary script. These fixtures
// do not establish what GitHub put in the failed real run's event payload.
const boundaryDiagnosticPrefix = "PROBE_BOUNDARY_DIAGNOSTIC ";
const boundaryInputKeys = ["mode", "probe_id", "fixed_sha", "source_run_id", "source_attempt", "acknowledgement"];
let boundaryDiagnosticScript;
async function boundaryDiagnosticFixture(mode = "dispatch") {
  if (!boundaryDiagnosticScript) {
    const path = new URL("../../.github/workflows/board-actor-probe.yml", import.meta.url);
    const workflow = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", 'print JSON.generate(YAML.load_file(ARGV[0]))', path.pathname], { encoding: "utf8" }));
    boundaryDiagnosticScript = workflow.jobs.boundary.steps[0].with.script;
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("github", "context", "process", "core", boundaryDiagnosticScript);
  const f = {
    context: { repo: { owner: "uk-product-lab", repo: "sns-marketing-manager" }, ref: "refs/heads/main", sha: SHA,
      eventName: "workflow_dispatch", payload: { inputs: input(mode) } },
    env: { PROBE_RUN_ATTEMPT: "1", PROBE_WORKFLOW_REF: context().workflowRef, PROBE_WORKFLOW_SHA: SHA },
    calls: [], messages: [],
  };
  f.core = { error: (message) => f.messages.push(message) };
  f.github = { request: async (route, params) => {
    f.calls.push({ route, params });
    assert.equal(route, "GET /repos/{owner}/{repo}/branches/{branch}");
    assert.equal(params.owner + "/" + params.repo, probe.REPOSITORY);
    assert.equal(params.branch, "main");
    assert.equal(params.headers["X-GitHub-Api-Version"], probe.API_VERSION);
    return { status: 200, data: { name: "main", commit: { sha: SHA } } };
  } };
  f.execute = () => execute(f.github, f.context, { env: f.env }, f.core);
  return f;
}
async function rejectedBoundaryDiagnostic(f, expectedReason) {
  await assert.rejects(f.execute(), (error) => error.message === "PROBE_CONTEXT_REJECTED");
  assert.equal(f.calls.length, 0); // Neither the main READ nor any write is reached.
  assert.equal(f.messages.length, 1); assert.equal(typeof f.messages[0], "string");
  assert.ok(f.messages[0].startsWith(boundaryDiagnosticPrefix));
  const diagnostic = JSON.parse(f.messages[0].slice(boundaryDiagnosticPrefix.length));
  assert.equal(diagnostic.schema, "board-actor-boundary-diagnostic:v1");
  assert.equal(diagnostic.reasons.includes(expectedReason), true);
  if (diagnostic.checksPassed && expectedReason in diagnostic.checksPassed) assert.equal(diagnostic.checksPassed[expectedReason], false);
  return diagnostic;
}

for (const mode of ["dispatch", "receive", "direct-negative"]) test("DIAG-001/004 accepted boundary retains one fixed main READ without rejection diagnostics: " + mode, async () => {
  const f = await boundaryDiagnosticFixture(mode); await f.execute();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.messages, []);
  assert.deepEqual(probe.parseInputs(f.context.payload.inputs), input(mode));
});

for (const [name, change, reason] of [
  ["event", (f) => { f.context.eventName = "push"; }, "EVENT_NAME_MISMATCH"],
  ["repository owner", (f) => { f.context.repo.owner = "synthetic-fork"; }, "REPOSITORY_MISMATCH"],
  ["repository name", (f) => { f.context.repo.repo = "synthetic-other"; }, "REPOSITORY_MISMATCH"],
  ["feature ref", (f) => { f.context.ref = "refs/heads/feature"; }, "REF_MISMATCH"],
  ["tag ref", (f) => { f.context.ref = "refs/tags/main"; }, "REF_MISMATCH"],
  ["attempt", (f) => { f.env.PROBE_RUN_ATTEMPT = "2"; }, "RUN_ATTEMPT_MISMATCH"],
  ["workflow ref", (f) => { f.env.PROBE_WORKFLOW_REF += "-other"; }, "WORKFLOW_REF_MISMATCH"],
  ["unknown mode", (f) => { f.context.payload.inputs.mode = "unknown"; }, "MODE_NOT_ALLOWED"],
  ["numeric mode", (f) => { f.context.payload.inputs.mode = 1; }, "MODE_NOT_ALLOWED"],
  ["SHA format", (f) => { f.context.payload.inputs.fixed_sha = "invalid"; }, "FIXED_SHA_FORMAT_INVALID"],
  ["array SHA", (f) => { f.context.payload.inputs.fixed_sha = [SHA]; }, "FIXED_SHA_CONTEXT_MISMATCH"],
  ["input SHA binding", (f) => { f.context.payload.inputs.fixed_sha = OTHER_SHA; }, "FIXED_SHA_CONTEXT_MISMATCH"],
  ["context SHA binding", (f) => { f.context.sha = OTHER_SHA; }, "FIXED_SHA_CONTEXT_MISMATCH"],
  ["workflow SHA", (f) => { f.env.PROBE_WORKFLOW_SHA = OTHER_SHA; }, "WORKFLOW_SHA_CONTEXT_MISMATCH"],
  ["unknown key", (f) => { f.context.payload.inputs.unknown = "synthetic"; }, "INPUT_KEYS_MISMATCH"],
  ["missing payload", (f) => { f.context.payload = undefined; }, "BOUNDARY_EVALUATION_UNAVAILABLE"],
  ["missing repository object", (f) => { f.context.repo = undefined; }, "REPOSITORY_MISMATCH"],
]) test("DIAG-002/004 embedded boundary identifies rejection predicate: " + name, async () => {
  const f = await boundaryDiagnosticFixture(); change(f);
  const d = await rejectedBoundaryDiagnostic(f, reason);
  assert.equal(d.diagnosticAvailable, true);
  assert.equal(Object.values(d.checksPassed).every((value) => typeof value === "boolean"), true);
  assert.deepEqual(Object.keys(d.knownInputs), boundaryInputKeys);
});

for (const [name, value, expectedType] of [
  ["undefined", undefined, "undefined"], ["null", null, "null"], ["array", [], "array"],
  ["string", "synthetic", "string"], ["empty string", "", "string"],
  ["number", 1, "number"], ["zero", 0, "number"], ["boolean", false, "boolean"],
]) test("DIAG-003/004 malformed input shape is classified without values or API calls: " + name, async () => {
  const f = await boundaryDiagnosticFixture(); f.context.payload.inputs = value;
  const d = await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  assert.equal(d.inputsType, expectedType);
  assert.equal(d.unknownKeyCount, typeof value === "string" ? value.length : 0);
  for (const observed of Object.values(d.knownInputs)) assert.deepEqual(observed, { present: false, type: "undefined" });
});

for (const key of ["mode", "probe_id", "fixed_sha", "acknowledgement"]) test("DIAG-004 omitted required boundary key remains rejected: " + key, async () => {
  const f = await boundaryDiagnosticFixture(); delete f.context.payload.inputs[key];
  const d = await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  assert.deepEqual(d.knownInputs[key], { present: false, type: "undefined" });
  assert.equal(d.unknownKeyCount, 0);
});

const sourceKeyOmissions = [["source_run_id"], ["source_attempt"], ["source_run_id", "source_attempt"]];
for (const mode of ["dispatch", "direct-negative"]) {
  for (const keys of sourceKeyOmissions) test("SRC-001 permits omitted source inputs in " + mode + ": " + keys.join(", "), async () => {
    const f = await boundaryDiagnosticFixture(mode);
    const inputs = f.context.payload.inputs;
    for (const key of keys) delete inputs[key];
    await f.execute();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(probe.parseInputs(inputs), input(mode));
    for (const key of keys) assert.equal(Object.hasOwn(inputs, key), false);
  });
}
for (const keys of sourceKeyOmissions) test("SRC-002 receive rejects omitted source inputs: " + keys.join(", "), async () => {
  const f = await boundaryDiagnosticFixture("receive");
  const inputs = f.context.payload.inputs;
  for (const key of keys) delete inputs[key];
  const d = await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  for (const key of keys) assert.deepEqual(d.knownInputs[key], { present: false, type: "undefined" });
  assert.throws(() => probe.parseInputs(inputs), { code: "INPUT_KEYS_INVALID" });
});

for (const [mode, stage] of [["dispatch", "dispatch"], ["direct-negative", "guard"]]) test("SRC-003 four-key payload reaches the " + stage + " stage", async () => {
  const f = fixture(mode);
  delete f.inputs.source_run_id;
  delete f.inputs.source_attempt;
  const boundary = await boundaryDiagnosticFixture(mode);
  boundary.context.payload.inputs = f.inputs;
  await boundary.execute();
  assert.equal(boundary.calls.length, 1);
  assert.deepEqual(boundary.messages, []);
  const root = await mkdtemp(join(tmpdir(), "board-probe-omitted-source-"));
  const result = await probe.runWorkflowStage(stage, { ...f, ...f.options, root });
  const writes = f.calls.filter(({ route }) => route?.startsWith("POST "));
  if (mode === "dispatch") {
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params.inputs, input("receive"));
    assert.equal(result.receipt.receiver.id, RECEIVER);
  } else {
    assert.equal(writes.length, 0);
    assert.equal(result.expected, "SELF_REVIEW_MUST_BE_DENIED");
    assert.equal(result.positiveMarker, false);
  }
});

for (const key of ["probe_id", "extra"]) test("SRC-002 source omissions do not mask key mismatch: " + key, async () => {
  const f = await boundaryDiagnosticFixture();
  const inputs = f.context.payload.inputs;
  delete inputs.source_run_id;
  delete inputs.source_attempt;
  if (key === "extra") inputs.extra = "synthetic";
  else delete inputs[key];
  await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  assert.throws(() => probe.parseInputs(inputs), { code: "INPUT_KEYS_INVALID" });
});

for (const [name, mode, change, code] of [
  ["numeric acknowledgement", "dispatch", (i) => { i.acknowledgement = 1; }, "ACKNOWLEDGEMENT_INVALID"],
  ["numeric probe id", "dispatch", (i) => { i.probe_id = 1; }, "INPUT_IDENTITY_INVALID"],
  ["receive empty source", "receive", (i) => { i.source_run_id = ""; }, "SOURCE_INPUT_INVALID"],
  ["receive numeric source", "receive", (i) => { i.source_run_id = SOURCE; }, "SOURCE_INPUT_INVALID"],
  ["receive numeric attempt", "receive", (i) => { i.source_attempt = 1; }, "SOURCE_INPUT_INVALID"],
  ["dispatch recursive source", "dispatch", (i) => { i.source_run_id = String(SOURCE); }, "RECURSIVE_INPUT_REJECTED"],
  ["dispatch explicit undefined source with omitted attempt", "dispatch", (i) => { i.source_run_id = undefined; delete i.source_attempt; }, "RECURSIVE_INPUT_REJECTED"],
  ["direct-negative explicit null attempt with omitted source", "direct-negative", (i) => { i.source_attempt = null; delete i.source_run_id; }, "RECURSIVE_INPUT_REJECTED"],
]) test("DIAG-001/004 downstream strict parser retains input value rejection: " + name, async () => {
  const f = await boundaryDiagnosticFixture(mode); change(f.context.payload.inputs); await f.execute();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.messages, []);
  assert.throws(() => probe.parseInputs(f.context.payload.inputs), (error) => error instanceof probe.ProbeError && error.code === code);
});

test("DIAG-002 multiple predicate failures retain every applicable static reason", async () => {
  const f = await boundaryDiagnosticFixture(); f.context.ref = "refs/tags/main"; f.env.PROBE_RUN_ATTEMPT = "2"; f.env.PROBE_WORKFLOW_SHA = OTHER_SHA;
  const d = await rejectedBoundaryDiagnostic(f, "REF_MISMATCH");
  assert.deepEqual(d.reasons, ["REF_MISMATCH", "RUN_ATTEMPT_MISMATCH", "WORKFLOW_SHA_CONTEXT_MISMATCH"]);
});
test("DIAG-003/005 hostile input names and values never enter the structured diagnostic", async () => {
  const f = await boundaryDiagnosticFixture(), canary = "synthetic-boundary-secret-canary-never-log";
  f.context.payload.inputs = Object.fromEntries(boundaryInputKeys.map((key) => [key, canary]));
  f.context.payload.inputs[canary + "\n::error::"] = canary;
  f.context.eventName = canary; f.context.repo.owner = canary; f.context.repo.repo = canary; f.context.ref = canary; f.context.sha = canary;
  f.env.PROBE_RUN_ATTEMPT = canary; f.env.PROBE_WORKFLOW_REF = canary; f.env.PROBE_WORKFLOW_SHA = canary;
  const d = await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  assert.equal(d.unknownKeyCount, 1); assert.equal(f.messages[0].includes(canary), false);
  assert.equal(f.messages[0].includes("::error::"), false);
  for (const observed of Object.values(d.knownInputs)) assert.deepEqual(observed, { present: true, type: "string" });
  assert.ok(f.messages[0].length < 4096);
});
test("DIAG-003/005 raw input toJSON is never called by diagnostic serialization", async () => {
  const f = await boundaryDiagnosticFixture(); let serialized = 0;
  f.context.payload.inputs.toJSON = () => { serialized++; throw new Error("synthetic-serialization-secret"); };
  const d = await rejectedBoundaryDiagnostic(f, "INPUT_KEYS_MISMATCH");
  assert.equal(serialized, 0); assert.equal(d.unknownKeyCount, 1);
  assert.equal(f.messages[0].includes("synthetic-serialization-secret"), false);
});
test("DIAG-003/005 evaluation and diagnostic exceptions still reject with fixed sanitized output", async () => {
  const f = await boundaryDiagnosticFixture();
  Object.defineProperty(f.context.payload.inputs, "mode", { enumerable: true, get() { throw new Error("synthetic-getter-secret"); } });
  const d = await rejectedBoundaryDiagnostic(f, "DIAGNOSTIC_UNAVAILABLE");
  assert.equal(d.evaluationAvailable, false); assert.equal(d.diagnosticAvailable, false);
  assert.equal(f.messages[0].includes("synthetic-getter-secret"), false);
});
test("DIAG-003 failed diagnostic sink cannot continue to the main READ or expose its error", async () => {
  const f = await boundaryDiagnosticFixture(); f.context.ref = "refs/heads/feature";
  f.core.error = () => { throw new Error("synthetic-diagnostic-sink-secret"); };
  await assert.rejects(f.execute(), (error) => error.message === "PROBE_CONTEXT_REJECTED");
  assert.equal(f.calls.length, 0);
});
test("DIAG-001/006 valid context retains fixed failures from the real main READ", async () => {
  const f = await boundaryDiagnosticFixture(); let reads = 0;
  f.github.request = async () => { reads++; throw new Error("synthetic-upstream-read-secret"); };
  await assert.rejects(f.execute(), (error) => error.message === "PROBE_MAIN_READ_BLOCKED");
  assert.equal(reads, 1); assert.deepEqual(f.messages, []);
  const changed = await boundaryDiagnosticFixture();
  changed.github.request = async () => ({ status: 200, data: { name: "main", commit: { sha: OTHER_SHA } } });
  await assert.rejects(changed.execute(), (error) => error.message === "PROBE_MAIN_CHANGED");
  assert.deepEqual(changed.messages, []);
});
