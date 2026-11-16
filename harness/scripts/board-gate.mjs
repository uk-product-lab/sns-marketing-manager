import { join } from "node:path";
import {
  ProbeError, REPOSITORY, ENVIRONMENT, BOARD_LOGIN, RECEIPT_BYTES, RECEIPT_TTL_MS, READ_WAIT_MS, READ_INTERVAL_MS, API_VERSION,
  activeStates, positiveId, requireCondition, exactKeys, timestamp, identity, requireReceiverActor, request,
  validateEnvironment, validateRun, listDispatchRuns, validateDispatchResponse, readDispatchedRun,
  artifactMetadata, parseReceiptArchive, createRuntimeApi, uploadBudget, writeEvidence,
} from "./board-actor-probe.mjs";

// Production board gate (TASK-0013). The scheduled independent review (source)
// dispatches this workflow once with the built-in token; the bot-started run
// (receiver) is the only one the board owner can approve. Run binding, receipt
// archive, Environment and review-history checks are the parts the secretless
// probe already exercised. Imports are inert; LOCAL tests inject the API and clock.
export { ProbeError as GateError, createRuntimeApi };
export const SOURCE_WORKFLOW = ".github/workflows/independent-review.yml";
export const GATE_WORKFLOW = ".github/workflows/board-gate.yml";
export const SOURCE_JOBS = { prepare: "review/prepare-attestation", verify: "review/trusted-recheck", dispatch: "review/dispatch-board-gate" };
export const STATUS_CONTEXTS = [
  "governance/protected-files",
  "quality/static",
  "quality/unit",
  "quality/e2e-chromium",
  "quality/e2e-webkit-mobile",
  "quality/accessibility",
  "review/independent",
];
export const PENDING_LABEL = "review:board-pending";
export const APPROVED_LABEL = "review:approved";
export const BLOCKING_LABELS = ["review:stale", "review:invalid", "review:awaiting-board", APPROVED_LABEL];
export const INPUT_KEYS = ["gate_id", "pull_request", "fixed_sha", "base_sha", "evidence_branch",
  "evidence_commit_sha", "evidence_sha256", "source_run_id", "source_attempt"];
