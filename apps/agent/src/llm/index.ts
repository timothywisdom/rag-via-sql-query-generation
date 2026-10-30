import type { AppConfig } from "../config";
import { CursorProvider, findCursorModel, STUB_MODEL_ID } from "./cursor";
import { GEMINI_MODEL_ID, GeminiProvider } from "./gemini";
import { findOllamaModel, OllamaProvider } from "./ollama";
import { LlmService } from "./service";
import { OpenAiProvider } from "./openai";
import { StubProvider } from "./stub";
import type { LlmProvider } from "./types";

export class ModelSelectionError extends Error {}

export function createLlmService(config: AppConfig): LlmService {
  return new LlmService(createProvider(config), config.maxLlmAttempts, config.retryBaseMs);
}

export async function llmForModel(config: AppConfig, modelId: string, fallback: LlmService): Promise<LlmService> {
  if (modelId === STUB_MODEL_ID) return fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(modelId)) {
    throw new ModelSelectionError("Unknown model.");
  }
  if (modelId === GEMINI_MODEL_ID) {
    if (!config.geminiApiKey) {
      throw new ModelSelectionError("Set GEMINI_API_KEY in apps/agent/.env.local to use Gemini.");
    }
    return new LlmService(new GeminiProvider(config.geminiApiKey), config.maxLlmAttempts, config.retryBaseMs);
  }
  if (config.ollamaBaseUrl) {
    try {
      const ollama = await findOllamaModel(config.ollamaBaseUrl, modelId);
      if (ollama) {
        return new LlmService(
          new OllamaProvider(config.ollamaBaseUrl, ollama.id),
          config.maxLlmAttempts,
          config.retryBaseMs,
        );
      }
    } catch {
      throw new ModelSelectionError("Ollama could not be reached.");
    }
  }
  if (!config.cursorApiKey) {
    throw new ModelSelectionError(
      config.ollamaBaseUrl
        ? "Unknown model."
        : "Set CURSOR_API_KEY in apps/agent/.env.local to use a Cursor model.",
    );
  }
  const model = await findCursorModel(config.cursorApiKey, modelId);
  if (!model) throw new ModelSelectionError("Unknown model.");
  return new LlmService(new CursorProvider(config.cursorApiKey, model), config.maxLlmAttempts, config.retryBaseMs);
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
