import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Vitest JSON/JUnit omit retry history. Record the real completed TestCase diagnostics.
export default class CIUnitReporter {
  tests = [];
  onTestCaseResult(test) {
    const diagnostic = test.diagnostic();
    const result = test.result();
    const ancestors = [];
    for (let parent = test.parent; parent?.type === "suite"; parent = parent.parent) ancestors.unshift(parent.name);
    this.tests.push({ id: test.id, file: test.module.moduleId, ancestors, title: test.name, status: result.state, errors: result.errors?.length ?? 0, retryCount: diagnostic?.retryCount ?? null, repeatCount: diagnostic?.repeatCount ?? null, flaky: diagnostic?.flaky ?? null });
  }
  async onTestRunEnd(_modules, errors, reason) {
    if (!process.env.SNS_CI_OUTPUT) throw new Error("Trusted unit output missing");
    await writeFile(join(process.env.SNS_CI_OUTPUT, "unit-history.json"), `${JSON.stringify({ reason, unhandledErrors: errors.length, tests: this.tests }, null, 2)}\n`, { flag: "wx" });
  }
}
