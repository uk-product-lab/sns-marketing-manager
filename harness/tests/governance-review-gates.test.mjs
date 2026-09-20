import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(testDir, "../scripts");
const acquireScript = join(scriptsDir, "acquire-lease.mjs");
const releaseScript = join(scriptsDir, "release-lease.mjs");
const validateGovernanceScript = join(scriptsDir, "validate-governance-verdict.mjs");
const validateFailureRecordScript = join(scriptsDir, "validate-review-failure-record.mjs");

const checkProfiles = {
  DOCS_PASS: {
    name: "docs-v1",
    checks: [
      "scope-diff",
      "docs-consistency",
      "public-boundary",
      "secret-patterns",
      "source-immutability",
    ],
  },
  HARNESS_LOCAL_PASS: {
    name: "harness-local-v1",
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
    ],
  },
};

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
}

function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function expectSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, "command unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

async function createRepository() {
  const worktree = await mkdtemp(join(tmpdir(), "governance-gate-repo-"));
  await mkdir(join(worktree, "harness"), { recursive: true });
  await writeFile(
    join(worktree, "harness", "regression_manifest.md"),
    "# Regression manifest\n\nNo product scenarios are REQUIRED in this fixture.\n",
  );
  await writeFile(join(worktree, "fixture.txt"), "fixed snapshot\n");
  execFileSync("git", ["init", "-b", "codex/governance-gate-test"], { cwd: worktree });
  git(worktree, ["config", "user.name", "Harness Test"]);
  git(worktree, ["config", "user.email", "harness-test@example.invalid"]);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", "Create fixed review snapshot"]);
  return worktree;
}

async function prepareReview(outcome = "DOCS_PASS") {
  const implementationWorktree = await createRepository();
  const branch = "codex/governance-gate-test";
  const implementationSession = `implementer-${Math.random().toString(16).slice(2)}`;
  const reviewerSession = `reviewer-${Math.random().toString(16).slice(2)}`;

  const acquiredImplementation = runNode(
    acquireScript,
    [
      "--task", "TASK-TEST",
      "--role", "implementer",
      "--agent", "codex",
      "--agent-session", implementationSession,
      "--branch", branch,
      "--worktree", implementationWorktree,
    ],
    implementationWorktree,
  );
  expectSuccess(acquiredImplementation);
  const implementationLease = JSON.parse(acquiredImplementation.stdout);
  const fixedCommitSha = git(implementationWorktree, ["rev-parse", "HEAD"]);

  const releasedImplementation = runNode(
    releaseScript,
    [
      "--task", "TASK-TEST",
      "--role", "implementer",
      "--lease-id", implementationLease.leaseId,
      "--outcome", "SELF_TESTED",
      "--fixed-sha", fixedCommitSha,
      "--worktree", implementationWorktree,
      "--actor", "ceo",
    ],
    implementationWorktree,
  );
  expectSuccess(releasedImplementation);

  const reviewWorktree = `${implementationWorktree}-review`;
  execFileSync(
    "git",
    ["-C", implementationWorktree, "worktree", "add", "--detach", reviewWorktree, fixedCommitSha],
    { encoding: "utf8" },
  );
  const acquiredReview = runNode(
    acquireScript,
    [
      "--task", "TASK-TEST",
      "--role", "reviewer",
      "--agent", "claude",
      "--agent-session", reviewerSession,
      "--branch", branch,
      "--worktree", reviewWorktree,
      "--fixed-sha", fixedCommitSha,
    ],
    reviewWorktree,
  );
  expectSuccess(acquiredReview);
  const reviewLease = JSON.parse(acquiredReview.stdout);

  const gateId = `gate_${Math.random().toString(16).slice(2)}`;
  const evidencePath = join(reviewLease.stateRoot, "reviews", gateId);
  await mkdir(evidencePath, { recursive: true });
  const checkProfile = checkProfiles[outcome];
  assert(checkProfile, `Missing test check profile for ${outcome}`);
  const requiredChecks = checkProfile.checks;
  const testStartedAt = reviewLease.startedAt;
  const testedAt = new Date(Date.parse(testStartedAt) + 1).toISOString();
  const verdict = {
    gateId,
    taskId: "TASK-TEST",
    fixedCommitSha,
    implementationLeaseId: implementationLease.leaseId,
    reviewLeaseId: reviewLease.leaseId,
    implementerSession: implementationSession,
    reviewerSession,
    testStartedAt,
    testedAt,
    verdict: outcome,
    recommendation: "BOARD_REVIEW_CANDIDATE",
    checkProfile: checkProfile.name,
    requiredChecks,
    executedChecks: [...requiredChecks],
    failedChecks: [],
    evidencePath,
  };
  await writeFile(join(evidencePath, "summary.md"), "# Governance review\n\nAll scoped checks passed.\n");
  await writeFile(
    join(evidencePath, "checks.json"),
    `${JSON.stringify({
      taskId: verdict.taskId,
      fixedCommitSha,
      checks: requiredChecks.map((id) => ({ id, result: "PASS" })),
    }, null, 2)}\n`,
  );
  await writeFile(join(evidencePath, "commands.log"), "node --test\n");
  const verdictPath = join(evidencePath, "governance-verdict.json");
  await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);

  return {
    implementationWorktree,
    reviewWorktree,
    implementationLease,
    reviewLease,
    verdict,
    verdictPath,
  };
}

