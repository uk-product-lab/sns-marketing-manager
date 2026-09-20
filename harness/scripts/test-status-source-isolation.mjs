import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const requiredContexts = [
  "governance/protected-files",
  "quality/static",
  "quality/unit",
  "quality/e2e-chromium",
  "quality/e2e-webkit-mobile",
  "quality/accessibility",
  "review/independent",
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function ghJson(parameters) {
  return JSON.parse(
    execFileSync("gh", ["api", ...parameters], { encoding: "utf8" }),
  );
}

function ghPaginatedArray(endpoint) {
  const pages = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", endpoint],
      { encoding: "utf8" },
    ),
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`Expected paginated array response: ${endpoint}`);
  }
  return pages.flat();
}

function ghGraphql(query, variables) {
  const parameters = ["graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    parameters.push("-F", `${name}=${value}`);
  }
  return ghJson(parameters);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function pullRequestWithComputedMergeability(repo, pullRequestNumber) {
  const deadline = Date.now() + 60_000;
  let pullRequest;
  while (Date.now() < deadline) {
    pullRequest = ghJson([
      `repos/${repo}/pulls/${pullRequestNumber}`,
    ]);
    if (
      pullRequest.mergeable !== null &&
      pullRequest.mergeable_state !== "unknown"
    ) {
      return pullRequest;
    }
    await delay(3_000);
  }
  throw new Error(
    `Timed out waiting for GitHub to compute PR mergeability: ${pullRequest?.mergeable_state}`,
  );
}

async function stableBlockedMergeState({
  branch,
  fixedSha,
  gatekeeperAppId,
  pullRequestNumber,
  repo,
}) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          mergeable
          mergeStateStatus
          reviewDecision
        }
      }
    }
  `;
  await delay(15_000);
  const deadline = Date.now() + 60_000;
  let consecutiveBlocked = 0;
  let lastState;
  while (Date.now() < deadline) {
    const restPullRequest = ghJson([
      `repos/${repo}/pulls/${pullRequestNumber}`,
    ]);
    const currentDefaultBranch = ghJson([
      `repos/${repo}/branches/${encodeURIComponent(branch)}`,
    ]);
    const currentReviewComments = ghJson([
      `repos/${repo}/pulls/${pullRequestNumber}/comments?per_page=100`,
    ]);
    const currentReviews = ghJson([
      `repos/${repo}/pulls/${pullRequestNumber}/reviews?per_page=100`,
    ]);
    const currentComparison = ghJson([
      `repos/${repo}/compare/${currentDefaultBranch.commit.sha}...${restPullRequest.head.sha}`,
    ]);
    if (
      restPullRequest.head.sha !== fixedSha ||
      restPullRequest.base.ref !== branch ||
      restPullRequest.base.sha !== currentDefaultBranch.commit.sha ||
      restPullRequest.draft !== false ||
      !["ahead", "identical"].includes(currentComparison.status) ||
      !Array.isArray(currentReviewComments) ||
      currentReviewComments.length !== 0 ||
      !Array.isArray(currentReviews) ||
      currentReviews.length !== 0
    ) {
      throw new Error(
        "Negative-test PR head, base, draft state, or review state changed during mergeability polling",
      );
    }
    const graphqlPullRequest = ghGraphql(query, {
      owner,
      name,
      number: pullRequestNumber,
    }).data?.repository?.pullRequest;
    lastState = {
      restMergeable: restPullRequest.mergeable,
      restMergeableState: restPullRequest.mergeable_state,
      graphqlMergeable: graphqlPullRequest?.mergeable,
      graphqlMergeStateStatus: graphqlPullRequest?.mergeStateStatus,
      graphqlReviewDecision: graphqlPullRequest?.reviewDecision,
      fixedShaStillCurrent: restPullRequest.head.sha === fixedSha,
      defaultBranchSha: currentDefaultBranch.commit.sha,
      comparisonStatus: currentComparison.status,
      reviewCommentCount: currentReviewComments.length,
      reviewDecisionCount: currentReviews.length,
    };
    if (graphqlPullRequest?.reviewDecision !== null) {
      throw new Error("Negative-test PR gained a review decision during polling");
    }
    if (
      restPullRequest.mergeable === true &&
      restPullRequest.mergeable_state === "blocked" &&
      graphqlPullRequest?.mergeable === "MERGEABLE" &&
      graphqlPullRequest?.mergeStateStatus === "BLOCKED"
    ) {
      consecutiveBlocked += 1;
      if (consecutiveBlocked >= 3) {
        return { ...lastState, consecutiveBlockedPolls: consecutiveBlocked };
      }
    } else if (
      restPullRequest.mergeable !== null &&
      restPullRequest.mergeable_state !== "unknown" &&
      graphqlPullRequest?.mergeable &&
      graphqlPullRequest.mergeable !== "UNKNOWN" &&
      graphqlPullRequest?.mergeStateStatus &&
      graphqlPullRequest.mergeStateStatus !== "UNKNOWN"
    ) {
      throw new Error(
        `Untrusted statuses changed the PR away from blocked despite Gatekeeper App ${gatekeeperAppId}: ${JSON.stringify(lastState)}`,
      );
    } else {
      consecutiveBlocked = 0;
    }
    await delay(5_000);
  }
  throw new Error(
    `Timed out waiting for three stable blocked merge-state polls: ${JSON.stringify(lastState)}`,
  );
}

const args = parseArgs(process.argv.slice(2));
for (const key of [
  "repo",
  "branch",
  "pull-request",
  "sha",
  "gatekeeper-app-id",
  "automation-login",
  "actions-canary-run-id",
  "evidence-output",
]) {
  if (!args[key]) throw new Error(`Missing --${key}`);
}
if (!/^[a-f0-9]{40}$/i.test(args.sha)) throw new Error("Invalid --sha");
const pullRequestNumber = Number(args["pull-request"]);
const gatekeeperAppId = Number(args["gatekeeper-app-id"]);
const canaryRunId = Number(args["actions-canary-run-id"]);
if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
  throw new Error("Invalid --pull-request");
}
if (!Number.isInteger(gatekeeperAppId) || gatekeeperAppId <= 0) {
  throw new Error("Invalid --gatekeeper-app-id");
}
if (!Number.isInteger(canaryRunId) || canaryRunId <= 0) {
  throw new Error("Invalid --actions-canary-run-id");
}
const authenticatedUser = ghJson(["user"]);
if (
  authenticatedUser.login?.toLowerCase() !==
  args["automation-login"].toLowerCase()
) {
  throw new Error("The active gh identity is not the declared automation identity");
}

const repository = ghJson([`repos/${args.repo}`]);
if (args.branch !== "main" || repository.default_branch !== "main") {
  throw new Error(
    `The repository default branch and --branch must both be main; received ${repository.default_branch} and ${args.branch}`,
  );
}
const [repositoryOwner, repositoryName, ...extraRepoParts] = args.repo.split("/");
if (!repositoryOwner || !repositoryName || extraRepoParts.length > 0) {
  throw new Error("--repo must use owner/name");
}

const pullRequest = await pullRequestWithComputedMergeability(
  args.repo,
  pullRequestNumber,
);
if (
  pullRequest.head.sha !== args.sha ||
  pullRequest.base.ref !== args.branch ||
  pullRequest.draft !== false ||
  pullRequest.mergeable !== true
) {
  throw new Error(
    "Negative-test PR must target the default branch, be non-draft, conflict-free, and match --sha",
  );
}
const defaultBranch = ghJson([
  `repos/${args.repo}/branches/${encodeURIComponent(args.branch)}`,
]);
if (pullRequest.base.sha !== defaultBranch.commit?.sha) {
  throw new Error("Negative-test PR base is not the current default-branch commit");
}
const comparison = ghJson([
  `repos/${args.repo}/compare/${pullRequest.base.sha}...${pullRequest.head.sha}`,
]);
if (!["ahead", "identical"].includes(comparison.status)) {
  throw new Error("Negative-test PR head is not current with the default branch");
}
const reviewComments = ghJson([
  `repos/${args.repo}/pulls/${pullRequestNumber}/comments?per_page=100`,
]);
if (!Array.isArray(reviewComments) || reviewComments.length !== 0) {
  throw new Error(
    "Negative-test PR must have no review comments or unresolved conversations",
  );
}
const reviews = ghJson([
  `repos/${args.repo}/pulls/${pullRequestNumber}/reviews?per_page=100`,
]);
if (!Array.isArray(reviews) || reviews.length !== 0) {
  throw new Error("Negative-test PR must have no review decisions");
}

const protection = ghJson([
  `repos/${args.repo}/branches/${encodeURIComponent(args.branch)}/protection`,
]);
if (protection.required_pull_request_reviews) {
  throw new Error(
    "Default branch must not add GitHub PR-review approval beside board-review Environment approval",
  );
}
const configuredChecks = protection.required_status_checks?.checks ?? [];
if (configuredChecks.length !== requiredContexts.length) {
  throw new Error("Default branch must require exactly the seven harness statuses");
}
for (const context of requiredContexts) {
  const checks = configuredChecks.filter((check) => check.context === context);
  if (checks?.length !== 1 || checks[0].app_id !== gatekeeperAppId) {
    throw new Error(`${context} is not pinned only to the Gatekeeper App`);
  }
}
const branchRuleQuery = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      branchProtectionRules(first: 10) {
        totalCount
        nodes {
          pattern
          isAdminEnforced
          lockBranch
          requireLastPushApproval
          requiredApprovingReviewCount
          requiredDeploymentEnvironments
          requiresApprovingReviews
          requiresCodeOwnerReviews
          requiresCommitSignatures
          requiresConversationResolution
          requiresDeployments
          requiresLinearHistory
          requiresStatusChecks
          requiresStrictStatusChecks
          restrictsPushes
          restrictsReviewDismissals
          bypassPullRequestAllowances(first: 1) { totalCount }
          pushAllowances(first: 1) { totalCount }
          reviewDismissalAllowances(first: 1) { totalCount }
        }
      }
    }
  }
`;
const branchRules = ghGraphql(branchRuleQuery, {
  owner: repositoryOwner,
  name: repositoryName,
}).data?.repository?.branchProtectionRules;
const branchRule = branchRules?.nodes?.[0];
if (
  branchRules?.totalCount !== 1 ||
  branchRules.nodes?.length !== 1 ||
  branchRule?.pattern !== args.branch ||
  branchRule.isAdminEnforced !== true ||
  branchRule.lockBranch !== false ||
  branchRule.requireLastPushApproval !== false ||
  branchRule.requiredApprovingReviewCount !== 0 ||
  (branchRule.requiredDeploymentEnvironments ?? []).length !== 0 ||
  branchRule.requiresApprovingReviews !== false ||
  branchRule.requiresCodeOwnerReviews !== false ||
  branchRule.requiresCommitSignatures !== false ||
  branchRule.requiresConversationResolution !== true ||
  branchRule.requiresDeployments !== false ||
  branchRule.requiresLinearHistory !== false ||
  branchRule.requiresStatusChecks !== true ||
  branchRule.requiresStrictStatusChecks !== true ||
  branchRule.restrictsPushes !== false ||
  branchRule.restrictsReviewDismissals !== false ||
  branchRule.bypassPullRequestAllowances?.totalCount !== 0 ||
  branchRule.pushAllowances?.totalCount !== 0 ||
  branchRule.reviewDismissalAllowances?.totalCount !== 0
) {
  throw new Error(
    "Negative test requires one exact branch rule with no merge blocker besides the seven statuses and resolved conversations",
  );
}
const rulesetSummaries = ghPaginatedArray(
  `repos/${args.repo}/rulesets?includes_parents=true&per_page=100`,
);
const activeRulesets = rulesetSummaries
  .map((ruleset) => ghJson([`repos/${args.repo}/rulesets/${ruleset.id}`]))
  .filter((ruleset) => ruleset.enforcement === "active");
