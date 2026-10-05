import { fileURLToPath } from "node:url";
import { observeParserProcess } from "./ci-parser-observation.mjs";

export const EVIDENCE_FILE_LIMIT = 20 * 1024 * 1024;

// Fixed trusted code only; untrusted reports are UTF-8 stdin, never Python source.
const SOURCE = String.raw`
import sys, time, json, os
def phase(name, runtime=None):
    record = {"version": 1, "callId": sys.argv[-1], "phase": name, "pid": os.getpid(), "monotonicNs": str(time.monotonic_ns()), "wallTimeNs": str(time.time_ns())}
    if runtime is not None: record["runtime"] = runtime
    sys.stderr.write("SNS_PARSER_PHASE " + json.dumps(record, separators=(",", ":")) + "\n")
    sys.stderr.flush()
phase("bootstrap")
import base64, io, json, math, platform, pyexpat, re, stat, struct, sys, zipfile, zlib
from html.parser import HTMLParser
from pathlib import PurePosixPath
import xml.etree.ElementTree as ET
phase("stdlib", {"python": platform.python_version(), "executable": sys.executable, "expat": pyexpat.EXPAT_VERSION, "isolated": bool(sys.flags.isolated)})

if sys.version_info < (3, 9) or pyexpat.version_info < (2, 7, 2):
    raise ValueError("Requires Python >=3.9 and Expat >=2.7.2")

def integer(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        raise ValueError("JUnit counter must be an ASCII nonnegative integer")
    return int(value)

class NoDTD(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0
    def doctype(self, name, pubid, system):
        raise ValueError("JUnit DOCTYPE/entity declarations forbidden")
    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 8 or self.nodes > 100000:
            raise ValueError("JUnit depth/node bound exceeded")
        return super().start(tag, attrs)
    def end(self, tag):
        self.depth -= 1
        return super().end(tag)

def junit(payload, expected):
    root = ET.fromstring(payload.decode("utf-8", "strict"), parser=ET.XMLParser(target=NoDTD()))
    allowed = {"testsuites": {"testsuite"}, "testsuite": {"testcase", "properties", "system-out", "system-err"}, "testcase": {"properties", "system-out", "system-err"}, "properties": {"property"}, "property": set(), "system-out": set(), "system-err": set()}
    if root.tag not in {"testsuites", "testsuite"}:
        raise ValueError("JUnit root must be testsuites or testsuite")
    for element in root.iter():
        if element.tag not in allowed or any(child.tag not in allowed[element.tag] for child in element):
            raise ValueError("JUnit failure/skip/retry or unsupported structure")
        if any("}" in attr or ":" in attr for attr in element.attrib):
            raise ValueError("JUnit namespaced attributes forbidden")
        if element.tag not in {"system-out", "system-err", "property"} and (element.text or "").strip():
            raise ValueError("JUnit structural text forbidden")
        if any((child.tail or "").strip() for child in element):
            raise ValueError("JUnit structural tail forbidden")
        for attr in ("failures", "errors", "skipped", "disabled", "retries"):
            if attr in element.attrib and integer(element.attrib[attr]) != 0:
                raise ValueError("JUnit nonzero failure/skip/retry")
        if "status" in element.attrib and element.attrib["status"] not in {"passed", "pass", "run"}:
            raise ValueError("JUnit unsuccessful status")
    suites = [root] if root.tag == "testsuite" else list(root)
    actual = 0
    for suite in suites:
        count = len(suite.findall("testcase"))
        if integer(suite.get("tests")) != count:
            raise ValueError("JUnit suite declared count mismatch")
        actual += count
    if actual != expected or ("tests" in root.attrib and integer(root.attrib["tests"]) != actual):
        raise ValueError("JUnit total testcase count mismatch")
    return {"tests": actual}

def archive(payload):
    phase("zip-start")
    files = {}
    with zipfile.ZipFile(io.BytesIO(payload)) as zipped:
        entries = zipped.infolist()
        if not entries or len(entries) > 500 or sum(item.file_size for item in entries) > 20 * 1024 * 1024:
            raise ValueError("ZIP entry/uncompressed size bound exceeded")
        for item in entries:
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in item.filename or ":" in item.filename or stat.S_ISLNK(item.external_attr >> 16) or item.filename in files:
                raise ValueError("ZIP external/duplicate/symlink path forbidden")
            if item.flag_bits & 1 or item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise ValueError("ZIP encryption/unsupported compression forbidden")
            files[item.filename] = zipped.read(item)  # Bounded by declared size; verifies each CRC, never extracts.
    phase("zip-end")
    return files

def trace(payload, expected):
    files = archive(payload)
    phase("json-start")
    events = [json.loads(line) for name, data in files.items() if name.endswith(".trace") for line in data.decode("utf-8", "strict").splitlines() if line.strip()]
    if not events or any(not isinstance(event, dict) or not isinstance(event.get("type"), str) for event in events):
        raise ValueError("ZIP lacks actual trace events")
    if not any(event.get("type") == "context-options" and event.get("browserName") == expected["browserName"] and event.get("options", {}).get("viewport") == expected["viewport"] for event in events):
        raise ValueError("Trace browser/viewport mismatch")
    if not any(event.get("type") in {"before", "after", "event", "frame-snapshot"} for event in events):
        raise ValueError("Trace lacks execution events")
    phase("json-end")
    return {"entries": len(files)}

class ReportHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.template = False
        self.templates = 0
        self.target_ids = 0
        self.template_depth = 0
        self.payload = ""
        self.html = 0
        self.closed = 0
        self.title = False
        self.title_text = ""
    def handle_starttag(self, tag, attrs):
        if len(attrs) != len({name for name, value in attrs}):
            raise ValueError("HTML duplicate attributes forbidden")
        if dict(attrs).get("id") == "playwrightReportBase64":
            self.target_ids += 1
            if tag != "template" or self.template_depth: raise ValueError("HTML report ID must be unique accessible template")
        if tag == "template": self.template_depth += 1
        if tag == "html": self.html += 1
        if tag == "title": self.title = True
        if tag == "template" and dict(attrs).get("id") == "playwrightReportBase64":
            self.template = True
            self.templates += 1
    def handle_endtag(self, tag):
        if tag == "html": self.closed += 1
        if tag == "title": self.title = False
        if tag == "template":
            self.template_depth -= 1
            if self.template_depth < 0: raise ValueError("HTML unmatched template end")
            self.template = False
    def handle_data(self, data):
        if self.template: self.payload += data
        if self.title: self.title_text += data

def html_report(payload, expected):
    parser = ReportHTML()
    parser.feed(payload.decode("utf-8", "strict"))
    parser.close()
    prefix = "data:application/zip;base64,"
    if parser.html != 1 or parser.closed != 1 or parser.templates != 1 or parser.target_ids != 1 or parser.template_depth != 0 or parser.template or parser.title_text != "Playwright Test Report" or not parser.payload.startswith(prefix):
        raise ValueError("HTML is not a complete Playwright report")
    files = archive(base64.b64decode(parser.payload[len(prefix):], validate=True))
    phase("json-start")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError("HTML JSON duplicate key forbidden")
            result[key] = value
        return result
    def nonfinite(value):
        raise ValueError("HTML JSON nonfinite number forbidden")
    def equal(left, right):
        # JSON booleans are not numbers (Python otherwise equates False/0 and True/1).
        if type(left) is not type(right) and not (type(left) in (int, float) and type(right) in (int, float)):
            return False
        if isinstance(left, dict): return left.keys() == right.keys() and all(equal(value, right[key]) for key, value in left.items())
        if isinstance(left, list): return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
        return left == right
    def load(name):
        return json.loads(files[name].decode("utf-8", "strict"), object_pairs_hook=unique_object, parse_constant=nonfinite)
    def stats(actual, count):
        wanted = {"total": count, "expected": count, "unexpected": 0, "flaky": 0, "skipped": 0, "ok": True}
        if actual != wanted or any(type(actual.get(key)) is not int for key in wanted if key != "ok") or actual.get("ok") is not True:
            raise ValueError("HTML report/file stats mismatch")
    report = load("report.json")
    count = len(expected)
    if count <= 0: raise ValueError("HTML report has zero tests")
    stats(report.get("stats", {}), count)
    if report.get("errors") != []:
        raise ValueError("HTML report failing/skip/retry/count mismatch")
    wanted = {test["testId"]: test for test in expected}
    if len(wanted) != count or any(not isinstance(key, str) or not key for key in wanted):
        raise ValueError("HTML canonical test IDs missing/duplicate")
    summaries = report.get("files")
    if not isinstance(summaries, list) or not summaries: raise ValueError("HTML file summaries missing")
    names, ids, seen = set(), set(), set()
    for summary in summaries:
        file_id, file_name = summary.get("fileId"), summary.get("fileName")
        if not isinstance(file_id, str) or not re.fullmatch(r"[0-9a-f]{20}", file_id) or not isinstance(file_name, str) or not file_name or file_id in ids or file_name in names:
            raise ValueError("HTML file identity missing/duplicate")
        ids.add(file_id)
        names.add(file_name)
        detail = load(file_id + ".json")  # Every referenced detail is mandatory; summary is not retry history.
        if detail.get("fileId") != file_id or detail.get("fileName") != file_name:
            raise ValueError("HTML detail file identity mismatch")
        summary_tests, detail_tests = summary.get("tests"), detail.get("tests")
        if not isinstance(summary_tests, list) or not summary_tests or not isinstance(detail_tests, list) or len(detail_tests) != len(summary_tests):
            raise ValueError("HTML summary/detail test count mismatch")
        stats(summary.get("stats", {}), len(summary_tests))
        by_id = {test["testId"]: test for test in detail_tests}
        if len(by_id) != len(detail_tests): raise ValueError("HTML duplicate detail test ID")
        for brief in summary_tests:
            test_id = brief.get("testId")
            if test_id not in wanted or test_id in seen or test_id not in by_id:
                raise ValueError("HTML summary/detail/canonical test IDs mismatch")
            seen.add(test_id)
            test, canonical = by_id[test_id], wanted[test_id]
            required = {"testId", "title", "projectName", "location", "duration", "annotations", "tags", "outcome", "path", "ok", "results"}
            if not required.issubset(test) or any(not equal(test[key], canonical[key]) for key in ("testId", "title", "projectName", "location")) or test["location"].get("file") != file_name:
                raise ValueError("HTML detail/canonical test identity mismatch")
            if any(type(test["location"].get(key)) is not int or test["location"][key] <= 0 for key in ("line", "column")):
                raise ValueError("HTML invalid test location")
            if test["outcome"] != "expected" or test["ok"] is not True or type(test.get("repeatEachIndex", 0)) is not int or test.get("repeatEachIndex", 0) != 0 or not isinstance(test["results"], list) or len(test["results"]) != 1:
                raise ValueError("HTML detail failure/skip/repeat/multiple attempts")
            result = test["results"][0]
            if set(result) != {"duration", "startTime", "retry", "steps", "errors", "status", "annotations", "attachments", "workerIndex"} or any(not isinstance(result[key], list) for key in ("steps", "annotations", "attachments")):
                raise ValueError("HTML incomplete/unknown detail result fields")
            if result.get("status") != "passed" or type(result.get("retry")) is not int or result["retry"] != 0 or result.get("errors") != []:
                raise ValueError("HTML detail failed/skipped/retried/error result")
            if type(test["duration"]) not in (int, float) or not math.isfinite(test["duration"]) or test["duration"] < 0 or type(result.get("duration")) not in (int, float) or not math.isfinite(result["duration"]) or result["duration"] < 0 or type(result.get("workerIndex")) is not int or result["workerIndex"] < 0 or not isinstance(result.get("startTime"), str) or not result["startTime"]:
                raise ValueError("HTML invalid result identity")
            if any(not equal(result.get(key), canonical["result"][key]) for key in ("status", "retry", "errors", "duration", "startTime", "workerIndex")) or not equal(test["duration"], canonical["result"]["duration"]):
                raise ValueError("HTML detail/canonical result mismatch")
            # Installed Playwright 1.63.0 HtmlBuilder's exact summary projection.
            projected = {key: value for key, value in test.items() if key != "results"}
            projected["results"] = [{"attachments": [{key: attachment[key] for key in ("name", "contentType", "path") if key in attachment} for attachment in item["attachments"]], "startTime": item["startTime"], "workerIndex": item["workerIndex"]} for item in test["results"]]
            if not equal(projected, brief): raise ValueError("HTML detail/summary projection mismatch")
    if seen != set(wanted) or names != {test["location"]["file"] for test in expected} or set(files) != {"report.json"} | {file_id + ".json" for file_id in ids}:
        raise ValueError("HTML missing/extra file or test detail")
    if sorted(report.get("projectNames", [])) != sorted({test["projectName"] for test in expected}):
        raise ValueError("HTML report projects mismatch")
    phase("json-end")
    return {"tests": count}

def png(payload, expected):
    # A narrow screenshot integrity check, not a general image decoder: noninterlaced 8-bit RGB/RGBA only.
    if payload[:8] != b"\x89PNG\r\n\x1a\n": raise ValueError("Invalid PNG signature")
    offset, header, compressed, ended, chunks, data_finished = 8, None, b"", False, 0, False
    while offset < len(payload):
        if offset + 12 > len(payload): raise ValueError("Truncated PNG chunk")
        length = struct.unpack(">I", payload[offset:offset+4])[0]
        kind = payload[offset+4:offset+8]
        chunks += 1
        if chunks > 500 or len(kind) != 4 or not kind.isalpha(): raise ValueError("PNG chunk bound/type invalid")
        end = offset + 12 + length
        if end > len(payload) or ended: raise ValueError("PNG length/trailing data mismatch")
        data = payload[offset+8:offset+8+length]
        crc = struct.unpack(">I", payload[offset+8+length:end])[0]
        if zlib.crc32(kind + data) & 0xffffffff != crc: raise ValueError("PNG CRC mismatch")
        if header is None and kind != b"IHDR": raise ValueError("PNG IHDR must be first")
        if kind == b"IHDR":
            if header is not None or length != 13: raise ValueError("PNG duplicate/invalid IHDR")
            header = struct.unpack(">IIBBBBB", data)
        elif kind == b"IDAT":
            if data_finished: raise ValueError("PNG IDAT chunks must be consecutive")
            compressed += data
        elif kind == b"IEND":
            if length or not compressed: raise ValueError("PNG invalid IEND/empty image")
            ended = True
        elif kind == b"PLTE":
            if compressed or not length or length % 3 or length > 768: raise ValueError("PNG palette invalid/order mismatch")
        elif not kind[0] & 32: raise ValueError("Unsupported PNG critical chunk")
        if compressed and kind != b"IDAT": data_finished = True
        offset = end
    if not ended or header is None: raise ValueError("PNG missing image/end")
    width, height, depth, color, compression, filtering, interlace = header
    if width != expected["width"] or height < expected["height"] or depth != 8 or color not in {2, 6} or compression or filtering or interlace:
        raise ValueError("PNG screenshot dimensions/encoding mismatch")
    stride = width * (3 if color == 2 else 4) + 1
    size = stride * height
    if size > 20 * 1024 * 1024: raise ValueError("PNG uncompressed size bound exceeded")
    inflater = zlib.decompressobj()
    pixels = inflater.decompress(compressed, size + 1)
    if len(pixels) != size or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail or any(pixels[line] > 4 for line in range(0, size, stride)):
        raise ValueError("PNG malformed pixel stream")
    return {"width": width, "height": height}

mode = sys.argv[1]
if mode == "runtime":
    result = {"python": platform.python_version(), "executable": sys.executable, "expat": pyexpat.EXPAT_VERSION, "isolated": bool(sys.flags.isolated)}
elif mode in {"junit", "trace", "html", "png"}:
    phase("stdin-start")
    payload = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    phase("stdin-end")
    if not payload or len(payload) > 20 * 1024 * 1024:
        raise ValueError("Evidence empty or exceeds 20 MiB")
    phase("parse-start")
    result = junit(payload, int(sys.argv[2])) if mode == "junit" else {"trace": trace, "html": html_report, "png": png}[mode](payload, json.loads(sys.argv[2]))
    phase("parse-end")
else:
    raise ValueError("Unknown trusted parser mode")
print(json.dumps(result))
phase("complete")
`;

export function standardLibraryCheck(mode, input = Buffer.alloc(0), args = [], observation = {}) {
  if (input.length > EVIDENCE_FILE_LIMIT) throw new Error("Evidence exceeds 20 MiB parser limit");
  if (!observation || Object.getPrototypeOf(observation) !== Object.prototype || Object.keys(observation).some((key) => !["observationRoot", "inputPath"].includes(key))) throw new Error("Unknown parser observation option");
  const requiredPhases = ["bootstrap", "stdlib", ...(mode === "runtime" ? [] : ["stdin-start", "stdin-end", "parse-start"]), ...(["trace", "html"].includes(mode) ? ["zip-start", "zip-end", "json-start", "json-end"] : []), ...(mode === "runtime" ? [] : ["parse-end"]), "complete"];
  return observeParserProcess({ source: SOURCE, modulePath: fileURLToPath(import.meta.url), mode, input, args, requiredPhases, observationRoot: observation.observationRoot, inputPath: observation.inputPath });
}

export function parserRuntime(observation = {}) { return standardLibraryCheck("runtime", Buffer.alloc(0), [], observation); }
