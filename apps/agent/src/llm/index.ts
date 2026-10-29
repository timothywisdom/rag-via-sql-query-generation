import type { AppConfig } from "../config";
import { LlmService } from "./service";
import { OpenAiProvider } from "./openai";
import { StubProvider } from "./stub";
import type { LlmProvider } from "./types";

export function createLlmService(config: AppConfig): LlmService {
  return new LlmService(createProvider(config), config.maxLlmAttempts, config.retryBaseMs);
}

function createProvider(config: AppConfig): LlmProvider {
  if (config.llmProvider === "openai") {
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is missing. Set it in apps/agent/.env.local, or use LLM_PROVIDER=stub.");
    }
    return new OpenAiProvider(config.openaiApiKey, config.openaiModel);
  }
  return new StubProvider({
    alwaysTool: config.stubAlwaysTool,
    failMode: config.llmFailMode,
    failFirstN: config.llmFailFirstN,
  });
}
