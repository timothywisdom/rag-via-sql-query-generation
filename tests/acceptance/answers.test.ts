import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask, boot, employee, money, readEmployees, type AnswerBody } from "./harness";
import type { RunningServer } from "../../apps/agent/src/server";

describe("ledger answers", () => {
  let server: RunningServer;
  const rows = readEmployees();

  beforeAll(async () => {
    server = await boot();
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers where Bob Langley works and how long he has been employed", async () => {
    const { status, body } = await ask(
      server.url,
      "Where does Bob Langley work? How long has he been employed?",
    );
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("stub");
    expect(body.steps).toBe(1);
    expect(body.llmAttempts).toBe(3);
    expect(body.forcedGenerate).toBe(false);
    expect(body.answer).toContain("Chicago");
    expect(body.answer).toContain("2019-03-15");
    expect(body.answer).toContain("7 years, 7 months");
    expect(body.trace[0]?.tool).toBe("query_ledger");
    expect(body.trace[0]?.output.rows?.[0]?.officeLocation).toBe("Chicago");
    expect(body.trace[0]?.sql).toMatch(/from employees/i);
    expect(body.instanceId).toBe("agent-test");
  });

  it("compares Terry Jeffords's salary with the Nunavut band", async () => {
    const terry = employee(rows, "Terry", "Jeffords");
    const { body } = await ask(
      server.url,
      "We are thinking about moving Terry Jeffords from the Brooklyn office to Nunavut. Is his salary sufficient, or will we need to increase it to be more aligned with Nunavut salaries?",
    );
    expect(body.status).toBe("ok");
    expect(body.trace[0]?.output.rows?.[0]?.bandPosition).toBe("below_min");
    expect(body.trace[0]?.output.rows?.[0]?.roleLevel).toBe("Manager");
    expect(body.answer).toContain("Brooklyn");
    expect(body.answer).toContain("Nunavut");
    expect(body.answer).toContain(money(terry.salary2025Cents));
    expect(body.answer).toContain("$138,000.00");
    expect(body.answer).toContain("$185,000.00");
    expect(body.answer).toMatch(/below the band/);
    expect(body.answer).toMatch(/increase/);
  });

  it("totals 2024 payroll from the ledger, including every employee", async () => {
    const total = rows.reduce((sum, row) => sum + row.salary2024Cents, 0);
    const { body } = await ask(server.url, "What was the total payroll for 2024?");
    expect(body.status).toBe("ok");
    expect(body.answer).toContain(money(total));
    expect(body.answer).toContain("2024");
    expect(body.trace[0]?.output.metrics?.sum_salary_2024).toBe(money(total));
  });

  it("refuses Horatio Kane's salary without revealing a figure", async () => {
    const kane = employee(rows, "Horatio", "Kane");
    const { body } = await ask(server.url, "What is Horatio Kane\u2019s salary?");
    expectRefusal(body, [
      money(kane.salary2023Cents),
      money(kane.salary2024Cents),
      money(kane.salary2025Cents),
      kane.salary_2023,
      kane.salary_2024,
      kane.salary_2025,
    ]);
  });

  it("refuses Nancy Nunchuk's 2023 expenses without revealing a figure", async () => {
    const nancy = employee(rows, "Nancy", "Nunchuk");
    const { body } = await ask(
      server.url,
      "What was the total of expenses paid to Nancy Nunchuk in 2023?",
    );
    expectRefusal(body, [
      money(nancy.expenses2023Cents),
      money(nancy.expenses2024Cents),
      money(nancy.expenses2025Cents),
      nancy.expenses_2023,
      "28,500",
      "28500",
    ]);
  });

  it("still answers a non-executive salary question", async () => {
    const terry = employee(rows, "Terry", "Jeffords");
    const { body } = await ask(server.url, "What is Terry Jeffords's salary?");
    expect(body.status).toBe("ok");
    expect(body.answer).toContain(money(terry.salary2025Cents));
    expect(body.answer).toContain(money(terry.salary2024Cents));
  });

  it("answers headcount and a department average that were not in the scripted success criteria", async () => {
    const chicago = rows.filter((row) => row.office_location === "Chicago").length;
    const sanFrancisco = rows.filter((row) => row.office_location === "San Francisco").length;
    const humanResources = rows.filter((row) => row.department === "Human Resources").length;
    const technology = rows.filter((row) => row.department === "Technology");
    const average = Math.round(
      technology.reduce((sum, row) => sum + row.salary2025Cents, 0) / technology.length,
    );

    const city = await ask(server.url, "How many employees work in Chicago?");
    expect(city.body.answer).toBe(`${chicago} employees work in Chicago.`);

    const coast = await ask(server.url, "How many employees work in San Francisco?");
    expect(coast.body.answer).toBe(`${sanFrancisco} employees work in San Francisco.`);

    const department = await ask(server.url, "How many employees work in Human Resources?");
    expect(department.body.answer).toBe(`${humanResources} employees work in Human Resources.`);

    const avg = await ask(server.url, "What is the average 2025 salary in the Technology department?");
    expect(avg.body.status).toBe("ok");
    expect(avg.body.answer).toContain(money(average));
    expect(avg.body.answer).toContain("Technology");
  });

  it("keeps an apostrophe in James O'Brien's name and leaves the ledger queryable afterwards", async () => {
    const james = employee(rows, "James", "O'Brien");
    const located = await ask(server.url, "Where does James O'Brien work?");
    expect(located.body.status).toBe("ok");
    expect(located.body.answer).toContain(james.office_location);

    const total = rows.reduce((sum, row) => sum + row.salary2024Cents, 0);
    const payroll = await ask(server.url, "What was the total payroll for 2024?");
    expect(payroll.body.answer).toContain(money(total));
  });

  it("asks which Russell Graham when the full name is shared", async () => {
    const grahams = rows.filter((row) => row.first_name === "Russell" && row.last_name === "Graham");
    expect(grahams).toHaveLength(2);
    const { body } = await ask(server.url, "Where does Russell Graham work?");
    expect(body.status).toBe("ok");
    expect(body.trace[0]?.output.status).toBe("ambiguous");
    for (const person of grahams) {
      expect(body.answer).toContain(person.employee_id);
      expect(body.answer).toContain(person.office_location);
      expect(body.answer).not.toContain(money(person.salary2025Cents));
    }
  });

  it("looks up the employee id from an ambiguous name on a later question", async () => {
    const graham = rows.find((row) => row.employee_id === "E098");
    if (!graham) throw new Error("missing E098");
    const { body } = await ask(server.url, "Where does employee E098 work?");
    expect(body.answer).toContain(graham.office_location);
    expect(body.answer).not.toContain(money(graham.salary2025Cents));
  });

  it("refuses a minimum or maximum salary because it identifies one person", async () => {
    const highest = rows.reduce((max, row) => Math.max(max, row.salary2025Cents), 0);
    const { body } = await ask(server.url, "What is the maximum salary?");
    expectRefusal(body, [money(highest), "485000", "485,000"]);
  });

  it("does not invent an answer for a question outside the ledger", async () => {
    const { body } = await ask(server.url, "What's the weather in Nunavut?");
    expect(body.status).toBe("ok");
    expect(body.steps).toBe(0);
    expect(body.trace).toHaveLength(0);
    expect(body.answer).toMatch(/payroll|employees|salary bands/i);
    expect(body.answer).not.toMatch(/\$\d/);
  });

  it("rejects a missing query and an unknown caller", async () => {
    const missing = await fetch(new URL("/answer", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "   " }),
    });
    expect(missing.status).toBe(400);

    const caller = await fetch(new URL("/answer", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Where does Bob Langley work?", caller: "executive" }),
    });
    expect(caller.status).toBe(400);
  });

  it("reports health for the process that is serving", async () => {
    const response = await fetch(new URL("/health", server.url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; instanceId: string; provider: string; asOf: string };
    expect(body).toMatchObject({ ok: true, instanceId: "agent-test", provider: "stub", asOf: "2026-10-29" });
  });
});

function expectRefusal(body: AnswerBody, forbidden: string[]) {
  expect(body.status).toBe("refused");
  expect(body.answer).toBeTruthy();
  expect(body.answer).not.toMatch(/\d/);
  expect(body.trace[0]?.output.status).toBe("refused");
  expect(body.trace[0]?.sql).toBeUndefined();
  const visible = `${body.answer}\n${JSON.stringify(body.trace)}`;
  for (const secret of forbidden) {
    expect(visible).not.toContain(secret);
  }
}
