import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { DEPARTMENTS } from "../ledger/catalog";
import type { LedgerResult } from "../ledger/query";
import type { LlmProvider, LlmRequest } from "./types";

const TOKEN = String.raw`[A-Z][a-z]*(?:'[A-Z][a-z]+)?`;
const PERSON = String.raw`${TOKEN}(?:\s+${TOKEN})+`;

export type StubOptions = {
  alwaysTool: boolean;
  failMode: "none" | "retryable" | "fatal";
  failFirstN: number;
};

export class StubProvider implements LlmProvider {
  readonly name = "stub" as const;
  private failuresLeft: number;

  constructor(private readonly options: StubOptions) {
    this.failuresLeft = options.failFirstN;
  }

  async invoke(request: LlmRequest): Promise<AIMessage> {
    if (this.options.failMode === "fatal") {
      throw Object.assign(new Error("simulated fatal model error"), { retryable: false });
    }
    if (this.options.failMode === "retryable" && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw Object.assign(new Error("simulated provider timeout"), { retryable: true });
    }

    if (request.mode === "generate") {
      return new AIMessage(renderFromMessages(request.messages));
    }
    if (this.options.alwaysTool) {
      return toolCall({
        filters: [{ field: "name", op: "eq", value: "Nobody Matches" }],
        fields: ["full_name"],
      });
    }
    if (hasToolResult(request.messages)) {
      return new AIMessage("");
    }
    const planned = planQuery(firstHuman(request.messages));
    if (!planned) return new AIMessage("");
    return toolCall(planned);
  }
}

function toolCall(args: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        id: crypto.randomUUID(),
        name: "query_ledger",
        args,
        type: "tool_call",
      },
    ],
  });
}

