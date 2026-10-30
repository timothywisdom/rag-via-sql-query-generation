import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage } from "@langchain/core/messages";
import { SchemaType } from "@google/generative-ai";
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

export const GEMINI_MODEL_ID = "gemini-3.8-flash";
export const GEMINI_MODEL_LABEL = "Gemini 3.8 Flash";

const stringEnum = (values: readonly string[]) => ({
  type: SchemaType.STRING,
  format: "enum",
  enum: [...values],
});

const queryLedgerDeclaration = {
  functionDeclarations: [
    {
      name: "query_ledger",
      description: QUERY_TOOL_DESCRIPTION,
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          filters: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                field: stringEnum(FILTER_FIELDS),
                op: stringEnum(["eq", "in", "gte", "lte", "between"]),
                value: {
                  type: SchemaType.STRING,
                  description:
                    'Comparison value. For op "in" or "between", send a JSON array, for example ["Chicago","Boston"].',
                },
              },
              required: ["field", "op", "value"],
            },
          },
          fields: { type: SchemaType.ARRAY, items: stringEnum(SELECT_FIELDS) },
          metrics: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                fn: stringEnum(METRIC_FNS),
                field: stringEnum(COMPENSATION_FIELDS),
              },
              required: ["fn"],
            },
          },
          groupBy: { type: SchemaType.ARRAY, items: stringEnum(GROUP_FIELDS) },
          orderBy: {
            type: SchemaType.OBJECT,
            properties: {
              field: stringEnum(SELECT_FIELDS),
              direction: stringEnum(["asc", "desc"]),
            },
            required: ["field", "direction"],
          },
          limit: { type: SchemaType.INTEGER },
          bandCity: { type: SchemaType.STRING },
          band: {
            type: SchemaType.OBJECT,
            properties: {
              city: { type: SchemaType.STRING },
              roleLevel: stringEnum(ROLE_LEVELS),
            },
            required: ["city"],
          },
        },
      },
    },
  ],
};

export class GeminiProvider implements LlmProvider {
  readonly name = GEMINI_MODEL_ID;
  private readonly chat: ChatGoogleGenerativeAI;

  constructor(apiKey: string) {
    this.chat = new ChatGoogleGenerativeAI({
      apiKey,
      model: GEMINI_MODEL_ID,
      temperature: 0,
      maxRetries: 0,
      thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
    });
  }

  async invoke(request: LlmRequest): Promise<AIMessage> {
    const model =
      request.mode === "reason" && request.tools && request.tools.length > 0
        ? this.chat.bindTools([queryLedgerDeclaration])
        : this.chat;
    const result = await model.invoke(request.messages);
    if (result.getType() !== "ai") {
      throw Object.assign(new Error("The language model returned a non-assistant message."), {
        retryable: false,
      });
    }
    return result as AIMessage;
  }
}
