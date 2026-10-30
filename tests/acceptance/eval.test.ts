import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { afterAll, describe, expect, it } from "vitest";
import type { StreamEvent } from "../../apps/agent/src/agent/events";
import { buildLedgerGraph } from "../../apps/agent/src/agent/graph";
import { systemPrompt } from "../../apps/agent/src/agent/prompt";
import { defaultDataDir } from "../../apps/agent/src/config";
import { JUDGE_SYSTEM, parseJudgeScore } from "../../apps/agent/src/eval/judge";
import { scoreAccuracy, scoreGroundedness, type GoldenCase } from "../../apps/agent/src/eval/score";
import { loadLedger } from "../../apps/agent/src/ledger/database";
import { LlmService } from "../../apps/agent/src/llm/service";
import type { LlmProvider, LlmRequest } from "../../apps/agent/src/llm/types";
import { createLedgerTool } from "../../apps/agent/src/tools/query-ledger";

const db = loadLedger(defaultDataDir());

afterAll(() => {
  db.close();
});

describe("answer scores", () => {
  it("accepts figures that appear in the tool result and rejects invented ones", () => {
    const context = JSON.stringify({
      status: "ok",
      rows: [{ fullName: "Bob Langley", officeLocation: "Chicago", hireDate: "2019-03-15", tenure: "7 years, 7 months" }],
    });
    const grounded = scoreGroundedness(
      "Bob Langley works in Chicago. Hired on 2019-03-15. That is 7 years, 7 months.",
      context,
      false,
    );
    expect(grounded.passed).toBe(true);
    expect(grounded.groundedness).toBe(1);

    const invented = scoreGroundedness("His salary is $485,000.00.", context, true);
    expect(invented.passed).toBe(false);
    expect(invented.groundedness).toBe(0);
  });

  it("rejects a place that is not in the tool result when the answer has no number", () => {
    const context = JSON.stringify({
      status: "ok",
      rows: [{ fullName: "Bob Langley", officeLocation: "Chicago", department: "Finance" }],
    });
    const grounded = scoreGroundedness("Bob Langley works in Chicago.", context, false);
    expect(grounded.passed).toBe(true);
    expect(grounded.groundedness).toBe(1);

    const invented = scoreGroundedness("Bob Langley works in Paris.", context, false);
    expect(invented.passed).toBe(false);
    expect(invented.failures.join(" ")).toMatch(/paris/i);
  });

  it("accepts a refusal that repeats the year from the question", () => {
    const item: GoldenCase = {
      id: "nancy",
      query: "What was the total of expenses paid to Nancy Nunchuk in 2023?",
      caller: "junior_hr_assistant",
      expectStatus: "refused",
      mustInclude: ["Nancy Nunchuk"],
      mustExclude: ["$28,500.00"],
    };
    const answer =
      "I'm sorry, but I'm unable to provide Nancy Nunchuk's 2023 expense figures. Executive compensation is restricted for a Junior HR Assistant. I'd recommend asking a Senior HR Manager or the Finance team.";
    const context = JSON.stringify({
      status: "refused",
      message:
        "I can't share Nancy Nunchuk's compensation. Executive compensation is restricted for a Junior HR Assistant.",
    });
    expect(scoreAccuracy(answer, "refused", item).accuracy).toBe(1);
    const grounded = scoreGroundedness(answer, context, true, item.query);
    expect(grounded.passed).toBe(true);
    expect(grounded.groundedness).toBe(1);
  });

  it("reads a judge score from a JSON object", () => {
    const scored = parseJudgeScore(
      '```json\n{"accuracy": 1, "groundedness": 0.5, "failures": ["The figure 46000 is not supported."]}\n```',
    );
    expect(scored.accuracy).toBe(1);
    expect(scored.groundedness).toBe(0.5);
    expect(scored.failures).toEqual(["The figure 46000 is not supported."]);
  });

  it("scores a golden refusal by the expected text and the absence of leaked figures", () => {
    const item: GoldenCase = {
      id: "horatio",
      query: "What is Horatio Kane's salary?",
      caller: "junior_hr_assistant",
      expectStatus: "refused",
      mustInclude: ["Horatio Kane"],
      mustExclude: ["$485,000.00"],
    };
    const safe = scoreAccuracy(
      "I can't share Horatio Kane's compensation.",
      "refused",
      item,
    );
    expect(safe.accuracy).toBe(1);
    const leaked = scoreAccuracy("Horatio Kane earns $485,000.00.", "ok", item);
    expect(leaked.accuracy).toBeLessThan(1);
  });
});