async function writeVerdict(fixture, transform) {
  const next = transform(structuredClone(fixture.verdict));
  await writeFile(fixture.verdictPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function writeCheckIds(fixture, ids) {
  const checksPath = join(fixture.verdict.evidencePath, "checks.json");
  const checks = JSON.parse(await readFile(checksPath, "utf8"));
  checks.checks = ids.map((id) => ({ id, result: "PASS" }));
  await writeFile(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
}

async function prepareFailureReview(outcome) {
  const fixture = await prepareReview();
  await unlink(fixture.verdictPath);
  const checkId = outcome === "FAIL" ? "docs-consistency" : "review-environment";
  const checksPath = join(fixture.verdict.evidencePath, "checks.json");
  await writeFile(
    checksPath,
    `${JSON.stringify({
      taskId: fixture.verdict.taskId,
      fixedCommitSha: fixture.verdict.fixedCommitSha,
      checks: [
        { id: "scope-diff", result: "PASS" },
        { id: checkId, result: outcome },
      ],
    }, null, 2)}\n`,
  );
  await writeFile(join(fixture.verdict.evidencePath, "commands.log"), "node --test\n");
  const failureRecord = {
    gateId: fixture.verdict.gateId,
    taskId: fixture.verdict.taskId,
    fixedCommitSha: fixture.verdict.fixedCommitSha,
    implementationLeaseId: fixture.verdict.implementationLeaseId,
    reviewLeaseId: fixture.verdict.reviewLeaseId,
    implementerSession: fixture.verdict.implementerSession,
    reviewerSession: fixture.verdict.reviewerSession,
    testStartedAt: fixture.verdict.testStartedAt,
    testedAt: fixture.verdict.testedAt,
    outcome,
    recommendation: outcome === "FAIL" ? "RETURN_TO_IMPLEMENTER" : "WAIT",
    failedChecks: outcome === "FAIL" ? [checkId] : [],
    blockedChecks: outcome === "BLOCKED" ? [checkId] : [],
    blockedReasons: outcome === "BLOCKED" ? ["Required review environment was unavailable"] : [],
    evidencePath: fixture.verdict.evidencePath,
  };
  const failureRecordPath = join(fixture.verdict.evidencePath, "failure-record.json");
  await writeFile(failureRecordPath, `${JSON.stringify(failureRecord, null, 2)}\n`);
  return { ...fixture, failureRecord, failureRecordPath };
}

async function writeFailureRecord(fixture, transform) {
  fixture.failureRecord = transform(structuredClone(fixture.failureRecord));
  await writeFile(
    fixture.failureRecordPath,
    `${JSON.stringify(fixture.failureRecord, null, 2)}\n`,
  );
}

function validateGovernance(fixture) {
  return runNode(
    validateGovernanceScript,
    [fixture.verdictPath, "--state-root", fixture.reviewLease.stateRoot],
    fixture.reviewWorktree,
  );
}

function validateFailureRecord(fixture) {
  return runNode(
    validateFailureRecordScript,
    [fixture.failureRecordPath, "--state-root", fixture.reviewLease.stateRoot],
    fixture.reviewWorktree,
  );
}

function releaseReview(fixture, outcome, includeVerdict = true) {
  const args = [
    "--task", "TASK-TEST",
    "--role", "reviewer",
    "--lease-id", fixture.reviewLease.leaseId,
    "--outcome", outcome,
    "--worktree", fixture.reviewWorktree,
    "--actor", "ceo",
  ];
  if (includeVerdict) args.push("--verdict-file", fixture.verdictPath);
  return runNode(releaseScript, args, fixture.reviewWorktree);
}

function releaseFailure(fixture, outcome, includeRecord = true) {
  const args = [
    "--task", "TASK-TEST",
    "--role", "reviewer",
    "--lease-id", fixture.reviewLease.leaseId,
    "--outcome", outcome,
    "--worktree", fixture.reviewWorktree,
    "--actor", "ceo",
  ];
  if (includeRecord) args.push("--failure-record", fixture.failureRecordPath);
  return runNode(releaseScript, args, fixture.reviewWorktree);
}

for (const outcome of ["DOCS_PASS", "HARNESS_LOCAL_PASS"]) {
  test(`${outcome} releases a clean fixed SHA without an origin remote`, async () => {
    const fixture = await prepareReview(outcome);
    assert.equal(git(fixture.reviewWorktree, ["remote"]), "");
    const released = releaseReview(fixture, outcome);
    expectSuccess(released);
    assert.match(released.stdout, new RegExp(`Governance verdict is valid: ${outcome}`));

    const archivedValidation = validateGovernance(fixture);
    expectSuccess(archivedValidation);
  });
}

test("FAIL and BLOCKED require validated failure evidence", async (t) => {
  for (const outcome of ["FAIL", "BLOCKED"]) {
    await t.test(outcome, async () => {
      const fixture = await prepareFailureReview(outcome);
      expectSuccess(validateFailureRecord(fixture));
      const released = releaseFailure(fixture, outcome);
      expectSuccess(released);
      assert.match(released.stdout, new RegExp(`Review failure record is valid: ${outcome}`));
      expectSuccess(validateFailureRecord(fixture));
    });
  }
});

test("reviewer failure release rejects missing or invalid failure evidence", async (t) => {
  await t.test("missing failure record", async () => {
    const fixture = await prepareFailureReview("FAIL");
    expectFailure(releaseFailure(fixture, "FAIL", false), /Reviewer FAIL requires --failure-record/);
  });

  await t.test("outcome mismatch", async () => {
    const fixture = await prepareFailureReview("FAIL");
    expectFailure(releaseFailure(fixture, "BLOCKED"), /Failure record does not match the review lease and outcome|Failure outcome and recommendation conflict/);
  });

  await t.test("missing commands log", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await unlink(join(fixture.failureRecord.evidencePath, "commands.log"));
    expectFailure(releaseFailure(fixture, "FAIL"), /Missing or empty evidence: commands\.log/);
  });

  await t.test("empty summary", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await writeFile(join(fixture.failureRecord.evidencePath, "summary.md"), "");
    expectFailure(releaseFailure(fixture, "FAIL"), /Missing or empty evidence: summary\.md/);
  });

  await t.test("success verdict present", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await writeFile(join(fixture.failureRecord.evidencePath, "governance-verdict.json"), "{}\n");
    expectFailure(releaseFailure(fixture, "FAIL"), /must not contain governance-verdict\.json/);
  });

  await t.test("failed check mismatch", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await writeFailureRecord(fixture, (record) => ({ ...record, failedChecks: ["scope-diff"] }));
    expectFailure(releaseFailure(fixture, "FAIL"), /failedChecks does not match checks\.json/);
  });

  await t.test("blocked reason omitted", async () => {
    const fixture = await prepareFailureReview("BLOCKED");
    await writeFailureRecord(fixture, (record) => ({ ...record, blockedReasons: [] }));
    expectFailure(releaseFailure(fixture, "BLOCKED"), /BLOCKED requires at least one blocked reason/);
  });
});

