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
  const allowedKeys = new Set([
    "organization", "repo", "branch", "gatekeeper-app-id",
    "board-reviewer-login", "automation-login", "identity-model", "evidence-output",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (!allowedKeys.has(name)) throw new Error(`Unknown argument ${key}`);
    if (Object.hasOwn(args, name)) throw new Error(`Duplicate argument ${key}`);
    args[name] = value;
  }
  return args;
}

function ghJson(endpoint) {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], { encoding: "utf8" }),
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
  const parameters = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    parameters.push("-F", `${name}=${value}`);
  }
  return JSON.parse(
    execFileSync("gh", parameters, { encoding: "utf8" }),
  );
}

function assertGhApiDenied(endpoint) {
  try {
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const diagnostics = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (diagnostics.includes("HTTP 403") || diagnostics.includes("HTTP 404")) {
      return;
    }
    throw error;
  }
  throw new Error(
    `Automation credential has forbidden Actions secret/variable access: ${endpoint}`,
  );
}

const args = parseArgs(process.argv.slice(2));
for (const key of [
  "identity-model",
  "organization",
  "repo",
  "branch",
  "gatekeeper-app-id",
  "board-reviewer-login",
  "automation-login",
  "evidence-output",
]) {
  if (!args[key]) throw new Error(`Missing --${key}`);
}
// DEC-009 permits administrator-account automation. It does not authorize
// secret access: the credential denial checks below remain required in both models.
const identityModel = args["identity-model"];
if (!["shared-admin", "separated-identities"].includes(identityModel)) {
  throw new Error("--identity-model must be shared-admin or separated-identities");
}
const sharedAdmin = identityModel === "shared-admin";
const accountLoginsDistinct =
  args["automation-login"].toLowerCase() !==
  args["board-reviewer-login"].toLowerCase();
if (sharedAdmin && accountLoginsDistinct) {
  throw new Error("shared-admin requires the same board and automation GitHub login");
}
if (!sharedAdmin && !accountLoginsDistinct) {
  throw new Error("separated-identities requires different board and automation GitHub logins");
}
const gatekeeperAppId = Number(args["gatekeeper-app-id"]);
if (!Number.isSafeInteger(gatekeeperAppId) || gatekeeperAppId <= 0) {
  throw new Error("Invalid --gatekeeper-app-id");
}
const [repositoryOwner, repositoryName, ...extraRepoParts] = args.repo.split("/");
if (!repositoryOwner || !repositoryName || extraRepoParts.length > 0) {
  throw new Error("--repo must use owner/name");
}
if (
  repositoryOwner.toLowerCase() !==
  args.organization.toLowerCase()
) {
  throw new Error(
    "The repository owner must be the declared GitHub Organization",
  );
}
const authenticatedUser = ghJson("user");
if (
  authenticatedUser.login?.toLowerCase() !==
  args["automation-login"].toLowerCase()
) {
  throw new Error("The active gh identity is not the declared automation identity");
}
const organization = ghJson(`orgs/${encodeURIComponent(args.organization)}`);
if (
  organization.login?.toLowerCase() !== args.organization.toLowerCase() ||
  organization.type !== "Organization"
) {
  throw new Error("The declared owner is not the expected GitHub Organization");
}
const organizationOwners = ghPaginatedArray(
  `orgs/${encodeURIComponent(args.organization)}/members?role=admin&per_page=100`,
);
if (
  organizationOwners.length !== 1 ||
  organizationOwners[0]?.login?.toLowerCase() !==
    args["board-reviewer-login"].toLowerCase()
) {
  throw new Error(
    "The Organization must have exactly one owner: the declared board owner",
  );
}
const boardMembership = ghJson(
  `orgs/${encodeURIComponent(args.organization)}/memberships/${encodeURIComponent(args["board-reviewer-login"])}`,
);
if (boardMembership.state !== "active" || boardMembership.role !== "admin") {
  throw new Error("The declared board owner must be an active Organization owner");
}
const automationMembership = sharedAdmin
  ? boardMembership
  : ghJson(
    `orgs/${encodeURIComponent(args.organization)}/memberships/${encodeURIComponent(args["automation-login"])}`,
  );
const expectedOrganizationRole = sharedAdmin ? "admin" : "member";
if (
  automationMembership.state !== "active" ||
  automationMembership.role !== expectedOrganizationRole
) {
  throw new Error(
    `The automation identity must be active with Organization role ${expectedOrganizationRole} for ${identityModel}`,
  );
}
const repository = ghJson(`repos/${args.repo}`);
if (
  repository.owner?.login?.toLowerCase() !== args.organization.toLowerCase() ||
  repository.owner?.type !== "Organization" ||
  repository.visibility !== "public" ||
  repository.private !== false
) {
  throw new Error(
    "The repository must be Public and owned by the declared GitHub Organization",
  );
}
if (args.branch !== "main" || repository.default_branch !== "main") {
  throw new Error(
    `The repository default branch and --branch must both be main; received ${repository.default_branch} and ${args.branch}`,
  );
}

