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
    id: "external-protocol-relative-url",
    pattern:
      /(?:["'`]\s*|\burl\(\s*|\b(?:src|href|action|poster|srcset|formaction)\s*=\s*)\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#"'`)\s]|$))(?=[^\s"'`)]+)/iu,
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
const srcsetAttributePattern =
  /\bsrcset\s*=\s*(?:\{\s*)?(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s>]+))/giu;
const externalProtocolRelativeCandidatePattern =
  /^\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#]|$))[^\s,]+/iu;

function hasExternalSrcsetCandidate(content) {
  for (const match of content.matchAll(srcsetAttributePattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (
      value.split(",").some((candidate) =>
        externalProtocolRelativeCandidatePattern.test(candidate.trimStart()))
    ) {
      return true;
    }
  }
  return false;
}

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

  if (
    !findings.some((finding) => finding.rule === "external-protocol-relative-url") &&
    hasExternalSrcsetCandidate(content)
  ) {
    findings.push({ file, rule: "external-protocol-relative-url" });
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
    {
      name: "protocol-relative-image.html",
      content: '<img src="//example.com/pixel" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-css.css",
      content: ".hero { background:url(//example.com/pixel); }\n",
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-unquoted.html",
      content: "<img src=//example.com/pixel />\n",
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-lookalike.html",
      content: '<img src="//localhost.example.com/pixel" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-ipv6.css",
      content: ".hero { background:url(//[2606:4700::1111]/pixel); }\n",
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-later.html",
      content: '<img srcset="/local.png 1x, //example.com/pixel 2x" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-third.html",
      content: '<img SRCSET="//localhost:4173/one.png 1x, /two.png 2x, //localhost.example.com/pixel 3x" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-jsx.tsx",
      content: 'export const image = <img srcSet={"/local.png 1x, //example.com/pixel 2x"} />;\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-multiline.html",
      content: '<img srcset="/local.png 1x,\n //example.com/pixel 2x" />\n',
      expectedRule: "external-protocol-relative-url",
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
  const allowedProtocolRelativeFixture = path.join(
    fixtureDirectory,
    "local-protocol-relative.html",
  );
  await writeFile(
    allowedProtocolRelativeFixture,
    '<img src="//localhost:4173/pixel" /><style>.hero { background:url(//127.0.0.1:4173/pixel); }</style>\n',
    "utf8",
  );
  await assertBoundaries([allowedProtocolRelativeFixture]);
  const allowedSrcsetFixture = path.join(fixtureDirectory, "local-srcset.html");
  await writeFile(
    allowedSrcsetFixture,
    '<img srcset="/one.png 1x, //localhost:4173/two.png 2x, //127.0.0.1:4173/three.png 3x" />\n',
    "utf8",
  );
  await assertBoundaries([allowedSrcsetFixture]);
  const allowedMultilineSrcsetFixture = path.join(fixtureDirectory, "local-srcset-multiline.html");
  await writeFile(
    allowedMultilineSrcsetFixture,
    '<img srcset="/one.png 1x,\n //localhost/two.png 2x,\n //127.0.0.1/three.png 3x" />\n',
    "utf8",
  );
  await assertBoundaries([allowedMultilineSrcsetFixture]);
  console.log(
    `Boundary fixtures passed: ${String(negativeFixtures.length)} forbidden cases rejected and local HTTP/protocol-relative URLs, including srcset candidates, allowed.`,
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
