import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

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

async function readJsonFiles(directory) {
  const names = await readdir(directory).catch(() => []);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))),
  );
}

async function gitContext(worktreeInput) {
  const candidate = resolve(worktreeInput);
  if (!(await stat(candidate).catch(() => null))?.isDirectory()) {
    throw new Error("--worktree must be an existing directory");
  }
  const worktree = await realpath(candidate);
  const gitRoot = await realpath(
    execFileSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  if (gitRoot !== worktree) throw new Error("--worktree must point to the Git worktree root");
  const gitCommonDir = await realpath(
    execFileSync(
      "git",
      ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim(),
  );
  return {
    worktree,
    gitCommonDir,
    stateRoot: join(gitCommonDir, "sns-marketing-harness"),
  };
}

function currentHead(worktree) {
  return execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function assertClean(worktree) {
  const status = execFileSync(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Worktree must be clean at gate release");
}

const args = parseArgs(process.argv.slice(2));
const taskId = args.task;
const role = args.role;
const leaseId = args["lease-id"];
const outcome = args.outcome;

if (!/^[A-Z][A-Z0-9-]{2,50}$/.test(taskId ?? "")) throw new Error("Invalid --task");
if (!/^(implementer|reviewer)$/.test(role ?? "")) throw new Error("Invalid --role");
if (!/^[0-9a-f-]{36}$/i.test(leaseId ?? "")) throw new Error("Invalid --lease-id");
if (args.actor !== "ceo") throw new Error("Only --actor ceo may release a lease");

const allowed =
  role === "implementer"
    ? new Set(["SELF_TESTED", "BLOCKED", "ABANDONED"])
    : new Set([
        "PASS",
        "DOCS_PASS",
        "HARNESS_LOCAL_PASS",
        "FAIL",
        "BLOCKED",
        "ABANDONED",
      ]);
if (!allowed.has(outcome)) throw new Error(`Invalid outcome ${outcome}`);

const localGovernancePassOutcomes = new Set(["DOCS_PASS", "HARNESS_LOCAL_PASS"]);
const reviewFailureOutcomes = new Set(["FAIL", "BLOCKED"]);

const { worktree, gitCommonDir, stateRoot } = await gitContext(args.worktree);
const activeDir = join(stateRoot, "leases", "active");
const archiveDir = join(stateRoot, "leases", "archive");
const activePath = join(activeDir, `${taskId}.${role}.json`);
const lease = JSON.parse(await readFile(activePath, "utf8"));

if (lease.leaseId !== leaseId) throw new Error("Lease ID does not match active lease");
if (lease.worktree !== worktree || lease.gitCommonDir !== gitCommonDir) {
  throw new Error("Lease belongs to a different Git worktree or repository");
}
if (
  Date.parse(lease.expiresAt) <= Date.now() &&
  (outcome === "SELF_TESTED" || outcome === "PASS")
) {
  throw new Error("Expired lease cannot produce SELF_TESTED or PASS");
}
if (Date.parse(lease.expiresAt) <= Date.now() && localGovernancePassOutcomes.has(outcome)) {
  throw new Error("Expired lease cannot produce a local governance pass");
}

const fixedSha = args["fixed-sha"];
if (outcome === "SELF_TESTED") {
  if (!/^[a-f0-9]{40}$/i.test(fixedSha ?? "")) {
    throw new Error("SELF_TESTED requires a full 40-character --fixed-sha");
  }
  if (currentHead(worktree) !== fixedSha) {
    throw new Error("Implementer worktree HEAD must equal --fixed-sha");
  }
  assertClean(worktree);
}

if (role === "reviewer" && outcome === "PASS") {
  if (currentHead(worktree) !== lease.fixedCommitSha) {
    throw new Error("Reviewer worktree HEAD changed after review started");
  }
  assertClean(worktree);

  const verdictPath = resolve(args["verdict-file"] ?? "");
  if (!args["verdict-file"]) throw new Error("Reviewer PASS requires --verdict-file");
  execFileSync(
    process.execPath,
    [
      resolve(scriptDir, "validate-review-verdict.mjs"),
      verdictPath,
      "--project-root",
      worktree,
      "--state-root",
      stateRoot,
    ],
    { stdio: "inherit" },
  );
  const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
  const implementationLeases = (await readJsonFiles(archiveDir)).filter(
    (candidate) =>
      candidate.taskId === taskId &&
      candidate.role === "implementer" &&
      candidate.leaseId === lease.implementationLeaseId &&
      candidate.outcome === "SELF_TESTED",
  );
  const implementation = implementationLeases[0];
  if (!implementation) throw new Error("Matching SELF_TESTED implementation lease not found");
  if (
    verdict.verdict !== "PASS" ||
    verdict.taskId !== taskId ||
    verdict.fixedCommitSha !== lease.fixedCommitSha ||
    verdict.implementationLeaseId !== implementation.leaseId ||
    verdict.reviewLeaseId !== lease.leaseId ||
    verdict.implementerSession !== implementation.agentSession ||
    verdict.reviewerSession !== lease.agentSession
  ) {
    throw new Error("PASS verdict does not match implementation and review leases");
  }

  let remotePrHead;
  try {
    remotePrHead = execFileSync(
      "git",
      [
        "-C",
        worktree,
        "ls-remote",
        "--exit-code",
        "origin",
        `refs/pull/${verdict.pullRequest}/head`,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)[0];
  } catch {
    throw new Error("Cannot verify current GitHub PR head");
  }
  if (remotePrHead !== lease.fixedCommitSha) {
    throw new Error("GitHub PR head no longer matches reviewed fixed SHA");
  }
}

if (role === "reviewer" && localGovernancePassOutcomes.has(outcome)) {
  if (currentHead(worktree) !== lease.fixedCommitSha) {
    throw new Error("Reviewer worktree HEAD changed after review started");
  }
  assertClean(worktree);

  const verdictPath = resolve(args["verdict-file"] ?? "");
  if (!args["verdict-file"]) {
    throw new Error(`Reviewer ${outcome} requires --verdict-file`);
  }
  execFileSync(
    process.execPath,
    [
      resolve(scriptDir, "validate-governance-verdict.mjs"),
      verdictPath,
      "--state-root",
      stateRoot,
    ],
    { stdio: "inherit" },
  );
  const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
  if (verdict.verdict !== outcome) {
    throw new Error("Governance verdict outcome does not match lease outcome");
  }
}

if (role === "reviewer" && reviewFailureOutcomes.has(outcome)) {
  if (currentHead(worktree) !== lease.fixedCommitSha) {
    throw new Error("Reviewer worktree HEAD changed after review started");
  }
  assertClean(worktree);

  if (!args["failure-record"]) {
    throw new Error(`Reviewer ${outcome} requires --failure-record`);
  }
  const failureRecordPath = resolve(args["failure-record"]);
  execFileSync(
    process.execPath,
    [
      resolve(scriptDir, "validate-review-failure-record.mjs"),
      failureRecordPath,
      "--state-root",
      stateRoot,
    ],
    { stdio: "inherit" },
  );
  const failureRecord = JSON.parse(await readFile(failureRecordPath, "utf8"));
  if (
    failureRecord.outcome !== outcome ||
    failureRecord.taskId !== taskId ||
    failureRecord.fixedCommitSha !== lease.fixedCommitSha ||
    failureRecord.implementationLeaseId !== lease.implementationLeaseId ||
    failureRecord.reviewLeaseId !== lease.leaseId ||
    failureRecord.reviewerSession !== lease.agentSession
  ) {
    throw new Error("Failure record does not match the review lease and outcome");
  }
}

const releasedAt = new Date().toISOString();
const archived = {
  ...lease,
  fixedCommitSha: fixedSha ?? lease.fixedCommitSha,
  status: "RELEASED",
  outcome,
  releasedBy: "ceo",
  releasedAt,
};

await mkdir(archiveDir, { recursive: true });
const timestamp = releasedAt.replaceAll(/[:.]/g, "-");
const archivePath = join(
  archiveDir,
  `${taskId}.${role}.${timestamp}.${leaseId}.json`,
);
for (const lockName of lease.resourceLocks ?? []) {
  const lockPath = join(activeDir, lockName);
  if (!(await stat(lockPath).catch(() => null))?.isFile()) {
    throw new Error(`Missing resource lock: ${lockName}`);
  }
}
const pendingArchivePath = `${archivePath}.pending`;
await writeFile(pendingArchivePath, `${JSON.stringify(archived, null, 2)}\n`, {
  flag: "wx",
});
for (const lockName of lease.resourceLocks ?? []) {
  await rename(
    join(activeDir, lockName),
    join(archiveDir, `${timestamp}.${leaseId}.${lockName}`),
  );
}
await rename(activePath, `${archivePath}.original`);
await rename(pendingArchivePath, archivePath);

process.stdout.write(`${JSON.stringify(archived, null, 2)}\n`);