const branchProtection = ghJson(
  `repos/${args.repo}/branches/${encodeURIComponent(args.branch)}/protection`,
);
const statusProtection = branchProtection.required_status_checks;
if (!statusProtection) throw new Error("Required status checks are not configured");
if (!statusProtection.strict) {
  throw new Error("Required checks must be strict and current with the base branch");
}
if (branchProtection.enforce_admins?.enabled !== true) {
  throw new Error("Repository administrators must not bypass branch protection");
}
if (branchProtection.allow_force_pushes?.enabled === true) {
  throw new Error("Force pushes must be disabled");
}
if (branchProtection.allow_deletions?.enabled === true) {
  throw new Error("Protected branch deletion must be disabled");
}
if (branchProtection.required_conversation_resolution?.enabled !== true) {
  throw new Error("Conversation resolution must be required before merge");
}
if (branchProtection.required_pull_request_reviews) {
  throw new Error(
    "GitHub PR-review approval must be disabled; board-review Environment is the sole manual approval gate",
  );
}
const configuredChecks = Array.isArray(statusProtection.checks)
  ? statusProtection.checks
  : [];
if (configuredChecks.length !== requiredContexts.length) {
  throw new Error("Exactly the seven harness statuses must be required");
}
for (const context of requiredContexts) {
  const matches = configuredChecks.filter((check) => check.context === context);
  if (matches.length !== 1) {
    throw new Error(`Required check must have exactly one expected source: ${context}`);
  }
  if (matches[0].app_id !== gatekeeperAppId) {
    throw new Error(
      `Required check is not pinned to the dedicated Gatekeeper App: ${context}`,
    );
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
    "The exact default-branch rule must use only strict statuses plus conversation resolution, with no alternate merge condition or bypass",
  );
}

const environment = ghJson(
  `repos/${args.repo}/environments/${encodeURIComponent("board-review")}`,
);
if (environment.can_admins_bypass !== false) {
  throw new Error("board-review must disable administrator bypass");
}
const reviewerRule = environment.protection_rules?.find(
  (rule) => rule.type === "required_reviewers",
);
if (!reviewerRule || reviewerRule.prevent_self_review !== true) {
  throw new Error("board-review must require reviewers and prevent self-review");
}
const reviewerLogins = (reviewerRule.reviewers ?? [])
  .filter((reviewer) => reviewer.type === "User")
  .map((reviewer) => reviewer.reviewer?.login)
  .filter(Boolean);
if (
  reviewerRule.reviewers?.length !== 1 ||
  reviewerLogins.length !== 1 ||
  reviewerLogins[0] !== args["board-reviewer-login"]
) {
  throw new Error("board-review must have exactly one reviewer: the board owner");
}
if (
  environment.deployment_branch_policy?.protected_branches !== false ||
  environment.deployment_branch_policy?.custom_branch_policies !== true
) {
  throw new Error("board-review must use a custom branch policy only");
}
const deploymentPolicies = ghJson(
  `repos/${args.repo}/environments/${encodeURIComponent("board-review")}/deployment-branch-policies`,
);
if (
  deploymentPolicies.branch_policies?.length !== 1 ||
  deploymentPolicies.branch_policies[0].name !== args.branch ||
  deploymentPolicies.branch_policies[0].type !== "branch"
) {
  throw new Error("board-review must allow only the default branch");
}
const automationPermission = ghJson(
  `repos/${args.repo}/collaborators/${encodeURIComponent(args["automation-login"])}/permission`,
);
const expectedRepositoryRole = sharedAdmin ? "admin" : "write";
if (
  automationPermission.permission !== expectedRepositoryRole ||
  automationPermission.role_name !== expectedRepositoryRole
) {
  throw new Error(
    `Automation identity must have the exact ${expectedRepositoryRole} role for ${identityModel}; received permission=${automationPermission.permission}, role_name=${automationPermission.role_name}`,
  );
}
const forbiddenAutomationEndpoints = [
  `repos/${args.repo}/actions/secrets?per_page=1`,
  `repos/${args.repo}/actions/variables?per_page=1`,
  `repos/${args.repo}/environments/${encodeURIComponent("board-review")}/secrets?per_page=1`,
  `repos/${args.repo}/environments/${encodeURIComponent("board-review")}/variables?per_page=1`,
];
for (const endpoint of forbiddenAutomationEndpoints) {
  assertGhApiDenied(endpoint);
}
const rulesetSummaries = ghPaginatedArray(
  `repos/${args.repo}/rulesets?includes_parents=true&per_page=100`,
);
const rulesets = rulesetSummaries.map((ruleset) =>
  ghJson(`repos/${args.repo}/rulesets/${ruleset.id}`),
);
const activeRulesets = rulesets.filter(
  (ruleset) => ruleset.enforcement === "active",
);
const expectedEvidenceRuleTypes = [
  "deletion",
  "non_fast_forward",
  "update",
].sort();
const evidenceRuleset = activeRulesets.find((ruleset) => {
  const includedRefs = ruleset.conditions?.ref_name?.include ?? [];
  const ruleTypes = (ruleset.rules ?? [])
    .map((rule) => rule.type)
    .sort();
  return (
    ruleset.target === "branch" &&
    ruleset.enforcement === "active" &&
    includedRefs.length === 1 &&
    includedRefs[0] === "refs/heads/review-evidence/**" &&
    (ruleset.conditions?.ref_name?.exclude ?? []).length === 0 &&
    (ruleset.bypass_actors ?? []).length === 0 &&
    ruleTypes.length === expectedEvidenceRuleTypes.length &&
    ruleTypes.every(
      (ruleType, index) => ruleType === expectedEvidenceRuleTypes[index],
    )
  );
});
if (!evidenceRuleset || activeRulesets.length !== 1) {
  throw new Error(
    "The sole ruleset must protect review-evidence/** with exactly update, deletion, and non_fast_forward and no bypass",
  );
}

