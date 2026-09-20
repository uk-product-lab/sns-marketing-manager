import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const projectRoot = resolve(argv[0] ?? ".");
const gitRefIndex = argv.indexOf("--git-ref");
const gitRef = gitRefIndex >= 0 ? argv[gitRefIndex + 1] : null;
if (gitRefIndex >= 0 && !/^[a-f0-9]{40}$/i.test(gitRef ?? "")) {
  throw new Error("--git-ref must be a full 40-character commit SHA");
}
const roots = [
  join(projectRoot, ".github", "workflows"),
  join(projectRoot, "harness", "canaries"),
];
const failures = [];
let checked = 0;
const rubyYamlToJson = String.raw`
source = STDIN.read
document = YAML.safe_load(
  source,
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false
)
STDOUT.write(JSON.generate(document))
`;

async function yamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await yamlFiles(path));
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path);
  }
  return files;
}

async function workflowDocuments() {
  if (gitRef) {
    const names = execFileSync(
      "git",
      ["-C", projectRoot, "ls-tree", "-r", "--name-only", gitRef],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(
        (path) =>
          /^\.github\/workflows\/.*\.ya?ml$/i.test(path) ||
          /^harness\/canaries\/.*\.ya?ml$/i.test(path),
      );
    return names.map((path) => ({
      displayPath: path,
      text: execFileSync(
        "git",
        ["-C", projectRoot, "show", `${gitRef}:${path}`],
        { encoding: "utf8" },
      ),
    }));
  }
  const documents = [];
  for (const root of roots) {
    for (const file of await yamlFiles(root)) {
      documents.push({
        displayPath: relative(projectRoot, file),
        text: await readFile(file, "utf8"),
      });
    }
  }
  return documents;
}

function parseYaml(text, displayPath) {
  try {
    return JSON.parse(
      execFileSync(
        "ruby",
        ["-ryaml", "-rjson", "-e", rubyYamlToJson],
        {
          encoding: "utf8",
          input: text,
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    );
  } catch (error) {
    throw new Error(
      `Workflow YAML could not be safely parsed: ${displayPath}\n${error.stderr ?? error.message}`,
    );
  }
}

function inspectUses(node, displayPath, objectPath = "$") {
  if (Array.isArray(node)) {
    node.forEach((value, index) =>
      inspectUses(value, displayPath, `${objectPath}[${index}]`),
    );
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    const nextPath = `${objectPath}.${key}`;
    if (key === "uses") {
      checked += 1;
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[a-f0-9]{40}$/i.test(value)
      ) {
        failures.push(
          `${displayPath} ${nextPath} ${JSON.stringify(value)}`,
        );
      }
    }
    inspectUses(value, displayPath, nextPath);
  }
}

for (const { displayPath, text } of await workflowDocuments()) {
  inspectUses(parseYaml(text, displayPath), displayPath);
}

if (checked === 0) {
  throw new Error("No external GitHub Actions references were found");
}
if (failures.length > 0) {
  throw new Error(
    `External GitHub Actions must use immutable 40-character commit SHAs:\n${failures.join("\n")}`,
  );
}
process.stdout.write(`Action pin policy passed for ${checked} references\n`);