test("reviewer failure release requires a clean unchanged fixed snapshot", async (t) => {
  await t.test("dirty worktree", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await writeFile(join(fixture.reviewWorktree, "untracked.txt"), "dirty\n");
    expectFailure(releaseFailure(fixture, "FAIL"), /Worktree must be clean/);
  });

  await t.test("changed HEAD", async () => {
    const fixture = await prepareFailureReview("FAIL");
    await writeFile(join(fixture.reviewWorktree, "fixture.txt"), "changed snapshot\n");
    git(fixture.reviewWorktree, ["add", "fixture.txt"]);
    git(fixture.reviewWorktree, ["commit", "-m", "Change reviewed snapshot"]);
    expectFailure(
      releaseFailure(fixture, "FAIL"),
      /Reviewer worktree HEAD changed after review started/,
    );
  });
});

test("product PASS still requires product evidence and a current GitHub PR head", async () => {
  const fixture = await prepareReview();
  const evidencePath = fixture.verdict.evidencePath;
  for (const file of [
    "test-results.xml",
    "console.log",
    "network.log",
    "accessibility.json",
  ]) {
    await writeFile(join(evidencePath, file), file === "accessibility.json" ? "{}\n" : "ok\n");
  }
  for (const directory of [
    "playwright-report",
    "screenshots/mac",
    "screenshots/iphone",
    "traces",
  ]) {
    await mkdir(join(evidencePath, directory), { recursive: true });
    await writeFile(join(evidencePath, directory, "evidence.txt"), "evidence\n");
  }
  await writeFile(
    join(evidencePath, "environment.json"),
    `${JSON.stringify({
      fixedCommitSha: fixture.verdict.fixedCommitSha,
      testStartedAt: fixture.verdict.testStartedAt,
      testedAt: fixture.verdict.testedAt,
    })}\n`,
  );
  await writeVerdict(fixture, (verdict) => ({
    gateId: verdict.gateId,
    taskId: verdict.taskId,
    pullRequest: 1,
    fixedCommitSha: verdict.fixedCommitSha,
    implementationLeaseId: verdict.implementationLeaseId,
    reviewLeaseId: verdict.reviewLeaseId,
    implementerSession: verdict.implementerSession,
    reviewerSession: verdict.reviewerSession,
    testStartedAt: verdict.testStartedAt,
    testedAt: verdict.testedAt,
    verdict: "PASS",
    recommendation: "MERGE_CANDIDATE",
    requiredTestCount: 1,
    passedTestCount: 1,
    skippedTestCount: 0,
    requiredRegressionIds: [],
    executedRegressionIds: [],
    evidencePath: verdict.evidencePath,
  }));

  expectFailure(releaseReview(fixture, "PASS"), /Cannot verify current GitHub PR head/);
});

