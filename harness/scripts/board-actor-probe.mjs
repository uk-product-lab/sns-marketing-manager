import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

// Fixed trust boundary. Imports are inert; LOCAL tests supply API/clock fixtures.
export const REPOSITORY = "uk-product-lab/sns-marketing-manager";
export const WORKFLOW = ".github/workflows/board-actor-probe.yml";
export const API_VERSION = "2026-03-10";
export const ENVIRONMENT = "board-review";
export const BOARD_LOGIN = "ukyo-0001";
export const RECEIPT_BYTES = 16 * 1024;
export const ARCHIVE_BYTES = 64 * 1024;
export const RECEIPT_TTL_MS = 60 * 60 * 1000;
export const READ_WAIT_MS = 120_000;
export const READ_INTERVAL_MS = 3_000;
// Five bounded upload sites, even if all were reached: 20 MiB / 500.
export const UPLOAD_SLOTS = 5;
export const UPLOAD_BYTES = 20 * 1024 * 1024 / UPLOAD_SLOTS;
export const UPLOAD_FILES = 500 / UPLOAD_SLOTS;
const shaPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const workflowRef = `${REPOSITORY}/${WORKFLOW}@refs/heads/main`;
const activeStates = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export class ProbeError extends Error {
  constructor(code, result = "FAIL") { super(code); this.code = code; this.result = result; }
}
function requireCondition(condition, code, result) { if (!condition) throw new ProbeError(code, result); }
function exactKeys(value, keys, code) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
}
function timestamp(value, code) {
  requireCondition(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), code);
  const canonical = new Date(Date.parse(value)).toISOString();
  requireCondition(canonical === value || canonical.replace(".000Z", "Z") === value, code);
  return Date.parse(value);
}
function identity(value) {
  requireCondition(value && positiveId(value.id) && typeof value.login === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9[\]-]{0,60}$/.test(value.login) && ["User", "Bot"].includes(value.type), "RUN_IDENTITY_INVALID");
  return { login: value.login, id: value.id, type: value.type };
}
function runTitle(mode, probeId) { return `board-actor-probe:${mode}:${probeId}`; }
export function receiptName(runId) { requireCondition(positiveId(runId), "RUN_ID_INVALID"); return `board-actor-receipt-${runId}-1`; }

export function parseInputs(value) {
  exactKeys(value, ["mode", "probe_id", "fixed_sha", "source_run_id", "source_attempt", "acknowledgement"], "INPUT_KEYS_INVALID");
  requireCondition(["dispatch", "receive", "direct-negative"].includes(value.mode), "MODE_INVALID");
  requireCondition(uuidPattern.test(value.probe_id ?? "") && shaPattern.test(value.fixed_sha ?? ""), "INPUT_IDENTITY_INVALID");
  requireCondition(value.acknowledgement === "SYNTHETIC_PROBE_ONLY", "ACKNOWLEDGEMENT_INVALID");
  if (value.mode === "receive") {
    requireCondition(typeof value.source_run_id === "string" && /^[1-9][0-9]*$/.test(value.source_run_id) && positiveId(Number(value.source_run_id)) && value.source_attempt === "1", "SOURCE_INPUT_INVALID");
  } else requireCondition(value.source_run_id === "" && value.source_attempt === "", "RECURSIVE_INPUT_REJECTED");
  return { mode: value.mode, probe_id: value.probe_id, fixed_sha: value.fixed_sha,
    source_run_id: value.source_run_id, source_attempt: value.source_attempt, acknowledgement: value.acknowledgement };
}

export function runtimeContext(context, env) {
  return {
    repository: `${context.repo.owner}/${context.repo.repo}`, repositoryId: Number(env.PROBE_REPOSITORY_ID),
    runId: context.runId, runAttempt: Number(env.PROBE_RUN_ATTEMPT), eventName: context.eventName,
    ref: context.ref, sha: context.sha, workflowRef: env.PROBE_WORKFLOW_REF, workflowSha: env.PROBE_WORKFLOW_SHA,
    actor: context.actor, actorId: Number(env.PROBE_ACTOR_ID), triggeringActor: env.PROBE_TRIGGERING_ACTOR,
  };
}

