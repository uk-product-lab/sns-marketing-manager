import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import ts from "typescript";

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
    id: "external-sns-or-paid-service",
    pattern:
      /(?:api\.(?:x|twitter)\.com|graph\.(?:facebook|instagram)\.com|open\.tiktokapis\.com|note\.com\/api|api\.resend\.com|api\.sendgrid\.com|api\.stripe\.com|drive\.googleapis\.com|r2\.cloudflarestorage\.com)/iu,
  },
  {
    id: "paid-service-package",
    pattern: /["'](?:stripe|resend|@sendgrid\/mail|openai|@aws-sdk\/client-s3)["']\s*:/iu,
  },
];

const localBase = "http://localhost/";
const urlAttributes = new Set(["src", "href", "action", "poster", "formaction", "xlink:href"]);
const srcsetAttributes = new Set(["srcset", "imagesrcset"]);
const scriptExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const asciiWhitespace = /[\t\n\f\r ]/u;
const maxStaticUrlLength = 16_384;
const maxSrcsetCandidates = 1_000;

function addFinding(findings, file, rule) {
  if (!findings.some((finding) => finding.file === file && finding.rule === rule)) {
    findings.push({ file, rule });
  }
}

function urlRule(value, { allowData = false } = {}) {
  if (value.length > maxStaticUrlLength) return "network-target-dynamic";
  let resolved;
  try {
    resolved = new URL(value, localBase);
  } catch {
    return "network-target-dynamic";
  }
  if (allowData && resolved.protocol === "data:") return null;
  if (
    (resolved.protocol === "http:" || resolved.protocol === "https:") &&
    (resolved.hostname === "localhost" || resolved.hostname === "127.0.0.1")
  ) {
    return null;
  }
  const normalized = value.replace(/[\t\n\f\r]/gu, "").trimStart();
  return /^[\\/]/u.test(normalized) ? "external-protocol-relative-url" : "external-url";
}

function inspectUrl(value, file, findings, options) {
  const rule = urlRule(value, options);
  if (rule !== null) addFinding(findings, file, rule);
}

// Match the HTML srcset tokenization boundary: commas inside a URL (including a data URL)
// do not end that URL; commas after descriptors or at the URL's end do.
function srcsetUrls(value) {
  if (value.length > maxStaticUrlLength) return null;
  const urls = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (asciiWhitespace.test(value[index]) || value[index] === ",")) {
      index += 1;
    }
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !asciiWhitespace.test(value[index])) index += 1;
    const token = value.slice(start, index);
    const url = token.replace(/,+$/u, "");
    if (url) urls.push(url);
    if (urls.length > maxSrcsetCandidates) return null;
    if (token.endsWith(",")) continue;
    let parentheses = 0;
    while (index < value.length) {
      const character = value[index];
      index += 1;
      if (character === "(") parentheses += 1;
      else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (character === "," && parentheses === 0) break;
    }
  }
  return urls;
}

function inspectSrcset(value, file, findings) {
  const urls = srcsetUrls(value);
  if (urls === null) {
    addFinding(findings, file, "network-target-dynamic");
    return;
  }
  for (const url of urls) inspectUrl(url, file, findings, { allowData: true });
}

function decodeCssEscapes(value) {
  return value.replace(/\\([0-9a-fA-F]{1,6})(?:[\t\n\f\r ]|\r\n)?|\\(\r\n|[\n\f\r])|\\(.)/gu,
    (_match, hex, continuation, character) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return continuation ? "" : character;
    });
}