export const RECEIPT_SCHEMA = "board-gate-dispatch-receipt:v1";
export const RECEIPT_FILE = "dispatch-receipt.json";
// The receipt and the receiver must be younger than this at preflight and again
// after approval. The scheduled source spends its time on the trusted recheck
// first, so only its own age follows the one-day artifact retention.
export const GATE_TTL_MS = RECEIPT_TTL_MS;
export const SOURCE_RUN_TTL_MS = 24 * 60 * 60 * 1000;
export const RELEASE_TTL_MS = 5 * 60 * 1000;
export const GATE_UPLOAD_FILES = 3;
export const GATE_UPLOAD_BYTES = GATE_UPLOAD_FILES * RECEIPT_BYTES;
const RELEASE_SCHEMA = "board-gate-release:v1";
const PUBLISHED_SCHEMA = "board-gate-published:v1";
const GATE_TITLE_PREFIX = "board-gate:";
const shaPattern = /^[a-f0-9]{40}$/;
const gatePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const sourceWorkflowRef = `${REPOSITORY}/${SOURCE_WORKFLOW}@refs/heads/main`;
const gateWorkflowRef = `${REPOSITORY}/${GATE_WORKFLOW}@refs/heads/main`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const runUrl = (runId) => `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
const sleepForRead = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function gateTitle(gateId) { return `${GATE_TITLE_PREFIX}${gateId}`; }
export function gateReceiptName(runId) { requireCondition(positiveId(runId), "RUN_ID_INVALID"); return `board-gate-receipt-${runId}-1`; }

export function parseGateInputs(value) {
  exactKeys(value, INPUT_KEYS, "INPUT_KEYS_INVALID");
  requireCondition(INPUT_KEYS.every((key) => typeof value[key] === "string"), "INPUT_TYPE_INVALID");
  requireCondition(gatePattern.test(value.gate_id) && /^[1-9][0-9]{0,15}$/.test(value.pull_request) && positiveId(Number(value.pull_request)), "INPUT_IDENTITY_INVALID");
  requireCondition(shaPattern.test(value.fixed_sha) && shaPattern.test(value.base_sha) && shaPattern.test(value.evidence_commit_sha) &&
    /^[a-f0-9]{64}$/.test(value.evidence_sha256), "INPUT_SHA_INVALID");
  requireCondition(value.evidence_branch === `review-evidence/${value.gate_id}`, "INPUT_EVIDENCE_BRANCH_INVALID");
  requireCondition(/^[1-9][0-9]{0,15}$/.test(value.source_run_id) && positiveId(Number(value.source_run_id)) && value.source_attempt === "1", "SOURCE_INPUT_INVALID");
  // GitHub does not promise an input key order; the receipt compares this one.
  return Object.fromEntries(INPUT_KEYS.map((key) => [key, value[key]]));
}

// The scheduled source passes the selection of its prepare job through the environment.
export function selectionFromEnv(env) {
  return { gate_id: env.GATE_ID, pull_request: env.GATE_PULL_REQUEST, fixed_sha: env.GATE_FIXED_SHA, base_sha: env.GATE_BASE_SHA,
    evidence_branch: env.GATE_EVIDENCE_BRANCH, evidence_commit_sha: env.GATE_EVIDENCE_COMMIT_SHA, evidence_sha256: env.GATE_EVIDENCE_SHA256 };
}

export function runtimeContext(context, env) {
  return {
    repository: `${context.repo.owner}/${context.repo.repo}`, repositoryId: Number(env.GATE_REPOSITORY_ID),
    runId: context.runId, runAttempt: Number(env.GATE_RUN_ATTEMPT), eventName: context.eventName,
    ref: context.ref, sha: context.sha, workflowRef: env.GATE_WORKFLOW_REF, workflowSha: env.GATE_WORKFLOW_SHA,
    actor: context.actor, actorId: Number(env.GATE_ACTOR_ID), triggeringActor: env.GATE_TRIGGERING_ACTOR,
  };
}

function requireContext(context, inputs, eventName, workflowRef) {
  requireCondition(context?.repository === REPOSITORY && positiveId(context.repositoryId) && positiveId(context.runId) &&
    context.runAttempt === 1 && context.eventName === eventName && context.ref === "refs/heads/main" &&
    context.workflowRef === workflowRef && context.sha === inputs.base_sha && context.workflowSha === inputs.base_sha, "CONTEXT_UNTRUSTED");
}

// The probe's run checks name the main commit "fixedSha". Here that commit is the
// PR base SHA, and "fixed_sha" is the reviewed PR head.
function sourceRun(trust, inputs, runId, now) {
  return { runId, workflowId: trust.workflows.source, repositoryId: trust.repositoryId, fixedSha: inputs.base_sha, mode: "source",
    workflowPath: SOURCE_WORKFLOW, event: "schedule", title: null, workflowRef: sourceWorkflowRef, maxAgeMs: SOURCE_RUN_TTL_MS, now };
}
function gateRun(trust, inputs, runId, now) {
  return { runId, workflowId: trust.workflows.gate, repositoryId: trust.repositoryId, fixedSha: inputs.base_sha, mode: "gate",
    workflowPath: GATE_WORKFLOW, event: "workflow_dispatch", title: gateTitle(inputs.gate_id), titlePrefix: GATE_TITLE_PREFIX,
    workflowRef: gateWorkflowRef, maxAgeMs: GATE_TTL_MS, now };
}

async function readTrust(api, context, inputs) {
  const repository = await request(api, "GET /repos/{owner}/{repo}");
  requireCondition(repository?.id === context.repositoryId && repository.full_name === REPOSITORY && repository.default_branch === "main" && repository.private === false, "REPOSITORY_INVALID");
  const branch = await request(api, "GET /repos/{owner}/{repo}/branches/{branch}", { branch: "main" });
  requireCondition(branch?.name === "main" && branch.commit?.sha === inputs.base_sha, "MAIN_CHANGED");
  const workflows = {};
  for (const [role, path] of [["source", SOURCE_WORKFLOW], ["gate", GATE_WORKFLOW]]) {
    const workflow = await request(api, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", { workflow_id: path.split("/").at(-1) });
    requireCondition(positiveId(workflow?.id) && workflow.path === path && workflow.state === "active", "WORKFLOW_INVALID");
    workflows[role] = workflow.id;
  }
  requireCondition(workflows.source !== workflows.gate, "WORKFLOW_INVALID");
  return { repositoryId: repository.id, workflows };
}

async function readEnvironment(api) {
  return validateEnvironment(
    await request(api, "GET /repos/{owner}/{repo}/environments/{environment_name}", { environment_name: ENVIRONMENT }),
    await request(api, "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies", { environment_name: ENVIRONMENT, per_page: 100, page: 1 }),
  );
}

// What a release is bound to. The evidence digest was recomputed by the scheduled
// source; here it travels with the evidence commit that fixes the same content.
function expectedBinding(inputs) {
  return { pullRequest: Number(inputs.pull_request), fixedSha: inputs.fixed_sha, baseSha: inputs.base_sha, evidenceBranch: inputs.evidence_branch,
    evidenceCommitSha: inputs.evidence_commit_sha, evidenceSha256: inputs.evidence_sha256 };
}

// PR head, base, containment of the current main, pending label and evidence branch.
async function readBinding(api, inputs, repositoryId) {
  const number = Number(inputs.pull_request);
  const pull = await request(api, "GET /repos/{owner}/{repo}/pulls/{pull_number}", { pull_number: number });
  requireCondition(pull?.number === number && pull.state === "open" && pull.merged === false && pull.head?.sha === inputs.fixed_sha, "PULL_REQUEST_STALE");
  requireCondition(pull.base?.ref === "main" && pull.base.sha === inputs.base_sha && pull.base.repo?.id === repositoryId &&
    pull.base.repo.full_name === REPOSITORY, "PULL_REQUEST_BASE_STALE");
  const labels = Array.isArray(pull.labels) ? pull.labels.map((label) => label?.name) : [null];
  requireCondition(labels.every((name) => typeof name === "string") && labels.includes(PENDING_LABEL) &&
    !labels.some((name) => BLOCKING_LABELS.includes(name)), "PULL_REQUEST_LABEL_INVALID");
  const comparison = await request(api, "GET /repos/{owner}/{repo}/compare/{basehead}", { basehead: `${inputs.base_sha}...${inputs.fixed_sha}` });
  requireCondition(["ahead", "identical"].includes(comparison?.status), "PULL_REQUEST_BASE_NOT_CONTAINED");
  const evidence = await request(api, "GET /repos/{owner}/{repo}/git/ref/{ref}", { ref: `heads/${inputs.evidence_branch}` });
  requireCondition(evidence?.ref === `refs/heads/${inputs.evidence_branch}` && evidence.object?.type === "commit" &&
    evidence.object.sha === inputs.evidence_commit_sha, "EVIDENCE_CHANGED");
  return expectedBinding(inputs);
}

// An attestation is valid for one main commit only, so one gate ID owns at most
// one receiver among the dispatched runs of that commit.
async function duplicateGuard(api, trust, inputs, allowedRunId) {
  const runs = await listDispatchRuns(api, trust.workflows.gate, { head_sha: inputs.base_sha });
  const sameGate = runs.filter((item) => item.display_title === gateTitle(inputs.gate_id));
  requireCondition(allowedRunId === null ? sameGate.length === 0 : sameGate.length === 1 && sameGate[0].id === allowedRunId, "DUPLICATE_GATE_REJECTED");
}

// A run concludes "success" even when its jobs were skipped, so the trusted
// recheck is read as a job of the first attempt.
async function verifySourceJobs(api, source, dispatching) {
  const data = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { run_id: source.id, filter: "all", per_page: 100, page: 1 });
  const names = Object.values(SOURCE_JOBS);
  requireCondition(Number.isSafeInteger(data?.total_count) && Array.isArray(data.jobs) && data.jobs.length === data.total_count &&
    data.total_count === names.length && names.every((name) => data.jobs.filter((job) => job?.name === name).length === 1) &&
    data.jobs.every((job) => job?.run_id === source.id && job.run_attempt === 1 && job.head_sha === source.sha), "SOURCE_JOBS_INVALID");
  for (const job of data.jobs) {
    const running = dispatching && job.name === SOURCE_JOBS.dispatch;
    requireCondition(running ? activeStates.has(job.status) && job.conclusion === null : job.status === "completed" && job.conclusion === "success", "SOURCE_VERIFY_UNPROVEN");
  }
}

async function inspectGate(api, context, inputs, now) {
  requireContext(context, inputs, "workflow_dispatch", gateWorkflowRef);
  const trust = await readTrust(api, context, inputs);
  const data = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: context.runId });
  const run = validateRun(data, gateRun(trust, inputs, context.runId, now));
  requireCondition(activeStates.has(data.status) && run.actor.login === context.actor && run.actor.id === context.actorId &&
    run.triggeringActor.login === context.triggeringActor, "CONTEXT_ACTOR_MISMATCH");
  const environment = await readEnvironment(api);
  // A run started by the board owner or anyone else can never wait for approval.
  requireReceiverActor(run.actor, environment.reviewer.id);
  await duplicateGuard(api, trust, inputs, run.id);
  return { repository: REPOSITORY, gateId: inputs.gate_id, mainSha: inputs.base_sha, trust, run, environment };
}

export async function dispatchBoardGate(api, context, selection, { now = Date.now, sleep = sleepForRead } = {}) {
  requireCondition(selection && typeof selection === "object" && positiveId(context?.runId), "SELECTION_INVALID");
  const inputs = parseGateInputs({ ...selection, source_run_id: String(context.runId), source_attempt: "1" });
  requireContext(context, inputs, "schedule", sourceWorkflowRef);
  const trust = await readTrust(api, context, inputs);
  const data = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: context.runId });
  const source = validateRun(data, sourceRun(trust, inputs, context.runId, now()));
  requireCondition(activeStates.has(data.status) && source.actor.login === context.actor && source.actor.id === context.actorId &&
    source.triggeringActor.login === context.triggeringActor, "CONTEXT_ACTOR_MISMATCH");
  await verifySourceJobs(api, source, true);
  const environment = await readEnvironment(api);
  const binding = await readBinding(api, inputs, trust.repositoryId);
  await duplicateGuard(api, trust, inputs, null);
  const existing = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: context.runId, per_page: 100, page: 1 });
  requireCondition(Number.isSafeInteger(existing?.total_count) && existing.total_count <= 100 && Array.isArray(existing.artifacts) &&
    existing.artifacts.length === existing.total_count && !existing.artifacts.some((item) => item?.name === gateReceiptName(context.runId)), "DISPATCH_ALREADY_RECEIPTED");
  const dispatchedAtMs = now();
  // Exactly one write. Any uncertain response ends this attempt, never retries.
  const receiver = validateDispatchResponse(await request(api, "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    workflow_id: GATE_WORKFLOW.split("/").at(-1), ref: "main", inputs,
  }), context.runId);
  const { run, receiverRead } = await readDispatchedRun(api, gateRun(trust, inputs, receiver.id),
    { now, sleep, dispatchedAtMs, reviewerId: environment.reviewer.id });
  requireReceiverActor(run.actor, environment.reviewer.id);
  const receipt = { schema: RECEIPT_SCHEMA, repository: REPOSITORY, repositoryId: trust.repositoryId, gateId: inputs.gate_id,
    mainSha: inputs.base_sha, source, receiver: { ...receiver, run }, inputs, binding, environment,
    dispatchedAt: new Date(dispatchedAtMs).toISOString() };
  requireCondition(Buffer.byteLength(JSON.stringify(receipt, null, 2)) < RECEIPT_BYTES, "RECEIPT_TOO_LARGE");
  return { receipt, receiverRead };
}

function validateReceipt(receipt, snapshot, source, inputs, binding, now) {
  exactKeys(receipt, ["schema", "repository", "repositoryId", "gateId", "mainSha", "source", "receiver", "inputs", "binding", "environment", "dispatchedAt"], "RECEIPT_SCHEMA_INVALID");
  requireCondition(receipt.schema === RECEIPT_SCHEMA && receipt.repository === REPOSITORY && receipt.repositoryId === snapshot.run.repositoryId &&
    receipt.gateId === inputs.gate_id && receipt.mainSha === inputs.base_sha && same(receipt.source, source) && same(receipt.inputs, inputs) &&
    same(receipt.binding, binding) && same(receipt.environment, snapshot.environment), "RECEIPT_PROVENANCE_INVALID");
  exactKeys(receipt.receiver, ["id", "apiUrl", "htmlUrl", "run"], "RECEIPT_RECEIVER_INVALID");
  requireCondition(receipt.receiver.id === snapshot.run.id && receipt.receiver.id !== source.id &&
    receipt.receiver.apiUrl === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${snapshot.run.id}` &&
    receipt.receiver.htmlUrl === snapshot.run.htmlUrl && same(receipt.receiver.run, snapshot.run), "RECEIPT_RECEIVER_INVALID");
  const dispatchedAt = timestamp(receipt.dispatchedAt, "RECEIPT_TIME_INVALID");
  requireCondition(dispatchedAt >= timestamp(source.createdAt, "RUN_TIME_INVALID") && dispatchedAt <= now && now - dispatchedAt <= GATE_TTL_MS &&
    timestamp(snapshot.run.createdAt, "RUN_TIME_INVALID") >= dispatchedAt - 1000, "RECEIPT_EXPIRED");
}

