import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export default class ViewportReporter {
  tests = [];
  version() { return "v2"; }
  onConfigure(config) { this.rootDir = config.rootDir; }
  onTestEnd(test, result) {
    const project = test.parent.project();
    this.tests.push({ testId: test.id, title: test.title, location: { ...test.location, file: relative(this.rootDir, test.location.file).replaceAll("\\", "/") }, project: project.name, viewport: project.use.viewport, browserName: project.use.browserName, retry: result.retry, status: result.status });
  }
  async onEnd(result) {
    await writeFile(join(process.env.SNS_CI_OUTPUT, "viewports.json"), `${JSON.stringify({ status: result.status, tests: this.tests }, null, 2)}\n`, { flag: "wx" });
  }
}