test("local governance passes require a dedicated matching verdict file", async (t) => {
  await t.test("missing verdict", async () => {
    const fixture = await prepareReview();
    expectFailure(
      releaseReview(fixture, "DOCS_PASS", false),
      /Reviewer DOCS_PASS requires --verdict-file/,
    );
  });

  await t.test("outcome mismatch", async () => {
    const fixture = await prepareReview("DOCS_PASS");
    expectFailure(
      releaseReview(fixture, "HARNESS_LOCAL_PASS"),
      /Governance verdict outcome does not match lease outcome/,
    );
  });
});

const invalidVerdicts = [
  ["missing checkProfile", (v) => {
    const { checkProfile, ...withoutProfile } = v;
    return withoutProfile;
  }, /Missing checkProfile/],
  ["empty requiredChecks", (v) => ({ ...v, requiredChecks: [], executedChecks: [] }), /requiredChecks must not be empty/],
  ["duplicate requiredChecks", (v) => ({ ...v, requiredChecks: ["same", "same"], executedChecks: ["same"] }), /requiredChecks must not contain duplicates/],
  ["executed set mismatch", (v) => ({ ...v, executedChecks: ["docs-consistency"] }), /executedChecks must match trusted checkProfile docs-v1 exactly/],
  ["failed check", (v) => ({ ...v, failedChecks: ["script-tests"] }), /zero failedChecks/],
  ["wrong recommendation", (v) => ({ ...v, recommendation: "MERGE_CANDIDATE" }), /Verdict and recommendation conflict/],
  ["same sessions", (v) => ({ ...v, reviewerSession: v.implementerSession }), /sessions must differ/],
  ["wrong fixed SHA", (v) => ({ ...v, fixedCommitSha: "0".repeat(40) }), /Review lease SHA does not match/],
  ["wrong implementation lease", (v) => ({ ...v, implementationLeaseId: "00000000-0000-4000-8000-000000000000" }), /Implementation lease link mismatch/],
  ["test before lease", (v) => ({ ...v, testStartedAt: "2000-01-01T00:00:00.000Z" }), /inside the active lease interval/],
];

