import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toCents } from "./money";
import { inferRoleLevel } from "./role-level";

export type LedgerDatabase = DatabaseSync;

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  const headers = lines[0]?.split(",") ?? [];
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    return record;
  });
}

function requireDate(value: string, context: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date ${value} for ${context}`);
  }
  return value;
}

export function loadLedger(dataDir: string): LedgerDatabase {
  const employees = parseCsv(readFileSync(path.join(dataDir, "employees.csv"), "utf8"));
  const bands = parseCsv(readFileSync(path.join(dataDir, "salary_bands.csv"), "utf8"));
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE employees (
      employee_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      role_level TEXT NOT NULL,
      department TEXT NOT NULL,
      office_location TEXT NOT NULL,
      salary_2023_cents INTEGER NOT NULL,
      salary_2024_cents INTEGER NOT NULL,
      salary_2025_cents INTEGER NOT NULL,
      hire_date TEXT NOT NULL,
      tax_status TEXT NOT NULL,
      expenses_2023_cents INTEGER NOT NULL,
      expenses_2024_cents INTEGER NOT NULL,
      expenses_2025_cents INTEGER NOT NULL,
      access_level TEXT NOT NULL
    );
    CREATE TABLE salary_bands (
      city TEXT NOT NULL,
      region TEXT NOT NULL,
      country TEXT NOT NULL,
      role_level TEXT NOT NULL,
      salary_band_min_cents INTEGER NOT NULL,
      salary_band_max_cents INTEGER NOT NULL,
      cost_of_living_index INTEGER NOT NULL,
      PRIMARY KEY (city, role_level)
    );
  `);

  const insertEmployee = db.prepare(`
    INSERT INTO employees (
      employee_id, first_name, last_name, full_name, role, role_level, department,
      office_location, salary_2023_cents, salary_2024_cents, salary_2025_cents,
      hire_date, tax_status, expenses_2023_cents, expenses_2024_cents, expenses_2025_cents,
      access_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBand = db.prepare(`
    INSERT INTO salary_bands (
      city, region, country, role_level, salary_band_min_cents, salary_band_max_cents, cost_of_living_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (const row of employees) {
      const id = row.employee_id;
      insertEmployee.run(
        id,
        row.first_name,
        row.last_name,
        `${row.first_name} ${row.last_name}`,
        row.role,
        inferRoleLevel(row.role),
        row.department,
        row.office_location,
        toCents(row.salary_2023, `${id} salary_2023`),
        toCents(row.salary_2024, `${id} salary_2024`),
        toCents(row.salary_2025, `${id} salary_2025`),
        requireDate(row.hire_date, id),
        row.tax_status,
        toCents(row.expenses_2023, `${id} expenses_2023`),
        toCents(row.expenses_2024, `${id} expenses_2024`),
        toCents(row.expenses_2025, `${id} expenses_2025`),
        row.access_level,
      );
    }
    for (const row of bands) {
      insertBand.run(
        row.city,
        row.region,
        row.country,
        row.role_level,
        toCents(row.salary_band_min, `${row.city} ${row.role_level} min`),
        toCents(row.salary_band_max, `${row.city} ${row.role_level} max`),
        Number(row.cost_of_living_index),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  db.exec("PRAGMA query_only = ON");
  return db;
}
