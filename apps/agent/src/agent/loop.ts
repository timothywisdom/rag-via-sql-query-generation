import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AppConfig } from "../config";
import type { CallerRole } from "../ledger/callers";
import type { LedgerDatabase } from "../ledger/database";
import { LlmService } from "../llm/service";
import { createLedgerTool } from "../tools/query-ledger";
import { buildLedgerGraph } from "./graph";
import { systemPrompt } from "./prompt";
import type { GroundednessReport } from "../eval/score";
import type { TraceEvent } from "./state";

export type { TraceEvent };

export type AgentResponse = {
  status: "ok" | "refused" | "error";
  answer: string | null;
  error?: string;
  steps: number;
  forcedGenerate: boolean;
  llmAttempts: number;
  trace: TraceEvent[];
  provider: string;
  caller: CallerRole;
  evaluation?: GroundednessReport;
};

export async function runLedgerAgent(
  db: LedgerDatabase,
  llm: LlmService,
  config: AppConfig,
  query: string,
  caller: CallerRole,
): Promise<AgentResponse> {
  const ledgerTool = createLedgerTool(db, config.asOfDate, caller);
  const graph = buildLedgerGraph({
    llm,
    ledgerTool,
    maxReasoningSteps: config.maxReasoningSteps,
    onStepLimit: config.onStepLimit,
    onlineEval: config.onlineEval,
    onlineEvalMaxRetries: config.onlineEvalMaxRetries,
  });
  const final = await graph.invoke({
    messages: [new SystemMessage(systemPrompt(config.asOfDate, caller)), new HumanMessage(query)],
  });
  return {
    status: final.status,
    answer: final.answer,
    error: final.error || undefined,
    steps: final.steps,
    forcedGenerate: final.forcedGenerate,
    llmAttempts: final.llmAttempts,
    trace: final.trace,
    provider: llm.name,
    caller,
    ...(final.evaluation ? { evaluation: final.evaluation } : {}),
  };
}
