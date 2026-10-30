import type { CallerRole } from "../ledger/callers";

const NUMBER_PATTERN = /\$?\d[\d,]*(?:\.\d+)?/g;
const MONTHS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

export type GroundednessReport = {
  groundedness: number;
  passed: boolean;
  failures: string[];
};

export type GoldenCase = {
  id: string;
  query: string;
  caller: CallerRole;
  expectStatus: "ok" | "refused" | "error";
  mustInclude: string[];
  mustExclude: string[];
};

export function numericTokens(text: string): string[] {
  return [...text.matchAll(NUMBER_PATTERN)].map((match) =>
    match[0].replace(/[$,]/g, ""),
  );
}

export function toolContext(trace: Array<{ output: unknown }>): string {
  return trace.map((event) => JSON.stringify(event.output)).join("\n");
}

export function scoreGroundedness(
  answer: string,
  context: string,
  refusedWithoutFigures: boolean,
  question = "",
): GroundednessReport {
  const allowed = `${question}\n${context}`;
  const numbers = numericTokens(answer);
  const missingNumbers = numbers.filter(
    (token) =>
      !numericTokens(allowed).some((allowedToken) =>
        sameAmount(token, allowedToken),
      ),
  );
  const names = refusedWithoutFigures ? [] : properNames(answer);
  const missingNames = names.filter((name) => !corpusHas(allowed, name));
  const failures = [
    ...[...new Set(missingNumbers)].map(
      (token) =>
        `The figure ${token} is not in the question or the tool results.`,
    ),
    ...[...new Set(missingNames)].map(
      (name) =>
        `The name "${name}" is not in the question or the tool results.`,
    ),
  ];
  const claims = numbers.length + names.length;
  const missing = missingNumbers.length + missingNames.length;
  const groundedness = Number(
    (claims === 0 ? 1 : (claims - missing) / claims).toFixed(2),
  );
  return { groundedness, passed: failures.length === 0, failures };
}

export function scoreAccuracy(
  answer: string | null,
  status: string,
  item: GoldenCase,
): { accuracy: number; failures: string[] } {
  const text = answer ?? "";
  const checks: Array<{ ok: boolean; failure: string }> = [
    {
      ok: status === item.expectStatus,
      failure: `Status was ${status}, expected ${item.expectStatus}.`,
    },
  ];
  for (const part of item.mustInclude) {
    checks.push({
      ok: text.includes(part),
      failure: `Missing expected text: ${part}.`,
    });
  }
  for (const part of item.mustExclude) {
    checks.push({
      ok: !text.includes(part),
      failure: `Answer included a forbidden figure: ${part}.`,
    });
  }
  if (item.expectStatus === "refused") {
    const leaked = numericTokens(text).filter(
      (token) =>
        !numericTokens(item.query).some((asked) => sameAmount(token, asked)),
    );
    checks.push({
      ok: leaked.length === 0,
      failure:
        leaked.length === 0
          ? ""
          : `A refusal included a figure that was not in the question: ${leaked.join(", ")}.`,
    });
  }
  const passed = checks.filter((check) => check.ok).length;
  return {
    accuracy: Number((passed / checks.length).toFixed(2)),
    failures: checks.flatMap((check) => (check.ok ? [] : [check.failure])),
  };
}

function properNames(answer: string): string[] {
  const names: string[] = [];
  for (const sentence of answer.split(/[.!?]+/)) {
    const words = sentence.match(/[A-Z][A-Za-z'-]*/g) ?? [];
    for (const word of words.slice(1)) {
      if (word.length <= 2 || MONTHS.has(word.toLowerCase())) continue;
      names.push(word);
    }
  }
  return names;
}

function corpusHas(corpus: string, name: string): boolean {
  return new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  ).test(corpus);
}

function sameAmount(left: string, right: string): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