function inspectCss(content, file, findings) {
  const css = decodeCssEscapes(content.replace(/\/\*[\s\S]*?\*\//gu, ""));
  const urlFunctions = [...css.matchAll(/\burl\s*\(([^)]*)\)/giu)];
  for (const match of urlFunctions) {
    const argument = match[1].trim();
    const quote = argument[0];
    const isQuoted = quote === '"' || quote === "'";
    if (isQuoted && !argument.endsWith(quote)) {
      addFinding(findings, file, "network-target-dynamic");
      continue;
    }
    const value = isQuoted ? argument.slice(1, -1) : argument;
    inspectUrl(value, file, findings, { allowData: true });
  }
  const urlOpenings = [...css.matchAll(/\burl\s*\(/giu)];
  if (urlOpenings.length !== urlFunctions.length) addFinding(findings, file, "network-target-dynamic");
  for (const match of css.matchAll(/@import\s+(["'])([\s\S]*?)\1/giu)) {
    inspectUrl(match[2], file, findings);
  }
  for (const match of css.matchAll(/(["'])([^"']*)\1/gu)) {
    if (looksUrlLike(match[2])) inspectUrl(match[2], file, findings, { allowData: true });
  }
}

function inspectHtml(content, file, findings, depth = 0) {
  if (depth > 8) {
    addFinding(findings, file, "network-target-dynamic");
    return;
  }
  const fragment = JSDOM.fragment(content);
  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (srcsetAttributes.has(name)) inspectSrcset(value, file, findings);
      else if (urlAttributes.has(name)) {
        inspectUrl(value, file, findings, {
          allowData: name === "src" && ["img", "source"].includes(element.localName),
        });
      } else if (name === "data" && element.localName === "object") {
        inspectUrl(value, file, findings);
      } else if (name === "ping" && ["a", "area"].includes(element.localName)) {
        for (const target of value.split(/[\t\n\f\r ]+/u).filter(Boolean)) {
          inspectUrl(target, file, findings);
        }
      } else if (name === "style") inspectCss(value, file, findings);
      else if (name === "srcdoc") inspectHtml(value, file, findings, depth + 1);
      else if (/^on[a-z]+$/u.test(name)) inspectScript(value, file, findings, ".js");
    }
    if (element.localName === "style") inspectCss(element.textContent, file, findings);
    if (element.localName === "template") inspectHtml(element.innerHTML, file, findings, depth + 1);
    if (element.localName === "script" && !element.hasAttribute("src")) {
      inspectScript(element.textContent, file, findings, ".js");
    }
    if (
      element.localName === "meta" &&
      element.getAttribute("http-equiv")?.toLowerCase() === "refresh"
    ) {
      const target = element.getAttribute("content")?.match(/\burl\s*=\s*([\s\S]*)/iu)?.[1];
      if (target !== undefined) inspectUrl(target.replace(/^["']|["']$/gu, ""), file, findings);
    }
  }
}

const htmlEntityDecoder = JSDOM.fragment("<textarea></textarea>").firstChild;

function decodeJsxAttribute(value) {
  if (/[<>]/u.test(value)) return null;
  htmlEntityDecoder.innerHTML = value;
  return htmlEntityDecoder.value;
}

function staticString(expression) {
  let node = expression;
  while (
    node &&
    (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression;
  }
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function looksUrlLike(value) {
  return /^(?:https?:|data:|blob:|[\\/])/iu.test(value.replace(/[\t\n\f\r]/gu, "").trimStart());
}

function inspectScript(content, file, findings, extension) {
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX
    : extension === ".jsx" ? ts.ScriptKind.JSX
      : extension === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length > 0) addFinding(findings, file, "network-target-dynamic");
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
            ? callee.argumentExpression.text : null;
      if (name === "XMLHttpRequest") {
        addFinding(findings, file, "network-client-unscoped");
      } else if (["insertAdjacentHTML", "write"].includes(name)) {
        addFinding(findings, file, "network-target-dynamic");
      } else if (["fetch", "WebSocket", "EventSource", "sendBeacon"].includes(name)) {
        const target = node.arguments?.[0] && staticString(node.arguments[0]);
        if (target === null || target === undefined) {
          addFinding(findings, file, "network-target-dynamic");
        } else if (urlRule(target) !== null) {
          addFinding(findings, file, "network-target-nonlocal");
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ["innerHTML", "outerHTML"].includes(node.left.name.text)
    ) {
      addFinding(findings, file, "network-target-dynamic");
    }
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text.toLowerCase() : null;
      if (name === "__html") addFinding(findings, file, "network-target-dynamic");
      else if (urlAttributes.has(name) || srcsetAttributes.has(name)) {
        const value = staticString(node.initializer);
        if (value === null) addFinding(findings, file, "network-target-dynamic");
        else if (srcsetAttributes.has(name)) inspectSrcset(value, file, findings);
        else inspectUrl(value, file, findings, { allowData: name === "src" });
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source).toLowerCase();
      if (name === "dangerouslysetinnerhtml") {
        addFinding(findings, file, "network-target-dynamic");
      } else if (urlAttributes.has(name) || srcsetAttributes.has(name)) {
        let value = null;
        if (node.initializer && ts.isStringLiteral(node.initializer)) {
          value = decodeJsxAttribute(node.initializer.text);
        } else if (node.initializer && ts.isJsxExpression(node.initializer)) {
          value = staticString(node.initializer.expression);
        }
        if (value === null) addFinding(findings, file, "network-target-dynamic");
        else if (srcsetAttributes.has(name)) inspectSrcset(value, file, findings);
        else inspectUrl(value, file, findings, { allowData: name === "src" });
      }
    } else if (ts.isJsxSpreadAttribute(node)) {
      addFinding(findings, file, "network-target-dynamic");
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (looksUrlLike(node.text)) inspectUrl(node.text, file, findings, { allowData: true });
      if (/\burl\s*\(|@import\b/iu.test(node.text)) inspectCss(node.text, file, findings);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function inspectJson(content, file, findings) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    addFinding(findings, file, "network-target-dynamic");
    return;
  }
  function visit(value) {
    if (typeof value === "string" && looksUrlLike(value)) {
      inspectUrl(value, file, findings, { allowData: true });
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry);
    }
  }
  visit(parsed);
}

function inspectRawConfig(content, file, findings) {
  for (const match of content.matchAll(/(?:https?:\/\/|\/\/)[^\s"'`<>),;]+/giu)) {
    inspectUrl(match[0], file, findings);
  }
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
      addFinding(findings, file, rule.id);
    }
  }
  // Keep the broad absolute-URL check, but let the URL parser—not a hostname prefix regex—decide locality.
  for (const match of content.matchAll(/https?:\/\/[^\s"'`<>),;]+/giu)) {
    inspectUrl(match[0], file, findings);
  }

  const extension = path.extname(file);
  if (extension === ".html") inspectHtml(content, file, findings);
  else if (extension === ".css") inspectCss(content, file, findings);
  else if (scriptExtensions.has(extension)) inspectScript(content, file, findings, extension);
  else if (extension === ".json") inspectJson(content, file, findings);
  else inspectRawConfig(content, file, findings);

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
      name: "protocol-relative-css-escape.css",
      content: ".hero { background:url(\\2f \\2f example.com/pixel); }\n",
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-css-escaped-function.css",
      content: ".hero { background:u\\72l(//example.com/pixel); }\n",
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-css-image-set.css",
      content: '.hero { background:image-set("//example.com/pixel" 1x); }\n',
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
    {
      name: "protocol-relative-srcset-entity.html",
      content: '<img srcset="/local.png 1x, &#47;&#47;example.com/pixel 2x" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-named-entity.html",
      content: '<img srcset="/local.png 1x, &sol;&sol;example.com/pixel 2x" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-data-then-external.html",
      content: '<img srcset="data:image/png;base64,AAAA 1x, //example.com/pixel 2x" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-src-line-feed.html",
      content: '<img src="/\n/example.com/pixel" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-src-backslash.html",
      content: '<img src="/\\example.com/pixel" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-userinfo.html",
      content: '<img src="//localhost@evil.example/pixel" />\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-template.html",
      content: '<template><img src="//example.com/pixel" /></template>\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-object.html",
      content: '<object data="//example.com/pixel"></object>\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-ping.html",
      content: '<a href="/local" ping="/local //example.com/pixel">Open</a>\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-parenthesized.tsx",
      content: 'export const image = <img srcSet={("/local.png 1x, //example.com/pixel 2x")} />;\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-srcset-entity.tsx",
      content: 'export const image = <img srcSet="/local.png 1x, &#47;&#47;example.com/pixel 2x" />;\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "external-absolute-url.html",
      content: '<img src="https://example.com/pixel" />\n',
      expectedRule: "external-url",
    },
    {
      name: "embedded-external-absolute-url.ts",
      content: 'export const note = "image: https://example.com/pixel";\n',
      expectedRule: "external-url",
    },
    {
      name: "dynamic-jsx-url.tsx",
      content: 'export const image = <img src={imageUrl} />;\n',
      expectedRule: "network-target-dynamic",
    },
    {
      name: "dynamic-jsx-spread.tsx",
      content: 'export const image = <img {...imageProps} />;\n',
      expectedRule: "network-target-dynamic",
    },
    {
      name: "dynamic-concatenated-request.ts",
      content: 'export const request = () => fetch("/" + "/example.com/pixel");\n',
      expectedRule: "network-target-dynamic",
    },
    {
      name: "protocol-relative-jsx-style.tsx",
      content: 'export const image = <div style={{ backgroundImage: "url(//example.com/pixel)" }} />;\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "protocol-relative-create-element.ts",
      content: 'export const image = React.createElement("img", { srcSet: "/local.png 1x, //example.com/pixel 2x" });\n',
      expectedRule: "external-protocol-relative-url",
    },
    {
      name: "dynamic-injected-html.tsx",
      content: 'export const image = <div dangerouslySetInnerHTML={{ __html: "<img src=&#47;&#47;example.com>" }} />;\n',
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
  const allowedDataSrcsetFixture = path.join(fixtureDirectory, "local-data-srcset.html");
  await writeFile(
    allowedDataSrcsetFixture,
    '<img srcset="data:image/png;base64,AAAA 1x, //localhost:4173/two.png 2x" />\n',
    "utf8",
  );
  await assertBoundaries([allowedDataSrcsetFixture]);
  const allowedNormalizedLocalFixture = path.join(fixtureDirectory, "local-normalized.html");
  await writeFile(
    allowedNormalizedLocalFixture,
    '<img src="/\n/localhost/pixel" srcset="/local.png 1x, &sol;&sol;127.0.0.1:4173/two.png 2x" />\n',
    "utf8",
  );
  await assertBoundaries([allowedNormalizedLocalFixture]);
  const allowedParenthesizedJsxFixture = path.join(fixtureDirectory, "local-parenthesized.tsx");
  await writeFile(
    allowedParenthesizedJsxFixture,
    'export const image = <img srcSet={("/local.png 1x, //localhost:4173/two.png 2x")} />;\n',
    "utf8",
  );
  await assertBoundaries([allowedParenthesizedJsxFixture]);
  const allowedParenthesizedRequestFixture = path.join(fixtureDirectory, "local-parenthesized-request.ts");
  await writeFile(
    allowedParenthesizedRequestFixture,
    'export const request = () => fetch(("http://localhost:4173/health"));\n',
    "utf8",
  );
  await assertBoundaries([allowedParenthesizedRequestFixture]);
  const allowedCssImageSetFixture = path.join(fixtureDirectory, "local-image-set.css");
  await writeFile(
    allowedCssImageSetFixture,
    '.hero { background:image-set("//localhost:4173/one.png" 1x, "/two.png" 2x); }\n',
    "utf8",
  );
  await assertBoundaries([allowedCssImageSetFixture]);
  const allowedTemplateFixture = path.join(fixtureDirectory, "local-template.html");
  await writeFile(
    allowedTemplateFixture,
    '<template><img src="//localhost:4173/pixel" /></template>\n',
    "utf8",
  );
  await assertBoundaries([allowedTemplateFixture]);
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
console.log(
  "Static-scan limit: computed URLs, aliased network clients, and runtime DOM changes still require browser network review.",
);
