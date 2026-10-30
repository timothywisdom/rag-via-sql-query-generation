export type StreamPhase = "reason" | "tools" | "generate" | "evaluate";

export type StreamEvent =
  | { type: "status"; phase: StreamPhase }
  | { type: "replace" }
  | { type: "token"; text: string }
  | { type: "done"; payload: Record<string, unknown> }
  | { type: "error"; error: string };

export function encodeSse(event: StreamEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