async function request(api, route, parameters = {}) {
  let response;
  try { response = await api.request(route, { owner: "uk-product-lab", repo: "sns-marketing-manager", ...parameters,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION } }); }
  catch { throw new ProbeError(route.startsWith("POST ") ? "DISPATCH_RESPONSE_UNKNOWN_NO_RETRY" : "API_READ_BLOCKED", "BLOCKED"); }
  requireCondition(response?.status === 200, route.startsWith("POST ") ? "DISPATCH_RESPONSE_INVALID_NO_RETRY" : "API_READ_STATUS_INVALID", "BLOCKED");
  return response.data;
}

export function validateEnvironment(environment, policies) {
  requireCondition(environment?.name === ENVIRONMENT && positiveId(environment.id) && environment.can_admins_bypass === false, "ENVIRONMENT_INVALID");
  const rules = environment.protection_rules;
  requireCondition(Array.isArray(rules) && rules.length === 2 &&
    JSON.stringify(rules.map((item) => item.type).sort()) === JSON.stringify(["branch_policy", "required_reviewers"]), "ENVIRONMENT_RULES_INVALID");
  const rule = rules.find((item) => item.type === "required_reviewers");
  requireCondition(rule.prevent_self_review === true && Array.isArray(rule.reviewers) && rule.reviewers.length === 1 &&
    rule.reviewers[0].type === "User" && rule.reviewers[0].reviewer?.login === BOARD_LOGIN && positiveId(rule.reviewers[0].reviewer?.id), "ENVIRONMENT_REVIEWER_INVALID");
  requireCondition(environment.deployment_branch_policy?.protected_branches === false &&
    environment.deployment_branch_policy?.custom_branch_policies === true && policies?.total_count === 1 &&
    Array.isArray(policies.branch_policies) && policies.branch_policies.length === 1 &&
    policies.branch_policies[0].name === "main" && policies.branch_policies[0].type === "branch" && positiveId(policies.branch_policies[0].id), "ENVIRONMENT_BRANCH_INVALID");
  const observed = { id: environment.id, name: ENVIRONMENT, reviewer: { login: BOARD_LOGIN, id: rule.reviewers[0].reviewer.id },
    preventSelfReview: true, adminsBypass: false, branch: "main", branchPolicyId: policies.branch_policies[0].id };
  return { ...observed, fingerprint: hash(JSON.stringify(observed)) };
}

