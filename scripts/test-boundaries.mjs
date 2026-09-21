import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const productionTargets = [
  "src",
  "migrations",
  "package.json",
  "vite.config.ts",
  "wrangler.toml",
];
const inspectedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
]);

const forbiddenPatterns = [
  {
    id: "secret-private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    id: "secret-assignment",
    pattern:
      /["'`]?(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)["'`]?\s*[:=]\s*(?:"[^"\s]{8,}"|'[^'\s]{8,}'|`[^`\s]{8,}`|[A-Za-z0-9_./+=-]{12,})/iu,
  },
  {
    id: "external-url",
    pattern: /https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|["'`]))[^\s"'`)]+/iu,
  },
  {
    id: "external-sns-or-paid-service",
    pattern:
      /(?:api\.(?:x|twitter)\.com|graph\.(?:facebook|instagram)\.com|open\.tiktokapis\.com|note\.com\/api|api\.resend\.com|api\.sendgrid\.com|api\.stripe\.com|drive\.googleapis\.com|r2\.cloudflarestorage\.com)/iu,
  },
  {
    id: "paid-service-package",
    pattern: /["'](?:stripe|resend|@sendgrid\/mail|openai|@aws-sdk\/client-s3)["']\s*:/iu,
  },
];

const networkCallPattern =
  /\b(?:fetch|WebSocket|EventSource|navigator\.sendBeacon)\s*\(\s*([^,\n)]+)/gu;
const unscopedNetworkPattern = /\bXMLHttpRequest\s*\(/u;
const allowedNetworkTargetPattern =
  /^(?:\/(?!\/)|\.\.?\/|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$))/u;

class BoundaryViolation extends Error {
  constructor(findings) {
    super(
      `Boundary check rejected ${String(findings.length)} finding(s):\n${findings
        .map((finding) => `- ${finding.file}: ${finding.rule}`)
        .join("\n")}`,
    );
    this.name = "BoundaryViolation";
    this.findings = findings;
  }
}

async function collectFiles(target) {
  const absoluteTarget = path.resolve(projectRoot, target);
  const entries = await readdir(absoluteTarget, { withFileTypes: true }).catch(() => null);

  if (!entries) {
    return inspectedExtensions.has(path.extname(absoluteTarget)) ? [absoluteTarget] : [];
  }

  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(absoluteTarget, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(path.relative(projectRoot, entryPath));
      }
      return inspectedExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
    }),
  );
  return nestedFiles.flat();
}

function inspectContent(file, content) {
  const findings = [];

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(content)) {
      findings.push({ file, rule: rule.id });
    }
  }

  for (const match of content.matchAll(networkCallPattern)) {
    const rawArgument = match[1]?.trim() ?? "";
    const quote = rawArgument[0];
    const isQuoted = quote === '"' || quote === "'" || quote === "`";
    const target = isQuoted && rawArgument.endsWith(quote)
      ? rawArgument.slice(1, -1)
      : null;

    if (target === null) {
      findings.push({ file, rule: "network-target-dynamic" });
    } else if (!allowedNetworkTargetPattern.test(target)) {
      findings.push({ file, rule: "network-target-nonlocal" });
    }
  }

  if (unscopedNetworkPattern.test(content)) {
    findings.push({ file, rule: "network-client-unscoped" });
  }

  return findings;
}

async function assertBoundaries(files) {
  const findings = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    findings.push(...inspectContent(path.relative(projectRoot, file), content));
  }

  if (findings.length > 0) {
    throw new BoundaryViolation(findings);
  }
}

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "sns-boundary-fixtures-"));
try {
  const negativeFixtures = [
    {
      name: "secret.json",
      content: '{"client_secret":"synthetic-not-a-real-secret"}\n',
      expectedRule: "secret-assignment",
    },
    {
      name: "paid-package.json",
      content: '{"dependencies":{"stripe":"0.0.0-synthetic"}}\n',
      expectedRule: "paid-service-package",
    },
    {
      name: "sns-request.ts",
      content: 'export const publish = () => fetch("https://api.x.com/2/tweets");\n',
      expectedRule: "external-sns-or-paid-service",
    },
    {
      name: "dynamic-request.ts",
      content: "export const request = (endpoint) => fetch(endpoint);\n",
      expectedRule: "network-target-dynamic",
    },
  ];

  for (const fixture of negativeFixtures) {
    const fixturePath = path.join(fixtureDirectory, fixture.name);
    await writeFile(fixturePath, fixture.content, "utf8");
    await assert.rejects(
      assertBoundaries([fixturePath]),
      (error) =>
        error instanceof BoundaryViolation &&
        error.findings.some((finding) => finding.rule === fixture.expectedRule),
      `The boundary scanner must reject ${fixture.name} with ${fixture.expectedRule}.`,
    );
  }

  const allowedFixture = path.join(fixtureDirectory, "local-request.ts");
  await writeFile(
    allowedFixture,
    'export const check = () => fetch("http://127.0.0.1:4173/health");\n',
    "utf8",
  );
  await assertBoundaries([allowedFixture]);
  console.log(
    `Boundary fixtures passed: ${String(negativeFixtures.length)} forbidden categories rejected and local HTTP allowed.`,
  );
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}

const productionFiles = (
  await Promise.all(productionTargets.map((target) => collectFiles(target)))
).flat();
await assertBoundaries(productionFiles);
console.log(
  `Boundary check passed: ${String(productionFiles.length)} production source/config files contain no detected secret literals, paid/SNS endpoints, or non-local network targets.`,
);
