import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask, boot } from "./harness";
import type { RunningServer } from "../../apps/agent/src/server";

describe("reasoning limit and model retry", () => {
  let limited: RunningServer;
  let forced: RunningServer;
  let flaky: RunningServer;
  let fatal: RunningServer;

  beforeAll(async () => {
    [limited, forced, flaky, fatal] = await Promise.all([
      boot({ maxReasoningSteps: 2, onStepLimit: "error", stubAlwaysTool: true, instanceId: "limit-error" }),
      boot({ maxReasoningSteps: 2, onStepLimit: "generate", stubAlwaysTool: true, instanceId: "limit-generate" }),
      boot({ llmFailMode: "retryable", llmFailFirstN: 2, instanceId: "retry" }),
      boot({ llmFailMode: "fatal", instanceId: "fatal" }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([limited.close(), forced.close(), flaky.close(), fatal.close()]);
  });

  it("returns an error when the step limit is reached and generate-on-limit is off", async () => {
    const { status, body } = await ask(limited.url, "What was the total payroll for 2024?");
    expect(status).toBe(200);
    expect(body.status).toBe("error");
    expect(body.answer).toBeNull();
    expect(body.steps).toBe(2);
    expect(body.llmAttempts).toBe(2);
    expect(body.forcedGenerate).toBe(false);
    expect(body.error).toMatch(/2 steps/);
    expect(body.trace).toHaveLength(2);
  });

  it("generates from the finished lookups when the step limit is reached", async () => {
    const { body } = await ask(forced.url, "What was the total payroll for 2024?");
    expect(body.status).toBe("ok");
    expect(body.forcedGenerate).toBe(true);
    expect(body.steps).toBe(2);
    expect(body.llmAttempts).toBe(3);
    expect(body.answer).toContain("I couldn't find an employee named Nobody Matches.");
    expect(body.answer).toMatch(/step limit/);
  });

  it("retries a timed-out model call and still answers", async () => {
    const { body } = await ask(flaky.url, "Where does Bob Langley work? How long has he been employed?");
    expect(body.status).toBe("ok");
    expect(body.answer).toContain("Chicago");
    expect(body.llmAttempts).toBe(4);
  });

  it("stops on a non-retryable model failure", async () => {
    const { body } = await ask(fatal.url, "Where does Bob Langley work?");
    expect(body.status).toBe("error");
    expect(body.answer).toBeNull();
    expect(body.llmAttempts).toBe(1);
    expect(body.error).toMatch(/language model request failed/i);
  });
});