async function receive(api, context, inputs, { now, sleep, wait }) {
  requireCondition(Number(inputs.source_run_id) !== context?.runId, "RECEIVER_SOURCE_INVALID");
  const started = now(); let preparationSleeps = 0;
  for (;;) {
    requireCondition(now() - started <= READ_WAIT_MS && preparationSleeps <= READ_WAIT_MS / READ_INTERVAL_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    const snapshot = await inspectGate(api, context, inputs, now());
    const sourceData = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: Number(inputs.source_run_id) });
    const source = validateRun(sourceData, sourceRun(snapshot.trust, inputs, Number(inputs.source_run_id), now()));
    requireCondition(sourceData.status !== "completed" || sourceData.conclusion === "success", "SOURCE_TERMINAL_FAILURE");
    const metadata = artifactMetadata(await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: source.id, per_page: 100, page: 1 }),
      source, now(), gateReceiptName(source.id));
    if (sourceData.status === "completed" && metadata) {
      requireCondition(now() - started <= READ_WAIT_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
      await verifySourceJobs(api, source, false);
      let archive;
      try { archive = await api.download(metadata.id); } catch { throw new ProbeError("ARCHIVE_DOWNLOAD_BLOCKED", "BLOCKED"); }
      requireCondition(Buffer.isBuffer(archive) && archive.length === metadata.size_in_bytes, "ARCHIVE_SIZE_INVALID");
      requireCondition(Date.parse(metadata.expires_at) > now(), "ARTIFACT_EXPIRED_DURING_DOWNLOAD");
      const receipt = parseReceiptArchive(archive, metadata.digest);
      const binding = await readBinding(api, inputs, snapshot.run.repositoryId);
      validateReceipt(receipt, snapshot, source, inputs, binding, now());
      return { snapshot, source, artifact: { id: metadata.id, digest: metadata.digest, bytes: metadata.size_in_bytes }, receipt, binding };
    }
    requireCondition(sourceData.status !== "completed", "COMPLETED_SOURCE_RECEIPT_MISSING", "BLOCKED");
    requireCondition(wait && now() - started < READ_WAIT_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    requireCondition(preparationSleeps < READ_WAIT_MS / READ_INTERVAL_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    preparationSleeps++;
    await sleep(Math.min(READ_INTERVAL_MS, READ_WAIT_MS - (now() - started)));
  }
}

// Preflight of the receiver, before the protected job can be scheduled.
export async function receiveBoardGate(api, context, rawInputs, options = {}) {
  return receive(api, context, parseGateInputs(rawInputs), { now: options.now ?? Date.now, sleep: options.sleep ?? sleepForRead, wait: options.wait ?? true });
}

// Runs on the runner that starts after the board approval. Nothing is published here.
export async function protectedBoardGate(api, context, rawInputs, expectedEnvironment, options = {}) {
  const now = options.now ?? Date.now, inputs = parseGateInputs(rawInputs);
  const verified = await receive(api, context, inputs, { now, sleep: options.sleep ?? sleepForRead, wait: false });
  requireCondition(same(verified.snapshot.environment, expectedEnvironment), "ENVIRONMENT_CHANGED");
  const history = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals", { run_id: context.runId });
  requireCondition(Array.isArray(history) && history.length <= 100, "REVIEW_HISTORY_INVALID");
  const approvals = history.filter((item) => Array.isArray(item?.environments) && item.environments.some((environment) => environment?.id === expectedEnvironment.id));
  requireCondition(approvals.length === 1 && approvals[0].state === "approved" && approvals[0].user?.login === BOARD_LOGIN &&
    approvals[0].user.id === expectedEnvironment.reviewer.id && approvals[0].user.type === "User", "BOARD_REVIEW_UNVERIFIED", "BLOCKED");
  // Last READ before the release. The API cannot make this atomic with settings.
  const last = await inspectGate(api, context, inputs, now());
  requireCondition(same(last.environment, expectedEnvironment), "ENVIRONMENT_CHANGED");
  await readBinding(api, inputs, last.run.repositoryId);
  return { schema: RELEASE_SCHEMA, repository: REPOSITORY, gateId: inputs.gate_id, binding: verified.binding,
    runId: last.run.id, targetUrl: last.run.htmlUrl, sourceRunId: verified.source.id, artifact: verified.artifact,
    environment: { id: expectedEnvironment.id, fingerprint: expectedEnvironment.fingerprint },
    review: { state: "approved", user: identity(approvals[0].user), environmentId: expectedEnvironment.id },
    // The reviewer ID and history do not prove which person operated the account.
    humanOperationProven: false, verifiedAt: new Date(now()).toISOString() };
}

async function write(api, route, parameters, status, code) {
  let response;
  try {
    response = await api.request(route, { owner: "uk-product-lab", repo: "sns-marketing-manager", ...parameters,
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION } });
  } catch { throw new ProbeError(`${code}_UNKNOWN_NO_RETRY`, "BLOCKED"); }
  requireCondition(response?.status === status, `${code}_INVALID_NO_RETRY`, "BLOCKED");
  return response.data;
}

