// Executed only by the offline test's isolated PATH. Unknown calls fail closed.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.HARNESS_GH_MOCK_DIRECTORY;
if (!directory) throw new Error("This gh substitute is only for offline tests");
const args = process.argv.slice(2);
const paginated = args[1] === "--paginate" && args[2] === "--slurp";
const graphql = args[1] === "graphql";
if (args[0] !== "api" || (!graphql && args.length !== (paginated ? 4 : 2))) {
  throw new Error("Unexpected gh operation (only synthetic read calls are allowed)");
}
if (graphql && (!args.includes("-f") || !args.some((arg) => arg.startsWith("query=")))) {
  throw new Error("Expected a GraphQL query");
}
const endpoint = graphql ? "graphql" : args[paginated ? 3 : 1];
appendFileSync(join(directory, "calls.jsonl"), `${JSON.stringify({ endpoint, args })}\n`);
const { routes, denied } = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
if (Object.hasOwn(denied, endpoint)) {
  process.stderr.write(`gh: Synthetic denial (HTTP ${denied[endpoint]})\n`);
  process.exitCode = 1;
} else if (Object.hasOwn(routes, endpoint)) {
  process.stdout.write(`${JSON.stringify(routes[endpoint])}\n`);
} else {
  process.stderr.write(`Unconfigured synthetic API call: ${endpoint}\n`);
  process.exitCode = 2;
}