describe("online groundedness check", () => {
  it("regenerates an ungrounded answer when the check is on", async () => {
    const checked = new ScriptedModel();
    const result = await runHoratio(checked, true);
    expect(checked.generates).toBe(2);
    expect(checked.judgments).toBe(2);
    expect(result.answer).not.toMatch(/485/);
    expect(result.evaluation?.passed).toBe(true);
    expect(result.evaluation?.groundedness).toBe(1);
  });

  it("keeps the first answer when the check is off", async () => {
    const unchecked = new ScriptedModel();
    const result = await runHoratio(unchecked, false);
    expect(unchecked.generates).toBe(1);
    expect(unchecked.judgments).toBe(0);
    expect(result.answer).toContain("$485,000.00");
    expect(result.evaluation).toBeNull();
  });

  it("does not stream a draft while the live check can regenerate it", async () => {
    const checked = new ScriptedModel();
    const events: StreamEvent[] = [];
    const result = await runHoratio(checked, true, events);
    expect(events).toEqual([]);
    expect(checked.generates).toBe(2);
    expect(result.answer).not.toMatch(/485/);
    expect(result.evaluation?.passed).toBe(true);
  });

  it("keeps the answer when the judge does not return a score", async () => {
    const broken = new ScriptedModel();
    broken.judgeText = "I think this answer is fine.";
    const result = await runHoratio(broken, true);
    expect(broken.generates).toBe(1);
    expect(broken.judgments).toBe(1);
    expect(result.answer).toContain("$485,000.00");
    expect(result.evaluation?.passed).toBe(false);
  });
});

class ScriptedModel implements LlmProvider {
  readonly name = "scripted";
  generates = 0;
  judgments = 0;
  judgeText = "";

  async invoke(request: LlmRequest): Promise<AIMessage> {
    if (request.messages.some((message) => message.getType() === "system" && message.content === JUDGE_SYSTEM)) {
      this.judgments += 1;
      if (this.judgeText) return new AIMessage(this.judgeText);
      const transcript = request.messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      const answer = transcript.split("Answer:").at(-1) ?? "";
      if (answer.includes("$485,000.00")) {
        return new AIMessage(
          '{"accuracy":0,"groundedness":0,"failures":["The figure 485000 is not in the tool results."]}',
        );
      }
      return new AIMessage('{"accuracy":1,"groundedness":1,"failures":[]}');
    }
    if (request.mode === "reason") {
      const lookedUp = request.messages.some((message) => message.getType() === "tool");
      if (lookedUp) return new AIMessage("");
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "lookup-horatio",
            name: "query_ledger",
            args: {
              filters: [{ field: "name", op: "eq", value: "Horatio Kane" }],
              fields: ["salary_2025"],
            },
            type: "tool_call",
          },
        ],
      });
    }
    this.generates += 1;
    if (this.generates === 1) return new AIMessage("Horatio Kane's salary is $485,000.00.");
    return new AIMessage("I can't share Horatio Kane's compensation.");
  }
}

async function runHoratio(model: ScriptedModel, onlineEval: boolean, events?: StreamEvent[]) {
  const graph = buildLedgerGraph({
    llm: new LlmService(model, 1, 1),
    ledgerTool: createLedgerTool(db, "2026-10-29", "junior_hr_assistant"),
    maxReasoningSteps: 4,
    onStepLimit: "generate",
    onlineEval,
    onlineEvalMaxRetries: 1,
    onEvent: events ? (event) => events.push(event) : undefined,
  });
  const final = await graph.invoke({
    messages: [
      new SystemMessage(systemPrompt("2026-10-29", "junior_hr_assistant")),
      new HumanMessage("What is Horatio Kane's salary?"),
    ],
  });
  return final;
}
