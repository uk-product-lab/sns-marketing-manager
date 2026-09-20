import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const recordFile = argv[0];
  const args = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
  }
  return { recordFile, args };
}

async function readJsonEntries(directory) {
  const names = await readdir(directory).catch(() => []);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        name,
        value: JSON.parse(await readFile(join(directory, name), "utf8")),
      })),
  );
}

async function isNonEmptyFile(path) {
  const entry = await stat(path).catch(() => null);
  return Boolean(entry?.isFile() && entry.size > 0);
}

function uniqueStringList(value, field, { nonEmpty = false } = {}) {
  assert(Array.isArray(value), `${field} must be an array`);
  assert(
    value.every((item) => typeof item === "string" && item.length > 0),
    `${field} must contain non-empty strings`,
  );
  assert(new Set(value).size === value.length, `${field} must not contain duplicates`);
  if (nonEmpty) assert(value.length > 0, `${field} must not be empty`);
  return [...value].sort();
}

function sameSet(actual, expected, field) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${field} does not match checks.json`);
}

const { recordFile, args } = parseArgs(process.argv.slice(2));
assert(
  recordFile && args["state-root"],
  "Usage: node validate-review-failure-record.mjs <failure-record.json> --state-root <shared state root>",
);

const recordPath = await realpath(resolve(recordFile));
const stateRoot = await realpath(resolve(args["state-root"]));
const record = JSON.parse(await readFile(recordPath, "utf8"));

assert(basename(recordPath) === "failure-record.json", "Failure record filename must be failure-record.json");
assert(/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(record.gateId ?? ""), "Invalid gateId");
assert(/^[A-Z][A-Z0-9-]{2,50}$/.test(record.taskId ?? ""), "Invalid taskId");
assert(/^[a-f0-9]{40}$/i.test(record.fixedCommitSha ?? ""), "Invalid fixedCommitSha");
assert(/^[0-9a-f-]{36}$/i.test(record.implementationLeaseId ?? ""), "Invalid implementationLeaseId");
assert(/^[0-9a-f-]{36}$/i.test(record.reviewLeaseId ?? ""), "Invalid reviewLeaseId");
assert(typeof record.implementerSession === "string" && record.implementerSession.length > 0, "Missing implementerSession");
assert(typeof record.reviewerSession === "string" && record.reviewerSession.length > 0, "Missing reviewerSession");
assert(record.implementerSession !== record.reviewerSession, "Implementer and reviewer sessions must differ");

const recommendationByOutcome = {
  FAIL: "RETURN_TO_IMPLEMENTER",
  BLOCKED: "WAIT",
};
assert(
  recommendationByOutcome[record.outcome] === record.recommendation,
  "Failure outcome and recommendation conflict",
);

const failedChecks = uniqueStringList(record.failedChecks, "failedChecks");
const blockedChecks = uniqueStringList(record.blockedChecks, "blockedChecks");
const blockedReasons = uniqueStringList(record.blockedReasons, "blockedReasons");
if (record.outcome === "FAIL") {
  assert(failedChecks.length > 0, "FAIL requires at least one failed check");
  assert(blockedChecks.length === 0, "FAIL must not list blockedChecks");
  assert(blockedReasons.length === 0, "FAIL must not list blockedReasons");
} else {
  assert(failedChecks.length === 0, "BLOCKED must not list failedChecks");
  assert(blockedChecks.length > 0, "BLOCKED requires at least one blocked check");
  assert(blockedReasons.length > 0, "BLOCKED requires at least one blocked reason");
}

const testStartedAt = Date.parse(record.testStartedAt);
const testedAt = Date.parse(record.testedAt);
assert(!Number.isNaN(testStartedAt), "Invalid testStartedAt");
assert(!Number.isNaN(testedAt), "Invalid testedAt");
assert(testStartedAt <= testedAt, "testStartedAt must not be after testedAt");
assert(testedAt <= Date.now() + 60_000, "testedAt must not be in the future");

const activeReviewLease = await readFile(
  join(stateRoot, "leases", "active", `${record.taskId}.reviewer.json`),
  "utf8",
)
  .then((text) => JSON.parse(text))
  .catch(() => null);
const archivedReviewLeaseEntries = (await readJsonEntries(
  join(stateRoot, "leases", "archive"),
)).filter(
  ({ value: lease }) =>
    lease.leaseId === record.reviewLeaseId &&
    lease.taskId === record.taskId &&
    lease.role === "reviewer" &&
    lease.outcome === record.outcome,
);
const reviewLease =
  activeReviewLease?.leaseId === record.reviewLeaseId
    ? activeReviewLease
    : archivedReviewLeaseEntries[0]?.value;
assert(reviewLease, "Matching active or archived review lease not found");
if (!activeReviewLease || activeReviewLease.leaseId !== record.reviewLeaseId) {
  assert(
    await isNonEmptyFile(
      join(
        stateRoot,
        "leases",
        "archive",
        `${archivedReviewLeaseEntries[0].name}.original`,
      ),
    ),
    "Archived review lease is missing its original active lease record",
  );
}
assert(reviewLease.status === "ACTIVE" || reviewLease.status === "RELEASED", "Invalid review lease status");
assert(reviewLease.taskId === record.taskId, "Review lease task does not match failure record");
assert(reviewLease.implementationLeaseId === record.implementationLeaseId, "Implementation lease link mismatch");
assert(reviewLease.agentSession === record.reviewerSession, "Reviewer session does not match review lease");
assert(reviewLease.fixedCommitSha === record.fixedCommitSha, "Review lease SHA does not match failure record");

const leaseStartedAt = Date.parse(reviewLease.startedAt);
const leaseExpiresAt = Date.parse(reviewLease.expiresAt);
assert(
  leaseStartedAt <= testStartedAt && testedAt <= leaseExpiresAt,
  "Review interval must be inside the active lease interval",
);

const implementationLeaseEntries = (await readJsonEntries(
  join(stateRoot, "leases", "archive"),
)).filter(
  ({ value: lease }) =>
    lease.leaseId === record.implementationLeaseId &&
    lease.taskId === record.taskId &&
    lease.role === "implementer" &&
    lease.outcome === "SELF_TESTED",
);
const implementationLease = implementationLeaseEntries[0]?.value;
assert(implementationLease, "Matching SELF_TESTED implementation lease not found");
assert(
  await isNonEmptyFile(
    join(
      stateRoot,
      "leases",
      "archive",
      `${implementationLeaseEntries[0].name}.original`,
    ),
  ),
  "Archived SELF_TESTED implementation lease is missing its original active lease record",
);
assert(implementationLease.agentSession === record.implementerSession, "Implementer session does not match archived lease");
assert(implementationLease.fixedCommitSha === record.fixedCommitSha, "Implementation lease SHA does not match failure record");
assert(
  Date.parse(implementationLease.releasedAt) <= leaseStartedAt,
  "Review lease started before implementation SELF_TESTED release",
);

const evidenceDir = await realpath(resolve(record.evidencePath ?? ""));
const reviewsRoot = await realpath(join(stateRoot, "reviews"));
assert(evidenceDir.startsWith(`${reviewsRoot}/`), "Failure evidence must be in the shared reviews directory");
assert(evidenceDir === join(reviewsRoot, record.gateId), "Evidence directory must be reviews/<gateId>");
assert(evidenceDir === dirname(recordPath), "Evidence path must contain failure-record.json");

for (const relativePath of ["summary.md", "checks.json", "commands.log"]) {
  assert(await isNonEmptyFile(join(evidenceDir, relativePath)), `Missing or empty evidence: ${relativePath}`);
}
for (const successRecord of ["governance-verdict.json", "review-verdict.json"]) {
  assert(!(await stat(join(evidenceDir, successRecord)).catch(() => null)), `Failure evidence must not contain ${successRecord}`);
}

const checks = JSON.parse(await readFile(join(evidenceDir, "checks.json"), "utf8"));
assert(checks.taskId === record.taskId, "checks.json taskId does not match failure record");
assert(checks.fixedCommitSha === record.fixedCommitSha, "checks.json SHA does not match failure record");
assert(Array.isArray(checks.checks) && checks.checks.length > 0, "checks.json checks must be a non-empty array");
const checkIds = uniqueStringList(checks.checks.map((check) => check?.id), "checks.json check IDs", {
  nonEmpty: true,
});
assert(
  checks.checks.every((check) => check && ["PASS", "FAIL", "BLOCKED"].includes(check.result)),
  "checks.json results must be PASS, FAIL, or BLOCKED",
);
const failedIds = uniqueStringList(
  checks.checks.filter((check) => check.result === "FAIL").map((check) => check.id),
  "checks.json failed IDs",
);
const blockedIds = uniqueStringList(
  checks.checks.filter((check) => check.result === "BLOCKED").map((check) => check.id),
  "checks.json blocked IDs",
);
assert(checkIds.length === checks.checks.length, "checks.json check IDs must be unique");
sameSet(failedChecks, failedIds, "failedChecks");
sameSet(blockedChecks, blockedIds, "blockedChecks");

process.stdout.write(`Review failure record is valid: ${record.outcome}\n`);