// Uses the Gatekeeper App client. It accepts only the release that the protected
// recheck of this same run produced moments ago.
export async function publishStatuses(statusApi, context, rawInputs, release, { now = Date.now } = {}) {
  const inputs = parseGateInputs(rawInputs);
  requireContext(context, inputs, "workflow_dispatch", gateWorkflowRef);
  exactKeys(release, ["schema", "repository", "gateId", "binding", "runId", "targetUrl", "sourceRunId", "artifact", "environment", "review", "humanOperationProven", "verifiedAt"], "RELEASE_INVALID");
  requireCondition(release.schema === RELEASE_SCHEMA && release.repository === REPOSITORY && release.gateId === inputs.gate_id &&
    same(release.binding, expectedBinding(inputs)) && release.runId === context.runId && release.targetUrl === runUrl(context.runId) &&
    release.sourceRunId === Number(inputs.source_run_id) && release.review?.state === "approved" && release.review.user?.login === BOARD_LOGIN &&
    release.review.user.type === "User", "RELEASE_INVALID");
  const verifiedAt = timestamp(release.verifiedAt, "RELEASE_INVALID"), current = now();
  requireCondition(verifiedAt <= current && current - verifiedAt <= RELEASE_TTL_MS, "RELEASE_EXPIRED");
  const statusIds = [];
  for (const statusContext of STATUS_CONTEXTS) {
    try {
      const data = await write(statusApi, "POST /repos/{owner}/{repo}/statuses/{sha}", { sha: inputs.fixed_sha, state: "success",
        context: statusContext, description: `Gatekeeper approved ${inputs.gate_id}`, target_url: release.targetUrl }, 201, "STATUS_PUBLISH");
      requireCondition(data?.state === "success" && data.context === statusContext && positiveId(data.id), "STATUS_PUBLISH_INVALID_NO_RETRY", "BLOCKED");
      statusIds.push(data.id);
    } catch (error) {
      // No retry and no rollback: an incomplete set can never satisfy the seven required checks.
      const failure = error instanceof ProbeError ? error : new ProbeError("STATUS_PUBLISH_UNKNOWN_NO_RETRY", "BLOCKED");
      failure.publishedContexts = STATUS_CONTEXTS.slice(0, statusIds.length);
      failure.uncertainContext = statusContext; // Its write may or may not have been recorded.
      throw failure;
    }
  }
  return { schema: PUBLISHED_SCHEMA, repository: REPOSITORY, gateId: inputs.gate_id, pullRequest: Number(inputs.pull_request),
    fixedSha: inputs.fixed_sha, runId: context.runId, targetUrl: release.targetUrl, contexts: [...STATUS_CONTEXTS], statusIds };
}