function validateRun(run, { runId, workflowId, repositoryId, fixedSha, mode, probeId, now }) {
  requireCondition(run && run.id === runId && positiveId(runId) && run.workflow_id === workflowId &&
    [WORKFLOW, `${WORKFLOW}@main`, `${WORKFLOW}@refs/heads/main`].includes(run.path) && run.event === "workflow_dispatch" &&
    run.head_branch === "main" && run.head_sha === fixedSha && run.run_attempt === 1 &&
    run.repository?.id === repositoryId && run.repository.full_name === REPOSITORY &&
    run.head_repository?.id === repositoryId && run.head_repository.full_name === REPOSITORY &&
    run.html_url === `https://github.com/${REPOSITORY}/actions/runs/${runId}` &&
    run.url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${runId}` &&
    run.display_title === runTitle(mode, probeId), "RUN_PROVENANCE_INVALID");
  const created = timestamp(run.created_at, "RUN_TIME_INVALID");
  requireCondition(created <= now && now - created <= RECEIPT_TTL_MS, "RUN_EXPIRED");
  const actor = identity(run.actor), triggeringActor = identity(run.triggering_actor);
  requireCondition(actor.id === triggeringActor.id && actor.login === triggeringActor.login && actor.type === triggeringActor.type, "TRIGGERING_ACTOR_CHANGED");
  requireCondition(activeStates.has(run.status) ? run.conclusion === null : run.status === "completed" && typeof run.conclusion === "string", "RUN_STATE_INVALID");
  return { id: runId, attempt: 1, mode, workflowId, workflowRef, workflowSha: fixedSha, ref: "refs/heads/main", sha: fixedSha,
    repositoryId, actor, triggeringActor, createdAt: run.created_at, htmlUrl: run.html_url };
}

async function duplicateGuard(api, snapshot, inputs) {
  let total = null, runs = [];
  for (let page = 1; page <= 10; page++) {
    const data = await request(api, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
      workflow_id: snapshot.workflowId, event: "workflow_dispatch", per_page: 100, page,
    });
    requireCondition(Number.isSafeInteger(data?.total_count) && data.total_count >= 0 && data.total_count <= 1000 && Array.isArray(data.workflow_runs), "RUN_LIST_INVALID", "BLOCKED");
    if (total === null) total = data.total_count;
    requireCondition(total === data.total_count && data.workflow_runs.length <= 100, "RUN_LIST_CHANGED", "BLOCKED");
    runs.push(...data.workflow_runs);
    if (runs.length >= total) break;
    requireCondition(data.workflow_runs.length === 100, "RUN_LIST_INCOMPLETE", "BLOCKED");
  }
  requireCondition(runs.length === total && new Set(runs.map((item) => item.id)).size === runs.length, "RUN_LIST_INCOMPLETE", "BLOCKED");
  const same = runs.filter((item) => item.display_title === runTitle(inputs.mode, inputs.probe_id));
  requireCondition(same.length === 1 && same[0].id === snapshot.run.id, "DUPLICATE_PROBE_REJECTED");
}

async function inspect(api, context, inputs, now) {
  requireCondition(context.repository === REPOSITORY && positiveId(context.repositoryId) && positiveId(context.runId) &&
    context.runAttempt === 1 && context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main" &&
    context.workflowRef === workflowRef && context.sha === inputs.fixed_sha && context.workflowSha === inputs.fixed_sha, "CONTEXT_UNTRUSTED");
  const repository = await request(api, "GET /repos/{owner}/{repo}");
  requireCondition(repository?.id === context.repositoryId && repository.full_name === REPOSITORY && repository.default_branch === "main" && repository.private === false, "REPOSITORY_INVALID");
  const branch = await request(api, "GET /repos/{owner}/{repo}/branches/{branch}", { branch: "main" });
  requireCondition(branch?.name === "main" && branch.commit?.sha === inputs.fixed_sha, "MAIN_CHANGED");
  const workflow = await request(api, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", { workflow_id: "board-actor-probe.yml" });
  requireCondition(positiveId(workflow?.id) && workflow.path === WORKFLOW && workflow.state === "active", "WORKFLOW_INVALID");
  const data = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: context.runId });
  const run = validateRun(data, { runId: context.runId, workflowId: workflow.id, repositoryId: repository.id,
    fixedSha: inputs.fixed_sha, mode: inputs.mode, probeId: inputs.probe_id, now });
  requireCondition(activeStates.has(data.status) && run.actor.login === context.actor && run.actor.id === context.actorId && run.triggeringActor.login === context.triggeringActor, "CONTEXT_ACTOR_MISMATCH");
  const environment = validateEnvironment(
    await request(api, "GET /repos/{owner}/{repo}/environments/{environment_name}", { environment_name: ENVIRONMENT }),
    await request(api, "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies", { environment_name: ENVIRONMENT, per_page: 100, page: 1 }),
  );
  const snapshot = { repository: REPOSITORY, fixedSha: inputs.fixed_sha, probeId: inputs.probe_id, workflowId: workflow.id, run, environment };
  await duplicateGuard(api, snapshot, inputs);
  return snapshot;
}

export function validateDispatchResponse(data, sourceRunId) {
  exactKeys(data, ["workflow_run_id", "run_url", "html_url"], "DISPATCH_BODY_INVALID");
  const id = data.workflow_run_id;
  requireCondition(positiveId(id) && id !== sourceRunId && data.run_url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${id}` &&
    data.html_url === `https://github.com/${REPOSITORY}/actions/runs/${id}`, "DISPATCH_BINDING_INVALID");
  return { id, apiUrl: data.run_url, htmlUrl: data.html_url };
}

