import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { QUERY_TOOL_DESCRIPTION } from "../ledger/catalog";
import { GEMINI_MODEL_ID, GEMINI_MODEL_LABEL } from "./gemini";
import { listOllamaModels } from "./ollama";
import type { LlmProvider, LlmRequest } from "./types";

export const STUB_MODEL_ID = "stub";
export const MODEL_HEADER = "x-model";

export type CatalogModel = {
  id: string;
  label: string;
  params?: Array<{ id: string; value: string }>;
};

export type ModelMenu = {
  models: Array<{
    id: string;
    label: string;
    source: "stub" | "gemini" | "ollama" | "cursor";
  }>;
  cursor: "ready" | "missing_key" | "unavailable";
  gemini: "ready" | "missing_key";
  ollama: "unset" | "ready" | "unavailable";
};

type ListedModel = {
  id: string;
  displayName?: string;
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
  variants?: Array<{
    params?: Array<{ id: string; value: string }>;
    isDefault?: boolean;
  }>;
};

const cache = new Map<string, { at: number; models: CatalogModel[] }>();
const CACHE_MS = 60000;

export async function listModels(keys: {
  cursorApiKey?: string;
  geminiApiKey?: string;
  ollamaBaseUrl?: string;
}): Promise<ModelMenu> {
  const models: ModelMenu["models"] = [
    { id: STUB_MODEL_ID, label: "Stub", source: "stub" },
  ];
  const gemini = keys.geminiApiKey ? "ready" : "missing_key";
  if (keys.geminiApiKey)
    models.push({
      id: GEMINI_MODEL_ID,
      label: GEMINI_MODEL_LABEL,
      source: "gemini",
    });
  const ollama = await ollamaEntries(keys.ollamaBaseUrl);
  models.push(...ollama.models);
  if (!keys.cursorApiKey) {
    return { models, cursor: "missing_key", gemini, ollama: ollama.status };
  }
  try {
    const cursor = await cursorModels(keys.cursorApiKey);
    models.push(
      ...cursor.map(({ id, label }) => ({
        id,
        label,
        source: "cursor" as const,
      })),
    );
    return { models, cursor: "ready", gemini, ollama: ollama.status };
  } catch {
    return { models, cursor: "unavailable", gemini, ollama: ollama.status };
  }
}

async function ollamaEntries(baseUrl: string | undefined): Promise<{
  status: ModelMenu["ollama"];
  models: ModelMenu["models"];
}> {
  if (!baseUrl) return { status: "unset", models: [] };
  try {
    return { status: "ready", models: await listOllamaModels(baseUrl) };
  } catch {
    return { status: "unavailable", models: [] };
  }
}

export async function findCursorModel(
  apiKey: string,
  modelId: string,
): Promise<CatalogModel | undefined> {
  const models = await cursorModels(apiKey);
  return models.find((model) => model.id === modelId);
}

export class CursorProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: CatalogModel,
  ) {
    this.name = model.id;
  }

  async invoke(request: LlmRequest): Promise<AIMessage> {
    const sdk = await import("@cursor/sdk");
    const prompt =
      request.mode === "generate"
        ? generateInstruction(request.messages)
        : reasonInstruction(request.messages);
    try {
      const result = await sdk.Agent.prompt(prompt, {
        apiKey: this.apiKey,
        name: "ledger-logic",
        model: { id: this.model.id, params: this.model.params },
        tools: [],
        systemPrompt:
          "You are the language model inside a Payroll Assistant. Follow the user message exactly. Do not use tools, browse, or edit files.",
        local: {
          cwd: cursorCwd(),
          settingSources: [],
          enableAgentRetries: false,
        },
      });
      if (result.status !== "finished") {
        throw Object.assign(
          new Error(result.error?.message || "The Cursor model run failed."),
          { retryable: false },
        );
      }
      const text = result.result ?? "";
      return request.mode === "generate"
        ? new AIMessage(text)
        : messageFromCursorReason(text);
    } catch (error) {
      if (hasRetryableFlag(error)) throw error;
      const retryable =
        error instanceof sdk.CursorAgentError && error.isRetryable;
      const message =
        error instanceof Error
          ? error.message
          : "The Cursor model request failed.";
      throw Object.assign(new Error(message), { retryable });
    }
  }
}