for (const [name, mutate, expected] of invalidVerdicts) {
  test(`governance validator rejects ${name}`, async () => {
    const fixture = await prepareReview();
    await writeVerdict(fixture, mutate);
    expectFailure(validateGovernance(fixture), expected);
  });
}


test("validator rejects a self-declared placeholder-only check set", async () => {
  const fixture = await prepareReview();
  const attackerChecks = ["placeholder"];
  await writeVerdict(fixture, (verdict) => ({
    ...verdict,
    requiredChecks: attackerChecks,
    executedChecks: attackerChecks,
  }));
  await writeCheckIds(fixture, attackerChecks);
  expectFailure(
    validateGovernance(fixture),
    /requiredChecks must match trusted checkProfile docs-v1 exactly/,
  );
});

test("validator rejects a trusted profile with one check missing", async () => {
  const fixture = await prepareReview();
  const incompleteChecks = checkProfiles.DOCS_PASS.checks.slice(0, -1);
  await writeVerdict(fixture, (verdict) => ({
    ...verdict,
    requiredChecks: incompleteChecks,
    executedChecks: incompleteChecks,
  }));
  await writeCheckIds(fixture, incompleteChecks);
  expectFailure(
    validateGovernance(fixture),
    /requiredChecks must match trusted checkProfile docs-v1 exactly/,
  );
});

test("validator rejects a trusted profile with an extra check", async () => {
  const fixture = await prepareReview();
  const expandedChecks = [...checkProfiles.DOCS_PASS.checks, "untrusted-extra"];
  await writeVerdict(fixture, (verdict) => ({
    ...verdict,
    requiredChecks: expandedChecks,
    executedChecks: expandedChecks,
  }));
  await writeCheckIds(fixture, expandedChecks);
  expectFailure(
    validateGovernance(fixture),
    /requiredChecks must match trusted checkProfile docs-v1 exactly/,
  );
});

test("validator rejects checks.json IDs that omit a trusted check", async () => {
  const fixture = await prepareReview();
  await writeCheckIds(fixture, checkProfiles.DOCS_PASS.checks.slice(0, -1));
  expectFailure(
    validateGovernance(fixture),
    /checks\.json check IDs must match trusted checkProfile docs-v1 exactly/,
  );
});

