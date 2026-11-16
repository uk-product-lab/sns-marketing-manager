import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as probe from "../scripts/board-actor-probe.mjs";
import * as gate from "../scripts/board-gate.mjs";

// TASK-0013. Every API response, clock, identity, pull request, evidence ref and
// archive below is a synthetic LOCAL fixture. Nothing here shows that a real
// scheduled run, bot actor, Gatekeeper App token or board approval succeeded.
const NOW = Date.parse("2026-11-16T03:00:00.000Z");
const MAIN = "a".repeat(40), HEAD = "c".repeat(40), EVIDENCE = "e".repeat(40), OTHER_SHA = "b".repeat(40), DIGEST = "d".repeat(64);
const GATE_ID = "gate-0013-synthetic", PR = 42, SOURCE = 500, RECEIVER = 501, REPO_ID = 600, SOURCE_WORKFLOW_ID = 710, GATE_WORKFLOW_ID = 711;
const REPO = probe.REPOSITORY, ENVIRONMENT_ID = 900, ARTIFACT_ID = 950;
const owner = { login: probe.BOARD_LOGIN, id: 80, type: "User" };
const bot = { login: "github-actions[bot]", id: 81, type: "Bot" };
const stranger = { login: "synthetic-collaborator", id: 82, type: "User" };
const clone = (value) => structuredClone(value);
const digest = (buffer) => "sha256:" + createHash("sha256").update(buffer).digest("hex");
const instant = (delta = 0) => new Date(NOW + delta).toISOString();
const runUrls = (id) => ({ url: `https://api.github.com/repos/${REPO}/actions/runs/${id}`, html_url: `https://github.com/${REPO}/actions/runs/${id}` });
const repositories = () => ({ repository: { id: REPO_ID, full_name: REPO }, head_repository: { id: REPO_ID, full_name: REPO } });

const selection = () => ({ gate_id: GATE_ID, pull_request: String(PR), fixed_sha: HEAD, base_sha: MAIN,
  evidence_branch: `review-evidence/${GATE_ID}`, evidence_commit_sha: EVIDENCE, evidence_sha256: DIGEST });
const gateInputs = () => ({ ...selection(), source_run_id: String(SOURCE), source_attempt: "1" });
const baseContext = { repository: REPO, repositoryId: REPO_ID, runAttempt: 1, ref: "refs/heads/main", sha: MAIN, workflowSha: MAIN };
const sourceContext = () => ({ ...baseContext, runId: SOURCE, eventName: "schedule", workflowRef: `${REPO}/${gate.SOURCE_WORKFLOW}@refs/heads/main`,
  actor: owner.login, actorId: owner.id, triggeringActor: owner.login });
const gateContext = () => ({ ...baseContext, runId: RECEIVER, eventName: "workflow_dispatch", workflowRef: `${REPO}/${gate.GATE_WORKFLOW}@refs/heads/main`,
  actor: bot.login, actorId: bot.id, triggeringActor: bot.login });

function sourceRunData() {
  return { id: SOURCE, workflow_id: SOURCE_WORKFLOW_ID, path: gate.SOURCE_WORKFLOW, event: "schedule", head_branch: "main", head_sha: MAIN,
    run_attempt: 1, ...repositories(), actor: clone(owner), triggering_actor: clone(owner), created_at: instant(-20 * 60_000),
    status: "in_progress", conclusion: null, display_title: "Independent browser review board gate", ...runUrls(SOURCE) };
}
function receiverRunData(id = RECEIVER, gateId = GATE_ID) {
  return { id, workflow_id: GATE_WORKFLOW_ID, path: gate.GATE_WORKFLOW, event: "workflow_dispatch", head_branch: "main", head_sha: MAIN,
    run_attempt: 1, ...repositories(), actor: clone(bot), triggering_actor: clone(bot), created_at: instant(),
    status: "in_progress", conclusion: null, display_title: gate.gateTitle(gateId), ...runUrls(id) };
}
function sourceJobs() {
  return Object.values(gate.SOURCE_JOBS).map((name, index) => ({ id: 800 + index, name, run_id: SOURCE, run_attempt: 1, head_sha: MAIN,
    status: name === gate.SOURCE_JOBS.dispatch ? "in_progress" : "completed", conclusion: name === gate.SOURCE_JOBS.dispatch ? null : "success" }));
}
function pullData(number = PR, head = HEAD) {
  return { number, state: "open", merged: false, head: { sha: head }, base: { ref: "main", sha: MAIN, repo: { id: REPO_ID, full_name: REPO } },
    labels: [{ name: gate.PENDING_LABEL }, { name: "agent:claude" }] };
}
const evidenceRef = (gateId = GATE_ID, sha = EVIDENCE) => ({ ref: `refs/heads/review-evidence/${gateId}`, object: { type: "commit", sha } });
const artifactRun = () => ({ id: SOURCE, repository_id: REPO_ID, head_repository_id: REPO_ID, head_branch: "main", head_sha: MAIN });

function fixture() {
  const calls = [], state = {
    now: NOW,
    repository: { id: REPO_ID, full_name: REPO, default_branch: "main", private: false },
    branch: { name: "main", commit: { sha: MAIN } },
    workflows: { "independent-review.yml": { id: SOURCE_WORKFLOW_ID, path: gate.SOURCE_WORKFLOW, state: "active" },
      "board-gate.yml": { id: GATE_WORKFLOW_ID, path: gate.GATE_WORKFLOW, state: "active" } },
    environment: { id: ENVIRONMENT_ID, name: probe.ENVIRONMENT, can_admins_bypass: false,
      protection_rules: [{ type: "branch_policy" }, { type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: clone(owner) }] }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    policies: { total_count: 1, branch_policies: [{ id: 901, name: "main", type: "branch" }] },
    runs: { [SOURCE]: sourceRunData(), [RECEIVER]: receiverRunData() }, receiverCreated: false, list: null, jobs: sourceJobs(),
    // The trusted recheck of the scheduled run uploads its own artifact first.
    artifacts: [{ id: 940, name: `trusted-recheck-${HEAD}`, size_in_bytes: 1024, expired: false, workflow_run: artifactRun() }],
    archive: null, history: [{ state: "approved", environments: [{ id: ENVIRONMENT_ID, name: probe.ENVIRONMENT }], user: clone(owner) }],
    pulls: { [PR]: pullData() }, comparisons: { [`${MAIN}...${HEAD}`]: { status: "ahead" } },
    refs: { [`heads/review-evidence/${GATE_ID}`]: evidenceRef() },
    dispatchResponse: { status: 200, data: { workflow_run_id: RECEIVER, run_url: runUrls(RECEIVER).url, html_url: runUrls(RECEIVER).html_url } },
    statuses: [], statusFailure: null, labelWrites: [], readStatus: 200, override: null,
  };
  const client = (name) => ({
    async request(route, params) {
      calls.push({ client: name, route, params: clone(params) });
      assert.equal(params.headers["X-GitHub-Api-Version"], probe.API_VERSION);
      assert.equal(`${params.owner}/${params.repo}`, REPO);
      if (state.override) { const value = state.override(route, params, name); if (value !== undefined) return value; }
      const labelsOf = () => state.pulls[params.issue_number].labels;
      let data;
      switch (route) {
        case "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches":
          state.receiverCreated = true; return clone(state.dispatchResponse);
        case "POST /repos/{owner}/{repo}/statuses/{sha}": {
          if (state.statusFailure) { const failure = state.statusFailure(state.statuses.length, params); if (failure !== undefined) return failure; }
          state.statuses.push({ client: name, sha: params.sha, state: params.state, context: params.context, description: params.description, target_url: params.target_url });
          return { status: 201, data: { id: 9000 + state.statuses.length, state: params.state, context: params.context } };
        }
        case "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}": {
          state.labelWrites.push({ client: name, action: "remove", issue: params.issue_number, name: params.name });
          const index = labelsOf().findIndex((label) => label.name === params.name);
          if (index < 0) return { status: 404, data: null };
          labelsOf().splice(index, 1); return { status: 200, data: clone(labelsOf()) };
        }
        case "POST /repos/{owner}/{repo}/issues/{issue_number}/labels":
          state.labelWrites.push({ client: name, action: "add", issue: params.issue_number, labels: clone(params.labels) });
          labelsOf().push(...params.labels.map((label) => ({ name: label }))); return { status: 200, data: clone(labelsOf()) };
        case "GET /repos/{owner}/{repo}": data = state.repository; break;
        case "GET /repos/{owner}/{repo}/branches/{branch}": assert.equal(params.branch, "main"); data = state.branch; break;
        case "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}": data = state.workflows[params.workflow_id]; break;
        case "GET /repos/{owner}/{repo}/environments/{environment_name}": assert.equal(params.environment_name, probe.ENVIRONMENT); data = state.environment; break;
        case "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies": data = state.policies; break;
        case "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs": {
          assert.equal(params.workflow_id, GATE_WORKFLOW_ID); assert.equal(params.event, "workflow_dispatch"); assert.equal(params.head_sha, MAIN);
          const runs = state.list ?? (state.receiverCreated ? [state.runs[RECEIVER]] : []);
          data = { total_count: runs.length, workflow_runs: runs }; break;
        }
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}":
          if (params.run_id === RECEIVER) assert.equal(state.receiverCreated, true);
          if (!state.runs[params.run_id]) return { status: 404, data: null };
          data = state.runs[params.run_id]; break;
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs":
          assert.equal(params.run_id, SOURCE); assert.equal(params.filter, "all"); data = { total_count: state.jobs.length, jobs: state.jobs }; break;
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts":
          assert.equal(params.run_id, SOURCE); data = { total_count: state.artifacts.length, artifacts: state.artifacts }; break;
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals": data = state.history; break;
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
          if (!state.pulls[params.pull_number]) return { status: 404, data: null };
          data = state.pulls[params.pull_number]; break;
        case "GET /repos/{owner}/{repo}/compare/{basehead}": data = state.comparisons[params.basehead] ?? { status: "diverged" }; break;
        case "GET /repos/{owner}/{repo}/git/ref/{ref}":
          if (!state.refs[params.ref]) return { status: 404, data: null };
          data = state.refs[params.ref]; break;
        default: throw new Error("Unknown synthetic route");
      }
      return { status: state.readStatus, data: clone(data) };
    },
    async download(id) { calls.push({ client: name, download: id }); assert.equal(id, ARTIFACT_ID); return state.archive; },
  });
  const f = { state, calls, api: client("workflow"), appApi: client("app"), selection: selection(), inputs: gateInputs(),
    options: { now: () => state.now, sleep: async (ms) => { state.now += ms; } } };
  return f;
}

// The same standard-library ZIP writer the probe tests use. A non-seekable sink
// emits data descriptors, as the streaming archiver of the upload Action does.
function zip(content, name = gate.RECEIPT_FILE) {
  const program = String.raw`
import io, sys, zipfile
class Sink(io.BytesIO):
    def seek(self, *args): raise OSError("nonseekable")
    def tell(self): raise OSError("nonseekable")
target = Sink()
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as out:
    out.writestr(sys.argv[1], sys.stdin.buffer.read())
sys.stdout.buffer.write(target.getvalue())
`;
  return execFileSync("python3", ["-I", "-c", program, name], { input: content, maxBuffer: 1024 * 1024 });
}
function packageReceipt(f, receipt) {
  f.state.archive = zip(JSON.stringify(receipt, null, 2) + "\n");
  f.state.artifacts = f.state.artifacts.filter((item) => item.id !== ARTIFACT_ID);
  f.state.artifacts.push({ id: ARTIFACT_ID, name: gate.gateReceiptName(SOURCE), size_in_bytes: f.state.archive.length, expired: false,
    digest: digest(f.state.archive), created_at: instant(), expires_at: instant(24 * 60 * 60 * 1000), workflow_run: artifactRun() });
}
const receiptArtifact = (f) => f.state.artifacts.find((item) => item.id === ARTIFACT_ID);
// The scheduled run ends successfully after its last job uploaded the receipt.
function completeSource(f, receipt) {
  Object.assign(f.state.runs[SOURCE], { status: "completed", conclusion: "success" });
  for (const job of f.state.jobs) Object.assign(job, { status: "completed", conclusion: "success" });
  f.receipt = receipt; packageReceipt(f, receipt);
}

const routesOf = (f, pattern) => f.calls.filter(({ route }) => route && pattern.test(route));
const dispatchWrites = (f) => routesOf(f, /^POST .*\/dispatches$/);
const statusWrites = (f) => routesOf(f, /\/statuses\//);
const labelWrites = (f) => routesOf(f, /\/labels/);
const hasLabel = (f, name, number = PR) => f.state.pulls[number].labels.some((label) => label.name === name);
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof gate.GateError, `Unexpected error type: ${error?.message}`);
  if (code) assert.equal(error.code, code);
  return true;
});
// "No status and no approved label": nothing was written through either client.
function assertNothingReleased(f) {
  assert.equal(statusWrites(f).length, 0); assert.deepEqual(f.state.statuses, []);
  assert.equal(labelWrites(f).length, 0); assert.deepEqual(f.state.labelWrites, []);
  assert.equal(hasLabel(f, gate.APPROVED_LABEL), false); assert.equal(hasLabel(f, gate.PENDING_LABEL), true);
  assert.ok(dispatchWrites(f).length <= 1);
  assert.equal(routesOf(f, /rerun|cancel|pending_deployments|secrets|variables/).length, 0);
}

