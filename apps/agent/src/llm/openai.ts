import { ChatOpenAI } from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";
import type { LlmProvider, LlmRequest } from "./types";

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;
  private readonly chat: ChatOpenAI;

  constructor(apiKey: string, model: string) {
    this.chat = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0,
      maxRetries: 0,
      timeout: 30000,
    });
  }

  async invoke(request: LlmRequest): Promise<AIMessage> {
    const model =
      request.mode === "reason" && request.tools && request.tools.length > 0
        ? this.chat.bindTools(request.tools)
        : this.chat;
    const result = await model.invoke(request.messages);
    if (result.getType() !== "ai") {
      throw Object.assign(
        new Error("The language model returned a non-assistant message."),
        {
          retryable: false,
        },
      );
    }
    return result as AIMessage;
  }
}
