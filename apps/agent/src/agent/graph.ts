import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { LedgerResult } from "../ledger/query";
import type { LlmService } from "../llm/service";
import type { LlmFailure, LlmRequest } from "../llm/types";
import { judgeAnswer } from "../eval/judge";
import { scoreGroundedness, toolContext, type GroundednessReport } from "../eval/score";
import { createLedgerTool } from "../tools/query-ledger";
import { trace as logTrace } from "../log";
import type { StreamEvent } from "./events";
import { generatePrompt, revisionPrompt } from "./prompt";
import { LedgerState, type Hop, type TraceEvent } from "./state";

type LedgerTool = ReturnType<typeof createLedgerTool>;

type GraphDeps = {
  llm: LlmService;
  ledgerTool: LedgerTool;
  maxReasoningSteps: number;
  onStepLimit: "generate" | "error";
  onlineEval: boolean;
  onlineEvalMaxRetries: number;
  maxJudgeAttempts: number;
  onEvent?: (event: StreamEvent) => void;
};

export function buildLedgerGraph(deps: GraphDeps) {
  return new StateGraph(LedgerState)
    .addNode("reason", (state) => reason(state, deps))
    .addNode("tools", (state) => runTools(state, deps))
    .addNode("generate", (state) => generate(state, deps))
    .addNode("evaluate", (state) => evaluateAnswer(state, deps))
    .addEdge(START, "reason")
    .addConditionalEdges("reason", route)
    .addConditionalEdges("tools", route)
    .addConditionalEdges("generate", (state) => afterGenerate(state, deps))
    .addConditionalEdges("evaluate", route)
    .compile();
}

function route(state: typeof LedgerState.State): Hop | typeof END {
  return state.next === "end" ? END : state.next;
}

function afterGenerate(state: typeof LedgerState.State, deps: GraphDeps): "evaluate" | typeof END {
  if (!deps.onlineEval || state.status === "error" || !state.answer) return END;
  return "evaluate";
}

function liveStream(deps: GraphDeps): boolean {
  return !deps.onlineEval && deps.onEvent !== undefined;
}

function emit(deps: GraphDeps, event: StreamEvent): void {
  if (!liveStream(deps)) return;
  deps.onEvent?.(event);
}

async function reason(state: typeof LedgerState.State, deps: GraphDeps) {
  emit(deps, { type: "status", phase: "reason" });
  logTrace("hop", { node: "reason", steps: state.steps });
  const reasoned = await callModel(deps.llm, {
    messages: state.messages,
    tools: [deps.ledgerTool],
    mode: "reason",
  });
  const llmAttempts = state.llmAttempts + reasoned.attempts;
  if (!reasoned.ok) return modelFailure(llmAttempts, reasoned.error);
  const calls = reasoned.message.tool_calls ?? [];
  const next = calls.length === 0 ? "generate" : "tools";
  logTrace("hop", { node: "reason", next, toolCalls: calls.map((call) => call.name) });
  if (calls.length === 0) return { llmAttempts, next: "generate" as const, forcedGenerate: false };
  return { llmAttempts, messages: [reasoned.message], next: "tools" as const };
}

