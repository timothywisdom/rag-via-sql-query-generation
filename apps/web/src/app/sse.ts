export type SseMessage = { event: string; data: unknown };

export function takeSseMessages(buffer: string): { messages: SseMessage[]; rest: string } {
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";
  const messages = chunks.flatMap(parseSseChunk);
  return { messages, rest };
}

export async function readSse(response: Response, onMessage: (message: SseMessage) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = takeSseMessages(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) onMessage(message);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = takeSseMessages(`${buffer}\n\n`);
    for (const message of parsed.messages) onMessage(message);
  }
}

function parseSseChunk(chunk: string): SseMessage[] {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of chunk.split(/\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return [];
  try {
    return [{ event, data: JSON.parse(dataLines.join("\n")) as unknown }];
  } catch {
    return [];
  }
}