export async function dispatchProbe(api, context, rawInputs, { now = Date.now } = {}) {
  const inputs = parseInputs(rawInputs);
  requireCondition(inputs.mode === "dispatch", "DISPATCH_MODE_INVALID");
  const snapshot = await inspect(api, context, inputs, now());
  requireCondition(snapshot.run.actor.login === BOARD_LOGIN && snapshot.run.actor.type === "User" && snapshot.run.actor.id === snapshot.environment.reviewer.id, "DISPATCH_ACTOR_INVALID");
  const existing = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: context.runId, per_page: 100, page: 1 });
  requireCondition(existing?.total_count === 0 && Array.isArray(existing.artifacts) && existing.artifacts.length === 0, "DISPATCH_ALREADY_RECEIPTED");
  const childInputs = { ...inputs, mode: "receive", source_run_id: String(context.runId), source_attempt: "1" };
  const dispatchedAt = new Date(now()).toISOString();
  // Exactly one write. Any uncertain response ends this attempt, never retries.
  const receiver = validateDispatchResponse(await request(api, "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    workflow_id: "board-actor-probe.yml", ref: "main", inputs: childInputs,
  }), context.runId);
  const child = validateRun(await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: receiver.id }), {
    runId: receiver.id, workflowId: snapshot.workflowId, repositoryId: context.repositoryId,
    fixedSha: inputs.fixed_sha, mode: "receive", probeId: inputs.probe_id, now: now(),
  });
  const receipt = { schema: "board-actor-dispatch-receipt:v1", repository: REPOSITORY, repositoryId: context.repositoryId,
    probeId: inputs.probe_id, fixedSha: inputs.fixed_sha, source: snapshot.run, receiver: { ...receiver, run: child },
    inputs: childInputs, environment: snapshot.environment, dispatchedAt };
  requireCondition(Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_BYTES, "RECEIPT_TOO_LARGE");
  return { snapshot, receipt };
}

