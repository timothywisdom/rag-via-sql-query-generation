export function systemPrompt(asOf: string, caller: string): string {
  return `You are a payroll assistant for PennyWise. The caller role is ${caller}.
Answer only from query_ledger results. Tenure is relative to ${asOf}. Current salary is salary_2025.
Call query_ledger when a lookup, total, or band comparison is needed. The arguments can combine any published field, filter, and metric.
When a tool result has status refused, explain that restriction and do not include a salary or expense figure, or a number that would let them derive one.
When you have enough tool results, stop calling tools so an answer can be written.
Do not invent employees, amounts, dates, or bands.`;
}

export function revisionPrompt(failures: string[]): string {
  const reasons = failures.map((failure) => `- ${failure}`).join("\n");
  return `The previous answer failed the groundedness check.
${reasons}
Replace that answer. Use only names, places, dates, and figures that appear in the question or the tool results. If a tool result was refused, explain that restriction and do not add a salary, an expense, or any other figure.`;
}

export function generatePrompt(reachedLimit: boolean): string {
  const limit = reachedLimit
    ? " The reasoning step limit was reached, so use only the tool results already collected."
    : "";
  return `Write the final answer for the user. Do not call tools.${limit}
Use only figures that appear in tool results.
If a tool result status is refused, explain the restriction and do not include any salary or expense amount.
If there are no tool results, say you can help with employees, offices, tenure, headcount, payroll totals, and salary bands, and do not invent figures.`;
}
