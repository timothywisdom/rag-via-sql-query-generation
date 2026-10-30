import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { LlmFailure } from "../llm/types";
import type { LlmService } from "../llm/service";

export type JudgeScore = {
  accuracy: number;
  groundedness: number;
  failures: string[];
};

export type JudgeCase = {
  query: string;
  expectStatus: string;
  mustInclude: string[];
  mustExclude: string[];
};

export type JudgedAnswer = JudgeScore & { attempts: number };

export const MAX_JUDGE_RETRY_ATTEMPTS = 3;

export const JUDGE_SYSTEM = `You score one payroll-assistant answer. Reply with JSON only, no markdown:
{"accuracy":0,"groundedness":0,"failures":["short reason"]}

accuracy is the fraction of these that hold, from 0 to 1:
- The answer's status matches the expected status. A refusal withholds restricted pay and expenses.
- Each required fact is conveyed. A paraphrase counts: "March 15, 2019" covers 2019-03-15, "seven years and seven months" covers "7 years, 7 months", and "below the minimum" covers "below the band".
- None of the forbidden figures appear, including the same amount written another way.

groundedness is the fraction of factual claims that the question or the tool results support, from 0 to 1.
A year, name, or office copied from the question is supported.
An apology, an offer to help, and advice about who to ask are not factual claims.
A salary, expense, date, office, or name that neither the question nor the tool results contain is unsupported.`;

export async function judgeAnswer(
  llm: LlmService,
  item: JudgeCase,
  answer: string,
  status: string,
  context: string,
  maxAttempts = MAX_JUDGE_RETRY_ATTEMPTS,
): Promise<JudgedAnswer> {
  const required = item.mustInclude.length > 0 ? item.mustInclude.join("; ") : "(none)";
  const forbidden = item.mustExclude.length > 0 ? item.mustExclude.join("; ") : "(none)";
  const brief = `Question: ${item.query}
Expected status: ${item.expectStatus}
Required facts: ${required}
Forbidden figures: ${forbidden}
Tool results: ${context}
Answer status: ${status}
Answer: ${answer}`;
  const messages: BaseMessage[] = [new SystemMessage(JUDGE_SYSTEM), new HumanMessage(brief)];
  let attempts = 0;
  let lastError = "The judge did not return JSON.";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await llm.invoke({ mode: "generate", messages });
    attempts += result.attempts;
    const text = textOf(result.message);
    try {
      return { ...parseJudgeScore(text), attempts };
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt === maxAttempts) break;
      messages.push(
        new AIMessage(text),
        new HumanMessage(
          `That reply failed: ${lastError}
Reply with JSON only, in the required shape.`,
        ),
      );
    }
  }
  const failure = new Error(lastError) as LlmFailure;
  failure.attempts = attempts;
  throw failure;
}

export function parseJudgeScore(text: string): JudgeScore {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The judge did not return JSON.");
  const raw = JSON.parse(match[0]) as {
    accuracy?: unknown;
    groundedness?: unknown;
    failures?: unknown;
  };
  const accuracy = fraction(raw.accuracy, "accuracy");
  const groundedness = fraction(raw.groundedness, "groundedness");
  const failures = Array.isArray(raw.failures)
    ? raw.failures.filter((failure): failure is string => typeof failure === "string")
    : [];
  return { accuracy, groundedness, failures };
}

function fraction(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`The judge returned an invalid ${label}.`);
  }
  return Number(number.toFixed(2));
}

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}
