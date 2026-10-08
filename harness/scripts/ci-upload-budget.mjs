import { readdir, stat, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";

let count = 0;
let bytes = 0;
async function visit(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Upload evidence symlink forbidden");
  if (info.isDirectory()) for (const item of await readdir(path)) await visit(join(path, item));
  else if (info.isFile()) { if (!info.size) throw new Error("Upload evidence is empty"); count++; bytes += info.size; }
  else throw new Error("Upload evidence is not a regular file/directory");
}
if (!process.argv.slice(2).length) throw new Error("Expected upload evidence directories");
for (const input of process.argv.slice(2)) { const path = resolve(input); if (await stat(path).catch(() => null)) await visit(path); }
if (!count || count > 500 || bytes > 20 * 1024 * 1024) throw new Error(`Upload refused: ${count} files / ${bytes} bytes; limit 500 files / 20 MiB`);
process.stdout.write(`Upload evidence budget checked: ${count} files / ${bytes} bytes (not account-wide free-operation proof)\n`);
