# Pre-publication self-check for a review evidence folder (reviewer tool, run with python3 -I).
# Scans every file, the members of every zip, and zip payloads embedded as base64 in HTML.
# Usage: publication-check.py <evidence-dir> [--allow-local-path-in <relative file> ...]
# Machine-specific needles (login name, host name, git identity) are read at run time from
# the environment and are never written to the output; only the category of a hit is printed.
import base64, io, json, os, re, socket, subprocess, sys, zipfile

root = os.path.realpath(sys.argv[1])
allow = set()
args = sys.argv[2:]
while args:
    if args[0] == "--allow-local-path-in":
        allow.add(args[1]); args = args[2:]
    else:
        raise SystemExit("unknown argument")

def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""

home = os.path.expanduser("~")
dynamic = {
    "home-directory": home,
    "home-directory-name": os.path.basename(home),
    "login-name": os.environ.get("USER", ""),
    "host-name": socket.gethostname().split(".")[0],
    "computer-name": run(["scutil", "--get", "ComputerName"]),
    "local-host-name": run(["scutil", "--get", "LocalHostName"]),
    "git-user-name": run(["git", "config", "user.name"]),
    "git-user-email": run(["git", "config", "user.email"]),
}
# also the dash-mangled variants used in temp directory names
for key in ["home-directory-name", "login-name"]:
    value = dynamic[key]
    if value:
        dynamic[key + "-mangled"] = re.sub(r"[^A-Za-z0-9]", "-", value)
dynamic = {k: v for k, v in dynamic.items() if v and len(v) >= 4}

# The bracketed first letters keep this source file from matching its own patterns.
patterns = {
    "absolute-user-path": re.compile(rb"(/[U]sers/|/[h]ome/|[A-Za-z]:\\[U]sers\\)[^\s\"'<>]{1,80}"),
    "temp-path": re.compile(rb"(/[p]rivate/tmp/|/[p]rivate/var/|/[v]ar/folders/|/[t]mp/claude)[^\s\"'<>]{0,80}"),
    "email-address": re.compile(rb"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,3}\.[A-Za-z]{2,10}\b"),
    "github-token": re.compile(rb"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"),
    "aws-key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "private-key": re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "slack-token": re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    "api-key-like": re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}"),
    "bearer-or-cookie-header": re.compile(rb"(?i)\b(authorization|set-cookie|cookie)\"?\s*[:=]\s*\"?[^\s\"]{8,}"),
    "jwt": re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
}

findings = []
scanned = {"files": 0, "zipMembers": 0, "embeddedZips": 0, "bytes": 0}

FILE_SUFFIXES = (b".jpeg", b".jpg", b".png", b".json", b".js", b".css", b".html", b".zip", b".md", b".txt", b".ts", b".tsx", b".mjs")
IMAGE_MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")

SAFE_EXIF_TAGS = {0x8769: "ExifIFDPointer", 0xA001: "ColorSpace", 0xA002: "PixelXDimension", 0xA003: "PixelYDimension"}
image_info = {"imagesChecked": 0, "withDimensionOnlyExif": 0}

def exif_tags(tiff):
    # Minimal TIFF reader: tag ids of IFD0 and of the Exif sub-IFD. None means "could not parse".
    try:
        order = {b"MM": "big", b"II": "little"}[tiff[:2]]
        tags = []
        def read_ifd(offset):
            count = int.from_bytes(tiff[offset:offset + 2], order)
            for index in range(count):
                entry = tiff[offset + 2 + 12 * index: offset + 14 + 12 * index]
                tag = int.from_bytes(entry[:2], order)
                tags.append(tag)
                if tag == 0x8769:
                    read_ifd(int.from_bytes(entry[8:12], order))
        read_ifd(int.from_bytes(tiff[4:8], order))
        return tags
    except Exception:
        return None

def image_metadata(label, data, top):
    # Compressed pixel data is noise for text patterns, so images are checked structurally instead:
    # an embedded text/EXIF/comment block is the only place a string could hide. EXIF that carries
    # nothing but colour space and pixel dimensions is accepted; anything else is a finding.
    image_info["imagesChecked"] += 1
    blocks = []  # (kind, payload)
    if data.startswith(IMAGE_MAGIC[0]):
        offset = 8
        while offset + 8 <= len(data):
            length = int.from_bytes(data[offset:offset + 4], "big")
            kind = data[offset + 4:offset + 8].decode("latin-1")
            if kind not in {"IHDR", "IDAT", "IEND", "sRGB", "gAMA", "pHYs", "cHRM", "PLTE", "tRNS", "sBIT", "bKGD"}:
                blocks.append((kind, data[offset + 8:offset + 8 + length]))
            offset += 12 + length
    else:
        offset = 2
        while offset + 4 <= len(data) and data[offset] == 0xFF and data[offset + 1] != 0xDA:
            marker = data[offset + 1]
            length = int.from_bytes(data[offset + 2:offset + 4], "big")
            payload = data[offset + 4:offset + 2 + length]
            if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
                blocks.append(("eXIf", payload[6:]))
            elif marker == 0xFE or (0xE1 <= marker <= 0xEF):
                blocks.append(("jpeg-segment-%02x" % marker, payload))
            offset += 2 + length
    for kind, payload in blocks:
        tags = exif_tags(payload) if kind == "eXIf" else None
        if tags is not None and set(tags) <= set(SAFE_EXIF_TAGS):
            image_info["withDimensionOnlyExif"] += 1
        else:
            detail = kind if tags is None else kind + ":tags=" + ",".join("0x%04x" % tag for tag in sorted(set(tags) - set(SAFE_EXIF_TAGS)))
            findings.append({"file": label, "category": "image-metadata:" + detail, "count": 1, "allowed": False})

