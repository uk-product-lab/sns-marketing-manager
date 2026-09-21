import path from "node:path";
import { fileURLToPath } from "node:url";

import { preview } from "vite";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = 4174;
const server = await preview({
  configFile: path.join(projectRoot, "vite.config.ts"),
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
});

try {
  const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    throw new Error(`Preview returned HTTP ${String(response.status)}.`);
  }
  if (!contentType.includes("text/html")) {
    throw new Error(`Preview returned unexpected content-type: ${contentType}`);
  }
  if (!body.includes("<title>SNS Marketing Manager</title>") || !body.includes('id="root"')) {
    throw new Error("Preview response did not contain the expected app identity.");
  }

  console.log(`Smoke test passed: HTTP ${String(response.status)}, ${contentType}`);
} finally {
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
