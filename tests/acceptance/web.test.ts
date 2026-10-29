import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../apps/web/src/app/api/chat/route";
import { GET } from "../../apps/web/src/app/api/health/route";
import { ask, boot } from "./harness";
import type { RunningServer } from "../../apps/agent/src/server";

describe("web route calls the agent service", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await boot({ instanceId: "web-target" });
    process.env.AGENT_SERVICE_URL = server.url;
  });

  afterAll(async () => {
    delete process.env.AGENT_SERVICE_URL;
    await server.close();
  });

  it("returns the agent answer for Bob Langley", async () => {
    const direct = await ask(server.url, "Where does Bob Langley work? How long has he been employed?");
    const response = await POST(jsonRequest("Where does Bob Langley work? How long has he been employed?"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer: string; status: string; instanceId: string; steps: number };
    expect(body.answer).toBe(direct.body.answer);
    expect(body.status).toBe("ok");
    expect(body.instanceId).toBe("web-target");
    expect(body.steps).toBe(1);
    expect(body.answer).toContain("Chicago");
    expect(body.answer).toContain("7 years, 7 months");
  });

  it("passes a compensation refusal through unchanged", async () => {
    const response = await POST(jsonRequest("What is Horatio Kane's salary?"));
    const body = (await response.json()) as { status: string; answer: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe("refused");
    expect(body.answer).not.toMatch(/\d/);
  });

  it("proxies agent health", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; instanceId: string; provider: string };
    expect(body).toMatchObject({ ok: true, instanceId: "web-target", provider: "stub" });
  });

  it("rejects an empty question before calling the agent", async () => {
    const response = await POST(jsonRequest("  "));
    expect(response.status).toBe(400);
  });

  it("reports that the agent is unavailable", async () => {
    const doomed = await boot({ instanceId: "closed" });
    const closedUrl = doomed.url;
    await doomed.close();
    process.env.AGENT_SERVICE_URL = closedUrl;
    const response = await POST(jsonRequest("Where does Bob Langley work?"));
    process.env.AGENT_SERVICE_URL = server.url;
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/unavailable/);
  });
});

function jsonRequest(query: string): Request {
  return new Request("http://ledger.local/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}
