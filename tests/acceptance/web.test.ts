import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../apps/web/src/app/api/chat/route";
import { readSse } from "../../apps/web/src/app/sse";
import { GET as listModels } from "../../apps/web/src/app/api/models/route";
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

  it("streams the generate step and finishes with the trace", async () => {
    const response = await POST(
      jsonRequest("Where does Bob Langley work? How long has he been employed?", undefined, "stub", true),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const messages: Array<{ event: string; data: unknown }> = [];
    await readSse(response, (message) => messages.push(message));
    const tokens = messages.flatMap((message) => {
      if (message.event !== "token" || !message.data || typeof message.data !== "object") return [];
      const text = (message.data as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join("")).toContain("Chicago");
    const done = messages.find((message) => message.event === "done");
    const payload = done && done.data && typeof done.data === "object" ? (done.data as { payload?: { answer?: string; trace?: unknown[]; instanceId?: string } }).payload : undefined;
    expect(payload?.answer).toContain("Chicago");
    expect(payload?.answer).toContain("7 years, 7 months");
    expect(payload?.instanceId).toBe("web-target");
    expect(payload?.trace?.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.event === "status")).toBe(true);
  });

  it("returns the finished answer instead of a stream when the live check is on", async () => {
    const checked = await boot({ onlineEval: true, instanceId: "eval-on" });
    try {
      const response = await fetch(new URL("/answer", checked.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-caller-role": "junior_hr_assistant",
        },
        body: JSON.stringify({
          query: "Where does Bob Langley work? How long has he been employed?",
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as { answer: string; evaluation?: { passed: boolean } };
      expect(body.answer).toContain("Chicago");
      expect(body.evaluation?.passed).toBe(true);
    } finally {
      await checked.close();
    }
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

  it("uses the caller role header when it forwards the question", async () => {
    const direct = await ask(server.url, "What is Horatio Kane's salary?", "executive");
    const response = await POST(jsonRequest("What is Horatio Kane's salary?", "executive"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer: string; status: string; caller: string };
    expect(body.status).toBe("ok");
    expect(body.caller).toBe("executive");
    expect(body.answer).toBe(direct.body.answer);
    expect(body.answer).toMatch(/\$/);

    const rejected = await POST(jsonRequest("Where does Bob Langley work?", "intern"));
    expect(rejected.status).toBe(400);
  });

  it("forwards the selected model and keeps stub when the header is omitted", async () => {
    const menu = await listModels();
    expect(menu.status).toBe(200);
    const listed = (await menu.json()) as { models: Array<{ id: string }> };
    expect(listed.models.map((model) => model.id)).toContain("stub");

    const response = await POST(jsonRequest("Where does Bob Langley work?", undefined, "stub"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { provider: string; answer: string };
    expect(body.provider).toBe("stub");
    expect(body.answer).toContain("Chicago");

    const rejected = await POST(jsonRequest("Where does Bob Langley work?", undefined, "composer-2.5"));
    expect(rejected.status).toBe(400);
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

function jsonRequest(query: string, role?: string, model?: string, stream = false): Request {
  return new Request("http://ledger.local/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
      ...(role ? { "x-caller-role": role } : {}),
      ...(model ? { "x-model": model } : {}),
    },
    body: JSON.stringify({ query }),
  });
}
