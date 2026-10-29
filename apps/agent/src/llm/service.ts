import { AIMessage } from "@langchain/core/messages";
import { isRetryable, type LlmFailure, type LlmProvider, type LlmRequest } from "./types";

export class LlmService {
  constructor(
    private readonly provider: LlmProvider,
    private readonly maxAttempts: number,
    private readonly retryBaseMs: number,
  ) {}

  get name(): LlmProvider["name"] {
    return this.provider.name;
  }

  async invoke(request: LlmRequest): Promise<{ message: AIMessage; attempts: number }> {
    let lastError: unknown;
    let tried = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      tried = attempt;
      try {
        const message = await this.provider.invoke(request);
        return { message, attempts: tried };
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts || !isRetryable(error)) break;
        const delay = this.retryBaseMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Language model request failed";
    const failure = new Error(message) as LlmFailure;
    failure.retryable = false;
    failure.attempts = tried;
    throw failure;
  }
}
