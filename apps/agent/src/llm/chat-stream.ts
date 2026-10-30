import type { BaseMessage } from "@langchain/core/messages";
import { textOf } from "./text";

type ChatStream = {
  stream: (
    messages: BaseMessage[],
  ) => Promise<AsyncIterable<{ content: unknown }>> | AsyncIterable<{ content: unknown }>;
};

export async function* streamChat(chat: ChatStream, messages: BaseMessage[]): AsyncGenerator<string> {
  const streamed = await chat.stream(messages);
  for await (const chunk of streamed) {
    const text = textOf(chunk.content);
    if (text) yield text;
  }
}
