import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const wranglerCli = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const stateDirectory = await mkdtemp(path.join(tmpdir(), "sns-d1-migration-"));
const childTimeoutMs = 60_000;

function runWrangler(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerCli, ...argumentsList], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_API_TOKEN: "",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, childTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Wrangler exceeded the ${String(childTimeoutMs)}ms timeout.`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Wrangler exited with ${String(code)}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseWranglerJson(output) {
  const starts = [...output.matchAll(/\[/gu)].map((match) => match.index ?? -1);
  const ends = [...output.matchAll(/\]/gu)].map((match) => match.index ?? -1).reverse();

  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) {
        continue;
      }
      try {
        const parsed = JSON.parse(output.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Continue until a complete JSON array is found among Wrangler diagnostics.
      }
    }
  }

  throw new Error(`Wrangler did not return a parseable JSON array:\n${output}`);
}

const localArguments = [
  "--local",
  "--persist-to",
  stateDirectory,
  "--config",
  path.join(projectRoot, "wrangler.toml"),
];

try {
  const firstApply = await runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    ...localArguments,
  ]);
  const secondApply = await runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    ...localArguments,
  ]);

  const schemaResult = await runWrangler([
    "d1",
    "execute",
    "DB",
    ...localArguments,
    "--command",
    "PRAGMA table_info('foundation_status');",
    "--json",
  ]);
  const parsed = parseWranglerJson(schemaResult.stdout);
  const columns = parsed[0]?.results ?? [];
  const normalizedColumns = columns.map((row) => ({
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    defaultValue: row.dflt_value,
    primaryKey: row.pk,
  }));
  assert.deepEqual(normalizedColumns, [
    {
      name: "key",
      type: "TEXT",
      notnull: 1,
      defaultValue: null,
      primaryKey: 1,
    },
    {
      name: "value",
      type: "TEXT",
      notnull: 1,
      defaultValue: null,
      primaryKey: 0,
    },
    {
      name: "updated_at",
      type: "TEXT",
      notnull: 1,
      defaultValue: "CURRENT_TIMESTAMP",
      primaryKey: 0,
    },
  ]);

  const tableResult = await runWrangler([
    "d1",
    "execute",
    "DB",
    ...localArguments,
    "--command",
    "PRAGMA table_list('foundation_status');",
    "--json",
  ]);
  const tableRows = parseWranglerJson(tableResult.stdout)[0]?.results ?? [];
  const foundationTable = tableRows.find((row) => row.name === "foundation_status");
  assert.equal(foundationTable?.type, "table");
  assert.equal(foundationTable?.strict, 1, "foundation_status must remain STRICT.");

  const secondApplyOutput = `${secondApply.stdout}\n${secondApply.stderr}`;
  if (!/No migrations to apply/i.test(secondApplyOutput)) {
    throw new Error(`Second migration run did not confirm idempotency:\n${secondApplyOutput}`);
  }

  process.stdout.write(firstApply.stdout);
  process.stdout.write(secondApply.stdout);
  process.stdout.write(
    "D1 migration test passed: initial apply, safe reapply, exact columns, constraints, default, and STRICT mode.\n",
  );
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}
