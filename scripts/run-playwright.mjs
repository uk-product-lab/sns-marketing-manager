import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAvailableLoopbackPort } from "./local-port.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const playwrightCli = path.join(
  projectRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const port = await getAvailableLoopbackPort();

const child = spawn(process.execPath, [playwrightCli, "test"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    SNS_E2E_PORT: String(port),
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Playwright terminated by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
