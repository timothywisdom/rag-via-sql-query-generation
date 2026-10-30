import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export type LlmMode = "reason" | "generate";

export type LlmRequest = {
  messages: BaseMessage[];
  tools?: StructuredToolInterface[];
  mode: LlmMode;
};

export interface LlmProvider {
  readonly name: string;
  invoke(request: LlmRequest): Promise<AIMessage>;
  stream?(request: LlmRequest): AsyncIterable<string>;
}

export type LlmFailure = Error & { retryable?: boolean; attempts?: number };

export function isRetryable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return Boolean((error as { retryable?: boolean }).retryable);
  }
  const status = statusOf(error);
  if (status === 429 || (status != null && status >= 500)) return true;
  if (status != null && status >= 400) return false;
  const code = codeOf(error);
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND";
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" ? status : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