test("validator rejects an unknown check profile", async () => {
  const fixture = await prepareReview();
  await writeVerdict(fixture, (verdict) => ({
    ...verdict,
    checkProfile: "attacker-v1",
  }));
  expectFailure(validateGovernance(fixture), /Unknown checkProfile: attacker-v1/);
});

test("validator rejects a verdict and check profile mismatch", async () => {
  const fixture = await prepareReview("DOCS_PASS");
  await writeVerdict(fixture, (verdict) => ({
    ...verdict,
    checkProfile: "harness-local-v1",
  }));
  expectFailure(
    validateGovernance(fixture),
    /checkProfile harness-local-v1 is not valid for DOCS_PASS/,
  );
});

const releasePathInvalidCases = [
  {
    name: "placeholder-only check set",
    mutate: async (fixture) => {
      const ids = ["placeholder"];
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        requiredChecks: ids,
        executedChecks: ids,
      }));
      await writeCheckIds(fixture, ids);
    },
    expected: (profile) => new RegExp(`requiredChecks must match trusted checkProfile ${profile} exactly`),
  },
  {
    name: "missing trusted check",
    mutate: async (fixture, profile) => {
      const ids = profile.checks.slice(0, -1);
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        requiredChecks: ids,
        executedChecks: ids,
      }));
      await writeCheckIds(fixture, ids);
    },
    expected: (profile) => new RegExp(`requiredChecks must match trusted checkProfile ${profile} exactly`),
  },
  {
    name: "extra untrusted check",
    mutate: async (fixture, profile) => {
      const ids = [...profile.checks, "untrusted-extra"];
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        requiredChecks: ids,
        executedChecks: ids,
      }));
      await writeCheckIds(fixture, ids);
    },
    expected: (profile) => new RegExp(`requiredChecks must match trusted checkProfile ${profile} exactly`),
  },
  {
    name: "unknown check profile",
    mutate: async (fixture) => {
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        checkProfile: "unknown-v1",
      }));
    },
    expected: () => /Unknown checkProfile: unknown-v1/,
  },
  {
    name: "outcome and profile mismatch",
    mutate: async (fixture, profile, outcome) => {
      const otherProfile = outcome === "DOCS_PASS" ? "harness-local-v1" : "docs-v1";
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        checkProfile: otherProfile,
      }));
    },
    expected: (_profile, outcome) => new RegExp(`is not valid for ${outcome}`),
  },
  {
    name: "executed check set mismatch",
    mutate: async (fixture, profile) => {
      await writeVerdict(fixture, (verdict) => ({
        ...verdict,
        executedChecks: profile.checks.slice(0, -1),
      }));
    },
    expected: (profile) => new RegExp(`executedChecks must match trusted checkProfile ${profile} exactly`),
  },
  {
    name: "evidence check ID mismatch",
    mutate: async (fixture, profile) => {
      await writeCheckIds(fixture, profile.checks.slice(0, -1));
    },
    expected: (profile) => new RegExp(`checks\\.json check IDs must match trusted checkProfile ${profile} exactly`),
  },
];

for (const outcome of ["DOCS_PASS", "HARNESS_LOCAL_PASS"]) {
  test(`release-lease rejects invalid ${outcome} profile evidence`, async (t) => {
    for (const invalidCase of releasePathInvalidCases) {
      await t.test(invalidCase.name, async () => {
        const fixture = await prepareReview(outcome);
        const profile = checkProfiles[outcome];
        await invalidCase.mutate(fixture, profile, outcome);
        expectFailure(
          releaseReview(fixture, outcome),
          invalidCase.expected(profile.name, outcome),
        );
      });
    }
  });
}

