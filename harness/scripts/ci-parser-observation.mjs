import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const PARSER_TIMEOUT_MS = 10_000;
export const PARSER_OUTPUT_LIMIT = 64 * 1024;
const INPUT_LIMIT = 20 * 1024 * 1024;
const PREFIX = "SNS_PARSER_PHASE ";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = /(?:Bearer\s+\S+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|access_token|api_key)\s*[=:]\s*\S+)/i;
const stamp = () => ({ wall: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString() });
const code = (error) => typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";

function safe(value, depth = 0) {
  if (depth > 12) throw new Error("Observation metadata depth bound");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 4096 && !secret.test(value) && !/[\u0000-\u001f]/.test(value)) return;
  if (Array.isArray(value) && value.length <= 500) { for (const item of value) safe(item, depth + 1); return; }
  if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length <= 32) {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|secret|accesstoken|refreshtoken|apikey|authorization|cookie|privatekey|credential|token)$/i.test(key.replace(/[-_]/g, ""))) throw new Error("Observation secret key forbidden");
      safe(key, depth + 1); safe(item, depth + 1);
    } return;
  }
  throw new Error("Observation metadata type/size/secret bound");
}

function resolvedPython(env) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    try { const path = join(directory, "python3"); accessSync(path, constants.X_OK); return realpathSync(path); } catch { /* Not available here. */ }
  }
  return null;
}

function phases(stderr, required, childPid, callId) {
  const records = [];
  let otherBytes = 0;
  try {
  for (const line of stderr.toString("utf8").split("\n")) {
    if (!line) continue;
    if (!line.startsWith(PREFIX)) { otherBytes += Buffer.byteLength(line) + 1; continue; }
    if (records.length >= 32) throw new Error("PHASE_BOUND");
    let item;
    try { item = JSON.parse(line.slice(PREFIX.length)); safe(item); } catch { throw new Error("PHASE_INVALID"); }
    const keys = Object.keys(item).sort().join(",");
    if (!["callId,monotonicNs,phase,pid,version,wallTimeNs", "callId,monotonicNs,phase,pid,runtime,version,wallTimeNs"].includes(keys) || item.callId !== callId || item.version !== 1 || !required.includes(item.phase) || !Number.isSafeInteger(item.pid) || item.pid <= 0 || item.pid !== childPid || typeof item.monotonicNs !== "string" || typeof item.wallTimeNs !== "string" || !/^[0-9]{1,30}$/.test(item.monotonicNs) || !/^[0-9]{1,30}$/.test(item.wallTimeNs)) throw new Error("PHASE_INVALID");
    if (item.runtime !== undefined) {
      const runtime = item.runtime;
      if (item.phase !== "stdlib" || Object.keys(runtime).sort().join(",") !== "executable,expat,isolated,python" || !isAbsolute(runtime.executable) || runtime.isolated !== true || !/^\d+\.\d+\.\d+$/.test(runtime.python) || !/^expat_\d+\.\d+\.\d+$/.test(runtime.expat)) throw new Error("PHASE_RUNTIME_INVALID");
    }
    const last = records.at(-1);
    if (last && (BigInt(item.monotonicNs) < BigInt(last.monotonicNs) || BigInt(item.wallTimeNs) < BigInt(last.wallTimeNs))) throw new Error("PHASE_TIME_INVALID");
    if (item.phase !== required[records.length]) throw new Error("PHASE_ORDER_INVALID");
    records.push(item);
  }
  } catch (error) { error.validatedPhases = records; error.otherBytes = otherBytes; throw error; }
  return { records, otherBytes, complete: records.length === required.length && records.some((item) => item.runtime) };
}