// ZIP parser never extracts. One central-directory entry, one fixed filename,
// bounded inflation, local/central consistency and CRC; ZIP64/multi-disk denied.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function parseReceiptArchive(buffer, digest) {
  requireCondition(Buffer.isBuffer(buffer) && buffer.length >= 22 && buffer.length <= ARCHIVE_BYTES &&
    typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest) && `sha256:${hash(buffer)}` === digest, "ARCHIVE_DIGEST_INVALID");
  try {
    let end = -1;
    for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at--) {
      if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
    }
    requireCondition(end >= 0 && buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0 &&
      buffer.readUInt16LE(end + 8) === 1 && buffer.readUInt16LE(end + 10) === 1 && buffer.readUInt16LE(end + 20) === 0, "ZIP_DIRECTORY_INVALID");
    const central = buffer.readUInt32LE(end + 16), centralBytes = buffer.readUInt32LE(end + 12);
    requireCondition(central + centralBytes === end && centralBytes >= 46 && buffer.readUInt32LE(central) === 0x02014b50, "ZIP_DIRECTORY_INVALID");
    const flags = buffer.readUInt16LE(central + 8), method = buffer.readUInt16LE(central + 10), crc = buffer.readUInt32LE(central + 16);
    const compressed = buffer.readUInt32LE(central + 20), size = buffer.readUInt32LE(central + 24), nameBytes = buffer.readUInt16LE(central + 28);
    const extraBytes = buffer.readUInt16LE(central + 30), commentBytes = buffer.readUInt16LE(central + 32), offset = buffer.readUInt32LE(central + 42);
    requireCondition([0, 8].includes(method) && (flags & ~0x808) === 0 && size > 0 && size <= RECEIPT_BYTES && compressed > 0 && compressed <= ARCHIVE_BYTES &&
      centralBytes === 46 + nameBytes + extraBytes + commentBytes && buffer.readUInt16LE(central + 34) === 0 && offset === 0 &&
      (buffer.readUInt32LE(central + 38) >>> 16 & 0xf000) !== 0xa000 &&
      buffer.subarray(central + 46, central + 46 + nameBytes).toString("utf8") === "dispatch-receipt.json", "ZIP_ENTRY_INVALID");
    requireCondition(buffer.readUInt32LE(offset) === 0x04034b50 && buffer.readUInt16LE(offset + 6) === flags &&
      buffer.readUInt16LE(offset + 8) === method && buffer.readUInt16LE(offset + 26) === nameBytes, "ZIP_LOCAL_INVALID");
    const payloadStart = offset + 30 + nameBytes + buffer.readUInt16LE(offset + 28);
    requireCondition(buffer.subarray(offset + 30, offset + 30 + nameBytes).toString("utf8") === "dispatch-receipt.json" && payloadStart + compressed <= central, "ZIP_LOCAL_INVALID");
    if (!(flags & 8)) requireCondition(buffer.readUInt32LE(offset + 14) === crc && buffer.readUInt32LE(offset + 18) === compressed && buffer.readUInt32LE(offset + 22) === size && payloadStart + compressed === central, "ZIP_LOCAL_INVALID");
    else {
      const descriptor = payloadStart + compressed, signed = buffer.readUInt32LE(descriptor) === 0x08074b50, fields = descriptor + (signed ? 4 : 0);
      requireCondition(fields + 12 === central && buffer.readUInt32LE(fields) === crc && buffer.readUInt32LE(fields + 4) === compressed && buffer.readUInt32LE(fields + 8) === size, "ZIP_DESCRIPTOR_INVALID");
    }
    const payload = buffer.subarray(payloadStart, payloadStart + compressed);
    const content = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: RECEIPT_BYTES });
    requireCondition(content.length === size && crc32(content) === crc, "ZIP_PAYLOAD_INVALID");
    const text = content.toString("utf8");
    requireCondition(Buffer.from(text, "utf8").equals(content), "RECEIPT_ENCODING_INVALID");
    const receipt = JSON.parse(text);
    // Canonical JSON is emitted by the source. Reject duplicate-key ambiguity.
    requireCondition(JSON.stringify(receipt, null, 2) + "\n" === text, "RECEIPT_JSON_NONCANONICAL");
    return receipt;
  } catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError("ARCHIVE_PARSE_INVALID"); }
}

function artifactMetadata(data, source, now) {
  requireCondition(Number.isSafeInteger(data?.total_count) && data.total_count >= 0 && data.total_count <= 100 &&
    Array.isArray(data.artifacts) && data.artifacts.length === data.total_count, "ARTIFACT_LIST_INVALID");
  const matches = data.artifacts.filter((item) => item.name === receiptName(source.id));
  requireCondition(matches.length <= 1, "DUPLICATE_RECEIPT_REJECTED");
  if (!matches.length) return null;
  const artifact = matches[0];
  requireCondition(positiveId(artifact.id) && artifact.expired === false && positiveId(artifact.size_in_bytes) && artifact.size_in_bytes <= ARCHIVE_BYTES &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") && artifact.workflow_run?.id === source.id &&
    artifact.workflow_run.repository_id === source.repositoryId && artifact.workflow_run.head_repository_id === source.repositoryId &&
    artifact.workflow_run.head_branch === "main" && artifact.workflow_run.head_sha === source.sha &&
    timestamp(artifact.created_at, "ARTIFACT_TIME_INVALID") >= timestamp(source.createdAt, "RUN_TIME_INVALID") &&
    Date.parse(artifact.created_at) <= now && timestamp(artifact.expires_at, "ARTIFACT_TIME_INVALID") > now &&
    Date.parse(artifact.expires_at) - Date.parse(artifact.created_at) <= 24 * 60 * 60 * 1000 + 60_000, "ARTIFACT_PROVENANCE_INVALID");
  return artifact;
}

