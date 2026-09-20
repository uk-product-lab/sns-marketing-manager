import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const governanceApproved = args.includes("--governance-approved");
const bootstrapOnly = args.includes("--bootstrap-only");
const positional = args.filter(
  (arg) => arg !== "--governance-approved" && arg !== "--bootstrap-only",
);
const [baseSha, headSha] = positional;

if (!/^[a-f0-9]{40}$/i.test(baseSha ?? "") || !/^[a-f0-9]{40}$/i.test(headSha ?? "")) {
  throw new Error("Expected base and head 40-character SHAs");
}

function gitShow(sha, path) {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function parseRegressionManifest(text) {
  const rows = new Map();
  if (!text) return rows;
  for (const match of text.matchAll(
    /^\|\s*(REG-[A-Z0-9-]+)\s*\|\s*(PLANNED|REQUIRED)\s*\|\s*([^|]+?)\s*\|/gm,
  )) {
    rows.set(match[1], { status: match[2], scenario: match[3].trim() });
  }
  return rows;
}

function assertMonotonicRegressionManifest() {
  const base = parseRegressionManifest(
    gitShow(baseSha, "harness/regression_manifest.md"),
  );
  const head = parseRegressionManifest(
    gitShow(headSha, "harness/regression_manifest.md"),
  );
  if (base.size === 0) {
    throw new Error("Creating the regression manifest requires a governance PR");
  }
  for (const [id, before] of base) {
    const after = head.get(id);
    if (!after) throw new Error(`Regression scenario removed: ${id}`);
    if (before.scenario !== after.scenario) {
      throw new Error(`Regression scenario text changed outside governance: ${id}`);
    }
    if (before.status === "REQUIRED" && after.status !== "REQUIRED") {
      throw new Error(`REQUIRED regression scenario was weakened: ${id}`);
    }
  }
  for (const id of head.keys()) {
    if (!base.has(id)) throw new Error(`New regression scenario requires governance: ${id}`);
  }
}

function qualityScriptsChanged() {
  const beforeText = gitShow(baseSha, "package.json");
  const afterText = gitShow(headSha, "package.json");
  if (!beforeText && afterText) return true;
  if (!beforeText || !afterText) return false;
  const before = JSON.parse(beforeText);
  const after = JSON.parse(afterText);
  const names = [
    "typecheck",
    "lint",
    "build",
    "test:migrate",
    "test:unit",
    "test:e2e:chromium",
    "test:e2e:webkit-mobile",
    "test:a11y",
    "test:smoke",
  ];
  return names.some((name) => before.scripts?.[name] !== after.scripts?.[name]);
}

const changed = execFileSync(
  "git",
  ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, headSha],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const sourceChanges = changed.filter((path) => path === "sources" || path.startsWith("sources/"));
if (sourceChanges.length > 0) {
  throw new Error(`Read-only sources changed:\n${sourceChanges.join("\n")}`);
}

const regressionPath = "harness/regression_manifest.md";
if (changed.includes(regressionPath) && !governanceApproved) {
  assertMonotonicRegressionManifest();
}

const protectedExact = new Set([
  "AGENTS.md",
  "Harness.md",
  "CLAUDE.md",
  "Plan.md",
]);
const protectedPrefixes = [".github/", "harness/", "skills/"];
const governanceDocumentation = new Set(["README.md"]);
let protectedChanges = changed.filter(
  (path) =>
    path !== regressionPath &&
    (protectedExact.has(path) ||
      protectedPrefixes.some((prefix) => path.startsWith(prefix))),
);

if (changed.includes("package.json") && qualityScriptsChanged()) {
  protectedChanges = [...protectedChanges, "package.json"];
}

if (protectedChanges.length > 0 && !governanceApproved) {
  throw new Error(
    `Protected harness changes require a dedicated governance PR and governance:approved label:\n${protectedChanges.join("\n")}`,
  );
}

if (governanceApproved) {
  const governanceAllowed = changed.filter(
    (path) =>
      path === regressionPath ||
      protectedExact.has(path) ||
      protectedPrefixes.some((prefix) => path.startsWith(prefix)) ||
      governanceDocumentation.has(path) ||
      path === "package.json",
  );
  if (governanceAllowed.length !== changed.length) {
    const mixed = changed.filter((path) => !governanceAllowed.includes(path));
    throw new Error(`Governance PR must not mix product changes:\n${mixed.join("\n")}`);
  }
}

if (bootstrapOnly && !governanceApproved) {
  const bootstrapAllowed = changed.every(
    (path) =>
      path === regressionPath ||
      protectedExact.has(path) ||
      protectedPrefixes.some((prefix) => path.startsWith(prefix)) ||
      governanceDocumentation.has(path),
  );
  if (!bootstrapAllowed) {
    throw new Error("Product changes require package.json and real quality scripts");
  }
}

process.stdout.write(
  `Diff policy passed for ${changed.length} changed files (${governanceApproved ? "governance" : "product"})\n`,
);
