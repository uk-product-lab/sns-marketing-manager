// Synthetic configuration only. No credentials, real API calls, or live data.
export const organization = "synthetic-org";
export const repo = `${organization}/synthetic-repo`;
export const boardLogin = "synthetic-board";
export const legacyAutomationLogin = "synthetic-automation";
export const appId = 424242;
export const requiredContexts = [
  "governance/protected-files",
  "quality/static",
  "quality/unit",
  "quality/e2e-chromium",
  "quality/e2e-webkit-mobile",
  "quality/accessibility",
  "review/independent",
];

export const endpoints = {
  organization: `orgs/${organization}`,
  owners: `orgs/${organization}/members?role=admin&per_page=100`,
  boardMembership: `orgs/${organization}/memberships/${boardLogin}`,
  automationMembership: `orgs/${organization}/memberships/${legacyAutomationLogin}`,
  repository: `repos/${repo}`,
  protection: `repos/${repo}/branches/main/protection`,
  environment: `repos/${repo}/environments/board-review`,
  policies: `repos/${repo}/environments/board-review/deployment-branch-policies`,
  sharedPermission: `repos/${repo}/collaborators/${boardLogin}/permission`,
  legacyPermission: `repos/${repo}/collaborators/${legacyAutomationLogin}/permission`,
  rulesets: `repos/${repo}/rulesets?includes_parents=true&per_page=100`,
  evidenceRuleset: `repos/${repo}/rulesets/42`,
};

export const forbiddenEndpoints = [
  `repos/${repo}/actions/secrets?per_page=1`,
  `repos/${repo}/actions/variables?per_page=1`,
  `repos/${repo}/environments/board-review/secrets?per_page=1`,
  `repos/${repo}/environments/board-review/variables?per_page=1`,
];

export function configurationFixture(identityModel = "shared-admin") {
  const shared = identityModel === "shared-admin";
  const login = shared ? boardLogin : legacyAutomationLogin;
  const routes = {
    user: { login },
    [endpoints.organization]: { login: organization, type: "Organization" },
    [endpoints.owners]: [[{ login: boardLogin }]],
    [endpoints.boardMembership]: { state: "active", role: "admin" },
    [endpoints.repository]: {
      owner: { login: organization, type: "Organization" },
      visibility: "public",
      private: false,
      default_branch: "main",
    },
    [endpoints.protection]: {
      required_status_checks: {
        strict: true,
        checks: requiredContexts.map((context) => ({ context, app_id: appId })),
      },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      required_conversation_resolution: { enabled: true },
      required_pull_request_reviews: null,
    },
    graphql: {
      data: {
        repository: {
          branchProtectionRules: {
            totalCount: 1,
            nodes: [{
              pattern: "main",
              isAdminEnforced: true,
              lockBranch: false,
              requireLastPushApproval: false,
              requiredApprovingReviewCount: 0,
              requiredDeploymentEnvironments: [],
              requiresApprovingReviews: false,
              requiresCodeOwnerReviews: false,
              requiresCommitSignatures: false,
              requiresConversationResolution: true,
              requiresDeployments: false,
              requiresLinearHistory: false,
              requiresStatusChecks: true,
              requiresStrictStatusChecks: true,
              restrictsPushes: false,
              restrictsReviewDismissals: false,
              bypassPullRequestAllowances: { totalCount: 0 },
              pushAllowances: { totalCount: 0 },
              reviewDismissalAllowances: { totalCount: 0 },
            }],
          },
        },
      },
    },
    [endpoints.environment]: {
      can_admins_bypass: false,
      protection_rules: [{
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: boardLogin } }],
      }],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    [endpoints.policies]: { branch_policies: [{ name: "main", type: "branch" }] },
    [shared ? endpoints.sharedPermission : endpoints.legacyPermission]: {
      permission: shared ? "admin" : "write",
      role_name: shared ? "admin" : "write",
    },
    [endpoints.rulesets]: [[{ id: 42 }]],
    [endpoints.evidenceRuleset]: {
      id: 42,
      name: "synthetic-evidence-immutability",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["refs/heads/review-evidence/**"], exclude: [] },
      },
      bypass_actors: [],
      rules: ["update", "deletion", "non_fast_forward"].map((type) => ({ type })),
    },
  };
  const denied = {};
  for (const endpoint of forbiddenEndpoints) denied[endpoint] = 403;
  if (!shared) {
    routes[endpoints.automationMembership] = { state: "active", role: "member" };
  }
  return { routes, denied };
}
