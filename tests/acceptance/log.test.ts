import { describe, expect, it } from "vitest";
import { errorSummary } from "../../apps/agent/src/log";

describe("trace errors", () => {
  it("drops request urls that carry an API key", () => {
    const error = Object.assign(
      new Error(
        "Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=AIzaSyExampleKeyValue1234567890: [503 Service Unavailable] high demand",
      ),
      { status: 503 },
    );
    const summary = errorSummary(error);
    expect(summary.status).toBe(503);
    expect(summary.message).toContain("high demand");
    expect(summary.message).not.toContain("AIza");
    expect(summary.message).not.toContain("generativelanguage.googleapis.com");
  });
});