test("validator rejects evidence outside stateRoot/reviews/<gateId>", async () => {
  const fixture = await prepareReview();
  const wrongEvidence = join(fixture.reviewLease.stateRoot, "outside-reviews");
  await mkdir(wrongEvidence, { recursive: true });
  await writeFile(join(wrongEvidence, "summary.md"), "summary\n");
  await writeFile(
    join(wrongEvidence, "checks.json"),
    await readFile(join(fixture.verdict.evidencePath, "checks.json"), "utf8"),
  );
  const verdict = { ...fixture.verdict, evidencePath: wrongEvidence };
  const wrongVerdictPath = join(wrongEvidence, "governance-verdict.json");
  await writeFile(wrongVerdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  fixture.verdictPath = wrongVerdictPath;
  expectFailure(validateGovernance(fixture), /shared reviews directory/);
});

for (const missingFile of ["summary.md", "checks.json", "commands.log"]) {
  test(`validator rejects missing ${missingFile}`, async () => {
    const fixture = await prepareReview();
    await unlink(join(fixture.verdict.evidencePath, missingFile));
    expectFailure(validateGovernance(fixture), new RegExp(`Missing or empty evidence: ${missingFile.replace(".", "\\.")}`));
  });
}

test("validator rejects a non-PASS check result", async () => {
  const fixture = await prepareReview();
  const checksPath = join(fixture.verdict.evidencePath, "checks.json");
  const checks = JSON.parse(await readFile(checksPath, "utf8"));
  checks.checks[0].result = "FAIL";
  await writeFile(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
  expectFailure(validateGovernance(fixture), /Every checks\.json result must be PASS/);
});

test("local governance pass requires a clean unchanged reviewer worktree", async (t) => {
  await t.test("dirty worktree", async () => {
    const fixture = await prepareReview();
    await writeFile(join(fixture.reviewWorktree, "untracked.txt"), "dirty\n");
    expectFailure(releaseReview(fixture, "DOCS_PASS"), /Worktree must be clean/);
  });

  await t.test("changed HEAD", async () => {
    const fixture = await prepareReview();
    await writeFile(join(fixture.reviewWorktree, "fixture.txt"), "changed snapshot\n");
    git(fixture.reviewWorktree, ["add", "fixture.txt"]);
    git(fixture.reviewWorktree, ["commit", "-m", "Change reviewed snapshot"]);
    expectFailure(
      releaseReview(fixture, "DOCS_PASS"),
      /Reviewer worktree HEAD changed after review started/,
    );
  });
});

test("reviewer acquisition rejects the implementation session", async () => {
  const implementationWorktree = await createRepository();
  const session = "same-session-forbidden";
  const acquired = runNode(
    acquireScript,
    [
      "--task", "TASK-TEST",
      "--role", "implementer",
      "--agent", "codex",
      "--agent-session", session,
      "--branch", "codex/governance-gate-test",
      "--worktree", implementationWorktree,
    ],
    implementationWorktree,
  );
  expectSuccess(acquired);
  const implementationLease = JSON.parse(acquired.stdout);
  const fixedCommitSha = git(implementationWorktree, ["rev-parse", "HEAD"]);
  expectSuccess(
    runNode(
      releaseScript,
      [
        "--task", "TASK-TEST",
        "--role", "implementer",
        "--lease-id", implementationLease.leaseId,
        "--outcome", "SELF_TESTED",
        "--fixed-sha", fixedCommitSha,
        "--worktree", implementationWorktree,
        "--actor", "ceo",
      ],
      implementationWorktree,
    ),
  );
  const reviewWorktree = `${implementationWorktree}-review`;
  execFileSync(
    "git",
    ["-C", implementationWorktree, "worktree", "add", "--detach", reviewWorktree, fixedCommitSha],
  );
  expectFailure(
    runNode(
      acquireScript,
      [
        "--task", "TASK-TEST",
        "--role", "reviewer",
        "--agent", "claude",
        "--agent-session", session,
        "--branch", "codex/governance-gate-test",
        "--worktree", reviewWorktree,
        "--fixed-sha", fixedCommitSha,
      ],
      reviewWorktree,
    ),
    /Reviewer session must differ from implementer session/,
  );
});