function validateReceipt(receipt, snapshot, source, inputs, now) {
  exactKeys(receipt, ["schema", "repository", "repositoryId", "probeId", "fixedSha", "source", "receiver", "inputs", "environment", "dispatchedAt"], "RECEIPT_SCHEMA_INVALID");
  requireCondition(receipt.schema === "board-actor-dispatch-receipt:v1" && receipt.repository === REPOSITORY && receipt.repositoryId === snapshot.run.repositoryId &&
    receipt.probeId === inputs.probe_id && receipt.fixedSha === inputs.fixed_sha && JSON.stringify(receipt.source) === JSON.stringify(source) &&
    JSON.stringify(receipt.inputs) === JSON.stringify(inputs) && JSON.stringify(receipt.environment) === JSON.stringify(snapshot.environment), "RECEIPT_PROVENANCE_INVALID");
  exactKeys(receipt.receiver, ["id", "apiUrl", "htmlUrl", "run"], "RECEIPT_RECEIVER_INVALID");
  requireCondition(receipt.receiver.id === snapshot.run.id && receipt.receiver.id !== source.id &&
    receipt.receiver.apiUrl === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${snapshot.run.id}` && receipt.receiver.htmlUrl === snapshot.run.htmlUrl &&
    JSON.stringify(receipt.receiver.run) === JSON.stringify(snapshot.run), "RECEIPT_RECEIVER_INVALID");
  const dispatchedAt = timestamp(receipt.dispatchedAt, "RECEIPT_TIME_INVALID");
  requireCondition(dispatchedAt >= timestamp(source.createdAt, "RUN_TIME_INVALID") && dispatchedAt <= now && now - dispatchedAt <= RECEIPT_TTL_MS &&
    timestamp(snapshot.run.createdAt, "RUN_TIME_INVALID") >= dispatchedAt - 1000, "RECEIPT_EXPIRED");
}

async function receive(api, context, inputs, { now, sleep, wait }) {
  requireCondition(inputs.mode === "receive" && Number(inputs.source_run_id) !== context.runId, "RECEIVER_MODE_INVALID");
  const started = now(); let preparationSleeps = 0;
  for (;;) {
    requireCondition(now() - started <= READ_WAIT_MS && preparationSleeps <= READ_WAIT_MS / READ_INTERVAL_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    const snapshot = await inspect(api, context, inputs, now());
    const sourceData = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: Number(inputs.source_run_id) });
    const source = validateRun(sourceData, { runId: Number(inputs.source_run_id), workflowId: snapshot.workflowId,
      repositoryId: snapshot.run.repositoryId, fixedSha: inputs.fixed_sha, mode: "dispatch", probeId: inputs.probe_id, now: now() });
    requireCondition(source.actor.login === BOARD_LOGIN && source.actor.type === "User" && source.actor.id === snapshot.environment.reviewer.id, "SOURCE_ACTOR_INVALID");
    requireCondition(sourceData.status !== "completed" || sourceData.conclusion === "success", "SOURCE_TERMINAL_FAILURE");
    const metadata = artifactMetadata(await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: source.id, per_page: 100, page: 1 }), source, now());
    if (sourceData.status === "completed" && metadata) {
      requireCondition(now() - started <= READ_WAIT_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
      let archive;
      try { archive = await api.download(metadata.id); } catch { throw new ProbeError("ARCHIVE_DOWNLOAD_BLOCKED", "BLOCKED"); }
      requireCondition(Buffer.isBuffer(archive) && archive.length === metadata.size_in_bytes, "ARCHIVE_SIZE_INVALID");
      requireCondition(Date.parse(metadata.expires_at) > now(), "ARTIFACT_EXPIRED_DURING_DOWNLOAD");
      const receipt = parseReceiptArchive(archive, metadata.digest);
      validateReceipt(receipt, snapshot, source, inputs, now());
      requireCondition(snapshot.run.actor.type === "Bot" && snapshot.run.actor.login === "github-actions[bot]" && snapshot.run.actor.id !== snapshot.environment.reviewer.id, "RECEIVER_ACTOR_UNPROVEN", "BLOCKED");
      return { snapshot, source, artifact: { id: metadata.id, digest: metadata.digest, bytes: metadata.size_in_bytes }, receipt };
    }
    requireCondition(sourceData.status !== "completed", "COMPLETED_SOURCE_RECEIPT_MISSING", "BLOCKED");
    requireCondition(wait && now() - started < READ_WAIT_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    requireCondition(preparationSleeps < READ_WAIT_MS / READ_INTERVAL_MS, "RECEIPT_READINESS_TIMEOUT", "BLOCKED");
    preparationSleeps++;
    await sleep(Math.min(READ_INTERVAL_MS, READ_WAIT_MS - (now() - started)));
  }
}
export async function receiveProbe(api, context, rawInputs, options = {}) {
  return receive(api, context, parseInputs(rawInputs), { now: options.now ?? Date.now, sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), wait: options.wait ?? true });
}
export async function directNegativePreflight(api, context, rawInputs, { now = Date.now } = {}) {
  const inputs = parseInputs(rawInputs);
  requireCondition(inputs.mode === "direct-negative", "NEGATIVE_MODE_INVALID");
  const snapshot = await inspect(api, context, inputs, now());
  requireCondition(snapshot.run.actor.login === BOARD_LOGIN && snapshot.run.actor.type === "User" && snapshot.run.actor.id === snapshot.environment.reviewer.id, "NEGATIVE_ACTOR_INVALID");
  return { snapshot, expected: "SELF_REVIEW_MUST_BE_DENIED", positiveMarker: false };
}

export async function protectedProbe(api, context, rawInputs, expectedEnvironment, options = {}) {
  const verified = await receiveProbe(api, context, rawInputs, { ...options, wait: false });
  requireCondition(JSON.stringify(verified.snapshot.environment) === JSON.stringify(expectedEnvironment), "ENVIRONMENT_CHANGED");
  const history = await request(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals", { run_id: context.runId });
  requireCondition(Array.isArray(history) && history.length <= 100, "REVIEW_HISTORY_INVALID");
  const approvals = history.filter((item) => Array.isArray(item.environments) && item.environments.some((environment) => environment.id === expectedEnvironment.id));
  requireCondition(approvals.length === 1 && approvals[0].state === "approved" && approvals[0].user?.login === BOARD_LOGIN &&
    approvals[0].user.id === expectedEnvironment.reviewer.id && approvals[0].user.type === "User", "BOARD_REVIEW_UNVERIFIED", "BLOCKED");
  // Last READ before publishing. The API cannot make this atomic with settings.
  const last = await inspect(api, context, parseInputs(rawInputs), (options.now ?? Date.now)());
  requireCondition(JSON.stringify(last.environment) === JSON.stringify(expectedEnvironment), "ENVIRONMENT_CHANGED");
  return { schema: "board-actor-synthetic-marker:v1", synthetic: true, scope: "actor-path-observation-only",
    repositoryGatePass: false, humanOperationProven: false, productPass: false, run: verified.snapshot.run,
    source: verified.source, artifact: verified.artifact, environment: verified.snapshot.environment,
    review: { state: "approved", user: identity(approvals[0].user), environmentId: expectedEnvironment.id },
    reachedAt: new Date((options.now ?? Date.now)()).toISOString() };
}

export async function negativeProtectedProbe(api, context, inputs, expectedEnvironment, options = {}) {
  const verified = await directNegativePreflight(api, context, inputs, options);
  requireCondition(JSON.stringify(verified.snapshot.environment) === JSON.stringify(expectedEnvironment), "ENVIRONMENT_CHANGED");
  throw new ProbeError("SELF_REVIEW_NEGATIVE_UNEXPECTED_EXECUTION"); // No positive marker path.
}

export function createRuntimeApi(github, githubToken, fetchFunction = globalThis.fetch) {
  return {
    request: (route, parameters) => github.request(route, { ...parameters, request: { retries: 0 } }),
    async download(id) {
      requireCondition(positiveId(id) && typeof githubToken === "string" && githubToken.length > 0, "ARCHIVE_DOWNLOAD_BLOCKED", "BLOCKED");
      try {
        const redirect = await fetchFunction(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${githubToken}`, "X-GitHub-Api-Version": API_VERSION },
          redirect: "manual", signal: AbortSignal.timeout(10_000),
        });
        requireCondition(redirect.status === 302, "ARCHIVE_REDIRECT_INVALID");
        const location = new URL(redirect.headers.get("location"));
        requireCondition(location.protocol === "https:" && !location.username && !location.password && !location.port &&
          (/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(location.hostname) || /^[a-z0-9.-]+\.githubusercontent\.com$/.test(location.hostname)), "ARCHIVE_REDIRECT_INVALID");
        // Signed location is never logged/stored. Authentication is NOT forwarded.
        const response = await fetchFunction(location.href, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        requireCondition(response.status === 200 && response.body, "ARCHIVE_DOWNLOAD_BLOCKED");
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) { bytes += chunk.length; requireCondition(bytes <= ARCHIVE_BYTES, "ARCHIVE_TOO_LARGE"); chunks.push(Buffer.from(chunk)); }
        return Buffer.concat(chunks);
      } catch { throw new ProbeError("ARCHIVE_DOWNLOAD_BLOCKED", "BLOCKED"); }
    },
  };
}

