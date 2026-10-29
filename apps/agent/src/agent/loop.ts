import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { AppConfig } from "../config";
import type { LedgerDatabase } from "../ledger/database";
import type { LedgerResult } from "../ledger/query";
import { LlmService } from "../llm/service";
import type { LlmFailure, LlmRequest } from "../llm/types";
import { createLedgerTool } from "../tools/query-ledger";
import { generatePrompt, systemPrompt } from "./prompt";

export type TraceEvent = {
  toolCallId: string;
  tool: string;
  args: unknown;
  output: LedgerResult;
  sql?: string;
};

export type AgentResponse = {
  status: "ok" | "refused" | "error";
  answer: string | null;
  error?: string;
  steps: number;
  forcedGenerate: boolean;
  llmAttempts: number;
  trace: TraceEvent[];
  provider: string;
  caller: "junior_hr_assistant";
};

export async function runLedgerAgent(
  db: LedgerDatabase,
  llm: LlmService,
  config: AppConfig,
  query: string,
): Promise<AgentResponse> {
  const ledgerTool = createLedgerTool(db, config.asOfDate);
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt(config.asOfDate)), new HumanMessage(query)];
  const trace: TraceEvent[] = [];
  let steps = 0;
  let llmAttempts = 0;

  while (steps < config.maxReasoningSteps) {
    const reasoned = await callModel(llm, {
      messages,
      tools: [ledgerTool],
      mode: "reason",
    });
    if (!reasoned.ok) return fail(reasoned.attempts, reasoned.error, steps, trace, llm.name, llmAttempts);
    llmAttempts += reasoned.attempts;
    const calls = reasoned.message.tool_calls ?? [];
    if (calls.length === 0) break;
    messages.push(reasoned.message);

    for (const call of calls) {
      if (steps >= config.maxReasoningSteps) break;
      const toolCallId = call.id ?? crypto.randomUUID();
      const executed = await executeTool(ledgerTool, call.name, call.args);
      steps += 1;
      trace.push({
        toolCallId,
        tool: call.name,
        args: call.args,
        output: executed.output,
        sql: executed.sql,
      });
      messages.push(
        new ToolMessage({
          content: executed.content,
          tool_call_id: toolCallId,
          name: call.name,
        }),
      );
    }
  }

  const hitLimit = steps >= config.maxReasoningSteps && stillWantsTools(messages);
  if (hitLimit && config.onStepLimit === "error") {
    return {
      status: "error",
      answer: null,
      error: `Reasoning stopped after ${steps} steps (limit ${config.maxReasoningSteps}) without a final answer.`,
      steps,
      forcedGenerate: false,
      llmAttempts,
      trace,
      provider: llm.name,
      caller: "junior_hr_assistant",
    };
  }
  const forcedGenerate = hitLimit;

  const generated = await callModel(llm, {
    messages: [
      ...messages,
      new SystemMessage(generatePrompt(forcedGenerate)),
    ],
    mode: "generate",
  });
  if (!generated.ok) return fail(generated.attempts, generated.error, steps, trace, llm.name, llmAttempts);
  llmAttempts += generated.attempts;
  const answer = textContent(generated.message).trim();
  if (!answer) {
    return fail(0, "The model returned an empty answer.", steps, trace, llm.name, llmAttempts);
  }

  const note = forcedGenerate
    ? `\n\nAnswered from the lookups completed before the ${config.maxReasoningSteps}-step limit.`
    : "";
  return {
    status: statusFromTrace(trace),
    answer: `${answer}${note}`,
    steps,
    forcedGenerate,
    llmAttempts,
    trace,
    provider: llm.name,
    caller: "junior_hr_assistant",
  };
}

function stillWantsTools(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last?.getType() === "tool";
}

function statusFromTrace(trace: TraceEvent[]): "ok" | "refused" {
  const last = trace[trace.length - 1];
  if (last?.output.status === "refused") return "refused";
  return "ok";
}

async function executeTool(
  ledgerTool: ReturnType<typeof createLedgerTool>,
  name: string,
  args: unknown,
): Promise<{ content: string; output: LedgerResult; sql?: string }> {
  if (name !== "query_ledger") {
    const output: LedgerResult = { status: "invalid", message: `Unknown tool ${name}.` };
    return { content: JSON.stringify(output), output };
  }
  try {
    const raw = await ledgerTool.invoke(typeof args === "string" ? JSON.parse(args) : args);
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as LedgerResult;
    const { sql, ...output } = parsed;
    return { content: JSON.stringify(output), output, sql };
  } catch (error) {
    const output: LedgerResult = {
      status: "invalid",
      message: error instanceof Error ? error.message : "The ledger query was rejected.",
    };
    return { content: JSON.stringify(output), output };
  }
}

type ModelCall =
  | { ok: true; message: AIMessage; attempts: number }
  | { ok: false; error: string; attempts: number };

async function callModel(llm: LlmService, request: LlmRequest): Promise<ModelCall> {
  try {
    const result = await llm.invoke(request);
    return { ok: true, message: result.message, attempts: result.attempts };
  } catch (error) {
    const failure = error as LlmFailure;
    return {
      ok: false,
      error: "The language model request failed.",
      attempts: failure.attempts ?? 1,
    };
  }
}

function fail(
  attempts: number,
  error: string,
  steps: number,
  trace: TraceEvent[],
  provider: string,
  llmAttempts: number,
): AgentResponse {
  return {
    status: "error",
    answer: null,
    error,
    steps,
    forcedGenerate: false,
    llmAttempts: llmAttempts + attempts,
    trace,
    provider,
    caller: "junior_hr_assistant",
  };
}

function textContent(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}
