import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appId, boardLogin, configurationFixture, endpoints, forbiddenEndpoints,
  legacyAutomationLogin, organization, repo, requiredContexts,
} from "./fixtures/repository-gates-fixture.mjs";

const verifier = fileURLToPath(new URL("../scripts/verify-repository-gates.mjs", import.meta.url));
const mockSource = await readFile(new URL("./fixtures/mock-gh.mjs", import.meta.url), "utf8");

async function runVerifier({ model = "shared-admin", mutate = () => {}, argumentsFor = (args) => args } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sns-gates-offline-test-"));
  try {
    const fixture = configurationFixture(model);
    mutate(fixture);
    const bin = join(directory, "bin");
    await mkdir(bin);
    const mockExecutable = join(bin, "gh");
    await writeFile(mockExecutable, `#!${process.execPath}\n${mockSource}`);
    await chmod(mockExecutable, 0o700);
    await writeFile(join(directory, "fixture.json"), JSON.stringify(fixture));
    const evidencePath = join(directory, "evidence.json");
    const args = argumentsFor([
      "--identity-model", model,
      "--organization", organization,
      "--repo", repo,
      "--branch", "main",
      "--gatekeeper-app-id", String(appId),
      "--board-reviewer-login", boardLogin,
      "--automation-login", model === "shared-admin" ? boardLogin : legacyAutomationLogin,
      "--evidence-output", evidencePath,
    ]);
    const result = spawnSync(process.execPath, [verifier, ...args], {
      encoding: "utf8",
      cwd: directory,
      // Do not inherit GH_TOKEN, HOME, config paths, Node preload options, or real gh.
      env: { PATH: bin, HARNESS_GH_MOCK_DIRECTORY: directory },
      timeout: 15000,
    });
    if (result.error) throw result.error;
    const evidence = await readFile(evidencePath, "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const calls = await readFile(join(directory, "calls.jsonl"), "utf8")
      .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse))
      .catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    return { ...result, evidence, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function changeArgument(args, key, value) {
  const output = [...args];
  const index = output.indexOf(`--${key}`);
  assert.notEqual(index, -1);
  output[index + 1] = value;
  return output;
}

function assertRejected(result, expected) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
  assert.equal(result.evidence, null, "A failed check must not generate success evidence");
  assert.doesNotMatch(result.stdout, /CONFIGURATION_VERIFIED_ONLY|REPOSITORY_GATE_PASS/);
}

for (const model of ["shared-admin", "separated-identities"]) {
  test(`${model}: synthetic valid settings produce config-only evidence and retain all denial probes`, async () => {
    const result = await runVerifier({ model });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^CONFIGURATION_VERIFIED_ONLY:/);
    assert.match(result.stdout, /readiness remains BLOCKED/);
    assert.match(result.stdout, /human approval are not proven/);
    assert.doesNotMatch(result.stdout, /REPOSITORY_GATE_PASS|board-review isolation are valid/);
    assert.equal(result.evidence.status, "CONFIGURATION_VERIFIED_ONLY");
    assert.equal(result.evidence.verificationScope, "configuration-only");
    assert.equal(result.evidence.repositoryReadiness, "BLOCKED");
    assert.equal(result.evidence.identityModel, model);
    assert.equal(result.evidence.accountLoginsDistinct, model === "separated-identities");
    assert.equal(result.evidence.identitySeparation, false);
    assert.equal(result.evidence.humanApprovalVerified, false);
    assert.equal(result.evidence.credentialEndpointsDenied, true);
    assert.deepEqual(result.evidence.automationIdentity.forbiddenActionsEndpointsDenied, forbiddenEndpoints);
    assert.deepEqual(
      result.calls.map((call) => call.endpoint).filter((endpoint) => forbiddenEndpoints.includes(endpoint)),
      forbiddenEndpoints,
    );
    assert.equal(result.evidence.boardReviewEnvironment.preventSelfReview, true);
    assert.equal(result.evidence.boardReviewEnvironment.canAdminsBypass, false);
    assert.deepEqual(result.evidence.requiredChecks, requiredContexts.map((context) => ({ context, appId })));
    assert.match(result.evidence.outstandingRuntimeGates.join("\n"), /Human-performed final approval/);
    assert.match(result.evidence.outstandingRuntimeGates.join("\n"), /actor\/triggering-actor conflict positive and negative tests/);
    assert.match(result.evidence.outstandingRuntimeGates.join("\n"), /prevent_self_review=true/);
  });

  test(`${model}: wrong active gh login fails before organization checks`, async () => {
    const result = await runVerifier({ model, mutate: ({ routes }) => { routes.user.login = "wrong-login"; } });
    assertRejected(result, /active gh identity is not the declared automation identity/);
    assert.deepEqual(result.calls.map((call) => call.endpoint), ["user"]);
  });

  for (const endpoint of forbiddenEndpoints) {
    test(`${model}: credential access to ${endpoint} is still forbidden`, async () => {
      const result = await runVerifier({ model, mutate: ({ routes, denied }) => {
        delete denied[endpoint];
        routes[endpoint] = { total_count: 0 }; // Even an empty successful list is forbidden.
      } });
      assertRejected(result, /forbidden Actions secret\/variable access/);
    });
  }

  test(`${model}: HTTP 404 is accepted only as denial of the tested endpoints`, async () => {
    const result = await runVerifier({ model, mutate: ({ denied }) => {
      for (const endpoint of forbiddenEndpoints) denied[endpoint] = 404;
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.evidence.credentialEndpointsDenied, true);
    assert.equal(result.evidence.identitySeparation, false);
  });

  test(`${model}: HTTP 500 is not evidence of credential denial`, async () => {
    const result = await runVerifier({ model, mutate: ({ denied }) => { denied[forbiddenEndpoints[0]] = 500; } });
    assertRejected(result, /HTTP 500/);
  });

  test(`${model}: repository permission mismatch is rejected`, async () => {
    const result = await runVerifier({ model, mutate: ({ routes }) => {
      const permission = routes[model === "shared-admin" ? endpoints.sharedPermission : endpoints.legacyPermission];
      permission.permission = model === "shared-admin" ? "write" : "admin";
    } });
    assertRejected(result, /must have the exact (admin|write) role/);
  });

  test(`${model}: repository role_name mismatch is rejected`, async () => {
    const result = await runVerifier({ model, mutate: ({ routes }) => {
      routes[model === "shared-admin" ? endpoints.sharedPermission : endpoints.legacyPermission].role_name = "custom-role";
    } });
    assertRejected(result, /must have the exact (admin|write) role/);
  });

  const protectionCases = [
    ["missing required checks", (r) => { delete r[endpoints.protection].required_status_checks; }, /Required status checks are not configured/],
    ["missing source pin", (r) => { delete r[endpoints.protection].required_status_checks.checks[0].app_id; }, /not pinned to the dedicated Gatekeeper App/],
    ["tampered source pin", (r) => { r[endpoints.protection].required_status_checks.checks[0].app_id = appId + 1; }, /not pinned to the dedicated Gatekeeper App/],
    ["missing quality check", (r) => { r[endpoints.protection].required_status_checks.checks.pop(); }, /Exactly the seven/],
    ["extra quality check", (r) => { r[endpoints.protection].required_status_checks.checks.push({ context: "extra", app_id: appId }); }, /Exactly the seven/],
    ["duplicate check context", (r) => { r[endpoints.protection].required_status_checks.checks[1].context = requiredContexts[0]; }, /exactly one expected source/],
    ["non-strict checks", (r) => { r[endpoints.protection].required_status_checks.strict = false; }, /must be strict/],
    ["admin branch bypass", (r) => { r[endpoints.protection].enforce_admins.enabled = false; }, /must not bypass branch protection/],
    ["force push", (r) => { r[endpoints.protection].allow_force_pushes.enabled = true; }, /Force pushes must be disabled/],
    ["branch deletion", (r) => { r[endpoints.protection].allow_deletions.enabled = true; }, /branch deletion must be disabled/],
    ["missing conversation resolution", (r) => { r[endpoints.protection].required_conversation_resolution.enabled = false; }, /Conversation resolution must be required/],
    ["extra PR review condition", (r) => { r[endpoints.protection].required_pull_request_reviews = {}; }, /PR-review approval must be disabled/],
    ["non-main default branch", (r) => { r[endpoints.repository].default_branch = "development"; }, /must both be main/],
    ["wrong organization ownership", (r) => { r[endpoints.repository].owner.type = "User"; }, /Public and owned by the declared GitHub Organization/],
    ["private repository", (r) => { r[endpoints.repository].private = true; }, /Public and owned by the declared GitHub Organization/],
    ["self-review prevention disabled", (r) => { r[endpoints.environment].protection_rules[0].prevent_self_review = false; }, /prevent self-review/],
    ["self-review prevention absent", (r) => { delete r[endpoints.environment].protection_rules[0].prevent_self_review; }, /prevent self-review/],
    ["environment admin bypass", (r) => { r[endpoints.environment].can_admins_bypass = true; }, /disable administrator bypass/],
    ["extra environment reviewer", (r) => { r[endpoints.environment].protection_rules[0].reviewers.push({ type: "User", reviewer: { login: "extra" } }); }, /exactly one reviewer/],
    ["team environment reviewer", (r) => { r[endpoints.environment].protection_rules[0].reviewers[0].type = "Team"; }, /exactly one reviewer/],
    ["protected rather than custom environment policy", (r) => { r[endpoints.environment].deployment_branch_policy.protected_branches = true; }, /custom branch policy only/],
    ["wildcard environment branch", (r) => { r[endpoints.policies].branch_policies[0].name = "*"; }, /only the default branch/],
    ["evidence update protection absent", (r) => { r[endpoints.evidenceRuleset].rules.shift(); }, /sole ruleset must protect/],
    ["evidence creation blocked", (r) => { r[endpoints.evidenceRuleset].rules.push({ type: "creation" }); }, /sole ruleset must protect/],
    ["evidence bypass", (r) => { r[endpoints.evidenceRuleset].bypass_actors.push({ actor_id: 1 }); }, /sole ruleset must protect/],
    ["evidence exclusion", (r) => { r[endpoints.evidenceRuleset].conditions.ref_name.exclude.push("refs/heads/review-evidence/bypass"); }, /sole ruleset must protect/],
    ["extra active ruleset on next page", (r) => {
      r[endpoints.rulesets].push([{ id: 43 }]);
      r[`repos/${repo}/rulesets/43`] = { id: 43, enforcement: "active" };
    }, /sole ruleset must protect/],
    ["second owner on next page", (r) => { r[endpoints.owners].push([{ login: "extra-owner" }]); }, /exactly one owner/],
  ];
  for (const [name, mutate, expected] of protectionCases) {
    test(`${model}: ${name} is rejected`, async () => {
      assertRejected(await runVerifier({ model, mutate: ({ routes }) => mutate(routes) }), expected);
    });
  }

  const branchRuleFields = {
    pattern: "*", isAdminEnforced: false, lockBranch: true,
    requireLastPushApproval: true, requiredApprovingReviewCount: 1,
    requiredDeploymentEnvironments: ["production"], requiresApprovingReviews: true,
    requiresCodeOwnerReviews: true, requiresCommitSignatures: true,
    requiresConversationResolution: false, requiresDeployments: true,
    requiresLinearHistory: true, requiresStatusChecks: false,
    requiresStrictStatusChecks: false, restrictsPushes: true, restrictsReviewDismissals: true,
    bypassPullRequestAllowances: { totalCount: 1 }, pushAllowances: { totalCount: 1 },
    reviewDismissalAllowances: { totalCount: 1 },
  };
  for (const [field, value] of Object.entries(branchRuleFields)) {
    test(`${model}: GraphQL rule ${field} remains strict`, async () => {
      const result = await runVerifier({ model, mutate: ({ routes }) => {
        routes.graphql.data.repository.branchProtectionRules.nodes[0][field] = value;
      } });
      assertRejected(result, /exact default-branch rule/);
    });
  }
}

test("shared-admin: non-admin organization membership is rejected", async () => {
  assertRejected(await runVerifier({ mutate: ({ routes }) => { routes[endpoints.boardMembership].role = "member"; } }), /active Organization owner/);
});

test("shared-admin: inactive owner is rejected", async () => {
  assertRejected(await runVerifier({ mutate: ({ routes }) => { routes[endpoints.boardMembership].state = "pending"; } }), /active Organization owner/);
});

test("legacy: automation organization owner is rejected", async () => {
  assertRejected(await runVerifier({ model: "separated-identities", mutate: ({ routes }) => { routes[endpoints.automationMembership].role = "admin"; } }), /Organization role member/);
});

test("legacy: inactive automation member is rejected", async () => {
  assertRejected(await runVerifier({ model: "separated-identities", mutate: ({ routes }) => { routes[endpoints.automationMembership].state = "pending"; } }), /Organization role member/);
});

const argumentCases = [
  ["missing explicit model", (args) => args.slice(2), /Missing --identity-model/],
  ["unknown model", (args) => changeArgument(args, "identity-model", "automatic"), /must be shared-admin or separated-identities/],
  ["shared model with different logins", (args) => changeArgument(args, "automation-login", legacyAutomationLogin), /shared-admin requires the same/],
  ["legacy model with same login", (args) => changeArgument(args, "identity-model", "separated-identities"), /requires different board and automation/],
  ["two model arguments", (args) => [...args, "--identity-model", "separated-identities"], /Duplicate argument --identity-model/],
  ["unknown flag", (args) => [...args, "--allow-self-review", "true"], /Unknown argument --allow-self-review/],
  ["missing flag value", (args) => [...args, "--identity-model"], /Invalid argument/],
];
for (const [name, argumentsFor, expected] of argumentCases) {
  test(`arguments: ${name} is rejected before API calls`, async () => {
    const result = await runVerifier({ argumentsFor });
    assertRejected(result, expected);
    assert.deepEqual(result.calls, []);
  });
}
