import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

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

async function filesUnder(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    if (entry.isFile()) files.push(path);
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`Evidence contains unsupported entry: ${relative(root, path)}`);
    }
  }
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
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

async function evidenceDigest(evidencePath) {
  const hash = createHash("sha256");
  const files = await filesUnder(evidencePath);
  let bytes = 0;
  for (const path of files) {
    bytes += (await stat(path)).size;
    hash.update(relative(evidencePath, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), bytes, fileCount: files.length };
}

function normalizedGitHubRepo(remoteUrl) {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh) return ssh[1];
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return https?.[1];
}

function ghApiJson(parameters, payload) {
  const options = {
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
  };
  if (payload !== undefined) {
    options.input = JSON.stringify(payload);
    parameters = [...parameters, "--input", "-"];
  }
  return JSON.parse(execFileSync("gh", ["api", ...parameters], options));
}

function getGitRefOrNull(repo, ref) {
  try {
    return ghApiJson([`repos/${repo}/git/ref/${ref}`]);
  } catch (error) {
    const diagnostics = String(error.stderr ?? "");
    if (diagnostics.includes("HTTP 404") || diagnostics.includes("Not Found")) {
      return null;
    }
    throw error;
  }
}

async function publishEvidenceCommit({
  evidencePath,
  leaseProof,
  projectRoot,
  repo,
  verdict,
}) {
  const remoteUrl = execFileSync(
    "git",
    ["-C", projectRoot, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  ).trim();
  if (normalizedGitHubRepo(remoteUrl)?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error("The supplied repository does not match the project origin");
  }

  const temporaryRepository = await mkdtemp(join(tmpdir(), "sns-review-evidence-"));
  try {
    await cp(evidencePath, join(temporaryRepository, "evidence"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await writeFile(
      join(temporaryRepository, "evidence", "review-verdict.json"),
      `${JSON.stringify({ ...verdict, evidencePath: undefined }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(temporaryRepository, "evidence", "lease-proof.json"),
      `${JSON.stringify(leaseProof, null, 2)}\n`,
      "utf8",
    );
    const evidence = await evidenceDigest(
      join(temporaryRepository, "evidence"),
    );
    if (evidence.bytes > 20 * 1024 * 1024 || evidence.fileCount > 500) {
      throw new Error(
        "Evidence exceeds the Git-backed review limit of 20 MiB or 500 files",
      );
    }
    const manifest = {
      schemaVersion: 1,
      gateId: verdict.gateId,
      taskId: verdict.taskId,
      pullRequest: verdict.pullRequest,
      fixedCommitSha: verdict.fixedCommitSha,
      testStartedAt: verdict.testStartedAt,
      testedAt: verdict.testedAt,
      evidenceSha256: evidence.digest,
      evidenceBytes: evidence.bytes,
      evidenceFileCount: evidence.fileCount,
    };
    await writeFile(
      join(temporaryRepository, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const treeEntries = [];
    for (const path of await filesUnder(temporaryRepository)) {
      const content = await readFile(path);
      const blob = ghApiJson(
        ["--method", "POST", `repos/${repo}/git/blobs`],
        { content: content.toString("base64"), encoding: "base64" },
      );
      treeEntries.push({
        path: relative(temporaryRepository, path),
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const tree = ghApiJson(
      ["--method", "POST", `repos/${repo}/git/trees`],
      { tree: treeEntries },
    );
    const evidenceRefName = `heads/review-evidence/${verdict.gateId}`;
    const existingEvidenceRef = getGitRefOrNull(repo, evidenceRefName);
    if (existingEvidenceRef) {
      const existingEvidenceCommit = ghApiJson([
        `repos/${repo}/git/commits/${existingEvidenceRef.object.sha}`,
      ]);
      if (existingEvidenceCommit.tree.sha !== tree.sha) {
        throw new Error("The gate ID already points to different evidence");
      }
      return {
        evidenceCommitSha: existingEvidenceRef.object.sha,
        evidence,
      };
    }
    const commit = ghApiJson(
      ["--method", "POST", `repos/${repo}/git/commits`],
      {
        message: `Review evidence ${verdict.gateId} for ${verdict.fixedCommitSha}`,
        tree: tree.sha,
        parents: [],
      },
    );
    ghApiJson(
      ["--method", "POST", `repos/${repo}/git/refs`],
      {
        ref: `refs/${evidenceRefName}`,
        sha: commit.sha,
      },
    );
    return { evidenceCommitSha: commit.sha, evidence };
  } finally {
    await rm(temporaryRepository, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
for (const key of [
  "verdict-file",
  "project-root",
  "state-root",
  "repo",
  "automation-login",
]) {
  if (!args[key]) throw new Error(`Missing --${key}`);
}
const authenticatedUser = JSON.parse(
  execFileSync("gh", ["api", "user"], { encoding: "utf8" }),
);
if (
  authenticatedUser.login?.toLowerCase() !==
  args["automation-login"].toLowerCase()
) {
  throw new Error("The active gh identity is not the declared automation identity");
}

const verdictPath = await realpath(resolve(args["verdict-file"]));
const projectRoot = await realpath(resolve(args["project-root"]));
const stateRoot = await realpath(resolve(args["state-root"]));
execFileSync(
  process.execPath,
  [
    resolve(projectRoot, "harness", "scripts", "validate-review-verdict.mjs"),
    verdictPath,
    "--project-root",
    projectRoot,
    "--state-root",
    stateRoot,
  ],
  { stdio: "inherit" },
);

const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
if (verdict.verdict !== "PASS") throw new Error("Only PASS may be submitted");
const archiveDirectory = join(stateRoot, "leases", "archive");
const archivedLeaseEntries = await readJsonEntries(archiveDirectory);
const reviewLeaseEntry = archivedLeaseEntries.find(
  ({ value: lease }) =>
    lease.taskId === verdict.taskId &&
    lease.role === "reviewer" &&
    lease.leaseId === verdict.reviewLeaseId &&
    lease.outcome === "PASS",
);
const reviewLease = reviewLeaseEntry?.value;
if (!reviewLease) {
  throw new Error("Submission requires an archived PASS review lease");
}
await realpath(join(archiveDirectory, `${reviewLeaseEntry.name}.original`)).catch(() => {
  throw new Error("Archived PASS review lease is missing its original active lease record");
});
const implementationLeaseEntry = archivedLeaseEntries.find(
  ({ value: lease }) =>
    lease.taskId === verdict.taskId &&
    lease.role === "implementer" &&
    lease.leaseId === verdict.implementationLeaseId &&
    lease.outcome === "SELF_TESTED",
);
const implementationLease = implementationLeaseEntry?.value;
if (!implementationLease) {
  throw new Error("Submission requires the linked SELF_TESTED implementation lease");
}
await realpath(
  join(archiveDirectory, `${implementationLeaseEntry.name}.original`),
).catch(() => {
  throw new Error(
    "Archived SELF_TESTED implementation lease is missing its original active lease record",
  );
});
function publicLease(lease) {
  return {
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    role: lease.role,
    agent: lease.agent,
    agentSession: lease.agentSession,
    branch: lease.branch,
    implementationLeaseId: lease.implementationLeaseId,
    fixedCommitSha: lease.fixedCommitSha,
    startedAt: lease.startedAt,
    expiresAt: lease.expiresAt,
    outcome: lease.outcome,
    releasedAt: lease.releasedAt,
    releasedBy: lease.releasedBy,
  };
}
const leaseProof = {
  schemaVersion: 1,
  implementation: publicLease(implementationLease),
  review: publicLease(reviewLease),
};
const remoteRepository = ghApiJson([
  `repos/${args.repo}`,
]);
const remoteDefaultBranch = ghApiJson([
  `repos/${args.repo}/branches/${encodeURIComponent(remoteRepository.default_branch)}`,
]);
const remotePullRequest = ghApiJson([
  `repos/${args.repo}/pulls/${verdict.pullRequest}`,
]);
if (
  remotePullRequest.head.sha !== verdict.fixedCommitSha ||
  remotePullRequest.base.ref !== remoteRepository.default_branch ||
  remotePullRequest.base.sha !== remoteDefaultBranch.commit?.sha
) {
  throw new Error(
    "GitHub PR must target the current default branch and match the reviewed fixed SHA",
  );
}
const remoteComparison = ghApiJson([
  `repos/${args.repo}/compare/${remoteDefaultBranch.commit.sha}...${remotePullRequest.head.sha}`,
]);
if (!["ahead", "identical"].includes(remoteComparison.status)) {
  throw new Error("GitHub PR head does not contain the current default branch");
}

const evidencePath = await realpath(resolve(verdict.evidencePath));
const publishedEvidence = await publishEvidenceCommit({
  evidencePath,
  leaseProof,
  projectRoot,
  repo: args.repo,
  verdict,
});
const { evidenceCommitSha, evidence } = publishedEvidence;
const attestation = {
  ...verdict,
  evidencePath: undefined,
  evidenceSha256: evidence.digest,
  evidenceBytes: evidence.bytes,
  evidenceFileCount: evidence.fileCount,
  evidenceBranch: `review-evidence/${verdict.gateId}`,
  evidenceCommitSha,
  baseBranch: remoteRepository.default_branch,
  baseSha: remoteDefaultBranch.commit.sha,
  reviewLeaseStartedAt: reviewLease.startedAt,
  reviewLeaseExpiresAt: reviewLease.expiresAt,
  submittedAt: new Date().toISOString(),
};
const body = `<!-- sns-review-attestation:v1 -->\n${JSON.stringify(attestation, null, 2)}`;
const pullRequestState = JSON.parse(
  execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(verdict.pullRequest),
      "--repo",
      args.repo,
      "--json",
      "labels",
    ],
    { encoding: "utf8" },
  ),
);
const existingLabels = new Set(
  (pullRequestState.labels ?? []).map((label) => label.name),
);
if (
  existingLabels.has("review:board-pending") ||
  existingLabels.has("review:approved")
) {
  throw new Error("This PR is already pending or past board review");
}

execFileSync(
  "gh",
  [
    "label",
    "create",
    "review:awaiting-board",
    "--repo",
    args.repo,
    "--color",
    "FBCA04",
    "--description",
    "Validated review is waiting for board approval",
    "--force",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "label",
    "create",
    "review:stale",
    "--repo",
    args.repo,
    "--color",
    "BFD4F2",
    "--description",
    "Review attestation no longer matches the PR or evidence head",
    "--force",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "label",
    "create",
    "review:board-pending",
    "--repo",
    args.repo,
    "--color",
    "D4C5F9",
    "--description",
    "Board-review Environment is awaiting manual approval",
    "--force",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "label",
    "create",
    "review:approved",
    "--repo",
    args.repo,
    "--color",
    "0E8A16",
    "--description",
    "Board-approved independent browser review",
    "--force",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "label",
    "create",
    "review:invalid",
    "--repo",
    args.repo,
    "--color",
    "B60205",
    "--description",
    "Independent review attestation is invalid",
    "--force",
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "api",
    `repos/${args.repo}/issues/${verdict.pullRequest}/comments`,
    "--method",
    "POST",
    "-f",
    `body=${body}`,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "pr",
    "edit",
    String(verdict.pullRequest),
    "--repo",
    args.repo,
    "--add-label",
    "review:awaiting-board",
  ],
  { stdio: "inherit" },
);

process.stdout.write(
  `Submitted ${verdict.gateId} for scheduled board review with evidence commit ${evidenceCommitSha} and SHA-256 ${evidence.digest}\n`,
);