export async function uploadBudget(directory) {
  let bytes = 0, files = 0;
  async function visit(path) {
    const info = await lstat(path);
    requireCondition(!info.isSymbolicLink(), "UPLOAD_SYMLINK_REJECTED");
    if (info.isDirectory()) for (const item of await readdir(path)) await visit(join(path, item));
    else { requireCondition(info.isFile() && info.size > 0, "UPLOAD_FILE_INVALID"); bytes += info.size; files++; }
  }
  await visit(directory);
  requireCondition(files > 0 && files <= UPLOAD_FILES && bytes <= UPLOAD_BYTES, "UPLOAD_BUDGET_EXCEEDED");
  return { bytes, files, reservedSlots: UPLOAD_SLOTS, aggregateMaximumBytes: UPLOAD_BYTES * UPLOAD_SLOTS, aggregateMaximumFiles: UPLOAD_FILES * UPLOAD_SLOTS };
}

export async function writeEvidence(path, record) {
  const text = JSON.stringify(record, null, 2) + "\n";
  requireCondition(Buffer.byteLength(text) <= RECEIPT_BYTES && !/(?:Bearer\s|gh[pousr]_[A-Za-z0-9]|-----BEGIN.*PRIVATE KEY|[?&](?:sig|token|secret)=)/i.test(text), "PUBLIC_EVIDENCE_INVALID");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: "wx" }); // Keep the first failure; no overwrites.
}

