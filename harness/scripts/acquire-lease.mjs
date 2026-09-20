import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

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

function requireText(args, key, pattern = /.+/) {
  const value = args[key];
  if (!value || !pattern.test(value)) throw new Error(`Missing or invalid --${key}`);
  return value;
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
  let gitRoot;
  let gitCommonDir;
  try {
    gitRoot = await realpath(
      execFileSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    );
    gitCommonDir = await realpath(
      execFileSync(
        "git",
        ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8" },
      ).trim(),
    );
  } catch {
    throw new Error("--worktree must be a Git worktree");
  }
  if (gitRoot !== worktree) {
    throw new Error("--worktree must point to the Git worktree root");
  }
  return {
    worktree,
    gitCommonDir,
    stateRoot: join(gitCommonDir, "sns-marketing-harness"),
  };
}

const args = parseArgs(process.argv.slice(2));
const taskId = requireText(args, "task", /^[A-Z][A-Z0-9-]{2,50}$/);
const role = requireText(args, "role", /^(implementer|reviewer)$/);
const agent = requireText(args, "agent", /^(codex|claude)$/);
const agentSession = requireText(args, "agent-session", /^[A-Za-z0-9._:-]{3,120}$/);
const branch = requireText(args, "branch", /^[A-Za-z0-9._/-]{3,200}$/);
const { worktree, gitCommonDir, stateRoot } = await gitContext(
  requireText(args, "worktree"),
);
const activeDir = join(stateRoot, "leases", "active");
const archiveDir = join(stateRoot, "leases", "archive");
const ttlHours = Number(args["ttl-hours"] ?? "4");

if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24) {
  throw new Error("--ttl-hours must be greater than 0 and at most 24");
}

const fixedSha = args["fixed-sha"];
if (role === "reviewer" && !/^[a-f0-9]{40}$/i.test(fixedSha ?? "")) {
  throw new Error("Reviewer lease requires a full 40-character --fixed-sha");
}

if (role === "implementer") {
  const actualBranch = execFileSync(
    "git",
    ["-C", worktree, "branch", "--show-current"],
    { encoding: "utf8" },
  ).trim();
  if (actualBranch !== branch) {
    throw new Error(`Implementer worktree is on ${actualBranch || "detached HEAD"}, not ${branch}`);
  }
} else {
  const actualSha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actualSha !== fixedSha) throw new Error("Reviewer worktree HEAD must equal --fixed-sha");
  const status = execFileSync(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  if (status) throw new Error("Reviewer worktree must be clean before review");
}

await mkdir(activeDir, { recursive: true });
await mkdir(archiveDir, { recursive: true });

const activeLeases = await readJsonFiles(activeDir);
for (const lease of activeLeases) {
  if (lease.branch === branch || lease.worktree === worktree) {
    const expired = Date.parse(lease.expiresAt) <= Date.now();
    throw new Error(
      `Lease conflict with ${lease.leaseId}${expired ? " (expired; CEO must archive it)" : ""}`,
    );
  }
}

let implementationLease = null;
if (role === "reviewer") {
  const archived = (await readJsonFiles(archiveDir))
    .filter(
      (lease) =>
        lease.taskId === taskId &&
        lease.role === "implementer" &&
        lease.outcome === "SELF_TESTED",
    )
    .sort((a, b) => String(b.releasedAt).localeCompare(String(a.releasedAt)));
  implementationLease = archived[0];
  if (!implementationLease) {
    throw new Error("Reviewer lease requires an archived SELF_TESTED implementation lease");
  }
  if (implementationLease.agentSession === agentSession) {
    throw new Error("Reviewer session must differ from implementer session");
  }
  if (implementationLease.worktree === worktree) {
    throw new Error("Reviewer worktree must differ from implementer worktree");
  }
  if (implementationLease.fixedCommitSha !== fixedSha) {
    throw new Error("Reviewer fixed SHA must match the SELF_TESTED implementation SHA");
  }
}

const startedAt = new Date();
const leaseId = randomUUID();
const resourceLocks = [
  `branch-${createHash("sha256").update(branch).digest("hex")}.lock`,
  `worktree-${createHash("sha256").update(worktree).digest("hex")}.lock`,
];
const lease = {
  leaseId,
  taskId,
  role,
  agent,
  agentSession,
  branch,
  worktree,
  gitCommonDir,
  stateRoot,
  implementationLeaseId: implementationLease?.leaseId ?? null,
  fixedCommitSha: fixedSha ?? null,
  startedAt: startedAt.toISOString(),
  expiresAt: new Date(startedAt.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
  status: "ACTIVE",
  resourceLocks,
};

const leasePath = join(activeDir, `${taskId}.${role}.json`);
const createdLocks = [];
try {
  for (const lockName of resourceLocks) {
    const lockPath = join(activeDir, lockName);
    const lockHandle = await open(lockPath, "wx");
    try {
      await lockHandle.writeFile(
        `${JSON.stringify({
          leaseId,
          taskId,
          role,
          branch,
          worktree,
          expiresAt: lease.expiresAt,
        }, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await lockHandle.close();
    }
    createdLocks.push(lockPath);
  }

  const handle = await open(leasePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
} catch (error) {
  await Promise.all(createdLocks.map((path) => unlink(path).catch(() => undefined)));
  throw error;
}

process.stdout.write(`${JSON.stringify(lease, null, 2)}\n`);
