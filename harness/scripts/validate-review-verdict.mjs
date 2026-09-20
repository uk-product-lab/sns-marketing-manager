import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function hasFile(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await hasFile(resolve(path, entry.name)))) return true;
  }
  return false;
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

function sameStringSet(actual, expected, field) {
  assert(Array.isArray(actual), `${field} must be an array`);
  assert(actual.every((value) => typeof value === "string"), `${field} must contain strings`);
  const actualSorted = [...new Set(actual)].sort();
  const expectedSorted = [...new Set(expected)].sort();
  assert(
    JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
    `${field} does not match REQUIRED regression manifest`,
  );
}

const { verdictFile, args } = parseArgs(process.argv.slice(2));
assert(
  verdictFile && args["project-root"] && args["state-root"],
  "Usage: node validate-review-verdict.mjs <review-verdict.json> --project-root <review worktree> --state-root <shared state root>",
);

const verdictPath = resolve(verdictFile);
const projectRoot = await realpath(resolve(args["project-root"]));
const stateRoot = await realpath(resolve(args["state-root"]));
const verdict = JSON.parse(await readFile(verdictPath, "utf8"));

assert(/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(verdict.gateId ?? ""), "Invalid gateId");
assert(/^[A-Z][A-Z0-9-]{2,50}$/.test(verdict.taskId ?? ""), "Invalid taskId");
assert(Number.isInteger(verdict.pullRequest) && verdict.pullRequest > 0, "Invalid pullRequest");
assert(/^[a-f0-9]{40}$/i.test(verdict.fixedCommitSha ?? ""), "Invalid fixedCommitSha");
assert(/^[0-9a-f-]{36}$/i.test(verdict.implementationLeaseId ?? ""), "Invalid implementationLeaseId");
assert(/^[0-9a-f-]{36}$/i.test(verdict.reviewLeaseId ?? ""), "Invalid reviewLeaseId");
assert(verdict.implementerSession, "Missing implementerSession");
assert(verdict.reviewerSession, "Missing reviewerSession");
assert(
  verdict.implementerSession !== verdict.reviewerSession,
  "Implementer and reviewer sessions must differ",
);
const testStartedAt = Date.parse(verdict.testStartedAt);
const testedAt = Date.parse(verdict.testedAt);
assert(!Number.isNaN(testStartedAt), "Invalid testStartedAt");
assert(!Number.isNaN(testedAt), "Invalid testedAt");
assert(testStartedAt <= testedAt, "testStartedAt must not be after testedAt");

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
    lease.outcome === "PASS",
);
const reviewLease =
  activeReviewLease?.leaseId === verdict.reviewLeaseId
    ? activeReviewLease
    : archivedReviewLeaseEntries[0]?.value;
assert(reviewLease, "Matching active or archived PASS review lease not found");
if (!activeReviewLease || activeReviewLease.leaseId !== verdict.reviewLeaseId) {
  assert(
    await exists(
      join(
        stateRoot,
        "leases",
        "archive",
        `${archivedReviewLeaseEntries[0].name}.original`,
      ),
    ),
    "Archived PASS review lease is missing its original active lease record",
  );
}
assert(
  reviewLease.implementationLeaseId === verdict.implementationLeaseId,
  "Implementation lease link mismatch",
);
assert(
  reviewLease.agentSession === verdict.reviewerSession,
  "Reviewer session does not match review lease",
);
assert(
  reviewLease.fixedCommitSha === verdict.fixedCommitSha,
  "Review lease SHA does not match verdict SHA",
);
const leaseStartedAt = Date.parse(reviewLease.startedAt);
const leaseExpiresAt = Date.parse(reviewLease.expiresAt);
assert(
  leaseStartedAt <= testStartedAt && testedAt <= leaseExpiresAt,
  "Review test interval must be inside the active lease interval",
);
assert(testedAt <= Date.now() + 60_000, "testedAt must not be in the future");

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
  await exists(
    join(
      stateRoot,
      "leases",
      "archive",
      `${implementationLeaseEntries[0].name}.original`,
    ),
  ),
  "Archived SELF_TESTED implementation lease is missing its original active lease record",
);
assert(
  implementationLease.agentSession === verdict.implementerSession,
  "Implementer session does not match archived lease",
);
assert(
  implementationLease.fixedCommitSha === verdict.fixedCommitSha,
  "Implementation lease SHA does not match verdict SHA",
);
assert(
  Date.parse(implementationLease.releasedAt) <= leaseStartedAt,
  "Review lease started before implementation SELF_TESTED release",
);