const roots = mkdtemp(join(tmpdir(), "board-gate-test-")); let rootIndex = 0;
async function runStage(f, stage, extra = {}) {
  const root = extra.root ?? join(await roots, String(rootIndex++));
  const defaults = stage === "dispatch" ? { api: f.api, context: sourceContext(), inputs: f.selection }
    : { api: stage === "publish" ? f.appApi : f.api, context: gateContext(), inputs: f.inputs };
  f.root = root;
  return gate.runBoardGateStage(stage, { ...defaults, ...f.options, ...extra, root });
}
const observation = async (f, stage) => JSON.parse(await readFile(join(f.root, "observation", `${stage}.json`), "utf8"));
// Step and job outputs travel as JSON text between runners.
const output = (value) => JSON.parse(JSON.stringify(value));

async function dispatched(f = fixture()) {
  const result = await runStage(f, "dispatch"); completeSource(f, result.receipt); return f;
}
async function guarded(f = fixture()) {
  await dispatched(f); f.guard = await runStage(f, "guard"); f.expectedEnvironment = output(f.guard.snapshot.environment); return f;
}
async function released(f = fixture()) {
  await guarded(f); f.release = output(await runStage(f, "protected", { expectedEnvironment: f.expectedEnvironment })); return f;
}
// Mirrors the two workflows: each stage runs only if every earlier one succeeded,
// in the order of the jobs (needs/if) and of the steps of the protected job.
async function pipeline(f, hooks = {}) {
  await hooks.beforeDispatch?.(f);
  const dispatch = await runStage(f, "dispatch"); completeSource(f, dispatch.receipt);
  await hooks.afterDispatch?.(f);
  const guard = await runStage(f, "guard");
  await hooks.afterGuard?.(f); // The wait for the board approval happens here.
  const release = output(await runStage(f, "protected", { expectedEnvironment: output(guard.snapshot.environment) }));
  await hooks.afterRelease?.(f);
  const published = output(await runStage(f, "publish", { release }));
  await hooks.afterPublish?.(f);
  const approved = await runStage(f, "label", { published });
  return { dispatch, guard, release, published, approved };
}