def scan(label, data, top, body=None):
    body = data if body is None else body
    if body.startswith(IMAGE_MAGIC):
        image_metadata(label, body, top)
        data = data[: len(data) - len(body)]  # keep only the file name for text patterns
    for name, pattern in patterns.items():
        hits = [m.group(0) for m in pattern.finditer(data)]
        if name == "email-address":
            # "page@<id>-<n>.jpeg" style resource names are not addresses
            hits = [h for h in hits if not h.lower().endswith(FILE_SUFFIXES)]
        count = len(hits)
        if count:
            if name in ("absolute-user-path", "temp-path") and top in allow:
                findings.append({"file": label, "category": name, "count": count, "allowed": True})
            else:
                findings.append({"file": label, "category": name, "count": count, "allowed": False})
    for name, needle in dynamic.items():
        count = data.count(needle.encode("utf-8"))
        if count:
            findings.append({"file": label, "category": "machine-identity:" + name, "count": count, "allowed": top in allow and name.startswith("home-directory")})

def scan_zip(label, data, top, depth=0):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        findings.append({"file": label, "category": "unreadable-zip", "count": 1, "allowed": False}); return
    for member in archive.namelist():
        payload = archive.read(member)
        scanned["zipMembers"] += 1
        scan(f"{label}!{member}", member.encode("utf-8") + b"\n" + payload, top, payload)
        if payload[:4] == b"PK\x03\x04" and depth < 2:
            scan_zip(f"{label}!{member}", payload, top, depth + 1)

structure = {"fileCount": 0, "totalBytes": 0, "zeroByteFiles": [], "symlinks": [], "nonAsciiNames": [], "otherEntries": [], "largestFiles": []}
sizes = []
for directory, subdirs, files in os.walk(root, followlinks=False):
    for name in subdirs + files:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root)
        if os.path.islink(path):
            structure["symlinks"].append(relative)
        if not relative.isascii() or re.search(r"[^A-Za-z0-9._/-]", relative):
            structure["nonAsciiNames"].append(relative.encode("ascii", "backslashreplace").decode())
    for name in files:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root)
        if os.path.islink(path):
            continue
        if not os.path.isfile(path):
            structure["otherEntries"].append(relative); continue
        data = open(path, "rb").read()
        structure["fileCount"] += 1
        structure["totalBytes"] += len(data)
        sizes.append((len(data), relative))
        if len(data) == 0:
            structure["zeroByteFiles"].append(relative)
        scanned["files"] += 1
        scanned["bytes"] += len(data)
        if data[:4] == b"PK\x03\x04":
            scan(relative, relative.encode("utf-8"), relative)  # name only; members are scanned one by one
            scan_zip(relative, data, relative)
        else:
            scan(relative, relative.encode("utf-8") + b"\n" + data, relative, data)
        if relative.endswith(".html"):
            for match in re.finditer(rb"data:application/zip;base64,([A-Za-z0-9+/=]+)", data):
                scanned["embeddedZips"] += 1
                scan_zip(relative + "#embedded-zip", base64.b64decode(match.group(1)), relative)
structure["largestFiles"] = [{"bytes": size, "file": name} for size, name in sorted(sizes, reverse=True)[:5]]

blocking = [f for f in findings if not f["allowed"]]
limits = {"maxBytes": 20 * 1024 * 1024, "maxFiles": 500}
ok = (not blocking and not structure["zeroByteFiles"] and not structure["symlinks"] and not structure["nonAsciiNames"]
      and not structure["otherEntries"] and structure["totalBytes"] <= limits["maxBytes"] and structure["fileCount"] <= limits["maxFiles"])
print(json.dumps({"result": "PASS" if ok else "FAIL", "limits": limits, "structure": structure, "scanned": scanned,
                  "imageMetadata": {**image_info, "acceptedExifTags": sorted(SAFE_EXIF_TAGS.values())}, "patternCategories": sorted(patterns), "machineIdentityCategories": sorted(dynamic),
                  "findings": findings, "blockingFindings": len(blocking)}, indent=2))
sys.exit(0 if ok else 1)