const evidenceRuleset = activeRulesets[0];
const evidenceRuleTypes = (evidenceRuleset?.rules ?? [])
  .map((rule) => rule.type)
  .sort();
if (
  activeRulesets.length !== 1 ||
  evidenceRuleset?.target !== "branch" ||
  (evidenceRuleset.conditions?.ref_name?.include ?? []).length !== 1 ||
  evidenceRuleset.conditions.ref_name.include[0] !==
    "refs/heads/review-evidence/**" ||
  (evidenceRuleset.conditions?.ref_name?.exclude ?? []).length !== 0 ||
  (evidenceRuleset.bypass_actors ?? []).length !== 0 ||
  JSON.stringify(evidenceRuleTypes) !==
    JSON.stringify(["deletion", "non_fast_forward", "update"])
) {
  throw new Error(
    "Negative test requires the sole active ruleset to protect only immutable review-evidence branches",
  );
}

const fakeStatuses = requiredContexts.map((context) =>
  ghJson([
    "--method",
    "POST",
    `repos/${args.repo}/statuses/${args.sha}`,
    "-f",
    "state=success",
    "-f",
    `context=${context}`,
    "-f",
    "description=NEGATIVE TEST: untrusted same-name status",
  ]),
);
if (
  fakeStatuses.some(
    (status) => status.creator?.login === "github-actions[bot]",
  )
) {
  throw new Error("Negative test must use the connected user token, not Actions");
}
const canaryRun = ghJson([
  `repos/${args.repo}/actions/runs/${canaryRunId}`,
]);
if (
  canaryRun.head_sha !== args.sha ||
  canaryRun.event !== "push" ||
  canaryRun.path !== ".github/workflows/untrusted-status-canary.yml" ||
  canaryRun.conclusion !== "success"
) {
  throw new Error("The untrusted Actions canary run is invalid or incomplete");
}
const canaryCheckSuite = ghJson([
  `repos/${args.repo}/check-suites/${canaryRun.check_suite_id}`,
]);
const actionsCanaryAppId = canaryCheckSuite.app?.id;
if (
  !Number.isInteger(actionsCanaryAppId) ||
  actionsCanaryAppId === gatekeeperAppId
) {
  throw new Error(
    "The Actions canary check suite must have a real App ID different from the Gatekeeper App",
  );
}
const combinedStatus = ghJson([
  `repos/${args.repo}/commits/${args.sha}/status`,
]);
const actionsCanaryStatuses = requiredContexts.map((context) =>
  combinedStatus.statuses?.find(
    (status) =>
      status.context === context &&
      status.state === "success" &&
      status.creator?.login === "github-actions[bot]" &&
      status.target_url?.endsWith(`/actions/runs/${canaryRunId}`),
  ),
);
if (actionsCanaryStatuses.some((status) => !status)) {
  throw new Error("All seven same-name successes from GitHub Actions were not observed");
}

