import { fileURLToPath } from "node:url";

export type AppConfig = {
  host: string;
  port: number;
  llmProvider: "stub" | "openai";
  openaiApiKey?: string;
  openaiModel: string;
  maxLlmAttempts: number;
  retryBaseMs: number;
  maxReasoningSteps: number;
  onStepLimit: "generate" | "error";
  asOfDate: string;
  dataDir: string;
  instanceId: string;
  stubAlwaysTool: boolean;
  llmFailMode: "none" | "retryable" | "fatal";
  llmFailFirstN: number;
};

export function defaultDataDir(): string {
  return fileURLToPath(new URL("../../../specs", import.meta.url));
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const llmProvider = env.LLM_PROVIDER || "stub";
  if (llmProvider !== "stub" && llmProvider !== "openai") {
    throw new Error("LLM_PROVIDER must be stub or openai.");
  }
  const onStepLimit = env.ON_STEP_LIMIT || "generate";
  if (onStepLimit !== "generate" && onStepLimit !== "error") {
    throw new Error("ON_STEP_LIMIT must be generate or error.");
  }
  const failMode = env.LLM_FAIL_MODE || "none";
  if (failMode !== "none" && failMode !== "retryable" && failMode !== "fatal") {
    throw new Error("LLM_FAIL_MODE must be none, retryable, or fatal.");
  }
  const asOfDate = env.AS_OF_DATE || "2026-10-29";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error("AS_OF_DATE must be YYYY-MM-DD.");
  }
  const maxReasoningSteps = intEnv(env, "MAX_REASONING_STEPS", 4);
  if (maxReasoningSteps < 1 || maxReasoningSteps > 8) {
    throw new Error("MAX_REASONING_STEPS must be from 1 to 8.");
  }
  const maxLlmAttempts = intEnv(env, "LLM_MAX_ATTEMPTS", 3);
  if (maxLlmAttempts < 1 || maxLlmAttempts > 5) {
    throw new Error("LLM_MAX_ATTEMPTS must be from 1 to 5.");
  }

  return {
    host: env.HOST || "127.0.0.1",
    port: intEnv(env, "PORT", 4001),
    llmProvider,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
    maxLlmAttempts,
    retryBaseMs: intEnv(env, "LLM_RETRY_BASE_MS", 200),
    maxReasoningSteps,
    onStepLimit,
    asOfDate,
    dataDir: env.LEDGER_DATA_DIR || defaultDataDir(),
    instanceId: env.AGENT_INSTANCE || `agent-${process.pid}`,
    stubAlwaysTool: env.STUB_ALWAYS_TOOL === "1",
    llmFailMode: failMode,
    llmFailFirstN: intEnv(env, "LLM_FAIL_FIRST_N", 0),
  };
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}