const evidence = {
  status: "CONFIGURATION_VERIFIED_ONLY",
  verificationScope: "configuration-only",
  repositoryReadiness: "BLOCKED",
  identityModel,
  accountLoginsDistinct,
  // Account names and configuration cannot prove who operated an account.
  identitySeparation: false,
  humanApprovalVerified: false,
  // This covers only the four tested APIs, not token scope or every access path.
  credentialEndpointsDenied: true,
  outstandingRuntimeGates: [
    "Human-performed final approval and its evidence have not been verified",
    "Workflow actor/triggering-actor conflict positive and negative tests with prevent_self_review=true have not been run",
    "Same-name status source negative tests have not been run",
    "Gatekeeper key isolation, trusted workflow execution, and independent repository-readiness review remain unverified",
  ],
  verifiedAt: new Date().toISOString(),
  organization: {
    login: organization.login,
    type: organization.type,
    soleOwnerLogin: organizationOwners[0].login,
    boardOwnerMembership: {
      login: args["board-reviewer-login"],
      state: boardMembership.state,
      role: boardMembership.role,
    },
    automationMembership: {
      login: args["automation-login"],
      state: automationMembership.state,
      role: automationMembership.role,
    },
  },
  repository: args.repo,
  repositoryOwnerType: repository.owner.type,
  repositoryVisibility: repository.visibility,
  branch: args.branch,
  verifiedDefaultBranch: repository.default_branch,
  branchProtection: {
    enforceAdmins: branchProtection.enforce_admins.enabled,
    allowForcePushes: branchProtection.allow_force_pushes?.enabled ?? false,
    allowDeletions: branchProtection.allow_deletions?.enabled ?? false,
    requireConversationResolution:
      branchProtection.required_conversation_resolution.enabled,
    requiredPullRequestReviewsConfigured: false,
    exactRule: {
      pattern: branchRule.pattern,
      ruleCount: branchRules.totalCount,
      lockBranch: branchRule.lockBranch,
      requiresApprovingReviews: branchRule.requiresApprovingReviews,
      requiresCommitSignatures: branchRule.requiresCommitSignatures,
      requiresDeployments: branchRule.requiresDeployments,
      requiredDeploymentEnvironments:
        branchRule.requiredDeploymentEnvironments,
      requiresLinearHistory: branchRule.requiresLinearHistory,
      restrictsPushes: branchRule.restrictsPushes,
    },
  },
  gatekeeperAppId,
  boardReviewerLogin: args["board-reviewer-login"],
  automationIdentity: {
    login: args["automation-login"],
    permission: automationPermission.permission,
    roleName: automationPermission.role_name,
    forbiddenActionsEndpointsDenied: forbiddenAutomationEndpoints,
  },
  evidenceRuleset: {
    id: evidenceRuleset.id,
    name: evidenceRuleset.name,
    target: evidenceRuleset.target,
    enforcement: evidenceRuleset.enforcement,
    includedRefs: evidenceRuleset.conditions.ref_name.include,
    excludedRefs: evidenceRuleset.conditions.ref_name.exclude ?? [],
    bypassActorCount: (evidenceRuleset.bypass_actors ?? []).length,
    ruleTypes: evidenceRuleset.rules.map((rule) => rule.type),
  },
  requiredChecks: requiredContexts.map((context) => ({
    context,
    appId: configuredChecks.find((check) => check.context === context).app_id,
  })),
  boardReviewEnvironment: {
    canAdminsBypass: environment.can_admins_bypass,
    preventSelfReview: reviewerRule.prevent_self_review,
    reviewerLogins,
    deploymentBranchPolicies: deploymentPolicies.branch_policies.map(
      (policy) => ({ name: policy.name, type: policy.type }),
    ),
  },
};
await writeFile(
  resolve(args["evidence-output"]),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  "CONFIGURATION_VERIFIED_ONLY: repository configuration checks succeeded; repository readiness remains BLOCKED.\n" +
  "Human/automation identity separation and human approval are not proven. Runtime approval and actor-conflict tests remain outstanding.\n",
);
