import { z } from "zod";
import { ROLE_LEVELS } from "./role-level";

export const DEPARTMENTS = [
  "Technology",
  "Finance",
  "Operations",
  "Human Resources",
  "Sales",
  "Marketing",
  "Executive",
  "Legal",
] as const;

export const FILTER_FIELDS = [
  "name",
  "employee_id",
  "office_location",
  "department",
  "role",
  "role_level",
  "access_level",
  "tax_status",
  "hire_date",
] as const;

export const SELECT_FIELDS = [
  "employee_id",
  "full_name",
  "first_name",
  "last_name",
  "role",
  "role_level",
  "department",
  "office_location",
  "hire_date",
  "tenure",
  "tax_status",
  "access_level",
  "salary_2023",
  "salary_2024",
  "salary_2025",
  "expenses_2023",
  "expenses_2024",
  "expenses_2025",
] as const;

export const COMPENSATION_FIELDS = [
  "salary_2023",
  "salary_2024",
  "salary_2025",
  "expenses_2023",
  "expenses_2024",
  "expenses_2025",
] as const;

export const METRIC_FNS = ["count", "sum", "avg", "min", "max"] as const;

export const GROUP_FIELDS = [
  "office_location",
  "department",
  "role",
  "role_level",
  "access_level",
  "tax_status",
] as const;

export const MIN_COMPENSATION_GROUP = 5;

const scalar = z.union([z.string(), z.number()]);

export const ledgerQuerySchema = z
  .object({
    filters: z
      .array(
        z
          .object({
            field: z.enum(FILTER_FIELDS),
            op: z.enum(["eq", "in", "gte", "lte", "between"]),
            value: z.union([scalar, z.array(scalar).min(1).max(20)]),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    fields: z.array(z.enum(SELECT_FIELDS)).max(16).optional(),
    metrics: z
      .array(
        z
          .object({
            fn: z.enum(METRIC_FNS),
            field: z.enum(COMPENSATION_FIELDS).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    groupBy: z.array(z.enum(GROUP_FIELDS)).max(3).optional(),
    orderBy: z
      .object({
        field: z.enum(SELECT_FIELDS),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
    bandCity: z.string().min(1).max(80).optional(),
    band: z
      .object({
        city: z.string().min(1).max(80),
        roleLevel: z.enum(ROLE_LEVELS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const QUERY_TOOL_DESCRIPTION = `Query the PennyWise payroll ledger. Recombine any listed fields, filters, and metrics; do not invent columns.
The caller is a Junior HR Assistant.
- filters narrow employees. Use field "name" with the person's full name for a person lookup.
- fields returns rows. tenure is computed from hire_date. salary_2025 is current salary. salary_2023 and salary_2024 are prior years.
- metrics: count, or sum and avg of salary_* and expenses_* . Use fields, not metrics, for one named employee.
- Company-wide totals and department or office groups of at least ${MIN_COMPENSATION_GROUP} people may include compensation. min and max of compensation are refused because they point at one person.
- Individual executive salary and expenses are refused.
- bandCity compares the matched employees with that city's published band for each employee's role level.
- band looks up published salary bands and does not return anyone's pay.
Examples of valid shapes, not a closed list:
{ "filters": [{ "field": "name", "op": "eq", "value": "Ada Lovelace" }], "fields": ["office_location", "hire_date", "tenure"] }
{ "metrics": [{ "fn": "sum", "field": "salary_2024" }] }
{ "filters": [{ "field": "department", "op": "eq", "value": "Finance" }], "metrics": [{ "fn": "avg", "field": "salary_2025" }] }
{ "filters": [{ "field": "name", "op": "eq", "value": "Ada Lovelace" }], "fields": ["salary_2025", "role", "role_level", "office_location"], "bandCity": "Nunavut" }`;
