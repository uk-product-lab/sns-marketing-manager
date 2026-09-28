import type { Page } from "@playwright/test";

export interface HttpResponseSummary {
  method: string;
  status: number;
  url: string;
}

export function formatUnexpectedHttpResponse({
  method,
  status,
  url,
}: HttpResponseSummary): string | null {
  if (status < 400 || status > 599) {
    return null;
  }

  return `${method} ${String(status)} ${url}`;
}

export function monitorUnexpectedHttpResponses(page: Page): string[] {
  const findings: string[] = [];

  page.on("response", (response) => {
    const finding = formatUnexpectedHttpResponse({
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
    if (finding) {
      findings.push(finding);
    }
  });

  return findings;
}
