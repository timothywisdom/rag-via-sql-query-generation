import { ChatOpenAI } from "@langchain/openai";
import { streamChat } from "./chat-stream";
import { AIMessage } from "@langchain/core/messages";
import {
  COMPENSATION_FIELDS,
  FILTER_FIELDS,
  GROUP_FIELDS,
  METRIC_FNS,
  QUERY_TOOL_DESCRIPTION,
  SELECT_FIELDS,
} from "../ledger/catalog";
import { ROLE_LEVELS } from "../ledger/role-level";
import type { LlmProvider, LlmRequest } from "./types";

const stringEnum = (values: readonly string[]) => ({
  type: "string" as const,
  enum: [...values],
});

const queryLedgerTool = {
  type: "function" as const,
  function: {
    name: "query_ledger",
    description: QUERY_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        filters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: stringEnum(FILTER_FIELDS),
              op: stringEnum(["eq", "in", "gte", "lte", "between"]),
              value: {
                type: "string",
                description:
                  'Comparison value. For op "in" or "between", send a JSON array, for example ["Chicago","Boston"].',
              },
            },
            required: ["field", "op", "value"],
          },
        },
        fields: { type: "array", items: stringEnum(SELECT_FIELDS) },
        metrics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              fn: stringEnum(METRIC_FNS),
              field: stringEnum(COMPENSATION_FIELDS),
            },
            required: ["fn"],
          },
        },
        groupBy: { type: "array", items: stringEnum(GROUP_FIELDS) },
        orderBy: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: stringEnum(SELECT_FIELDS),
            direction: stringEnum(["asc", "desc"]),
          },
          required: ["field", "direction"],
        },
        limit: { type: "integer" },
        bandCity: { type: "string" },
        band: {
          type: "object",
          additionalProperties: false,
          properties: {
            city: { type: "string" },
            roleLevel: stringEnum(ROLE_LEVELS),
          },
          required: ["city"],
        },
      },
    },
  },
};

export type OllamaModel = { id: string; label: string; source: "ollama" };

const cache = new Map<string, { at: number; models: OllamaModel[] }>();
const CACHE_MS = 30000;

export async function listOllamaModels(
  baseUrl: string,
): Promise<OllamaModel[]> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  const response = await fetch(new URL("/api/tags", baseUrl), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
  const body = (await response.json()) as {
    models?: Array<{ name?: string; capabilities?: string[] }>;
  };
  const models = (body.models ?? []).flatMap((model) => {
    const name = model.name?.trim();
    if (!name) return [];
    if (model.capabilities && !model.capabilities.includes("tools")) return [];
    return [{ id: name, label: `Ollama ${name}`, source: "ollama" as const }];
  });
  cache.set(baseUrl, { at: Date.now(), models });
  return models;
}

export async function findOllamaModel(
  baseUrl: string,
  modelId: string,
): Promise<OllamaModel | undefined> {
  const models = await listOllamaModels(baseUrl);
  return models.find((model) => model.id === modelId);
}

export class OllamaProvider implements LlmProvider {
  readonly name: string;
  private readonly chat: ChatOpenAI;

  constructor(baseUrl: string, modelId: string) {
    this.name = modelId;
    this.chat = new ChatOpenAI({
      apiKey: "ollama",
      model: modelId,
      temperature: 0,
      maxRetries: 0,
      timeout: 120000,
      maxTokens: 1024,
      configuration: { baseURL: `${baseUrl}/v1` },
      modelKwargs: { think: false, options: { num_ctx: 8192 } },
    });
  }

  async invoke(request: LlmRequest): Promise<AIMessage> {
    const model =
      request.mode === "reason" && request.tools && request.tools.length > 0
        ? this.chat.bindTools([queryLedgerTool])
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

  stream(request: LlmRequest): AsyncIterable<string> {
    return streamChat(this.chat, request.messages);
  }
}