export function messageFromCursorReason(text: string): AIMessage {
  const parsed = parseJsonObject(text);
  const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
  const toolCalls = calls.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const record = call as { name?: unknown; arguments?: unknown };
    if (record.name !== "query_ledger") return [];
    return [
      {
        id: crypto.randomUUID(),
        name: "query_ledger",
        args: objectArgs(record.arguments),
        type: "tool_call" as const,
      },
    ];
  });
  if (toolCalls.length === 0) return new AIMessage("");
  return new AIMessage({ content: "", tool_calls: toolCalls });
}

function reasonInstruction(messages: BaseMessage[]): string {
  return `${transcript(messages)}

You are deciding the next ledger lookup. ${QUERY_TOOL_DESCRIPTION}

Reply with one JSON object and no other text.
To look something up: {"tool_calls":[{"name":"query_ledger","arguments":{}}]}
When the tool results are enough, or no lookup is needed: {"tool_calls":[]}`;
}

function generateInstruction(messages: BaseMessage[]): string {
  return `${transcript(messages)}

Write the final answer for the user as plain text. Do not call tools and do not wrap the answer in JSON.`;
}

function transcript(messages: BaseMessage[]): string {
  return messages
    .map((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      if (message.getType() === "ai") {
        const calls = (message as AIMessage).tool_calls ?? [];
        const rendered =
          calls.length > 0
            ? `${text}\nTool calls: ${JSON.stringify(calls)}`
            : text;
        return `Assistant:\n${rendered}`;
      }
      const label =
        message.getType() === "tool"
          ? "Tool result"
          : message.getType() === "system"
            ? "System"
            : "User";
      return `${label}:\n${text}`;
    })
    .join("\n\n");
}

function parseJsonObject(text: string): { tool_calls?: unknown[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw Object.assign(
      new Error("The Cursor model did not return a tool-call JSON object."),
      { retryable: false },
    );
  }
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as {
      tool_calls?: unknown[];
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch (error) {
    if (hasRetryableFlag(error)) throw error;
    throw Object.assign(
      new Error("The Cursor model did not return a tool-call JSON object."),
      { retryable: false },
    );
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function hasRetryableFlag(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error;
}

async function cursorModels(apiKey: string): Promise<CatalogModel[]> {
  const hit = cache.get(apiKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  const sdk = await import("@cursor/sdk");
  const listed = (await sdk.Cursor.models.list({ apiKey })) as ListedModel[];
  const models = listed.map(toCatalogModel);
  cache.set(apiKey, { at: Date.now(), models });
  return models;
}

function toCatalogModel(model: ListedModel): CatalogModel {
  const variant =
    model.variants?.find((item) => item.isDefault) ?? model.variants?.[0];
  const fromVariant = (variant?.params ?? []).filter(
    (param) => param.id && param.value,
  );
  const params =
    fromVariant.length > 0
      ? fromVariant
      : (model.parameters ?? []).flatMap((param) => {
          const preferred =
            param.id === "optimize_for"
              ? param.values?.find((value) => value.value === "balanced")
              : undefined;
          const value = preferred?.value ?? param.values?.[0]?.value;
          return value ? [{ id: param.id, value }] : [];
        });
  return {
    id: model.id,
    label: model.displayName || model.id,
    params: params.length > 0 ? params : undefined,
  };
}

function cursorCwd(): string {
  const dir = path.join(tmpdir(), "ledger-logic-cursor");
  mkdirSync(dir, { recursive: true });
  return dir;
}