// The formal parser supplies fixed SOURCE, modes and phases. This process-level
// helper also permits controlled synthetic children in tests; ci-quality exposes
// no SOURCE/command/timeout/phase override through arguments or environment.
export function observeParserProcess({ source, modulePath, mode, input, args, requiredPhases, observationRoot, inputPath = null }) {
  const callId = randomUUID();
  const started = stamp();
  const env = { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), LANG: "C", LC_ALL: "C" };
  const base = { version: 1, callId, mode: null, input: { path: null, bytes: null, sha256: null }, expected: null, trusted: null, process: { command: "python3", resolvedExecutable: null, argv: null, isolatedRequested: true, env: null, parentPid: process.pid, childPid: null, started: null, ended: null, timeoutMs: PARSER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: PARSER_OUTPUT_LIMIT }, started, ended: null, childSelfReport: { runtime: null, phases: [] }, exit: null, stdout: null, stderr: null, failure: null, observationFailure: null };
  let root;
  let storageReady = false;
  let result;
  let failure;
  try {
    if (!Buffer.isBuffer(input) || input.length > INPUT_LIMIT || typeof source !== "string" || source.length > PARSER_OUTPUT_LIMIT || typeof mode !== "string" || !Array.isArray(args) || args.length > 1 || !Array.isArray(requiredPhases) || !requiredPhases.length || requiredPhases.length > 32 || requiredPhases.some((phase) => typeof phase !== "string") || new Set(requiredPhases).size !== requiredPhases.length) throw new Error("METADATA_INVALID");
    safe({ mode, modulePath, inputPath, args, requiredPhases, env });
    if (inputPath !== null && !isAbsolute(inputPath)) throw new Error("METADATA_INVALID");
    const expected = args.length ? JSON.parse(String(args[0])) : null;
    safe(expected);
    base.mode = mode;
    base.input = { path: inputPath, bytes: input.length, sha256: digest(input) };
    base.expected = expected;
    base.trusted = { modulePath, moduleSha256: digest(readFileSync(modulePath)), sourceSha256: digest(source), observationModuleSha256: digest(readFileSync(new URL(import.meta.url))) };
    base.process.env = env;
    const executable = resolvedPython(env);
    safe(executable); // A harmless PATH may resolve through a symlink to unsafe metadata.
    base.process.resolvedExecutable = executable;
    base.process.argv = ["-I", "-c", { trustedSourceSha256: base.trusted.sourceSha256 }, mode, ...args.map(String), callId];
    root = observationRoot ?? mkdtempSync(join(tmpdir(), "sns-ci-parser-observation-"));
    safe(root);
    if (!isAbsolute(root)) throw new Error("METADATA_INVALID");
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("OBSERVATION_PATH_INVALID");
    const canonicalRoot = realpathSync(root);
    safe(canonicalRoot); // Validate derived values before retaining or returning them.
    root = canonicalRoot;
    storageReady = true;
    writeFileSync(join(root, `${callId}.start.json`), `${JSON.stringify(base, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    base.process.started = base.process.resolvedExecutable ? stamp() : null;
    const child = base.process.resolvedExecutable ? spawnSync(base.process.resolvedExecutable, ["-I", "-c", source, mode, ...args.map(String), callId], { input, timeout: PARSER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: PARSER_OUTPUT_LIMIT, env, stdio: ["pipe", "pipe", "pipe"] }) : { status: null, signal: null, error: { code: "ENOENT" } };
    base.ended = stamp();
    base.process.ended = base.process.started ? base.ended : null;
    base.process.childPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    base.exit = { status: child.status, signal: child.signal, errorCode: child.error ? code(child.error) : null, errno: Number.isInteger(child.error?.errno) ? child.error.errno : null, timedOut: child.error?.code === "ETIMEDOUT", killRequested: child.error?.code === "ETIMEDOUT" ? "SIGKILL" : null };
    const stdout = child.stdout ?? Buffer.alloc(0), stderr = child.stderr ?? Buffer.alloc(0);
    base.stdout = { bytes: stdout.length, sha256: digest(stdout), validResultJson: false };
    base.stderr = { bytes: stderr.length, sha256: digest(stderr), nonPhaseBytes: null, phaseError: null };
    let parsed;
    try {
      parsed = phases(stderr, requiredPhases, base.process.childPid, callId);
      base.childSelfReport = { runtime: parsed.records.find((item) => item.runtime)?.runtime ?? null, phases: parsed.records };
      base.stderr.nonPhaseBytes = parsed.otherBytes;
    } catch (error) {
      base.stderr.phaseError = error.message;
      const prefix = error.validatedPhases ?? [];
      base.childSelfReport = { runtime: prefix.find((item) => item.runtime)?.runtime ?? null, phases: prefix };
      base.stderr.nonPhaseBytes = error.otherBytes ?? null;
    }
    if (base.childSelfReport.runtime && base.childSelfReport.runtime.executable !== base.process.resolvedExecutable) { base.stderr.phaseError = "PHASE_EXECUTABLE_MISMATCH"; parsed = null; }
    if (child.error || child.status !== 0 || child.signal) failure = child.error?.code === "ETIMEDOUT" ? "PARSER_TIMEOUT" : "PARSER_PROCESS_FAILED";
    else if (!parsed || !parsed.complete || parsed.otherBytes) failure = "PARSER_PHASE_FAILED";
    else {
      try {
        result = JSON.parse(stdout.toString("utf8"));
        safe(result);
        if (!result || Object.getPrototypeOf(result) !== Object.prototype) throw new Error("Result must be an object");
        base.stdout.validResultJson = true;
      } catch { failure = "PARSER_OUTPUT_INVALID"; }
    }
  } catch (error) {
    failure = "PARSER_OBSERVATION_FAILED";
    base.observationFailure = { code: code(error) };
  }
  base.ended ??= stamp();
  base.failure = failure ?? null;
  try {
    if (!storageReady) throw new Error("No safe observation directory");
    writeFileSync(join(root, `${callId}.result.json`), `${JSON.stringify(base, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    failure ??= "PARSER_OBSERVATION_FAILED";
    base.failure = failure;
    base.observationFailure = { code: code(error) };
    // Parent receives this sanitized record even when storage is unavailable.
  }
  if (failure) {
    const error = new Error(`Trusted ${base.mode ?? "unknown"} parser rejected evidence or runtime: ${failure}`);
    error.observation = base;
    error.observationRoot = storageReady ? root : null;
    throw error;
  }
  return result;
}
