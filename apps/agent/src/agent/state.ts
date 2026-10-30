import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { GroundednessReport } from "../eval/score";
import type { LedgerResult } from "../ledger/query";

export type TraceEvent = {
  toolCallId: string;
  tool: string;
  args: unknown;
  output: LedgerResult;
  sql?: string;
};

export type Hop = "reason" | "tools" | "generate" | "evaluate" | "end";

export const LedgerState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  trace: Annotation<TraceEvent[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  steps: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  llmAttempts: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  next: Annotation<Hop>({
    reducer: (_, right) => right,
    default: () => "reason",
  }),
  forcedGenerate: Annotation<boolean>({
    reducer: (_, right) => right,
    default: () => false,
  }),
  status: Annotation<"ok" | "refused" | "error">({
    reducer: (_, right) => right,
    default: () => "ok",
  }),
  answer: Annotation<string | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  error: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  evalAttempts: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  evaluation: Annotation<GroundednessReport | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
});
