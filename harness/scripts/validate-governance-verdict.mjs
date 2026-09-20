import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const verdictFile = argv[0];
  const args = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
  }
  return { verdictFile, args };
}

async function existsFile(path) {
  return stat(path).then((entry) => entry.isFile()).catch(() => false);
}

async function isNonEmptyFile(path) {
  return stat(path).then((entry) => entry.isFile() && entry.size > 0).catch(() => false);
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

function uniqueStringList(value, field, { nonEmpty = false } = {}) {
  assert(Array.isArray(value), `${field} must be an array`);
  assert(value.every((item) => typeof item === "string" && item.length > 0), `${field} must contain non-empty strings`);
  assert(new Set(value).size === value.length, `${field} must not contain duplicates`);
  if (nonEmpty) assert(value.length > 0, `${field} must not be empty`);
  return [...value].sort();
}

function sameSet(actual, expected, field, authority) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${field} must match ${authority} exactly`,
  );
}

const trustedCheckProfiles = new Map([
  [
    "docs-v1",
    {
      verdict: "DOCS_PASS",
      checks: [
        "scope-diff",
        "docs-consistency",
        "public-boundary",
        "secret-patterns",
        "source-immutability",
      ].sort(),
    },
  ],
  [
    "harness-local-v1",
    {
      verdict: "HARNESS_LOCAL_PASS",
      checks: [
        "scope-diff",
        "docs-consistency",
        "node-syntax",
        "harness-tests",
        "workflow-yaml",
        "workflow-embedded-js",
        "action-pins",
        "skill-validation",
        "governance-diff-policy",
        "public-boundary",
        "secret-patterns",
        "source-immutability",
      ].sort(),
    },
  ],
]);

const { verdictFile, args } = parseArgs(process.argv.slice(2));
assert(
  verdictFile && args["state-root"],
  "Usage: node validate-governance-verdict.mjs <governance-verdict.json> --state-root <shared state root>",
);

const verdictPath = await realpath(resolve(verdictFile));
const stateRoot = await realpath(resolve(args["state-root"]));
const verdict = JSON.parse(await readFile(verdictPath, "utf8"));

assert(basename(verdictPath) === "governance-verdict.json", "Governance verdict filename must be governance-verdict.json");
assert(/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(verdict.gateId ?? ""), "Invalid gateId");
assert(/^[A-Z][A-Z0-9-]{2,50}$/.test(verdict.taskId ?? ""), "Invalid taskId");
assert(/^[a-f0-9]{40}$/i.test(verdict.fixedCommitSha ?? ""), "Invalid fixedCommitSha");
assert(/^[0-9a-f-]{36}$/i.test(verdict.implementationLeaseId ?? ""), "Invalid implementationLeaseId");
assert(/^[0-9a-f-]{36}$/i.test(verdict.reviewLeaseId ?? ""), "Invalid reviewLeaseId");
assert(typeof verdict.implementerSession === "string" && verdict.implementerSession.length > 0, "Missing implementerSession");
assert(typeof verdict.reviewerSession === "string" && verdict.reviewerSession.length > 0, "Missing reviewerSession");
assert(verdict.implementerSession !== verdict.reviewerSession, "Implementer and reviewer sessions must differ");

const recommendationByVerdict = {
  DOCS_PASS: "BOARD_REVIEW_CANDIDATE",
  HARNESS_LOCAL_PASS: "BOARD_REVIEW_CANDIDATE",
};
assert(
  recommendationByVerdict[verdict.verdict] === verdict.recommendation,
  "Verdict and recommendation conflict",
);

assert(
  typeof verdict.checkProfile === "string" && verdict.checkProfile.length > 0,
  "Missing checkProfile",
);
const checkProfile = trustedCheckProfiles.get(verdict.checkProfile);
assert(checkProfile, `Unknown checkProfile: ${verdict.checkProfile}`);
assert(
  checkProfile.verdict === verdict.verdict,
  `checkProfile ${verdict.checkProfile} is not valid for ${verdict.verdict}`,
);
const profileAuthority = `trusted checkProfile ${verdict.checkProfile}`;

const requiredChecks = uniqueStringList(verdict.requiredChecks, "requiredChecks", {
  nonEmpty: true,
});
const executedChecks = uniqueStringList(verdict.executedChecks, "executedChecks");
sameSet(requiredChecks, checkProfile.checks, "requiredChecks", profileAuthority);
sameSet(executedChecks, checkProfile.checks, "executedChecks", profileAuthority);
assert(Array.isArray(verdict.failedChecks), "failedChecks must be an array");
assert(verdict.failedChecks.length === 0, "Successful governance verdict requires zero failedChecks");

const testStartedAt = Date.parse(verdict.testStartedAt);
const testedAt = Date.parse(verdict.testedAt);
assert(!Number.isNaN(testStartedAt), "Invalid testStartedAt");
assert(!Number.isNaN(testedAt), "Invalid testedAt");
assert(testStartedAt <= testedAt, "testStartedAt must not be after testedAt");
assert(testedAt <= Date.now() + 60_000, "testedAt must not be in the future");

const activeReviewLease = await readFile(
  join(stateRoot, "leases", "active", `${verdict.taskId}.reviewer.json`),
  "utf8",
)
  .then((text) => JSON.parse(text))
  .catch(() => null);
const archivedReviewLeaseEntries = (await readJsonEntries(
  join(stateRoot, "leases", "archive"),
)).filter(
  ({ value: lease }) =>
    lease.leaseId === verdict.reviewLeaseId &&
    lease.taskId === verdict.taskId &&
    lease.role === "reviewer" &&
    lease.outcome === verdict.verdict,
);
const reviewLease =
  activeReviewLease?.leaseId === verdict.reviewLeaseId
    ? activeReviewLease
    : archivedReviewLeaseEntries[0]?.value;
assert(reviewLease, "Matching active or archived governance review lease not found");
if (!activeReviewLease || activeReviewLease.leaseId !== verdict.reviewLeaseId) {
  assert(
    await existsFile(
      join(
        stateRoot,
        "leases",
        "archive",
        `${archivedReviewLeaseEntries[0].name}.original`,
      ),
    ),
    "Archived governance review lease is missing its original active lease record",
  );
}
assert(reviewLease.status === "ACTIVE" || reviewLease.status === "RELEASED", "Invalid review lease status");
assert(reviewLease.role === "reviewer", "Verdict does not reference a reviewer lease");
assert(reviewLease.taskId === verdict.taskId, "Review lease task does not match verdict");
assert(reviewLease.implementationLeaseId === verdict.implementationLeaseId, "Implementation lease link mismatch");
assert(reviewLease.agentSession === verdict.reviewerSession, "Reviewer session does not match review lease");
assert(reviewLease.fixedCommitSha === verdict.fixedCommitSha, "Review lease SHA does not match verdict SHA");

const leaseStartedAt = Date.parse(reviewLease.startedAt);
const leaseExpiresAt = Date.parse(reviewLease.expiresAt);
assert(
  leaseStartedAt <= testStartedAt && testedAt <= leaseExpiresAt,
  "Review test interval must be inside the active lease interval",
);

const implementationLeaseEntries = (await readJsonEntries(
  join(stateRoot, "leases", "archive"),
)).filter(
  ({ value: lease }) =>
    lease.leaseId === verdict.implementationLeaseId &&
    lease.taskId === verdict.taskId &&
    lease.role === "implementer" &&
    lease.outcome === "SELF_TESTED",
);
const implementationLease = implementationLeaseEntries[0]?.value;
assert(implementationLease, "Matching SELF_TESTED implementation lease not found");
assert(
  await existsFile(
    join(
      stateRoot,
      "leases",
      "archive",
      `${implementationLeaseEntries[0].name}.original`,
    ),
  ),
  "Archived SELF_TESTED implementation lease is missing its original active lease record",
);
assert(implementationLease.agentSession === verdict.implementerSession, "Implementer session does not match archived lease");
assert(implementationLease.fixedCommitSha === verdict.fixedCommitSha, "Implementation lease SHA does not match verdict SHA");
assert(
  Date.parse(implementationLease.releasedAt) <= leaseStartedAt,
  "Review lease started before implementation SELF_TESTED release",
);

const evidenceDir = await realpath(resolve(verdict.evidencePath ?? ""));
const reviewsRoot = await realpath(join(stateRoot, "reviews"));
assert(evidenceDir.startsWith(`${reviewsRoot}/`), "Governance evidence must be in the shared reviews directory");
assert(evidenceDir === join(reviewsRoot, verdict.gateId), "Evidence directory must be reviews/<gateId>");
assert(evidenceDir === dirname(verdictPath), "Evidence path must contain governance verdict JSON");

for (const relativePath of ["summary.md", "checks.json", "commands.log"]) {
  assert(await isNonEmptyFile(join(evidenceDir, relativePath)), `Missing or empty evidence: ${relativePath}`);
}

const checks = JSON.parse(await readFile(join(evidenceDir, "checks.json"), "utf8"));
assert(checks.taskId === verdict.taskId, "checks.json taskId does not match verdict");
assert(checks.fixedCommitSha === verdict.fixedCommitSha, "checks.json SHA does not match verdict");
assert(Array.isArray(checks.checks), "checks.json checks must be an array");
const checkIds = uniqueStringList(
  checks.checks.map((check) => check?.id),
  "checks.json check IDs",
);
sameSet(checkIds, checkProfile.checks, "checks.json check IDs", profileAuthority);
assert(
  checks.checks.every((check) => check && check.result === "PASS"),
  "Every checks.json result must be PASS",
);

process.stdout.write(`Governance verdict is valid: ${verdict.verdict}\n`);
