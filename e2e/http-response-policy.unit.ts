import { describe, expect, it } from "vitest";

import { formatUnexpectedHttpResponse } from "./http-response-policy";

describe("HTTP response policy", () => {
  it.each([200, 204, 301, 399])("allows HTTP %i", (status) => {
    expect(
      formatUnexpectedHttpResponse({
        method: "GET",
        status,
        url: "http://127.0.0.1:43210/asset",
      }),
    ).toBeNull();
  });

  it.each([400, 404, 500, 503])("rejects HTTP %i", (status) => {
    expect(
      formatUnexpectedHttpResponse({
        method: "GET",
        status,
        url: "http://127.0.0.1:43210/api",
      }),
    ).toBe(`GET ${String(status)} http://127.0.0.1:43210/api`);
  });
});