test("BGT-001/003/004/005 the scheduled source dispatches once and the approved bot-started run publishes seven statuses, then the label", async () => {
  const f = fixture(), result = await pipeline(f);
  assert.equal(dispatchWrites(f).length, 1);
  const post = dispatchWrites(f)[0].params;
  assert.equal(post.workflow_id, "board-gate.yml"); assert.equal(post.ref, "main"); assert.deepEqual(post.inputs, gateInputs());
  assert.deepEqual(result.dispatch.receipt.receiver.run.actor, bot); assert.deepEqual(result.dispatch.receipt.source.actor, owner);
  assert.equal(result.dispatch.receipt.source.mode, "source"); assert.equal(result.dispatch.receipt.receiver.run.mode, "gate");
  assert.equal(result.guard.source.id, SOURCE); assert.equal(result.guard.artifact.id, ARTIFACT_ID);
  assert.deepEqual(result.guard.binding, { pullRequest: PR, fixedSha: HEAD, baseSha: MAIN, evidenceBranch: `review-evidence/${GATE_ID}`, evidenceCommitSha: EVIDENCE, evidenceSha256: DIGEST });
  assert.deepEqual(result.release.review, { state: "approved", user: owner, environmentId: ENVIRONMENT_ID });
  assert.equal(result.release.humanOperationProven, false);
  // BGT-005: same seven context names, the fixed PR head, the receiver run as target.
  assert.deepEqual(f.state.statuses, gate.STATUS_CONTEXTS.map((context) => ({ client: "app", sha: HEAD, state: "success", context,
    description: `Gatekeeper approved ${GATE_ID}`, target_url: runUrls(RECEIVER).html_url })));
  assert.deepEqual(gate.STATUS_CONTEXTS, ["governance/protected-files", "quality/static", "quality/unit", "quality/e2e-chromium",
    "quality/e2e-webkit-mobile", "quality/accessibility", "review/independent"]);
  assert.deepEqual(f.state.labelWrites, [{ client: "workflow", action: "remove", issue: PR, name: gate.PENDING_LABEL },
    { client: "workflow", action: "add", issue: PR, labels: [gate.APPROVED_LABEL] }]);
  assert.equal(hasLabel(f, gate.APPROVED_LABEL), true); assert.equal(hasLabel(f, gate.PENDING_LABEL), false);
  // The labels were written only after the seventh status.
  const order = f.calls.map(({ route }) => route).filter((route) => route && /statuses|labels/.test(route));
  assert.equal(order.findIndex((route) => route.includes("labels")), 7);
  // Writes: one dispatch, seven statuses, two label calls. Nothing else, and no READ of secrets or variables.
  const writes = f.calls.filter(({ route }) => route && !route.startsWith("GET "));
  assert.equal(writes.length, 10);
  assert.equal(routesOf(f, /rerun|cancel|pending_deployments|approvals\/|secrets|variables/).length, 0);
  assert.equal(f.calls.filter(({ client, route }) => client === "app" && !/\/statuses\//.test(route)).length, 0);
});

test("BGT-001 dispatch writes the bound receipt once and records the stage without overwriting", async () => {
  const f = fixture(), result = await runStage(f, "dispatch");
  assert.deepEqual((await readdir(f.root)).sort(), ["observation", "receipt"]);
  const text = await readFile(join(f.root, "receipt", gate.RECEIPT_FILE), "utf8");
  assert.equal(text, JSON.stringify(result.receipt, null, 2) + "\n");
  assert.deepEqual(Object.keys(result.receipt), ["schema", "repository", "repositoryId", "gateId", "mainSha", "source", "receiver", "inputs", "binding", "environment", "dispatchedAt"]);
  assert.equal(result.receipt.dispatchedAt, instant()); assert.equal(result.receipt.receiver.id, RECEIVER);
  const record = await observation(f, "dispatch");
  assert.equal(record.result, "STAGE_COMPLETED"); assert.equal(record.repositoryGatePass, false); assert.equal(record.productPass, false);
  // A second execution in the same place sees its own receiver, keeps the first receipt and fails closed.
  await rejectsCode(runStage(f, "dispatch", { root: f.root }), "DUPLICATE_GATE_REJECTED");
  assert.equal(await readFile(join(f.root, "receipt", gate.RECEIPT_FILE), "utf8"), text);
  assert.equal(dispatchWrites(f).length, 1);
});

for (const [name, change, code] of [
  ["204", (f) => { f.state.dispatchResponse = { status: 204, data: null }; }, "DISPATCH_RESPONSE_INVALID_NO_RETRY"],
  ["malformed 200", (f) => { f.state.dispatchResponse.data = {}; }, "DISPATCH_BODY_INVALID"],
  ["missing run URL", (f) => { delete f.state.dispatchResponse.data.run_url; }, "DISPATCH_BODY_INVALID"],
  ["string run ID", (f) => { f.state.dispatchResponse.data.workflow_run_id = String(RECEIVER); }, "DISPATCH_BINDING_INVALID"],
  ["its own run ID", (f) => { f.state.dispatchResponse.data.workflow_run_id = SOURCE; }, "DISPATCH_BINDING_INVALID"],
  ["another HTML URL", (f) => { f.state.dispatchResponse.data.html_url += "?token=synthetic"; }, "DISPATCH_BINDING_INVALID"],
  ["another API URL", (f) => { f.state.dispatchResponse.data.run_url = runUrls(RECEIVER + 1).url; }, "DISPATCH_BINDING_INVALID"],
  ["unknown body key", (f) => { f.state.dispatchResponse.data.extra = "synthetic"; }, "DISPATCH_BODY_INVALID"],
  ["lost response", (f) => { f.state.override = (route) => { if (route.startsWith("POST ")) throw new Error("Bearer synthetic-credential"); }; }, "DISPATCH_RESPONSE_UNKNOWN_NO_RETRY"],
]) test("BGT-001 dispatch response with " + name + " ends the attempt after a single POST", async () => {
  const f = fixture(); change(f);
  await rejectsCode(runStage(f, "dispatch"), code);
  assert.equal(dispatchWrites(f).length, 1);
  assert.equal(f.calls.filter(({ route }) => route && !route.startsWith("GET ")).length, 1); // No re-POST, rerun or cancel.
  assert.deepEqual(await readdir(f.root), ["observation"]);
  const record = await observation(f, "dispatch");
  assert.equal(record.code, code); assert.equal(record.approvedLabel, false); assert.deepEqual(record.publishedContexts, []);
  assert.equal(JSON.stringify(record).includes("synthetic-credential"), false);
});

for (const [name, change, code] of [
  ["nothing selected (empty prepare outputs)", (f) => { f.selection = gate.selectionFromEnv({}); }, "INPUT_TYPE_INVALID"],
  ["an extra selection field", (f) => { f.selection.url = "https://synthetic.invalid"; }, "INPUT_KEYS_INVALID"],
  ["an invalid gate ID", (f) => { f.selection.gate_id = "x"; }, "INPUT_IDENTITY_INVALID"],
  ["an evidence branch of another gate", (f) => { f.selection.evidence_branch = "review-evidence/other-gate"; }, "INPUT_EVIDENCE_BRANCH_INVALID"],
  ["a second attempt of the scheduled run", (f) => { f.context = { ...sourceContext(), runAttempt: 2 }; }, "CONTEXT_UNTRUSTED"],
  ["a manual start of the scheduled workflow", (f) => { f.context = { ...sourceContext(), eventName: "workflow_dispatch" }; }, "CONTEXT_UNTRUSTED"],
  ["another ref", (f) => { f.context = { ...sourceContext(), ref: "refs/heads/feature" }; }, "CONTEXT_UNTRUSTED"],
  ["a fork repository", (f) => { f.context = { ...sourceContext(), repository: "synthetic/fork" }; }, "CONTEXT_UNTRUSTED"],
  ["another workflow file", (f) => { f.context = { ...sourceContext(), workflowRef: gateContext().workflowRef }; }, "CONTEXT_UNTRUSTED"],
  ["a base SHA that is not the run commit", (f) => { f.selection.base_sha = OTHER_SHA; }, "CONTEXT_UNTRUSTED"],
  ["a moved main", (f) => { f.state.branch.commit.sha = OTHER_SHA; }, "MAIN_CHANGED"],
  ["a private repository", (f) => { f.state.repository.private = true; }, "REPOSITORY_INVALID"],
  ["a disabled board gate workflow", (f) => { f.state.workflows["board-gate.yml"].state = "disabled_manually"; }, "WORKFLOW_INVALID"],
  ["a board gate workflow at another path", (f) => { f.state.workflows["board-gate.yml"].path = ".github/workflows/other.yml"; }, "WORKFLOW_INVALID"],
  ["a recorded run of another event", (f) => { f.state.runs[SOURCE].event = "workflow_dispatch"; }, "RUN_PROVENANCE_INVALID"],
  ["a recorded second attempt", (f) => { f.state.runs[SOURCE].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["another actor than the context", (f) => { f.state.runs[SOURCE].actor = clone(stranger); f.state.runs[SOURCE].triggering_actor = clone(stranger); }, "CONTEXT_ACTOR_MISMATCH"],
  ["a failed trusted recheck", (f) => { f.state.jobs[1].conclusion = "failure"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a skipped trusted recheck", (f) => { f.state.jobs[1].conclusion = "skipped"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a missing trusted recheck job", (f) => { f.state.jobs.splice(1, 1); }, "SOURCE_JOBS_INVALID"],
  ["an unknown extra job", (f) => { f.state.jobs.push({ ...f.state.jobs[1], id: 899, name: "synthetic" }); }, "SOURCE_JOBS_INVALID"],
  ["jobs of a second attempt", (f) => { f.state.jobs[1].run_attempt = 2; }, "SOURCE_JOBS_INVALID"],
  ["Environment admin bypass", (f) => { f.state.environment.can_admins_bypass = true; }, "ENVIRONMENT_INVALID"],
  ["self-review prevention off", (f) => { f.state.environment.protection_rules[1].prevent_self_review = false; }, "ENVIRONMENT_REVIEWER_INVALID"],
  ["a missing Environment", (f) => { f.state.override = (route) => route.endsWith("/environments/{environment_name}") ? { status: 404, data: null } : undefined; }, "API_READ_STATUS_INVALID"],
  ["a moved PR head", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a closed PR", (f) => { f.state.pulls[PR].state = "closed"; }, "PULL_REQUEST_STALE"],
  ["a PR base that is not the current main", (f) => { f.state.pulls[PR].base.sha = OTHER_SHA; }, "PULL_REQUEST_BASE_STALE"],
  ["a PR without the pending label", (f) => { f.state.pulls[PR].labels = []; }, "PULL_REQUEST_LABEL_INVALID"],
  ["a PR already marked stale", (f) => { f.state.pulls[PR].labels.push({ name: "review:stale" }); }, "PULL_REQUEST_LABEL_INVALID"],
  ["a head that does not contain main", (f) => { f.state.comparisons[`${MAIN}...${HEAD}`].status = "diverged"; }, "PULL_REQUEST_BASE_NOT_CONTAINED"],
  ["a moved evidence branch", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
  ["an earlier run of the same gate", (f) => { f.state.list = [receiverRunData(499)]; }, "DUPLICATE_GATE_REJECTED"],
  ["an existing receipt of this run", (f) => { f.state.artifacts.push({ id: 951, name: gate.gateReceiptName(SOURCE) }); }, "DISPATCH_ALREADY_RECEIPTED"],
  ["an unreadable run list", (f) => { f.state.override = (route) => route.endsWith("/runs") ? { status: 200, data: { total_count: 1001, workflow_runs: [] } } : undefined; }, "RUN_LIST_INVALID"],
]) test("BGT-001 the scheduled source does not dispatch with " + name, async () => {
  const f = fixture(); change(f);
  await rejectsCode(runStage(f, "dispatch", f.context ? { context: f.context } : {}), code);
  assert.equal(f.calls.filter(({ route }) => route && !route.startsWith("GET ")).length, 0);
  assert.deepEqual(await readdir(f.root), ["observation"]);
  assert.equal((await observation(f, "dispatch")).code, code);
});

test("BGT-001 an unrelated gate of the same main commit does not block the dispatch", async () => {
  const f = fixture(); f.state.override = (route) => route.endsWith("/runs")
    ? { status: 200, data: { total_count: 1 + Number(f.state.receiverCreated), workflow_runs: [receiverRunData(499, "gate-0013-unrelated"), ...(f.state.receiverCreated ? [f.state.runs[RECEIVER]] : [])] } } : undefined;
  assert.equal((await runStage(f, "dispatch")).receipt.receiver.id, RECEIVER);
});

test("BGT-001 the receipt waits for the run-name of the same receiver and is not written before it", async () => {
  const f = fixture(), title = f.state.runs[RECEIVER].display_title, delays = [], root = join(await roots, "title-wait");
  f.state.runs[RECEIVER].display_title = "Board gate approval and status publication"; f.state.runs[RECEIVER].status = "queued";
  const result = await runStage(f, "dispatch", { root, sleep: async (ms) => {
    delays.push(ms); f.state.now += ms; await assert.rejects(readdir(root), { code: "ENOENT" });
    if (delays.length === 2) f.state.runs[RECEIVER].display_title = title;
  } });
  assert.deepEqual((await readdir(root)).sort(), ["observation", "receipt"]);
  assert.deepEqual(delays, [3000, 3000]); assert.equal(dispatchWrites(f).length, 1);
  assert.deepEqual(result.receiverRead, { reads: 3, firstIssues: [{ field: "display_title", kind: "mismatch" }], lastIssues: [] });
});
for (const [name, change, code] of [
  ["a title of another gate", (r) => { r.display_title = gate.gateTitle("gate-0013-other"); }, "RUN_PROVENANCE_INVALID"],
  ["a receiver started by a person", (r) => { r.actor = clone(owner); r.triggering_actor = clone(owner); }, "RECEIVER_ACTOR_UNPROVEN"],
  ["a receiver at another commit", (r) => { r.head_sha = OTHER_SHA; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver of another workflow", (r) => { r.workflow_id = SOURCE_WORKFLOW_ID; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver that predates the dispatch", (r) => { r.created_at = instant(-1001); r.display_title = "Provisional"; }, "RECEIPT_EXPIRED"],
]) test("BGT-001 no receipt is produced for " + name, async () => {
  const f = fixture(); change(f.state.runs[RECEIVER]);
  await rejectsCode(runStage(f, "dispatch"), code);
  assert.equal(dispatchWrites(f).length, 1); assert.deepEqual(await readdir(f.root), ["observation"]);
});

for (const [name, change, code] of [
  ["unknown key", (i) => { i.mode = "receive"; }, "INPUT_KEYS_INVALID"],
  ["missing key", (i) => { delete i.evidence_sha256; }, "INPUT_KEYS_INVALID"],
  ["numeric pull request", (i) => { i.pull_request = PR; }, "INPUT_TYPE_INVALID"],
  ["pull request zero", (i) => { i.pull_request = "0"; }, "INPUT_IDENTITY_INVALID"],
  ["gate ID with a separator", (i) => { i.gate_id = "gate:other"; }, "INPUT_IDENTITY_INVALID"],
  ["upper-case SHA", (i) => { i.fixed_sha = "C".repeat(40); }, "INPUT_SHA_INVALID"],
  ["short digest", (i) => { i.evidence_sha256 = "d".repeat(63); }, "INPUT_SHA_INVALID"],
  ["evidence branch of another gate", (i) => { i.evidence_branch = "review-evidence/other-gate"; }, "INPUT_EVIDENCE_BRANCH_INVALID"],
  ["second source attempt", (i) => { i.source_attempt = "2"; }, "SOURCE_INPUT_INVALID"],
  ["empty source run", (i) => { i.source_run_id = ""; }, "SOURCE_INPUT_INVALID"],
]) test("BGT-002 the receiver accepts known inputs only: " + name, () => {
  const inputs = gateInputs(); change(inputs);
  assert.throws(() => gate.parseGateInputs(inputs), (error) => error instanceof gate.GateError && error.code === code);
});
test("BGT-002 input key order is immaterial and non-objects are rejected", () => {
  assert.deepEqual(gate.parseGateInputs(Object.fromEntries(Object.entries(gateInputs()).reverse())), gateInputs());
  assert.deepEqual(Object.keys(gate.parseGateInputs(gateInputs())), gate.INPUT_KEYS);
  for (const value of [undefined, null, [], "synthetic", 1]) assert.throws(() => gate.parseGateInputs(value), gate.GateError);
});

for (const [name, change, code] of [
  ["the board owner starting the run directly", (f) => { f.state.runs[RECEIVER].actor = clone(owner); f.state.runs[RECEIVER].triggering_actor = clone(owner); f.context = { ...gateContext(), actor: owner.login, actorId: owner.id, triggeringActor: owner.login }; }, "RECEIVER_ACTOR_UNPROVEN"],
  ["a third party starting the run directly", (f) => { f.state.runs[RECEIVER].actor = clone(stranger); f.state.runs[RECEIVER].triggering_actor = clone(stranger); f.context = { ...gateContext(), actor: stranger.login, actorId: stranger.id, triggeringActor: stranger.login }; }, "RECEIVER_ACTOR_UNPROVEN"],
  ["a bot whose ID equals the reviewer ID", (f) => { f.state.environment.protection_rules[1].reviewers[0].reviewer.id = bot.id; }, "RECEIVER_ACTOR_UNPROVEN"],
  ["a person re-triggering a bot-started run", (f) => { f.state.runs[RECEIVER].triggering_actor = clone(owner); }, "TRIGGERING_ACTOR_CHANGED"],
  ["a context actor that differs from the recorded run", (f) => { f.context = { ...gateContext(), actorId: owner.id }; }, "CONTEXT_ACTOR_MISMATCH"],
  ["a context triggering actor that differs from the recorded run", (f) => { f.context = { ...gateContext(), triggeringActor: owner.login }; }, "CONTEXT_ACTOR_MISMATCH"],
]) test("BGT-002 preflight never reaches the receipt or the Environment job with " + name, async () => {
  const f = await dispatched(); change(f); f.calls.length = 0;
  await rejectsCode(runStage(f, "guard", f.context ? { context: f.context } : {}), code);
  assert.equal(f.calls.some(({ download, route }) => download || /artifacts|approvals/.test(route ?? "")), false);
  assertNothingReleased(f);
  // Without the "verified" output the protected job is never scheduled; even if it ran, it stops the same way.
  await rejectsCode(runStage(f, "protected", { expectedEnvironment: probe.validateEnvironment(fixture().state.environment, f.state.policies), ...(f.context ? { context: f.context } : {}) }), code);
  assertNothingReleased(f);
});

test("BGT-003 preflight binds the receiver to the scheduled source, its jobs and its single receipt", async () => {
  const f = await dispatched(); f.calls.length = 0;
  const result = await runStage(f, "guard", { inputs: Object.fromEntries(Object.entries(f.inputs).reverse()) });
  assert.deepEqual(result.receipt, f.receipt); assert.equal(result.snapshot.run.id, RECEIVER); assert.equal(result.source.id, SOURCE);
  assert.equal(result.source.workflowRef, `${REPO}/${gate.SOURCE_WORKFLOW}@refs/heads/main`);
  assert.deepEqual(result.snapshot.environment, probe.validateEnvironment(f.state.environment, f.state.policies));
  assert.equal(f.calls.filter(({ route }) => route && !route.startsWith("GET ")).length, 0); // READ only.
  assert.equal(f.calls.filter(({ download }) => download).length, 1);
  const runsList = routesOf(f, /workflows\/\{workflow_id\}\/runs$/)[0].params;
  assert.equal(runsList.head_sha, MAIN); assert.equal(runsList.event, "workflow_dispatch"); assert.equal(runsList.workflow_id, GATE_WORKFLOW_ID);
  const record = await observation(f, "guard"); assert.equal(record.result, "STAGE_COMPLETED"); assert.equal(record.receipt.gateId, GATE_ID);
});

test("BGT-003 preflight waits with READs only while the scheduled source is still finishing", async () => {
  const f = fixture(), receipt = (await runStage(f, "dispatch")).receipt, waits = []; f.calls.length = 0;
  await runStage(f, "guard", { sleep: async (ms) => { waits.push(ms); f.state.now += ms; if (waits.length === 2) completeSource(f, receipt); } });
  assert.deepEqual(waits, [3000, 3000]); assert.equal(f.calls.some(({ route }) => route && !route.startsWith("GET ")), false);
});
test("BGT-003 the wait for the scheduled source is bounded at 120 seconds and ends BLOCKED", async () => {
  const f = fixture(); await runStage(f, "dispatch"); let waits = 0; const started = f.state.now;
  await assert.rejects(runStage(f, "guard", { sleep: async (ms) => { assert.equal(ms, 3000); waits++; f.state.now += ms; } }),
    (error) => error.code === "RECEIPT_READINESS_TIMEOUT" && error.result === "BLOCKED");
  assert.equal(waits, 40); assert.equal(f.state.now - started, probe.READ_WAIT_MS); assertNothingReleased(f);
});

// Preflight negatives. Each leaves the "verified" output unset, so the protected
// job is not scheduled; none of them may write anything.
const preflightNegatives = [
  ["a source run of another workflow ID", (f) => { f.state.runs[SOURCE].workflow_id = GATE_WORKFLOW_ID; }, "RUN_PROVENANCE_INVALID"],
  ["a source run at another workflow path", (f) => { f.state.runs[SOURCE].path = ".github/workflows/board-actor-probe.yml"; }, "RUN_PROVENANCE_INVALID"],
  ["a source run that is the board gate workflow itself", (f) => { Object.assign(f.state.runs[SOURCE], { workflow_id: GATE_WORKFLOW_ID, path: gate.GATE_WORKFLOW, event: "workflow_dispatch" }); }, "RUN_PROVENANCE_INVALID"],
  ["a manually started source run", (f) => { f.state.runs[SOURCE].event = "workflow_dispatch"; }, "RUN_PROVENANCE_INVALID"],
  ["a source run on another branch", (f) => { f.state.runs[SOURCE].head_branch = "feature"; }, "RUN_PROVENANCE_INVALID"],
  ["a source run at another commit", (f) => { f.state.runs[SOURCE].head_sha = OTHER_SHA; }, "RUN_PROVENANCE_INVALID"],
  ["a second attempt of the source run", (f) => { f.state.runs[SOURCE].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["a source run from a fork", (f) => { f.state.runs[SOURCE].head_repository.id++; }, "RUN_PROVENANCE_INVALID"],
  ["a source run older than one day", (f) => { f.state.runs[SOURCE].created_at = instant(-gate.SOURCE_RUN_TTL_MS - 1); }, "RUN_EXPIRED"],
  ["a source run in the future", (f) => { f.state.runs[SOURCE].created_at = instant(1); }, "RUN_EXPIRED"],
  ["a failed source run", (f) => { f.state.runs[SOURCE].conclusion = "failure"; }, "SOURCE_TERMINAL_FAILURE"],
  ["a cancelled source run", (f) => { f.state.runs[SOURCE].conclusion = "cancelled"; }, "SOURCE_TERMINAL_FAILURE"],
  ["a failed trusted recheck job", (f) => { f.state.jobs[1].conclusion = "failure"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a skipped trusted recheck job", (f) => { f.state.jobs[1].conclusion = "skipped"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a missing trusted recheck job", (f) => { f.state.jobs.splice(1, 1); }, "SOURCE_JOBS_INVALID"],
  ["a second trusted recheck job", (f) => { f.state.jobs.push({ ...f.state.jobs[1], id: 899 }); }, "SOURCE_JOBS_INVALID"],
  ["jobs of a second attempt", (f) => { f.state.jobs[2].run_attempt = 2; }, "SOURCE_JOBS_INVALID"],
  ["an unfinished dispatch job", (f) => { Object.assign(f.state.jobs[2], { status: "in_progress", conclusion: null }); }, "SOURCE_VERIFY_UNPROVEN"],
  ["a completed source without a receipt", (f) => { f.state.artifacts = f.state.artifacts.filter((item) => item.id !== ARTIFACT_ID); }, "COMPLETED_SOURCE_RECEIPT_MISSING"],
  ["two receipts", (f) => { f.state.artifacts.push({ ...clone(receiptArtifact(f)), id: 951 }); }, "DUPLICATE_RECEIPT_REJECTED"],
  ["a receipt of another run", (f) => { receiptArtifact(f).workflow_run.id++; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a receipt of another repository", (f) => { receiptArtifact(f).workflow_run.head_repository_id++; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a receipt of another commit", (f) => { receiptArtifact(f).workflow_run.head_sha = OTHER_SHA; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["an expired receipt artifact", (f) => { receiptArtifact(f).expired = true; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a receipt kept longer than one day", (f) => { receiptArtifact(f).expires_at = instant(2 * 24 * 60 * 60 * 1000); }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a receipt without a digest", (f) => { delete receiptArtifact(f).digest; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a modified archive", (f) => { f.state.archive[60] ^= 1; }, "ARCHIVE_DIGEST_INVALID"],
  ["another archive digest", (f) => { receiptArtifact(f).digest = "sha256:" + "0".repeat(64); }, "ARCHIVE_DIGEST_INVALID"],
  ["another archive length", (f) => { receiptArtifact(f).size_in_bytes++; }, "ARCHIVE_SIZE_INVALID"],
  ["an archive entry with another name", (f) => { f.state.archive = zip(JSON.stringify(f.receipt, null, 2) + "\n", "receipt.json"); Object.assign(receiptArtifact(f), { digest: digest(f.state.archive), size_in_bytes: f.state.archive.length }); }, "ZIP_ENTRY_INVALID"],
  ["a non-canonical receipt", (f) => { f.state.archive = zip(JSON.stringify(f.receipt)); Object.assign(receiptArtifact(f), { digest: digest(f.state.archive), size_in_bytes: f.state.archive.length }); }, "RECEIPT_JSON_NONCANONICAL"],
  ["a receipt with another PR number", (f) => { f.receipt.inputs.pull_request = "43"; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another fixed SHA", (f) => { f.receipt.inputs.fixed_sha = OTHER_SHA; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another bound head", (f) => { f.receipt.binding.fixedSha = OTHER_SHA; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another base SHA", (f) => { f.receipt.mainSha = OTHER_SHA; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another gate ID", (f) => { f.receipt.gateId = "gate-0013-other"; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another evidence branch", (f) => { f.receipt.binding.evidenceBranch = "review-evidence/gate-0013-other"; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another evidence commit", (f) => { f.receipt.binding.evidenceCommitSha = OTHER_SHA; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another evidence digest", (f) => { f.receipt.binding.evidenceSha256 = "0".repeat(64); packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another source observation", (f) => { f.receipt.source.actor.id++; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt with another Environment", (f) => { f.receipt.environment.id++; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt naming another receiver", (f) => { f.receipt.receiver.id++; packageReceipt(f, f.receipt); }, "RECEIPT_RECEIVER_INVALID"],
  ["a receipt with another receiver actor", (f) => { f.receipt.receiver.run.actor.id++; packageReceipt(f, f.receipt); }, "RECEIPT_RECEIVER_INVALID"],
  ["a receipt with an extra key", (f) => { f.receipt.access_token = "short-canary"; packageReceipt(f, f.receipt); }, "RECEIPT_SCHEMA_INVALID"],
  ["a receipt without the binding", (f) => { delete f.receipt.binding; packageReceipt(f, f.receipt); }, "RECEIPT_SCHEMA_INVALID"],
  ["a receipt of another schema", (f) => { f.receipt.schema = "board-actor-dispatch-receipt:v1"; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["a receipt dated in the future", (f) => { f.receipt.dispatchedAt = instant(1); packageReceipt(f, f.receipt); }, "RECEIPT_EXPIRED"],
  ["a receipt older than one hour", (f) => { f.receipt.dispatchedAt = instant(-gate.GATE_TTL_MS - 1); packageReceipt(f, f.receipt); }, "RECEIPT_EXPIRED"],
  ["a receipt just past one hour while the receiver is not", (f) => { f.receipt.dispatchedAt = instant(-500); packageReceipt(f, f.receipt); f.state.now = NOW + gate.GATE_TTL_MS; }, "RECEIPT_EXPIRED"],
  ["a receiver created more than a second before its dispatch", (f) => { f.receipt.dispatchedAt = instant(1001); packageReceipt(f, f.receipt); f.state.now = NOW + 2000; }, "RECEIPT_EXPIRED"],
  ["one hour passing since the dispatch", (f) => { f.state.now += gate.GATE_TTL_MS + 1; }, "RUN_EXPIRED"],
  ["a moved main", (f) => { f.state.branch.commit.sha = OTHER_SHA; }, "MAIN_CHANGED"],
  ["a moved PR head", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a moved evidence branch", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
  ["a deleted evidence branch", (f) => { delete f.state.refs[`heads/review-evidence/${GATE_ID}`]; }, "API_READ_STATUS_INVALID"],
  ["a second receiver of the same gate", (f) => { f.state.list = [f.state.runs[RECEIVER], receiverRunData(502)]; }, "DUPLICATE_GATE_REJECTED"],
  ["a receiver missing from the run list", (f) => { f.state.list = []; }, "DUPLICATE_GATE_REJECTED"],
  ["its own run named as the source", (f) => { f.inputs.source_run_id = String(RECEIVER); }, "RECEIVER_SOURCE_INVALID"],
  ["another claimed source run", (f) => { f.inputs.source_run_id = "499"; }, "API_READ_STATUS_INVALID"],
  ["a second attempt of the receiver", (f) => { f.context = { ...gateContext(), runAttempt: 2 }; }, "CONTEXT_UNTRUSTED"],
  ["a recorded second attempt of the receiver", (f) => { f.state.runs[RECEIVER].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver on another ref", (f) => { f.context = { ...gateContext(), ref: "refs/heads/feature" }; }, "CONTEXT_UNTRUSTED"],
  ["a receiver on a tag named main", (f) => { f.context = { ...gateContext(), ref: "refs/tags/main" }; }, "CONTEXT_UNTRUSTED"],
  ["a recorded receiver on another branch", (f) => { f.state.runs[RECEIVER].head_branch = "feature"; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver in a fork", (f) => { f.context = { ...gateContext(), repository: "synthetic/fork" }; }, "CONTEXT_UNTRUSTED"],
  ["a recorded receiver from a fork", (f) => { f.state.runs[RECEIVER].head_repository = { id: REPO_ID + 1, full_name: "synthetic/fork" }; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver of another workflow file", (f) => { f.context = { ...gateContext(), workflowRef: sourceContext().workflowRef }; }, "CONTEXT_UNTRUSTED"],
  ["a receiver started by another event", (f) => { f.context = { ...gateContext(), eventName: "schedule" }; }, "CONTEXT_UNTRUSTED"],
  ["a receiver whose title names another gate", (f) => { f.state.runs[RECEIVER].display_title = gate.gateTitle("gate-0013-other"); }, "RUN_PROVENANCE_INVALID"],
  ["an Environment with a second reviewer", (f) => { f.state.environment.protection_rules[1].reviewers.push({ type: "User", reviewer: clone(stranger) }); }, "ENVIRONMENT_REVIEWER_INVALID"],
  ["an Environment that allows another branch", (f) => { f.state.policies.branch_policies[0].name = "main*"; }, "ENVIRONMENT_BRANCH_INVALID"],
];
for (const [name, change, code] of preflightNegatives) test("BGT-003/006 preflight stops on " + name, async () => {
  const f = await dispatched(); change(f); f.calls.length = 0;
  await rejectsCode(runStage(f, "guard", f.context ? { context: f.context } : {}), code);
  assertNothingReleased(f);
  const record = await observation(f, "guard");
  assert.equal(record.code, code); assert.equal(record.approvedLabel, false); assert.deepEqual(record.publishedContexts, []);
  assert.deepEqual(await readdir(f.root), ["observation"]);
});
for (const status of [403, 404, 500]) test("BGT-003 a READ status " + status + " is BLOCKED and nothing is created", async () => {
  const f = await dispatched(); f.state.readStatus = status; f.calls.length = 0;
  await assert.rejects(runStage(f, "guard"), (error) => error.code === "API_READ_STATUS_INVALID" && error.result === "BLOCKED");
  assert.equal(f.calls.length, 1); assertNothingReleased(f);
});
test("BGT-003 the receipt artifact expiring during the download is rejected", async () => {
  const f = await dispatched(); receiptArtifact(f).expires_at = instant(1);
  f.api.download = async () => { f.state.now += 2; return f.state.archive; };
  await rejectsCode(runStage(f, "guard"), "ARTIFACT_EXPIRED_DURING_DOWNLOAD"); assertNothingReleased(f);
});

test("BGT-004 the protected recheck repeats every binding after approval and releases nothing by itself", async () => {
  const f = await guarded(); f.calls.length = 0;
  const release = await runStage(f, "protected", { expectedEnvironment: f.expectedEnvironment });
  assert.deepEqual(Object.keys(release), ["schema", "repository", "gateId", "binding", "runId", "targetUrl", "sourceRunId", "artifact", "environment", "review", "humanOperationProven", "verifiedAt"]);
  assert.equal(release.runId, RECEIVER); assert.equal(release.targetUrl, runUrls(RECEIVER).html_url); assert.equal(release.verifiedAt, instant());
  const reads = f.calls.map(({ route }) => route).filter(Boolean);
  for (const route of ["pulls/{pull_number}", "compare/{basehead}", "git/ref/{ref}", "branches/{branch}", "environments/{environment_name}", "deployment-branch-policies", "runs/{run_id}/approvals", "runs/{run_id}/jobs"]) {
    assert.ok(reads.some((item) => item.endsWith(route)), route);
  }
  // PR, containment, evidence, main and Environment are read again after the approval history.
  const approvalAt = reads.findIndex((route) => route.endsWith("/approvals"));
  for (const route of ["pulls/{pull_number}", "compare/{basehead}", "git/ref/{ref}", "branches/{branch}", "environments/{environment_name}"]) {
    assert.ok(reads.slice(approvalAt).some((item) => item.endsWith(route)), route);
  }
  assert.equal(f.calls.some(({ route }) => route && !route.startsWith("GET ")), false);
  assertNothingReleased(f);
});

// After preflight succeeded and while the run waits for the board approval.
const approvalNegatives = [
  ["a rejected review", (f) => { f.state.history[0].state = "rejected"; }, "BOARD_REVIEW_UNVERIFIED"],
  ["no review at all", (f) => { f.state.history = []; }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review by another account", (f) => { f.state.history[0].user = clone(stranger); }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review by the Actions bot", (f) => { f.state.history[0].user = clone(bot); }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review with the reviewer login but another ID", (f) => { f.state.history[0].user.id++; }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review with the reviewer ID but another login", (f) => { f.state.history[0].user.login = "synthetic-other"; }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review with the reviewer identity but type Bot", (f) => { f.state.history[0].user.type = "Bot"; }, "BOARD_REVIEW_UNVERIFIED"],
  ["a review of another Environment", (f) => { f.state.history[0].environments[0].id++; }, "BOARD_REVIEW_UNVERIFIED"],
  ["two reviews", (f) => { f.state.history.push(clone(f.state.history[0])); }, "BOARD_REVIEW_UNVERIFIED"],
  ["an approval and a rejection", (f) => { f.state.history.push({ ...clone(f.state.history[0]), state: "rejected" }); }, "BOARD_REVIEW_UNVERIFIED"],
  ["an unreadable review history", (f) => { f.state.history = { total_count: 0 }; }, "REVIEW_HISTORY_INVALID"],
  ["an approval after the one-hour limit", (f) => { f.state.now += gate.GATE_TTL_MS + 1; }, "RUN_EXPIRED"],
  ["a receipt artifact that expired while waiting", (f) => { f.state.now += 60_000; receiptArtifact(f).expired = true; }, "ARTIFACT_PROVENANCE_INVALID"],
  ["a receipt deleted while waiting", (f) => { f.state.artifacts = f.state.artifacts.filter((item) => item.id !== ARTIFACT_ID); }, "COMPLETED_SOURCE_RECEIPT_MISSING"],
  ["a source run that turned to failure", (f) => { f.state.runs[SOURCE].conclusion = "failure"; }, "SOURCE_TERMINAL_FAILURE"],
  ["a source run re-run as a second attempt", (f) => { f.state.runs[SOURCE].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["a trusted recheck re-run to failure", (f) => { f.state.jobs[1].conclusion = "failure"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a new commit on the PR", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a merged PR", (f) => { f.state.pulls[PR].merged = true; f.state.pulls[PR].state = "closed"; }, "PULL_REQUEST_STALE"],
  ["a PR retargeted to another branch", (f) => { f.state.pulls[PR].base.ref = "develop"; }, "PULL_REQUEST_BASE_STALE"],
  ["a PR base that moved", (f) => { f.state.pulls[PR].base.sha = OTHER_SHA; }, "PULL_REQUEST_BASE_STALE"],
  ["a PR base in a fork", (f) => { f.state.pulls[PR].base.repo = { id: REPO_ID + 1, full_name: "synthetic/fork" }; }, "PULL_REQUEST_BASE_STALE"],
  ["a main that moved", (f) => { f.state.branch.commit.sha = OTHER_SHA; }, "MAIN_CHANGED"],
  ["a head that no longer contains main", (f) => { f.state.comparisons[`${MAIN}...${HEAD}`].status = "behind"; }, "PULL_REQUEST_BASE_NOT_CONTAINED"],
  ["a head that diverged from main", (f) => { f.state.comparisons[`${MAIN}...${HEAD}`].status = "diverged"; }, "PULL_REQUEST_BASE_NOT_CONTAINED"],
  ["an evidence branch that moved", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
  ["an evidence branch replaced by a tag object", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.type = "tag"; }, "EVIDENCE_CHANGED"],
  ["a modified receipt archive", (f) => { f.state.archive[60] ^= 1; }, "ARCHIVE_DIGEST_INVALID"],
  ["a replaced receipt with a matching digest", (f) => { f.receipt.binding.fixedSha = OTHER_SHA; packageReceipt(f, f.receipt); }, "RECEIPT_PROVENANCE_INVALID"],
  ["the pending label removed by the board owner", (f) => { f.state.pulls[PR].labels = f.state.pulls[PR].labels.filter((label) => label.name !== gate.PENDING_LABEL); }, "PULL_REQUEST_LABEL_INVALID", false],
  ["the PR marked stale by the next scheduled run", (f) => { f.state.pulls[PR].labels = [{ name: "review:stale" }]; }, "PULL_REQUEST_LABEL_INVALID", false],
  ["a second receiver of the same gate", (f) => { f.state.list = [f.state.runs[RECEIVER], receiverRunData(502)]; }, "DUPLICATE_GATE_REJECTED"],
  ["a second attempt of the receiver", (f) => { f.context = { ...gateContext(), runAttempt: 2 }; f.state.runs[RECEIVER].run_attempt = 2; }, "CONTEXT_UNTRUSTED"],
  ["a recorded second attempt of the receiver", (f) => { f.state.runs[RECEIVER].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["a person re-running the receiver", (f) => { f.state.runs[RECEIVER].triggering_actor = clone(owner); }, "TRIGGERING_ACTOR_CHANGED"],
  ["an Environment without self-review prevention", (f) => { f.state.environment.protection_rules[1].prevent_self_review = false; }, "ENVIRONMENT_REVIEWER_INVALID"],
  ["an Environment with admin bypass", (f) => { f.state.environment.can_admins_bypass = true; }, "ENVIRONMENT_INVALID"],
  ["an Environment with a second reviewer", (f) => { f.state.environment.protection_rules[1].reviewers.push({ type: "User", reviewer: clone(stranger) }); }, "ENVIRONMENT_REVIEWER_INVALID"],
  ["an Environment reviewed by a team", (f) => { f.state.environment.protection_rules[1].reviewers[0].type = "Team"; }, "ENVIRONMENT_REVIEWER_INVALID"],
  ["an Environment open to another branch", (f) => { f.state.policies.branch_policies.push({ id: 902, name: "develop", type: "branch" }); f.state.policies.total_count = 2; }, "ENVIRONMENT_BRANCH_INVALID"],
  ["an Environment open to all protected branches", (f) => { f.state.environment.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; }, "ENVIRONMENT_BRANCH_INVALID"],
  ["a recreated Environment with another ID", (f) => { f.state.environment.id++; }, "RECEIPT_PROVENANCE_INVALID"],
  ["another reviewer ID in the Environment", (f) => { f.state.environment.protection_rules[1].reviewers[0].reviewer.id = 83; }, "RECEIPT_PROVENANCE_INVALID"],
];
for (const [name, change, code, pendingKept = true] of approvalNegatives) test("BGT-004/006 no status and no approved label after " + name, async () => {
  const f = await guarded(); change(f); f.calls.length = 0;
  await rejectsCode(runStage(f, "protected", { expectedEnvironment: f.expectedEnvironment, ...(f.context ? { context: f.context } : {}) }), code);
  assert.equal(f.calls.some(({ route }) => route && !route.startsWith("GET ")), false);
  assert.deepEqual(f.state.statuses, []); assert.deepEqual(f.state.labelWrites, []);
  assert.equal(hasLabel(f, gate.APPROVED_LABEL), false); assert.equal(hasLabel(f, gate.PENDING_LABEL), pendingKept);
  const record = await observation(f, "protected");
  assert.equal(record.code, code); assert.equal(record.approvedLabel, false); assert.deepEqual(record.publishedContexts, []);
  assert.equal(Object.hasOwn(record, "targetUrl"), false);
});

test("BGT-004 a change observed only by the last READ still stops the release", async () => {
  for (const [change, code] of [
    [(f) => { f.state.branch.commit.sha = OTHER_SHA; }, "MAIN_CHANGED"],
    [(f) => { f.state.environment.can_admins_bypass = true; }, "ENVIRONMENT_INVALID"],
    [(f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
    [(f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
    [(f) => { f.state.list = [f.state.runs[RECEIVER], receiverRunData(502)]; }, "DUPLICATE_GATE_REJECTED"],
  ]) {
    const f = await guarded();
    f.state.override = (route) => { if (route.endsWith("/approvals")) change(f); };
    await rejectsCode(runStage(f, "protected", { expectedEnvironment: f.expectedEnvironment }), code);
    assertNothingReleased(f);
  }
});
test("BGT-004 the Environment observed by preflight must be the one observed after approval", async () => {
  const f = await guarded(), changed = { ...f.expectedEnvironment, branchPolicyId: 999 };
  await rejectsCode(runStage(f, "protected", { expectedEnvironment: changed }), "ENVIRONMENT_CHANGED"); assertNothingReleased(f);
  // Neither read alone decides: a setting that matches only at the last READ is refused by the first comparison.
  f.calls.length = 0;
  f.state.override = (route) => { if (route.endsWith("/approvals")) f.state.policies.branch_policies[0].id = 999; };
  await rejectsCode(runStage(f, "protected", { expectedEnvironment: changed }), "ENVIRONMENT_CHANGED");
  assert.equal(f.calls.some(({ route }) => route?.endsWith("/approvals")), false); assertNothingReleased(f);
});

// BGT-006: the whole path, from the scheduled dispatch to the label, for every
// named negative condition. "at" names the moment the condition appears.
const pipelineNegatives = [
  ["rejection by the board owner", "afterGuard", (f) => { f.state.history = [{ ...f.state.history[0], state: "rejected" }]; }, "BOARD_REVIEW_UNVERIFIED"],
  ["no approval", "afterGuard", (f) => { f.state.history = []; }, "BOARD_REVIEW_UNVERIFIED"],
  ["expiry before preflight", "afterDispatch", (f) => { f.state.now += gate.GATE_TTL_MS + 1; }, "RUN_EXPIRED"],
  ["expiry while waiting for approval", "afterGuard", (f) => { f.state.now += gate.GATE_TTL_MS + 1; }, "RUN_EXPIRED"],
  ["expiry of the release before publication", "afterRelease", (f) => { f.state.now += gate.RELEASE_TTL_MS + 1; }, "RELEASE_EXPIRED"],
  ["a failed trusted recheck in the source", "beforeDispatch", (f) => { f.state.jobs[1].conclusion = "failure"; }, "SOURCE_VERIFY_UNPROVEN"],
  ["a source run that failed after dispatching", "afterDispatch", (f) => { f.state.runs[SOURCE].conclusion = "failure"; }, "SOURCE_TERMINAL_FAILURE"],
  ["a stale PR head before dispatch", "beforeDispatch", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a stale PR head before preflight", "afterDispatch", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a stale PR head while waiting for approval", "afterGuard", (f) => { f.state.pulls[PR].head.sha = OTHER_SHA; }, "PULL_REQUEST_STALE"],
  ["a stale main while waiting for approval", "afterGuard", (f) => { f.state.branch.commit.sha = OTHER_SHA; }, "MAIN_CHANGED"],
  ["an evidence branch changed before preflight", "afterDispatch", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
  ["an evidence branch changed while waiting for approval", "afterGuard", (f) => { f.state.refs[`heads/review-evidence/${GATE_ID}`].object.sha = OTHER_SHA; }, "EVIDENCE_CHANGED"],
  ["a tampered receipt archive", "afterDispatch", (f) => { f.state.archive[60] ^= 1; }, "ARCHIVE_DIGEST_INVALID"],
  ["a duplicate start of the same gate before dispatch", "beforeDispatch", (f) => { f.state.list = [receiverRunData(499)]; }, "DUPLICATE_GATE_REJECTED"],
  ["a duplicate start of the same gate before preflight", "afterDispatch", (f) => { f.state.list = [f.state.runs[RECEIVER], receiverRunData(502)]; }, "DUPLICATE_GATE_REJECTED"],
  ["a duplicate start of the same gate while waiting for approval", "afterGuard", (f) => { f.state.list = [f.state.runs[RECEIVER], receiverRunData(502)]; }, "DUPLICATE_GATE_REJECTED"],
  ["attempt 2 of the source", "afterDispatch", (f) => { f.state.runs[SOURCE].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["attempt 2 of the receiver", "afterDispatch", (f) => { f.state.runs[RECEIVER].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["attempt 2 of the receiver while waiting for approval", "afterGuard", (f) => { f.state.runs[RECEIVER].run_attempt = 2; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver on another ref", "afterDispatch", (f) => { f.state.runs[RECEIVER].head_branch = "feature"; }, "RUN_PROVENANCE_INVALID"],
  ["a source on another ref", "afterDispatch", (f) => { f.state.runs[SOURCE].head_branch = "feature"; }, "RUN_PROVENANCE_INVALID"],
  ["a receiver from a fork", "afterDispatch", (f) => { f.state.runs[RECEIVER].head_repository = { id: REPO_ID + 1, full_name: "synthetic/fork" }; }, "RUN_PROVENANCE_INVALID"],
  ["a source from a fork", "afterDispatch", (f) => { f.state.runs[SOURCE].head_repository = { id: REPO_ID + 1, full_name: "synthetic/fork" }; }, "RUN_PROVENANCE_INVALID"],
  ["a PR whose base is a fork", "afterGuard", (f) => { f.state.pulls[PR].base.repo = { id: REPO_ID + 1, full_name: "synthetic/fork" }; }, "PULL_REQUEST_BASE_STALE"],
];
for (const [name, at, change, code] of pipelineNegatives) test("BGT-006 the whole path publishes no status and adds no approved label on " + name, async () => {
  const f = fixture();
  await rejectsCode(pipeline(f, { [at]: change }), code);
  assertNothingReleased(f);
  assert.equal(dispatchWrites(f).length, at === "beforeDispatch" ? 0 : 1);
});
for (const [name, context, stage, code] of [
  ["attempt 2 of the scheduled source", () => ({ ...sourceContext(), runAttempt: 2 }), "dispatch", "CONTEXT_UNTRUSTED"],
  ["a scheduled source on another ref", () => ({ ...sourceContext(), ref: "refs/heads/feature" }), "dispatch", "CONTEXT_UNTRUSTED"],
  ["a scheduled source in a fork", () => ({ ...sourceContext(), repository: "synthetic/fork", repositoryId: REPO_ID + 1 }), "dispatch", "CONTEXT_UNTRUSTED"],
  ["attempt 2 of the receiver", () => ({ ...gateContext(), runAttempt: 2 }), "guard", "CONTEXT_UNTRUSTED"],
  ["a receiver on another ref", () => ({ ...gateContext(), ref: "refs/heads/feature" }), "guard", "CONTEXT_UNTRUSTED"],
  ["a receiver in a fork", () => ({ ...gateContext(), repository: "synthetic/fork", repositoryId: REPO_ID + 1 }), "guard", "CONTEXT_UNTRUSTED"],
]) test("BGT-006 every later stage refuses the runner context of " + name, async () => {
  const f = stage === "dispatch" ? fixture() : await dispatched(), before = f.calls.length;
  await rejectsCode(runStage(f, stage, { context: context() }), code);
  assert.equal(f.calls.length, before); // Rejected before any API call.
  if (stage !== "dispatch") {
    const valid = await released(fixture());
    await rejectsCode(runStage(valid, "publish", { context: context(), release: valid.release }), code);
    assertNothingReleased(valid);
  }
  assertNothingReleased(f);
});

test("BGT-006 a receipt issued for another pull request cannot release a different one", async () => {
  const f = await dispatched(); // Legitimate source and receipt for PR 42.
  // A second bot-started run claims the same scheduled source for PR 43.
  const otherGate = "gate-0013-other", otherPr = 43, otherHead = "f".repeat(40), otherEvidence = "9".repeat(40), otherRun = 502;
  f.state.runs[otherRun] = receiverRunData(otherRun, otherGate);
  f.state.pulls[otherPr] = pullData(otherPr, otherHead);
  f.state.comparisons[`${MAIN}...${otherHead}`] = { status: "ahead" };
  f.state.refs[`heads/review-evidence/${otherGate}`] = evidenceRef(otherGate, otherEvidence);
  f.state.list = [f.state.runs[RECEIVER], f.state.runs[otherRun]];
  const inputs = { ...gateInputs(), gate_id: otherGate, pull_request: String(otherPr), fixed_sha: otherHead,
    evidence_branch: `review-evidence/${otherGate}`, evidence_commit_sha: otherEvidence };
  const context = { ...gateContext(), runId: otherRun };
  await rejectsCode(runStage(f, "guard", { context, inputs }), "RECEIPT_PROVENANCE_INVALID");
  const expectedEnvironment = probe.validateEnvironment(f.state.environment, f.state.policies);
  await rejectsCode(runStage(f, "protected", { context, inputs, expectedEnvironment }), "RECEIPT_PROVENANCE_INVALID");
  // The same gate copied into a second run is neither the receiver of the receipt nor unique.
  await rejectsCode(runStage(f, "guard", { context, inputs: gateInputs() }), "RUN_PROVENANCE_INVALID");
  f.state.runs[otherRun] = receiverRunData(otherRun); f.state.list = [f.state.runs[RECEIVER], f.state.runs[otherRun]];
  await rejectsCode(runStage(f, "guard", { context, inputs: gateInputs() }), "DUPLICATE_GATE_REJECTED");
  f.state.list = [f.state.runs[otherRun]];
  await rejectsCode(runStage(f, "guard", { context, inputs: gateInputs() }), "RECEIPT_RECEIVER_INVALID");
  // A release of PR 42 is not accepted for the inputs of PR 43 either.
  const valid = await released(fixture());
  await rejectsCode(runStage(valid, "publish", { inputs, release: valid.release }), "RELEASE_INVALID");
  for (const item of [f, valid]) {
    assert.deepEqual(item.state.statuses, []); assert.deepEqual(item.state.labelWrites, []); assert.equal(hasLabel(item, gate.APPROVED_LABEL), false);
  }
  assert.equal(hasLabel(f, gate.APPROVED_LABEL, otherPr), false);
});

for (const [name, change] of [
  ["a missing release", () => null],
  ["a release of another run", (r) => ({ ...r, runId: RECEIVER + 1 })],
  ["a release with another target", (r) => ({ ...r, targetUrl: runUrls(RECEIVER + 1).html_url })],
  ["a release of another gate", (r) => ({ ...r, gateId: "gate-0013-other" })],
  ["a release bound to another head", (r) => ({ ...r, binding: { ...r.binding, fixedSha: OTHER_SHA } })],
  ["a release bound to another PR", (r) => ({ ...r, binding: { ...r.binding, pullRequest: PR + 1 } })],
  ["a release of another source", (r) => ({ ...r, sourceRunId: SOURCE + 1 })],
  ["a release without an approved review", (r) => ({ ...r, review: { ...r.review, state: "rejected" } })],
  ["a release reviewed by another login", (r) => ({ ...r, review: { ...r.review, user: stranger } })],
  ["a release with an extra key", (r) => ({ ...r, statuses: [] })],
  ["a release without its time", (r) => { const { verifiedAt, ...rest } = r; return rest; }],
  ["a release dated in the future", (r) => ({ ...r, verifiedAt: instant(1) })],
  ["the preflight result instead of a release", (r, f) => output(f.guard)],
]) test("BGT-005 publication requires the release of this run: " + name, async () => {
  const f = await released();
  await rejectsCode(runStage(f, "publish", { release: change(f.release, f) })); assertNothingReleased(f);
  assert.deepEqual((await observation(f, "publish")).publishedContexts, []);
});

for (const failAt of [0, 3, 6]) for (const [kind, response] of [
  ["an HTTP error", () => ({ status: 403, data: null })],
  ["a lost response", () => { throw new Error("Bearer synthetic-app-credential"); }],
  ["another context in the response", (params) => ({ status: 201, data: { id: 9999, state: "success", context: params.context + "-other" } })],
  ["a non-success state in the response", (params) => ({ status: 201, data: { id: 9999, state: "pending", context: params.context } })],
  ["a 200 instead of 201", (params) => ({ status: 200, data: { id: 9999, state: "success", context: params.context } })],
]) test(`BGT-005/006 a partial publication (${kind} at status ${failAt + 1}) is never retried and never labelled`, async () => {
  const f = await released(); let posts = 0;
  f.state.statusFailure = (count, params) => { posts++; return count === failAt ? response(params) : undefined; };
  await assert.rejects(runStage(f, "publish", { release: f.release }), (error) => error instanceof gate.GateError && error.result === "BLOCKED" && /^STATUS_PUBLISH_/.test(error.code));
  assert.equal(posts, failAt + 1); assert.equal(statusWrites(f).length, failAt + 1); // No retry, no later context.
  assert.equal(f.state.statuses.length, failAt);
  const record = await observation(f, "publish");
  assert.deepEqual(record.publishedContexts, gate.STATUS_CONTEXTS.slice(0, failAt)); assert.equal(record.uncertainContext, gate.STATUS_CONTEXTS[failAt]);
  assert.equal(record.approvedLabel, false); assert.equal(JSON.stringify(record).includes("synthetic-app-credential"), false);
  // The label step does not run after a failed step. Its helper also refuses every incomplete record.
  const complete = { schema: "board-gate-published:v1", repository: REPO, gateId: GATE_ID, pullRequest: PR, fixedSha: HEAD, runId: RECEIVER,
    targetUrl: runUrls(RECEIVER).html_url, contexts: [...gate.STATUS_CONTEXTS], statusIds: [1, 2, 3, 4, 5, 6, 7] };
  for (const published of [undefined, null, {}, { ...complete, contexts: gate.STATUS_CONTEXTS.slice(0, failAt), statusIds: complete.statusIds.slice(0, failAt) },
    { ...complete, contexts: gate.STATUS_CONTEXTS.slice(0, 6), statusIds: complete.statusIds.slice(0, 6) }, { ...complete, statusIds: [1, 2, 3, 4, 5, 6, 6] },
    { ...complete, contexts: [...gate.STATUS_CONTEXTS].reverse() }, { ...complete, fixedSha: OTHER_SHA }, { ...complete, pullRequest: PR + 1 },
    { ...complete, gateId: "gate-0013-other" }, { ...complete, runId: RECEIVER + 1 }, { ...complete, partial: true }]) {
    await rejectsCode(runStage(f, "label", { published }), "PUBLICATION_INCOMPLETE");
  }
  assert.equal(labelWrites(f).length, 0); assert.equal(hasLabel(f, gate.APPROVED_LABEL), false); assert.equal(hasLabel(f, gate.PENDING_LABEL), true);
});

test("BGT-005 a failed label call is reported and not repeated", async () => {
  for (const [route, code, writes] of [["DELETE ", "LABEL_REMOVE_UNKNOWN_NO_RETRY", 1], ["POST /repos/{owner}/{repo}/issues", "LABEL_ADD_UNKNOWN_NO_RETRY", 2]]) {
    const f = await released(), published = output(await runStage(f, "publish", { release: f.release }));
    f.state.override = (item) => { if (item.startsWith(route)) throw new Error("synthetic label failure"); };
    await rejectsCode(runStage(f, "label", { published }), code);
    assert.equal(labelWrites(f).length, writes); assert.equal(hasLabel(f, gate.APPROVED_LABEL), false); assert.equal(f.state.statuses.length, 7);
  }
});

test("BGT-004/005 stage records stay public-safe, are never overwritten and unknown stages fail", async () => {
  const f = await released(), first = await readFile(join(f.root, "observation", "protected.json"), "utf8");
  await rejectsCode(runStage(f, "protected", { root: f.root, expectedEnvironment: f.expectedEnvironment }), "UNEXPECTED_GATE_FAILURE");
  assert.equal(await readFile(join(f.root, "observation", "protected.json"), "utf8"), first);
  await runStage(f, "publish", { root: f.root, release: f.release });
  assert.deepEqual((await readdir(join(f.root, "observation"))).sort(), ["protected.json", "publish.json"]);
  for (const name of ["protected.json", "publish.json"]) {
    const text = await readFile(join(f.root, "observation", name), "utf8");
    assert.equal(/Bearer|gh[pousr]_|PRIVATE KEY|[?&](?:sig|token|secret)=/.test(text), false);
    assert.equal(JSON.parse(text).repositoryGatePass, false); assert.equal(JSON.parse(text).productPass, false);
  }
  await rejectsCode(runStage(fixture(), "approve"), "STAGE_INVALID");
});

test("BGT-001/004 gate upload sites stay within their small fixed allocation", async () => {
  const f = await released(); await runStage(f, "publish", { root: f.root, release: f.release });
  const budget = await gate.gateUploadBudget(join(f.root, "observation"));
  assert.equal(budget.files, 2); assert.equal(budget.maximumFiles, 3); assert.equal(budget.maximumBytes, 3 * probe.RECEIPT_BYTES);
  assert.ok(budget.maximumBytes <= probe.UPLOAD_BYTES && budget.maximumFiles <= probe.UPLOAD_FILES);
  const many = await mkdtemp(join(tmpdir(), "board-gate-budget-"));
  for (const name of ["a", "b", "c", "d"]) await writeFile(join(many, name), "{}\n");
  await rejectsCode(gate.gateUploadBudget(many), "UPLOAD_BUDGET_EXCEEDED");
  const large = await mkdtemp(join(tmpdir(), "board-gate-budget-")); await writeFile(join(large, "a"), Buffer.alloc(gate.GATE_UPLOAD_BYTES + 1));
  await rejectsCode(gate.gateUploadBudget(large), "UPLOAD_BUDGET_EXCEEDED");
  const empty = await mkdtemp(join(tmpdir(), "board-gate-budget-")); await writeFile(join(empty, "a"), "");
  await rejectsCode(gate.gateUploadBudget(empty), "UPLOAD_FILE_INVALID");
  await rejectsCode(gate.gateUploadBudget(await mkdtemp(join(tmpdir(), "board-gate-budget-"))), "UPLOAD_BUDGET_EXCEEDED");
});

// Workflow files, parsed the way the existing harness tests parse them.
const loadWorkflow = (name) => JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", "print JSON.generate(YAML.load_file(ARGV[0]))",
  new URL(`../../.github/workflows/${name}`, import.meta.url).pathname], { encoding: "utf8" }));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const triggers = (workflow) => workflow.on ?? workflow.true;
const stepsOf = (job) => job.steps.map((step) => step.with?.script ?? "").join("\n");
function assertCommonSteps(job) {
  assert.equal(job["runs-on"], "ubuntu-latest");
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
    if (step.uses?.startsWith("actions/upload-artifact@")) {
      assert.equal(step.with["retention-days"], 1); assert.equal(step.with["if-no-files-found"], "error");
    }
    if (step.with?.script) new AsyncFunction("github", "context", "core", "process", step.with.script.replace(/\$\{\{.*?\}\}/gs, "0"));
    assert.equal(/cache/.test(step.uses ?? ""), false);
  }
}
function assertGateSteps(job) {
  assertCommonSteps(job);
  for (const step of job.steps) {
    if (step.uses?.startsWith("actions/checkout@")) {
      // Trusted main harness only: the run commit, never a pull request ref.
      assert.deepEqual(step.with, { ref: "${{ github.sha }}", "sparse-checkout": "harness/scripts", "persist-credentials": false });
    }
    if (step.uses?.startsWith("actions/upload-artifact@")) assert.equal(step.with.overwrite, false);
    assert.equal(step.run, undefined);
  }
}

test("BGT-001 the scheduled workflow has no Environment job and dispatches only after a selected, successful recheck", () => {
  const workflow = loadWorkflow("independent-review.yml");
  assert.deepEqual(Object.keys(triggers(workflow)), ["schedule"]); assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "verify", "dispatch"]);
  assert.deepEqual(Object.fromEntries(Object.entries(workflow.jobs).map(([key, job]) => [key, job.name])), gate.SOURCE_JOBS);
  for (const job of Object.values(workflow.jobs)) { assert.equal(job.environment, undefined); assertCommonSteps(job); }
  const text = JSON.stringify(workflow);
  for (const forbidden of ["secrets.", "vars.", "create-github-app-token", "createCommitStatus", "statuses", "review:approved", "pending_deployments"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  const { dispatch, prepare, verify } = workflow.jobs;
  assert.deepEqual(dispatch.needs, ["prepare", "verify"]);
  for (const condition of ["needs.prepare.outputs.found == 'true'", "needs.verify.result == 'success'", "github.run_attempt == 1"]) assert.ok(dispatch.if.includes(condition), condition);
  assert.equal(dispatch.if.includes("||"), false); assert.equal(dispatch.if.includes("always()"), false);
  // Only the dispatching job may write Actions; nothing else changed its permissions.
  assert.deepEqual(dispatch.permissions, { contents: "read", actions: "write", "pull-requests": "read" });
  assert.deepEqual(prepare.permissions, { contents: "read", issues: "write", "pull-requests": "read" });
  assert.deepEqual(verify.permissions, { contents: "read", "pull-requests": "read" });
  assertGateSteps(dispatch);
  const scripts = stepsOf(dispatch);
  assert.equal(scripts.split("runBoardGateStage(").length - 1, 1); assert.ok(scripts.includes("runBoardGateStage('dispatch'"));
  assert.ok(scripts.includes("gate.selectionFromEnv(process.env)")); assert.equal(/rerun|cancel|createWorkflowDispatch/.test(scripts), false);
  const step = dispatch.steps.find((item) => item.id === "dispatch");
  assert.equal(step.if, undefined); assert.equal(step.with.retries, 0); assert.equal(step.with["github-token"], undefined);
  // The selection reaches the helper as data, in the same shape the helper reads.
  const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, value.match(/^\$\{\{ needs\.prepare\.outputs\.([a-z0-9_]+) \}\}$/)[1]]));
  assert.deepEqual(gate.selectionFromEnv(env), Object.fromEntries(Object.keys(selection()).map((key) => [key, key])));
  assert.deepEqual(Object.keys(dispatch.env).sort(), ["GATE_ACTOR_ID", "GATE_REPOSITORY_ID", "GATE_RUN_ATTEMPT", "GATE_TRIGGERING_ACTOR", "GATE_WORKFLOW_REF", "GATE_WORKFLOW_SHA"]);
  const uploads = dispatch.steps.filter((item) => item.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(uploads.map((item) => item.with.name), ["board-gate-receipt-${{ github.run_id }}-1", "board-gate-dispatch-observation-${{ github.run_id }}-1"]);
  assert.equal(uploads[0].with.path, `gate-dispatch/receipt/${gate.RECEIPT_FILE}`);
  assert.equal(gate.gateReceiptName(SOURCE), uploads[0].with.name.replace("${{ github.run_id }}", String(SOURCE)));
  assert.equal(uploads[0].if.includes("always()"), false); // The receipt exists only after a successful dispatch stage.
});

test("BGT-002/004/005 the board gate workflow rejects before checkout, protects one job and keeps the App key there", () => {
  const workflow = loadWorkflow("board-gate.yml");
  assert.deepEqual(Object.keys(triggers(workflow)), ["workflow_dispatch"]); assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(triggers(workflow).workflow_dispatch.inputs), gate.INPUT_KEYS);
  for (const input of Object.values(triggers(workflow).workflow_dispatch.inputs)) { assert.equal(input.type, "string"); assert.equal(input.required, true); assert.equal(input.default, undefined); }
  assert.equal(workflow["run-name"], "board-gate:${{ inputs.gate_id }}"); assert.equal(gate.gateTitle("x"), "board-gate:x");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["boundary", "preflight", "board"]);
  const { boundary, preflight, board } = workflow.jobs;
  // The first job has a single pinned step, no checkout and no Environment.
  assert.equal(boundary.needs, undefined); assert.equal(boundary.if, undefined); assert.equal(boundary.steps.length, 1);
  assert.match(boundary.steps[0].uses, /^actions\/github-script@[a-f0-9]{40}$/); assert.equal(boundary.steps[0].with.script.includes("import("), false);
  assert.deepEqual(boundary.permissions, { contents: "read", actions: "read" });
  assert.equal(preflight.needs, "boundary"); assert.equal(preflight.environment, undefined); assert.equal(boundary.environment, undefined);
  for (const condition of ["github.run_attempt == 1", "github.ref == 'refs/heads/main'", "github.actor == 'github-actions[bot]'", "github.triggering_actor == 'github-actions[bot]'"]) assert.ok(preflight.if.includes(condition), condition);
  assert.equal(preflight.if.includes("||"), false);
  assert.deepEqual(preflight.permissions, { contents: "read", actions: "read", "pull-requests": "read" });
  assert.equal(board.needs, "preflight"); assert.equal(board.if.includes("||"), false);
  // The Environment job repeats the conditions of preflight: outputs of an earlier attempt alone never schedule it.
  for (const condition of ["needs.preflight.outputs.verified == 'true'", "github.repository == 'uk-product-lab/sns-marketing-manager'", "github.ref == 'refs/heads/main'",
    "github.run_attempt == 1", "github.actor == 'github-actions[bot]'", "github.triggering_actor == 'github-actions[bot]'"]) assert.ok(board.if.includes(condition), condition);
  assert.deepEqual(board.environment, { name: "board-review" }); assert.equal(board.name, "review/board-gate");
  assert.deepEqual(board.permissions, { contents: "read", actions: "read", "pull-requests": "read", issues: "write" });
  for (const job of Object.values(workflow.jobs)) { assertGateSteps(job); assert.equal(JSON.stringify(job.permissions).includes('"actions":"write"'), false); assert.equal(job.permissions.statuses, undefined); }
  assert.deepEqual(preflight.outputs, { verified: "${{ steps.guard.outputs.verified }}", environment: "${{ steps.guard.outputs.environment }}" });
  assert.ok(stepsOf(preflight).includes("runBoardGateStage('guard'")); assert.ok(stepsOf(preflight).indexOf("core.setOutput('verified', 'true')") > stepsOf(preflight).indexOf("runBoardGateStage('guard'"));
  // Protected job: trusted checkout, recheck, App token, publication, label. Each runs only if the previous step succeeded.
  const names = board.steps.map((step) => step.id ?? step.uses.split("@")[0]);
  assert.deepEqual(names.slice(0, 4), ["actions/checkout", "recheck", "gatekeeper", "publish"]);
  const [checkout, recheck, token, publish, label] = board.steps;
  for (const step of [checkout, recheck, token, publish, label]) { assert.equal(step.if, undefined); assert.equal(step["continue-on-error"], undefined); }
  assert.ok(recheck.with.script.includes("runBoardGateStage('protected'")); assert.ok(publish.with.script.includes("runBoardGateStage('publish'")); assert.ok(label.with.script.includes("runBoardGateStage('label'"));
  assert.match(token.uses, /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.deepEqual(token.with, { "app-id": "${{ vars.GATEKEEPER_APP_ID }}", "private-key": "${{ secrets.GATEKEEPER_APP_PRIVATE_KEY }}" });
  assert.equal(publish.with["github-token"], "${{ steps.gatekeeper.outputs.token }}"); assert.equal(publish.env.GATE_RELEASE, "${{ steps.recheck.outputs.release }}");
  assert.equal(label.env.GATE_PUBLISHED, "${{ steps.publish.outputs.published }}");
  // The key and the App token are referenced by exactly one step each, both inside the protected job.
  const text = JSON.stringify(workflow), boardText = JSON.stringify(board);
  assert.equal(text.split("secrets.").length - 1, 1); assert.equal(boardText.split("secrets.").length - 1, 1);
  assert.equal(text.split("steps.gatekeeper.outputs.token").length - 1, 1); assert.equal(text.split("vars.").length - 1, 1);
  for (const step of board.steps) if (step !== publish) assert.equal(step.with?.["github-token"], undefined);
  assert.equal(JSON.stringify([boundary, preflight]).includes("gatekeeper"), false);
  // No step reads a pull request ref or executes product code.
  assert.equal(/inputs\.fixed_sha|pull_request_target|npm |ci-quality/.test(text), false);
  assert.equal(/approvePendingDeployment|pending_deployments|rerun|dispatches/.test(text), false);
  const uploads = Object.values(workflow.jobs).flatMap((job) => job.steps).filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 2); for (const upload of uploads) assert.ok(upload.if.includes("steps.budget.outcome == 'success'"));
});

// Job conditions, evaluated the way GitHub schedules jobs for the forms used in these
// two workflows: a conjunction of `context.path == literal` terms. A term of any other
// form fails the test instead of being guessed. Whether real GitHub agrees is unproven.
function conditionHolds(expression, contexts) {
  const body = expression.match(/^\$\{\{ (.*) \}\}$/s)?.[1];
  assert.ok(body, "Unsupported condition form");
  return body.split(" && ").every((term) => {
    const match = term.match(/^((?:github|needs)(?:\.[a-z_]+)+) == (?:'([^']*)'|(\d+))$/);
    assert.ok(match, `Unsupported condition term: ${term}`);
    const actual = match[1].split(".").reduce((value, key) => value?.[key], contexts);
    if (actual === undefined || actual === null) return false; // No literal used here is empty or zero.
    return match[3] === undefined ? String(actual) === match[2] : Number(actual) === Number(match[3]);
  });
}
// One attempt of a run. Without a status function in its condition, a job is scheduled
// only if every needed job succeeded and the condition holds. In a partial re-run the
// jobs that are not run again keep the result and outputs of the earlier attempt.
function jobScheduled(workflow, key, github, needs) {
  const job = workflow.jobs[key];
  assert.equal(/always\(\)|failure\(\)|cancelled\(\)|success\(\)/.test(job.if ?? ""), false);
  return [].concat(job.needs ?? []).every((name) => needs[name]?.result === "success") &&
    (job.if === undefined || conditionHolds(job.if, { github, needs }));
}
const firstAttempt = { repository: REPO, ref: "refs/heads/main", run_attempt: 1, actor: bot.login, triggering_actor: bot.login };
const passed = (outputs = {}) => ({ result: "success", outputs });
const verifiedNeeds = { boundary: passed(), preflight: passed({ verified: "true" }) };

test("BGT-002 only the first attempt of the bot-started run can wait for the board approval", () => {
  const workflow = loadWorkflow("board-gate.yml");
  // Every job that uses an Environment in the two workflows of this path is covered below.
  assert.deepEqual(Object.keys(workflow.jobs).filter((key) => workflow.jobs[key].environment !== undefined), ["board"]);
  assert.deepEqual(Object.values(loadWorkflow("independent-review.yml").jobs).filter((job) => job.environment !== undefined), []);
  assert.equal(jobScheduled(workflow, "preflight", firstAttempt, { boundary: passed() }), true);
  assert.equal(jobScheduled(workflow, "board", firstAttempt, verifiedNeeds), true);
});
for (const [name, github, needs = verifiedNeeds] of [
  // Partial re-runs: boundary and preflight are not run again and keep verified == 'true'.
  ["only the protected job re-run by the board owner", { ...firstAttempt, run_attempt: 2, triggering_actor: owner.login }],
  ["the failed jobs re-run by the board owner after a rejection", { ...firstAttempt, run_attempt: 2, triggering_actor: owner.login }, { boundary: passed(), preflight: passed({ verified: "true", environment: "{}" }) }],
  ["only the protected job re-run by a third party", { ...firstAttempt, run_attempt: 2, triggering_actor: stranger.login }],
  ["a re-run requested with a workflow token", { ...firstAttempt, run_attempt: 2 }],
  ["a third attempt", { ...firstAttempt, run_attempt: 3, triggering_actor: owner.login }],
  // First attempts that are not the built-in token dispatch, even if an output claimed verification.
  ["a first attempt whose triggering actor is a person", { ...firstAttempt, triggering_actor: owner.login }],
  ["a first attempt started by the board owner", { ...firstAttempt, actor: owner.login, triggering_actor: owner.login }],
  ["a first attempt started by a third party", { ...firstAttempt, actor: stranger.login, triggering_actor: stranger.login }],
  ["a run started by a person whose triggering actor reads as the bot", { ...firstAttempt, actor: owner.login }],
  ["a first attempt without a recorded triggering actor", { ...firstAttempt, triggering_actor: undefined }],
  ["a run on another ref", { ...firstAttempt, ref: "refs/heads/feature" }],
  ["a run in a fork", { ...firstAttempt, repository: "synthetic/fork" }],
  // Preflight did not verify in this attempt.
  ["a preflight without the verified output", firstAttempt, { boundary: passed(), preflight: passed() }],
  ["a failed preflight", firstAttempt, { boundary: passed(), preflight: { result: "failure", outputs: { verified: "true" } } }],
  ["a skipped preflight", firstAttempt, { boundary: passed(), preflight: { result: "skipped", outputs: { verified: "true" } } }],
]) test("BGT-002 the Environment job is not scheduled, so nothing waits for approval, on " + name, () => {
  assert.equal(jobScheduled(loadWorkflow("board-gate.yml"), "board", github, needs), false);
});
test("BGT-002 a whole re-run stops at the boundary and schedules neither preflight nor the Environment job", async () => {
  const workflow = loadWorkflow("board-gate.yml"), rerun = { ...firstAttempt, run_attempt: 2, triggering_actor: owner.login };
  // Every job is evaluated again. The boundary step itself rejects attempt 2 and the person who re-ran it.
  const f = boundaryFixture(); f.env.GATE_RUN_ATTEMPT = "2"; f.env.GATE_TRIGGERING_ACTOR = owner.login;
  const diagnostic = await rejectedAtBoundary(f, "RUN_ATTEMPT_MISMATCH");
  assert.ok(diagnostic.reasons.includes("TRIGGERING_ACTOR_NOT_ACTIONS_BOT"));
  const needs = { boundary: { result: "failure", outputs: {} } };
  assert.equal(jobScheduled(workflow, "preflight", rerun, needs), false);
  assert.equal(jobScheduled(workflow, "board", rerun, { ...needs, preflight: { result: "skipped", outputs: {} } }), false);
  // Even if the boundary had passed, neither later job accepts the second attempt.
  assert.equal(jobScheduled(workflow, "preflight", rerun, { boundary: passed() }), false);
  assert.equal(jobScheduled(workflow, "board", rerun, verifiedNeeds), false);
});
test("BGT-001 a re-run of the scheduled source never dispatches again from earlier outputs", () => {
  const workflow = loadWorkflow("independent-review.yml"), needs = { prepare: passed({ found: "true" }), verify: passed() };
  assert.equal(jobScheduled(workflow, "dispatch", { run_attempt: 1 }, needs), true);
  for (const attempt of [2, 3]) assert.equal(jobScheduled(workflow, "dispatch", { run_attempt: attempt }, needs), false);
  assert.equal(jobScheduled(workflow, "dispatch", { run_attempt: 1 }, { prepare: passed({ found: "false" }), verify: passed() }), false);
  assert.equal(jobScheduled(workflow, "dispatch", { run_attempt: 1 }, { prepare: passed({ found: "true" }), verify: { result: "failure", outputs: {} } }), false);
  assert.equal(jobScheduled(workflow, "dispatch", { run_attempt: 1 }, { prepare: passed({ found: "true" }), verify: { result: "skipped", outputs: {} } }), false);
});

// The checkout-free boundary step, executed as written in the workflow.
function boundaryFixture() {
  const script = loadWorkflow("board-gate.yml").jobs.boundary.steps[0].with.script;
  const execute = new AsyncFunction("github", "context", "process", "core", script);
  const f = {
    context: { repo: { owner: "uk-product-lab", repo: "sns-marketing-manager" }, ref: "refs/heads/main", sha: MAIN, eventName: "workflow_dispatch",
      runId: RECEIVER, actor: bot.login, payload: { inputs: gateInputs() } },
    env: { GATE_RUN_ATTEMPT: "1", GATE_WORKFLOW_REF: gateContext().workflowRef, GATE_WORKFLOW_SHA: MAIN, GATE_TRIGGERING_ACTOR: bot.login, GATE_ACTOR_ID: String(bot.id) },
    run: receiverRunData(), environment: fixture().state.environment, branch: { name: "main", commit: { sha: MAIN } }, calls: [], messages: [],
  };
  f.core = { error: (message) => f.messages.push(message) };
  f.github = { request: async (route, params) => {
    f.calls.push(route);
    assert.equal(`${params.owner}/${params.repo}`, REPO); assert.equal(params.headers["X-GitHub-Api-Version"], probe.API_VERSION);
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}") return { status: 200, data: f.branch };
    if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}") { assert.equal(params.run_id, RECEIVER); return { status: 200, data: f.run }; }
    if (route === "GET /repos/{owner}/{repo}/environments/{environment_name}") { assert.equal(params.environment_name, "board-review"); return { status: 200, data: f.environment }; }
    throw new Error("Unknown synthetic route");
  } };
  f.execute = () => execute(f.github, f.context, { env: f.env }, f.core);
  return f;
}
const boundaryPrefix = "GATE_BOUNDARY_DIAGNOSTIC ";
async function rejectedAtBoundary(f, reason) {
  await assert.rejects(f.execute(), (error) => error.message === "GATE_CONTEXT_REJECTED");
  assert.deepEqual(f.calls, []); // No API read, hence no checkout and no Environment.
  assert.equal(f.messages.length, 1); assert.ok(f.messages[0].startsWith(boundaryPrefix));
  const diagnostic = JSON.parse(f.messages[0].slice(boundaryPrefix.length));
  assert.deepEqual(Object.keys(diagnostic), ["schema", "reasons"]); assert.equal(diagnostic.schema, "board-gate-boundary-diagnostic:v1");
  assert.ok(diagnostic.reasons.includes(reason), `${reason} not in ${diagnostic.reasons}`);
  return diagnostic;
}

test("BGT-002 the boundary accepts the built-in token dispatch after three fixed READs", async () => {
  const f = boundaryFixture(); await f.execute();
  assert.deepEqual(f.calls, ["GET /repos/{owner}/{repo}/branches/{branch}", "GET /repos/{owner}/{repo}/actions/runs/{run_id}", "GET /repos/{owner}/{repo}/environments/{environment_name}"]);
  assert.deepEqual(f.messages, []); assert.deepEqual(gate.parseGateInputs(f.context.payload.inputs), gateInputs());
});
for (const [name, change, reasons] of [
  ["the board owner starting it directly", (f) => { f.context.actor = owner.login; f.env.GATE_TRIGGERING_ACTOR = owner.login; f.env.GATE_ACTOR_ID = String(owner.id); f.run.actor = clone(owner); f.run.triggering_actor = clone(owner); }, ["ACTOR_NOT_ACTIONS_BOT", "TRIGGERING_ACTOR_NOT_ACTIONS_BOT"]],
  ["a third party starting it directly", (f) => { f.context.actor = stranger.login; f.env.GATE_TRIGGERING_ACTOR = stranger.login; f.env.GATE_ACTOR_ID = String(stranger.id); }, ["ACTOR_NOT_ACTIONS_BOT", "TRIGGERING_ACTOR_NOT_ACTIONS_BOT"]],
  ["a person re-running a bot-started run", (f) => { f.env.GATE_TRIGGERING_ACTOR = owner.login; }, ["TRIGGERING_ACTOR_NOT_ACTIONS_BOT"]],
  ["a bot actor with a human triggering actor on attempt 2", (f) => { f.env.GATE_TRIGGERING_ACTOR = owner.login; f.env.GATE_RUN_ATTEMPT = "2"; }, ["RUN_ATTEMPT_MISMATCH", "TRIGGERING_ACTOR_NOT_ACTIONS_BOT"]],
  ["a look-alike bot login", (f) => { f.context.actor = "github-actions"; }, ["ACTOR_NOT_ACTIONS_BOT"]],
  ["a missing triggering actor", (f) => { delete f.env.GATE_TRIGGERING_ACTOR; }, ["TRIGGERING_ACTOR_NOT_ACTIONS_BOT"]],
  ["another event", (f) => { f.context.eventName = "schedule"; }, ["EVENT_NAME_MISMATCH"]],
  ["a fork", (f) => { f.context.repo.owner = "synthetic-fork"; }, ["REPOSITORY_MISMATCH"]],
  ["another ref", (f) => { f.context.ref = "refs/heads/feature"; }, ["REF_MISMATCH"]],
  ["a tag named main", (f) => { f.context.ref = "refs/tags/main"; }, ["REF_MISMATCH"]],
  ["attempt 2", (f) => { f.env.GATE_RUN_ATTEMPT = "2"; }, ["RUN_ATTEMPT_MISMATCH"]],
  ["another workflow file", (f) => { f.env.GATE_WORKFLOW_REF = sourceContext().workflowRef; }, ["WORKFLOW_REF_MISMATCH"]],
  ["a workflow definition of another commit", (f) => { f.env.GATE_WORKFLOW_SHA = OTHER_SHA; }, ["WORKFLOW_SHA_CONTEXT_MISMATCH"]],
  ["an unknown input", (f) => { f.context.payload.inputs.mode = "receive"; }, ["INPUT_KEYS_MISMATCH"]],
  ["a missing input", (f) => { delete f.context.payload.inputs.evidence_sha256; }, ["INPUT_KEYS_MISMATCH", "SHA_FORMAT_INVALID"]],
  ["a non-string input", (f) => { f.context.payload.inputs.pull_request = PR; }, ["INPUT_KEYS_MISMATCH", "PULL_REQUEST_INVALID"]],
  ["missing inputs", (f) => { f.context.payload.inputs = undefined; }, ["INPUT_KEYS_MISMATCH", "GATE_ID_INVALID"]],
  ["an array of inputs", (f) => { f.context.payload.inputs = Object.values(gateInputs()); }, ["INPUT_KEYS_MISMATCH"]],
  ["a missing payload", (f) => { f.context.payload = undefined; }, ["BOUNDARY_EVALUATION_UNAVAILABLE"]],
  ["an invalid gate ID", (f) => { f.context.payload.inputs.gate_id = "gate:other"; }, ["GATE_ID_INVALID", "EVIDENCE_BRANCH_MISMATCH"]],
  ["an invalid pull request number", (f) => { f.context.payload.inputs.pull_request = "0x2a"; }, ["PULL_REQUEST_INVALID"]],
  ["an invalid fixed SHA", (f) => { f.context.payload.inputs.fixed_sha = "main"; }, ["SHA_FORMAT_INVALID"]],
  ["a base SHA that is not the run commit", (f) => { f.context.payload.inputs.base_sha = OTHER_SHA; }, ["BASE_SHA_CONTEXT_MISMATCH"]],
  ["a run commit that is not the base SHA", (f) => { f.context.sha = OTHER_SHA; }, ["BASE_SHA_CONTEXT_MISMATCH", "WORKFLOW_SHA_CONTEXT_MISMATCH"]],
  ["an evidence branch of another gate", (f) => { f.context.payload.inputs.evidence_branch = "review-evidence/gate-0013-other"; }, ["EVIDENCE_BRANCH_MISMATCH"]],
  ["a second source attempt", (f) => { f.context.payload.inputs.source_attempt = "2"; }, ["SOURCE_INPUT_INVALID"]],
  ["itself as the source", (f) => { f.context.payload.inputs.source_run_id = String(RECEIVER); }, ["SOURCE_INPUT_INVALID"]],
]) test("BGT-002 the boundary rejects " + name + " before any READ, checkout or Environment", async () => {
  const f = boundaryFixture(); change(f);
  const diagnostic = await rejectedAtBoundary(f, reasons[0]);
  for (const reason of reasons) assert.ok(diagnostic.reasons.includes(reason), reason);
});
for (const [name, change, message, reads] of [
  ["a moved main", (f) => { f.branch.commit.sha = OTHER_SHA; }, "GATE_MAIN_CHANGED", 1],
  ["an unreadable main", (f) => { f.github.request = async (route) => { f.calls.push(route); throw new Error("synthetic-upstream-secret"); }; }, "GATE_MAIN_READ_BLOCKED", 1],
  ["a recorded actor that is a person", (f) => { f.run.actor = clone(owner); f.run.triggering_actor = clone(owner); }, "GATE_ACTOR_REJECTED", 2],
  ["a recorded actor of type User with the bot login", (f) => { f.run.actor.type = "User"; }, "GATE_ACTOR_REJECTED", 2],
  ["a recorded triggering actor that is a person", (f) => { f.run.triggering_actor = clone(owner); }, "GATE_ACTOR_REJECTED", 2],
  ["a recorded actor ID that differs from the context", (f) => { f.run.actor.id = 91; f.run.triggering_actor.id = 91; }, "GATE_ACTOR_REJECTED", 2],
  ["a recorded second attempt", (f) => { f.run.run_attempt = 2; }, "GATE_ACTOR_REJECTED", 2],
  ["a recorded run of another event", (f) => { f.run.event = "schedule"; }, "GATE_ACTOR_REJECTED", 2],
  ["a missing run record", (f) => { f.run = null; }, "GATE_ACTOR_REJECTED", 2],
  ["a bot whose ID is the reviewer ID", (f) => { f.environment.protection_rules[1].reviewers[0].reviewer.id = bot.id; }, "GATE_REVIEWER_UNPROVEN", 3],
  ["another reviewer login", (f) => { f.environment.protection_rules[1].reviewers[0].reviewer = clone(stranger); }, "GATE_REVIEWER_UNPROVEN", 3],
  ["two reviewers", (f) => { f.environment.protection_rules[1].reviewers.push({ type: "User", reviewer: clone(stranger) }); }, "GATE_REVIEWER_UNPROVEN", 3],
  ["a team reviewer", (f) => { f.environment.protection_rules[1].reviewers[0].type = "Team"; }, "GATE_REVIEWER_UNPROVEN", 3],
  ["self-review prevention off", (f) => { f.environment.protection_rules[1].prevent_self_review = false; }, "GATE_REVIEWER_UNPROVEN", 3],
  ["no reviewer rule", (f) => { f.environment.protection_rules = [{ type: "branch_policy" }]; }, "GATE_REVIEWER_UNPROVEN", 3],
  ["a missing Environment", (f) => { f.environment = null; }, "GATE_REVIEWER_UNPROVEN", 3],
]) test("BGT-002 the boundary stops on " + name, async () => {
  const f = boundaryFixture(); change(f);
  await assert.rejects(f.execute(), (error) => error.message === message);
  assert.equal(f.calls.length, reads); assert.deepEqual(f.messages, []);
});
test("BGT-002 a non-200 boundary READ stops with a fixed message", async () => {
  for (const [index, message] of [[0, "GATE_MAIN_READ_BLOCKED"], [1, "GATE_RUN_READ_BLOCKED"], [2, "GATE_ENVIRONMENT_READ_BLOCKED"]]) {
    const f = boundaryFixture(), request = f.github.request;
    f.github.request = async (route, params) => { const response = await request(route, params); return f.calls.length === index + 1 ? { status: 404, data: response.data } : response; };
    await assert.rejects(f.execute(), (error) => error.message === message); assert.equal(f.calls.length, index + 1);
  }
});
test("BGT-002 hostile input names and values never enter the boundary diagnostic, and a failed log sink still rejects", async () => {
  const f = boundaryFixture(), canary = "synthetic-boundary-secret-canary-never-log";
  f.context.payload.inputs = Object.fromEntries(gate.INPUT_KEYS.map((key) => [key, canary]));
  f.context.payload.inputs[canary + "\n::error::"] = canary; f.context.actor = canary; f.context.ref = canary; f.env.GATE_WORKFLOW_REF = canary;
  await rejectedAtBoundary(f, "INPUT_KEYS_MISMATCH");
  assert.equal(f.messages[0].includes(canary), false); assert.equal(f.messages[0].includes("::error::"), false); assert.ok(f.messages[0].length < 1024);
  const getter = boundaryFixture();
  Object.defineProperty(getter.context.payload.inputs, "gate_id", { enumerable: true, get() { throw new Error("synthetic-getter-secret"); } });
  const diagnostic = await rejectedAtBoundary(getter, "BOUNDARY_EVALUATION_UNAVAILABLE");
  assert.deepEqual(diagnostic.reasons, ["BOUNDARY_EVALUATION_UNAVAILABLE"]); assert.equal(getter.messages[0].includes("synthetic-getter-secret"), false);
  const sink = boundaryFixture(); sink.context.ref = "refs/heads/feature"; sink.core.error = () => { throw new Error("synthetic-sink-secret"); };
  await assert.rejects(sink.execute(), (error) => error.message === "GATE_CONTEXT_REJECTED"); assert.deepEqual(sink.calls, []);
});

test("BGT-002 the workflow context becomes the helper context and the helper agrees with the boundary", () => {
  const f = boundaryFixture(), context = gate.runtimeContext(f.context, { ...f.env, GATE_REPOSITORY_ID: String(REPO_ID) });
  assert.deepEqual(context, gateContext());
  const workflow = loadWorkflow("board-gate.yml");
  assert.deepEqual(Object.keys(workflow.env).sort(), ["GATE_ACTOR_ID", "GATE_REPOSITORY_ID", "GATE_RUN_ATTEMPT", "GATE_TRIGGERING_ACTOR", "GATE_WORKFLOW_REF", "GATE_WORKFLOW_SHA"]);
  assert.equal(workflow.env.GATE_TRIGGERING_ACTOR, "${{ github.triggering_actor }}"); assert.equal(workflow.env.GATE_ACTOR_ID, "${{ github.actor_id }}");
  const script = workflow.jobs.boundary.steps[0].with.script;
  for (const key of gate.INPUT_KEYS) assert.ok(script.includes(`'${key}'`), key);
  assert.ok(script.includes(`${REPO}`)); assert.ok(script.includes(".github/workflows/board-gate.yml@refs/heads/main")); assert.ok(script.includes(`'${probe.API_VERSION}'`));
  assert.ok(script.includes(`REVIEWER = '${probe.BOARD_LOGIN}'`)); assert.ok(script.includes("'board-review'"));
});