const stableMergeState = await stableBlockedMergeState({
  branch: args.branch,
  fixedSha: args.sha,
  gatekeeperAppId,
  pullRequestNumber,
  repo: args.repo,
});

const evidence = {
  testedAt: new Date().toISOString(),
  repository: args.repo,
  branch: args.branch,
  verifiedDefaultBranch: repository.default_branch,
  pullRequest: pullRequestNumber,
  fixedCommitSha: args.sha,
  pullRequestPreconditions: {
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    comparisonStatus: comparison.status,
    draft: pullRequest.draft,
    conflictFree: pullRequest.mergeable,
    reviewCommentCount: reviewComments.length,
    reviewDecisionCount: reviews.length,
    requiredPullRequestReviewsConfigured: false,
    alternateBranchMergeConditionsConfigured: false,
  },
  protectedContexts: requiredContexts,
  expectedGatekeeperAppId: gatekeeperAppId,
  untrustedStatusIds: fakeStatuses.map((status) => status.id),
  untrustedCreator: fakeStatuses[0].creator?.login,
  actionsCanaryRunId: canaryRunId,
  actionsCanaryCheckSuiteId: canaryRun.check_suite_id,
  actionsCanaryAppId,
  actionsCanaryStatusIds: actionsCanaryStatuses.map((status) => status.id),
  actionsCanaryCreator: actionsCanaryStatuses[0].creator.login,
  mergeableStateAfterUntrustedStatus: stableMergeState,
};
await writeFile(
  resolve(args["evidence-output"]),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
process.stdout.write("Untrusted same-name review status did not satisfy the protected source\n");