const recommendationByVerdict = {
  PASS: "MERGE_CANDIDATE",
  FAIL: "RETURN_TO_IMPLEMENTER",
  BLOCKED: "WAIT",
};
assert(
  recommendationByVerdict[verdict.verdict] === verdict.recommendation,
  "Verdict and recommendation conflict",
);

for (const field of ["requiredTestCount", "passedTestCount", "skippedTestCount"]) {
  assert(Number.isInteger(verdict[field]) && verdict[field] >= 0, `Invalid ${field}`);
}

const manifest = await readFile(
  join(projectRoot, "harness", "regression_manifest.md"),
  "utf8",
);
const requiredRegressionIds = [...manifest.matchAll(
  /^\|\s*(REG-[A-Z0-9-]+)\s*\|\s*REQUIRED\s*\|/gm,
)].map((match) => match[1]);
sameStringSet(verdict.requiredRegressionIds, requiredRegressionIds, "requiredRegressionIds");
sameStringSet(verdict.executedRegressionIds, requiredRegressionIds, "executedRegressionIds");

if (verdict.verdict === "PASS") {
  assert(verdict.requiredTestCount > 0, "PASS requires at least one required test");
  assert(
    verdict.passedTestCount === verdict.requiredTestCount,
    "PASS requires all required tests to pass",
  );
  assert(verdict.skippedTestCount === 0, "PASS requires zero skipped tests");

  const evidenceDir = await realpath(resolve(verdict.evidencePath ?? ""));
  const reviewsRoot = await realpath(join(stateRoot, "reviews"));
  assert(
    evidenceDir.startsWith(`${reviewsRoot}/`),
    "PASS evidence must be in the shared Git common state reviews directory",
  );
  assert(evidenceDir === dirname(verdictPath), "Evidence path must contain review-verdict.json");
  assert(
    evidenceDir === join(reviewsRoot, verdict.gateId),
    "Evidence directory must be reviews/<gateId>",
  );

  const requiredFiles = [
    "summary.md",
    "test-results.xml",
    "console.log",
    "network.log",
    "accessibility.json",
    "environment.json",
  ];
  for (const relativePath of requiredFiles) {
    assert(await exists(resolve(evidenceDir, relativePath)), `Missing evidence: ${relativePath}`);
  }

  const requiredDirectories = [
    "playwright-report",
    "screenshots/mac",
    "screenshots/iphone",
    "traces",
  ];
  for (const relativePath of requiredDirectories) {
    const fullPath = resolve(evidenceDir, relativePath);
    assert(await exists(fullPath), `Missing evidence directory: ${relativePath}`);
    assert(await hasFile(fullPath), `Empty evidence directory: ${relativePath}`);
  }

  const environment = JSON.parse(
    await readFile(resolve(evidenceDir, "environment.json"), "utf8"),
  );
  assert(
    environment.fixedCommitSha === verdict.fixedCommitSha,
    "environment.json SHA does not match verdict SHA",
  );
  assert(
    environment.testStartedAt === verdict.testStartedAt &&
      environment.testedAt === verdict.testedAt,
    "environment.json test interval does not match verdict",
  );
}

process.stdout.write(`Review verdict is valid: ${verdict.verdict}\n`);