async function runTools(state: typeof LedgerState.State, deps: GraphDeps) {
  emit(deps, { type: "status", phase: "tools" });
  const last = state.messages[state.messages.length - 1];
  const calls = last instanceof AIMessage ? (last.tool_calls ?? []) : [];
  const messages: BaseMessage[] = [];
  const trace: TraceEvent[] = [];
  let steps = state.steps;

  for (const call of calls) {
    if (steps >= deps.maxReasoningSteps) break;
    const toolCallId = call.id ?? crypto.randomUUID();
    const executed = await executeTool(deps.ledgerTool, call.name, call.args);
    steps += 1;
    logTrace("tool", {
      tool: call.name,
      status: executed.output.status,
      ...(executed.sql ? { sql: executed.sql } : {}),
    });
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

  const hitLimit = steps >= deps.maxReasoningSteps;
  const usable = trace.length > 0 && trace.every((event) => finishedLookup(event.output.status));
  if (hitLimit && deps.onStepLimit === "error") {
    return {
      messages,
      trace,
      steps,
      next: "end" as const,
      forcedGenerate: false,
      status: "error" as const,
      answer: null,
      error: `Reasoning stopped after ${steps} steps (limit ${deps.maxReasoningSteps}) without a final answer.`,
    };
  }
  return {
    messages,
    trace,
    steps,
    next: hitLimit || usable ? ("generate" as const) : ("reason" as const),
    forcedGenerate: hitLimit,
  };
}

function finishedLookup(status: string): boolean {
  return status === "ok" || status === "refused";
}

async function generate(state: typeof LedgerState.State, deps: GraphDeps) {
  logTrace("hop", { node: "generate", steps: state.steps, forced: state.forcedGenerate });
  if (state.evalAttempts > 0) emit(deps, { type: "replace" });
  emit(deps, { type: "status", phase: "generate" });
  const request: LlmRequest = {
    messages: [...state.messages, new SystemMessage(generatePrompt(state.forcedGenerate))],
    mode: "generate",
  };
  const generated = liveStream(deps)
    ? await streamAnswer(deps.llm, request, (piece) => emit(deps, { type: "token", text: piece }))
    : await callModel(deps.llm, request);
  const llmAttempts = state.llmAttempts + generated.attempts;
  if (!generated.ok) return modelFailure(llmAttempts, generated.error);
  const answer = textContent(generated.message).trim();
  if (!answer) return modelFailure(llmAttempts, "The model returned an empty answer.");
  const note = state.forcedGenerate
    ? "\n\nAnswered from the lookups completed before the step limit."
    : "";
  if (note) emit(deps, { type: "token", text: note });
  const last = state.trace[state.trace.length - 1];
  return {
    llmAttempts,
    answer: `${answer}${note}`,
    status: last?.output.status === "refused" ? ("refused" as const) : ("ok" as const),
    error: "",
  };
}

async function evaluateAnswer(state: typeof LedgerState.State, deps: GraphDeps) {
  emit(deps, { type: "status", phase: "evaluate" });
  const answer = state.answer ?? "";
  const question = askedQuestion(state);
  const context = toolContext(state.trace);
  const refusedWithoutFigures =
    state.trace.length > 0 && state.trace.every((event) => event.output.status !== "ok");
  if (deps.llm.name === "stub") {
    return finishEvaluation(
      state,
      deps,
      scoreGroundedness(answer, context, refusedWithoutFigures, question),
      state.llmAttempts,
    );
  }
  try {
    const scored = await judgeAnswer(
      deps.llm,
      {
        query: question,
        expectStatus: state.status,
        mustInclude: [],
        mustExclude: [],
      },
      answer,
      state.status,
      context,
      deps.maxJudgeAttempts,
    );
    const failures =
      scored.failures.length > 0 || (scored.accuracy === 1 && scored.groundedness === 1)
        ? scored.failures
        : ["The answer did not match the question and the tool results."];
    return finishEvaluation(
      state,
      deps,
      {
        groundedness: scored.groundedness,
        passed: scored.accuracy === 1 && scored.groundedness === 1,
        failures,
      },
      state.llmAttempts + scored.attempts,
    );
  } catch (error) {
    const failure = error as LlmFailure;
    logTrace("evaluate", {
      groundedness: 0,
      passed: false,
      attempt: state.evalAttempts + 1,
      failures: ["The judge did not return a score."],
    });
    return {
      llmAttempts: state.llmAttempts + (failure.attempts ?? 1),
      evaluation: {
        groundedness: 0,
        passed: false,
        failures: ["The judge did not return a score."],
      },
      next: "end" as const,
    };
  }
}

function finishEvaluation(
  state: typeof LedgerState.State,
  deps: GraphDeps,
  report: GroundednessReport,
  llmAttempts: number,
) {
  logTrace("evaluate", {
    groundedness: report.groundedness,
    passed: report.passed,
    attempt: state.evalAttempts + 1,
    failures: report.failures,
  });
  if (report.passed || state.evalAttempts >= deps.onlineEvalMaxRetries) {
    return { llmAttempts, evaluation: report, next: "end" as const };
  }
  const answer = state.answer ?? "";
  const next = state.trace.length > 0 ? ("generate" as const) : ("reason" as const);
  return {
    llmAttempts,
    evaluation: report,
    evalAttempts: state.evalAttempts + 1,
    messages: [new AIMessage(answer), new SystemMessage(revisionPrompt(report.failures))],
    next,
  };
}

function askedQuestion(state: typeof LedgerState.State): string {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.getType() === "human" && typeof message.content === "string") return message.content;
  }
  return "";
}

function modelFailure(llmAttempts: number, error: string) {
  return {
    llmAttempts,
    next: "end" as const,
    status: "error" as const,
    answer: null,
    error,
    forcedGenerate: false,
  };
}

async function executeTool(
  ledgerTool: LedgerTool,
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
    return modelCallFailure(error);
  }
}

async function streamAnswer(
  llm: LlmService,
  request: LlmRequest,
  onToken: (text: string) => void,
): Promise<ModelCall> {
  try {
    const result = await llm.streamGenerate(request, onToken);
    return { ok: true, message: result.message, attempts: result.attempts };
  } catch (error) {
    return modelCallFailure(error);
  }
}

function modelCallFailure(error: unknown): ModelCall {
  const failure = error as LlmFailure;
  return {
    ok: false,
    error: "The language model request failed.",
    attempts: failure.attempts ?? 1,
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
