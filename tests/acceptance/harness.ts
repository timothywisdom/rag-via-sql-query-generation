import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer, type RunningServer } from "../../apps/agent/src/server";
import type { AppConfig } from "../../apps/agent/src/config";

const dataDir = fileURLToPath(new URL("../../specs", import.meta.url));

export type AnswerBody = {
  status: "ok" | "refused" | "error";
  answer: string | null;
  error?: string;
  steps: number;
  forcedGenerate: boolean;
  llmAttempts: number;
  trace: Array<{
    tool: string;
    args: unknown;
    output: {
      status: string;
      message?: string;
      rows?: Array<Record<string, string>>;
      metrics?: Record<string, string>;
      sql?: string;
    };
    sql?: string;
  }>;
  provider: string;
  instanceId: string;
  requestId: string;
  durationMs: number;
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    llmProvider: "stub",
    openaiModel: "gpt-4o-mini",
    maxLlmAttempts: 3,
    retryBaseMs: 5,
    maxReasoningSteps: 4,
    onStepLimit: "generate",
    asOfDate: "2026-10-29",
    dataDir,
    instanceId: "agent-test",
    stubAlwaysTool: false,
    llmFailMode: "none",
    llmFailFirstN: 0,
    onlineEval: false,
    onlineEvalMaxRetries: 1,
    maxJudgeAttempts: 3,
    ...overrides,
  };
}

export async function boot(overrides: Partial<AppConfig> = {}): Promise<RunningServer> {
  return startServer(testConfig(overrides));
}

export async function ask(baseUrl: string, query: string, caller = "junior_hr_assistant"): Promise<{
  status: number;
  body: AnswerBody;
}> {
  const response = await fetch(new URL("/answer", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-caller-role": caller },
    body: JSON.stringify({ query, caller }),
  });
  return { status: response.status, body: (await response.json()) as AnswerBody };
}

export type Employee = Record<string, string> & {
  salary2023Cents: number;
  salary2024Cents: number;
  salary2025Cents: number;
  expenses2023Cents: number;
  expenses2024Cents: number;
  expenses2025Cents: number;
};

export function readEmployees(): Employee[] {
  const file = path.join(fileURLToPath(new URL("../..", import.meta.url)), "specs", "employees.csv");
  const [header, ...lines] = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
  const columns = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? "";
    });
    return {
      ...row,
      salary2023Cents: cents(row.salary_2023),
      salary2024Cents: cents(row.salary_2024),
      salary2025Cents: cents(row.salary_2025),
      expenses2023Cents: cents(row.expenses_2023),
      expenses2024Cents: cents(row.expenses_2024),
      expenses2025Cents: cents(row.expenses_2025),
    };
  });
}

export function cents(raw: string): number {
  return Math.round(Number(raw) * 100);
}

export function money(centsValue: number): string {
  const absolute = Math.abs(Math.round(centsValue));
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${remainder}`;
}

export function employee(rows: Employee[], first: string, last: string): Employee {
  const matches = rows.filter((row) => row.first_name === first && row.last_name === last);
  if (matches.length !== 1) throw new Error(`Expected one ${first} ${last}, found ${matches.length}`);
  return matches[0];
}
