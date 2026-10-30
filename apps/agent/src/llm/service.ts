import { AIMessage } from "@langchain/core/messages";
import { errorSummary, trace } from "../log";
import { textOf } from "./text";
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
      const started = Date.now();
      trace("llm_start", {
        provider: this.name,
        mode: request.mode,
        attempt,
        tools: request.tools?.length ?? 0,
      });
      const waiting = setInterval(() => {
        trace("llm_wait", {
          provider: this.name,
          mode: request.mode,
          attempt,
          waitedMs: Date.now() - started,
        });
      }, 15_000);
      waiting.unref();
      try {
        const message = await this.provider.invoke(request);
        const toolCalls = message.tool_calls?.map((call) => call.name) ?? [];
        trace("llm_done", {
          provider: this.name,
          mode: request.mode,
          attempt,
          durationMs: Date.now() - started,
          toolCalls,
        });
        return { message, attempts: tried };
      } catch (error) {
        lastError = error;
        const retry = attempt < this.maxAttempts && isRetryable(error);
        trace("llm_error", {
          provider: this.name,
          mode: request.mode,
          attempt,
          durationMs: Date.now() - started,
          retry,
          ...errorSummary(error),
        });
        if (!retry) break;
        const delay = this.retryBaseMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearInterval(waiting);
      }
    }

    const failure = new Error(errorSummary(lastError).message) as LlmFailure;
    failure.retryable = false;
    failure.attempts = tried;
    throw failure;
  }

  async streamGenerate(
    request: LlmRequest,
    onToken: (text: string) => void,
  ): Promise<{ message: AIMessage; attempts: number }> {
    let lastError: unknown;
    let tried = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      tried = attempt;
      const started = Date.now();
      trace("llm_start", {
        provider: this.name,
        mode: request.mode,
        attempt,
        tools: request.tools?.length ?? 0,
      });
      const waiting = setInterval(() => {
        trace("llm_wait", {
          provider: this.name,
          mode: request.mode,
          attempt,
          waitedMs: Date.now() - started,
        });
      }, 15_000);
      waiting.unref();
      let emitted = "";
      try {
        if (this.provider.stream) {
          for await (const piece of this.provider.stream(request)) {
            if (!piece) continue;
            emitted += piece;
            onToken(piece);
          }
        } else {
          const message = await this.provider.invoke(request);
          emitted = textOf(message.content);
          if (emitted) onToken(emitted);
        }
        trace("llm_done", {
          provider: this.name,
          mode: request.mode,
          attempt,
          durationMs: Date.now() - started,
          toolCalls: [],
        });
        return { message: new AIMessage(emitted), attempts: tried };
      } catch (error) {
        lastError = error;
        const retry = emitted.length === 0 && attempt < this.maxAttempts && isRetryable(error);
        trace("llm_error", {
          provider: this.name,
          mode: request.mode,
          attempt,
          durationMs: Date.now() - started,
          retry,
          ...errorSummary(error),
        });
        if (!retry) break;
        const delay = this.retryBaseMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearInterval(waiting);
      }
    }

    const failure = new Error(errorSummary(lastError).message) as LlmFailure;
    failure.retryable = false;
    failure.attempts = tried;
    throw failure;
  }
}