export async function runWorkflowStage(stage, { api, context, inputs, expectedEnvironment, root, now, sleep }) {
  const resultFile = join(root, "observation", "result.json");
  try {
    let result;
    if (stage === "dispatch") {
      result = await dispatchProbe(api, context, inputs, { now });
      await writeEvidence(join(root, "receipt", "dispatch-receipt.json"), result.receipt);
    } else if (stage === "guard") {
      const parsed = parseInputs(inputs);
      result = parsed.mode === "receive" ? await receiveProbe(api, context, parsed, { now, sleep }) : await directNegativePreflight(api, context, parsed, { now });
    } else if (stage === "protected") result = await protectedProbe(api, context, inputs, expectedEnvironment, { now, sleep });
    else if (stage === "negative") result = await negativeProtectedProbe(api, context, inputs, expectedEnvironment, { now });
    else throw new ProbeError("STAGE_INVALID");
    await writeEvidence(resultFile, { stage, result: "OBSERVED_ONLY", liveHumanOperationProven: false, ...result });
    return result;
  } catch (error) {
    const failure = error instanceof ProbeError ? error : new ProbeError("UNEXPECTED_PROBE_FAILURE", "BLOCKED");
    await writeEvidence(resultFile, { stage, result: failure.result, code: failure.code, positiveMarker: false }).catch(() => undefined);
    throw failure;
  }
}