// Label transition with the workflow token, only after all seven statuses exist.
export async function markApproved(api, context, rawInputs, published) {
  const inputs = parseGateInputs(rawInputs);
  requireContext(context, inputs, "workflow_dispatch", gateWorkflowRef);
  exactKeys(published, ["schema", "repository", "gateId", "pullRequest", "fixedSha", "runId", "targetUrl", "contexts", "statusIds"], "PUBLICATION_INCOMPLETE");
  requireCondition(published.schema === PUBLISHED_SCHEMA && published.repository === REPOSITORY && published.gateId === inputs.gate_id &&
    published.pullRequest === Number(inputs.pull_request) && published.fixedSha === inputs.fixed_sha && published.runId === context.runId &&
    published.targetUrl === runUrl(context.runId) && same(published.contexts, STATUS_CONTEXTS) && Array.isArray(published.statusIds) &&
    published.statusIds.length === STATUS_CONTEXTS.length && published.statusIds.every(positiveId) &&
    new Set(published.statusIds).size === STATUS_CONTEXTS.length, "PUBLICATION_INCOMPLETE");
  await write(api, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { issue_number: published.pullRequest, name: PENDING_LABEL }, 200, "LABEL_REMOVE");
  await write(api, "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { issue_number: published.pullRequest, labels: [APPROVED_LABEL] }, 200, "LABEL_ADD");
  return { schema: "board-gate-approved:v1", gateId: published.gateId, pullRequest: published.pullRequest, fixedSha: published.fixedSha,
    removedLabel: PENDING_LABEL, addedLabel: APPROVED_LABEL };
}

export async function gateUploadBudget(directory) {
  const { bytes, files } = await uploadBudget(directory);
  requireCondition(files <= GATE_UPLOAD_FILES && bytes <= GATE_UPLOAD_BYTES, "UPLOAD_BUDGET_EXCEEDED");
  return { bytes, files, maximumBytes: GATE_UPLOAD_BYTES, maximumFiles: GATE_UPLOAD_FILES };
}

export async function runBoardGateStage(stage, { api, context, inputs, expectedEnvironment, release, published, root, now, sleep }) {
  const resultFile = join(root, "observation", `${stage}.json`);
  try {
    let result;
    if (stage === "dispatch") {
      result = await dispatchBoardGate(api, context, inputs, { now, sleep });
      await writeEvidence(join(root, "receipt", RECEIPT_FILE), result.receipt);
    } else if (stage === "guard") result = await receiveBoardGate(api, context, inputs, { now, sleep });
    else if (stage === "protected") result = await protectedBoardGate(api, context, inputs, expectedEnvironment, { now, sleep });
    else if (stage === "publish") result = await publishStatuses(api, context, inputs, release, { now });
    else if (stage === "label") result = await markApproved(api, context, inputs, published);
    else throw new ProbeError("STAGE_INVALID");
    await writeEvidence(resultFile, { stage, result: "STAGE_COMPLETED", repositoryGatePass: false, productPass: false, ...result });
    return result;
  } catch (error) {
    const failure = error instanceof ProbeError ? error : new ProbeError("UNEXPECTED_GATE_FAILURE", "BLOCKED");
    await writeEvidence(resultFile, { stage, result: failure.result, code: failure.code, approvedLabel: false,
      publishedContexts: failure.publishedContexts ?? [], uncertainContext: failure.uncertainContext,
      receiverRead: failure.receiverRead }).catch(() => undefined);
    throw failure;
  }
}