export function normalizeQuestion(question: string): string {
  return question
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function planQuery(question: string): Record<string, unknown> | null {
  const text = normalizeQuestion(question);

  if (/\b(?:maximum|highest) salary\b/i.test(text)) {
    return { metrics: [{ fn: "max", field: "salary_2025" }] };
  }
  if (/\b(?:minimum|lowest) salary\b/i.test(text)) {
    return { metrics: [{ fn: "min", field: "salary_2025" }] };
  }

  const relocation = new RegExp(
    String.raw`\bmoving (${PERSON}) from the (.+?) office to ([A-Za-z][A-Za-z .]*?)(?:[.?,]|$)`,
  ).exec(text);
  if (relocation) {
    return {
      filters: [{ field: "name", op: "eq", value: clean(relocation[1]) }],
      fields: ["role", "role_level", "office_location", "salary_2025"],
      bandCity: clean(relocation[3]),
    };
  }

  const expenses = new RegExp(String.raw`\bexpenses paid to (${PERSON}) in (20\d{2})`).exec(text);
  if (expenses) {
    return {
      filters: [{ field: "name", op: "eq", value: clean(expenses[1]) }],
      fields: [`expenses_${expenses[2]}`],
    };
  }

  const salary = new RegExp(String.raw`\b[Ww]hat is (${PERSON}) salary\b`).exec(text);
  if (salary) {
    return {
      filters: [{ field: "name", op: "eq", value: clean(salary[1]) }],
      fields: ["role", "salary_2023", "salary_2024", "salary_2025"],
    };
  }

  const payroll = /\btotal payroll for (20\d{2})/i.exec(text);
  if (payroll) {
    return { metrics: [{ fn: "sum", field: `salary_${payroll[1]}` }] };
  }

  const average = /\baverage (20\d{2}) salary in (?:the )?(.+?) department/i.exec(text);
  if (average) {
    return {
      filters: [{ field: "department", op: "eq", value: clean(average[2]) }],
      metrics: [{ fn: "avg", field: `salary_${average[1]}` }],
    };
  }

  const headcount = /\bhow many (?:employees|people) work in (.+?)\s*\??\s*$/i.exec(text);
  if (headcount) {
    const place = clean(headcount[1]);
    const department = DEPARTMENTS.find((item) => item.toLowerCase() === place.toLowerCase());
    return {
      filters: [
        {
          field: department ? "department" : "office_location",
          op: "eq",
          value: department ?? place,
        },
      ],
      metrics: [{ fn: "count" }],
    };
  }

  const employee = /\bwhere does employee (E\d+) work/i.exec(text);
  if (employee) {
    return {
      filters: [{ field: "employee_id", op: "eq", value: employee[1].toUpperCase() }],
      fields: ["office_location", "role", "department", "hire_date", "tenure"],
    };
  }

  const where = new RegExp(String.raw`\b[Ww]here does (${PERSON}) work\b`).exec(text);
  if (where) {
    return {
      filters: [{ field: "name", op: "eq", value: clean(where[1]) }],
      fields: ["office_location", "role", "department", "hire_date", "tenure"],
    };
  }

  return null;
}

function clean(value: string): string {
  return value.trim().replace(/[?.!,]+$/, "").trim();
}

function firstHuman(messages: BaseMessage[]): string {
  for (const message of messages) {
    if (message.getType() === "human" && typeof message.content === "string") return message.content;
  }
  return "";
}

function hasToolResult(messages: BaseMessage[]): boolean {
  return messages.some((message) => message.getType() === "tool");
}

function renderFromMessages(messages: BaseMessage[]): string {
  const toolMessages = messages.filter((message) => message.getType() === "tool");
  if (toolMessages.length === 0) {
    return "I can look up employees, offices, tenure, headcount, payroll totals, department averages, and salary-band comparisons. Ask about someone on the ledger, an office, or a department.";
  }
  const last = toolMessages[toolMessages.length - 1];
  const content = typeof last.content === "string" ? last.content : "";
  try {
    return renderResult(JSON.parse(content) as LedgerResult);
  } catch {
    return "I couldn't read the ledger result.";
  }
}

function renderResult(result: LedgerResult): string {
  if (result.status === "refused" || result.status === "not_found" || result.status === "invalid") {
    return result.message ?? "I couldn't answer that from the ledger.";
  }
  if (result.status === "ambiguous") {
    const choices = (result.candidates ?? [])
      .map((candidate) => `${candidate.fullName} (${candidate.employeeId}), ${candidate.role} in ${candidate.officeLocation}`)
      .join("; ");
    return `More than one employee has that name: ${choices}. Ask again with the employee id.`;
  }

  const row = result.rows?.[0];
  if (row?.bandPosition) return renderComparison(row, result.asOf);
  if (result.metrics && !result.rows) return renderMetrics(result);
  if (row) return renderPerson(row, result.asOf);
  if (result.rows && result.rows.length > 1 && result.rows[0]?.roleLevel && result.rows[0]?.salaryBandMin) {
    return result.rows
      .map((band) => `${band.bandCity} ${band.roleLevel}: ${band.salaryBandMin} to ${band.salaryBandMax}`)
      .join(". ");
  }
  return result.message ?? "I couldn't answer that from the ledger.";
}

function renderMetrics(result: LedgerResult): string {
  const metrics = result.metrics ?? {};
  const filters = result.appliedFilters ?? [];
  if (metrics.count && filters.length === 1) {
    const filter = filters[0];
    const place = String(filter.value);
    if (filter.field === "office_location") return `${metrics.count} employees work in ${place}.`;
    if (filter.field === "department") return `${metrics.count} employees work in ${place}.`;
  }
  if (metrics.count && filters.length === 0) return `There are ${metrics.count} employees in the ledger.`;
  const payrollYear = Object.keys(metrics).find((key) => key.startsWith("sum_salary_"));
  if (payrollYear && filters.length === 0) {
    const year = payrollYear.slice("sum_salary_".length);
    return `Total payroll for ${year} was ${metrics[payrollYear]}.`;
  }
  const averageKey = Object.keys(metrics).find((key) => key.startsWith("avg_salary_"));
  if (averageKey && filters.length === 1 && filters[0]?.field === "department") {
    const year = averageKey.slice("avg_salary_".length);
    return `The average ${year} salary in ${String(filters[0].value)} is ${metrics[averageKey]}.`;
  }
  return Object.entries(metrics)
    .map(([key, value]) => `${key}: ${value}`)
    .join(". ");
}

function renderPerson(row: Record<string, string>, asOf: string | undefined): string {
  const name = row.fullName ?? "This employee";
  const sentences: string[] = [];
  if (row.officeLocation && row.role && row.department) {
    sentences.push(`${name} works in the ${row.officeLocation} office as ${row.role} in ${row.department}.`);
  } else if (row.officeLocation) {
    sentences.push(`${name} works in the ${row.officeLocation} office.`);
  }
  if (row.hireDate) sentences.push(`Hired on ${row.hireDate}.`);
  if (row.tenure && asOf) sentences.push(`As of ${asOf}, that is ${row.tenure}.`);
  const salaryBits = [
    row.salary2023 ? `${row.salary2023} in 2023` : "",
    row.salary2024 ? `${row.salary2024} in 2024` : "",
    row.salary2025 ? `${row.salary2025} in 2025` : "",
  ].filter(Boolean);
  if (salaryBits.length > 0) sentences.push(`${name}'s salary was ${salaryBits.join(", ")}.`);
  const expenseBits = [
    row.expenses2023 ? `${row.expenses2023} in 2023` : "",
    row.expenses2024 ? `${row.expenses2024} in 2024` : "",
    row.expenses2025 ? `${row.expenses2025} in 2025` : "",
  ].filter(Boolean);
  if (expenseBits.length > 0) sentences.push(`${name}'s expenses were ${expenseBits.join(", ")}.`);
  if (sentences.length === 0) return `${name} is on the ledger.`;
  return sentences.join(" ");
}

function renderComparison(row: Record<string, string>, _asOf: string | undefined): string {
  const name = row.fullName ?? "This employee";
  const level = row.roleLevel ?? "that level";
  const city = row.bandCity ?? "the destination";
  const role = row.role ? `${row.role} (${level})` : level;
  const based = row.officeLocation ? ` based in ${row.officeLocation}` : "";
  if (row.bandPosition === "unknown" || !row.salaryBandMin || !row.salaryBandMax) {
    return `${name} is ${role}${based}. I couldn't find a ${city} salary band for ${level}.`;
  }
  const verdict =
    row.bandPosition === "below_min"
      ? "That salary is below the band, so it would need to increase to align with local pay."
      : row.bandPosition === "above_max"
        ? "That salary is above the band."
        : "That salary sits inside the band, so it does not need to increase to meet the band.";
  const index = row.costOfLivingIndex ? ` The cost-of-living index there is ${row.costOfLivingIndex}.` : "";
  return `${name} is ${role}${based}. Current salary is ${row.salary2025}. The ${city} ${level} band is ${row.salaryBandMin} to ${row.salaryBandMax}.${index} ${verdict}`;
}
