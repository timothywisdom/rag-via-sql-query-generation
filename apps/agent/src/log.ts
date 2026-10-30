import { AsyncLocalStorage } from "node:async_hooks";

const requestIds = new AsyncLocalStorage<string>();

export function withRequestId<T>(requestId: string, run: () => Promise<T>): Promise<T> {
  return requestIds.run(requestId, run);
}

export function trace(event: string, fields: Record<string, unknown> = {}): void {
  const requestId = requestIds.getStore();
  const line = JSON.stringify({
    event,
    time: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
    ...fields,
  });
  process.stderr.write(`${line}\n`);
}

export function errorSummary(error: unknown): { status?: number; message: string } {
  const status = statusOf(error);
  const raw = error instanceof Error ? error.message : "Language model request failed";
  return {
    ...(status != null ? { status } : {}),
    message: redact(raw).slice(0, 300),
  };
}

function redact(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" ? status : undefined;
}
