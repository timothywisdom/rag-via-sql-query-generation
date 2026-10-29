import {
  COMPENSATION_FIELDS,
  GROUP_FIELDS,
  MIN_COMPENSATION_GROUP,
  SELECT_FIELDS,
  ledgerQuerySchema,
  type LedgerQuery,
} from "./catalog";
import type { LedgerDatabase } from "./database";
import { asNumber, formatDollarsFromCents } from "./money";
import { formatTenure } from "./tenure";

type SqlValue = string | number;

export type LedgerResult = {
  status: "ok" | "refused" | "ambiguous" | "not_found" | "invalid";
  message?: string;
  asOf?: string;
  rows?: Record<string, string>[];
  metrics?: Record<string, string>;
  rowCount?: number;
  candidates?: Array<{
    employeeId: string;
    fullName: string;
    role: string;
    department: string;
    officeLocation: string;
  }>;
  appliedFilters?: LedgerQuery["filters"];
  suppressedCompensation?: boolean;
  sql?: string;
};

const compensation = new Set<string>(COMPENSATION_FIELDS);

const textColumns: Record<string, string> = {
  employee_id: "e.employee_id",
  office_location: "e.office_location",
  department: "e.department",
  role: "e.role",
  role_level: "e.role_level",
  access_level: "e.access_level",
  tax_status: "e.tax_status",
  hire_date: "e.hire_date",
};

const moneyColumns: Record<string, string> = {
  salary_2023: "salary_2023_cents",
  salary_2024: "salary_2024_cents",
  salary_2025: "salary_2025_cents",
  expenses_2023: "expenses_2023_cents",
  expenses_2024: "expenses_2024_cents",
  expenses_2025: "expenses_2025_cents",
};

const outputKey: Record<string, string> = {
  employee_id: "employeeId",
  full_name: "fullName",
  first_name: "firstName",
  last_name: "lastName",
  role: "role",
  role_level: "roleLevel",
  department: "department",
  office_location: "officeLocation",
  hire_date: "hireDate",
  tenure: "tenure",
  tax_status: "taxStatus",
  access_level: "accessLevel",
  salary_2023: "salary2023",
  salary_2024: "salary2024",
  salary_2025: "salary2025",
  expenses_2023: "expenses2023",
  expenses_2024: "expenses2024",
  expenses_2025: "expenses2025",
};

const plainColumns: Record<string, string> = {
  employee_id: "e.employee_id",
  full_name: "e.full_name",
  first_name: "e.first_name",
  last_name: "e.last_name",
  role: "e.role",
  role_level: "e.role_level",
  department: "e.department",
  office_location: "e.office_location",
  hire_date: "e.hire_date",
  tax_status: "e.tax_status",
  access_level: "e.access_level",
};

function invalid(message: string): LedgerResult {
  return { status: "invalid", message };
}

function refused(message: string): LedgerResult {
  return { status: "refused", message };
}

function plainRow(row: object): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

function stringValue(value: SqlValue): string {
  return String(value);
}

export function runLedgerQuery(
  db: LedgerDatabase,
  raw: unknown,
  asOf: string,
): LedgerResult {
  const parsed = ledgerQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
      .join("; ");
    return invalid(detail);
  }

  const query = parsed.data;
  const shape = normalizeShape(query);
  if ("status" in shape) return shape;

  if (shape.band && !shape.fields && !shape.metrics && !shape.bandCity && !shape.filters?.length) {
    return lookupBands(db, shape.band, asOf);
  }

  const resolved = resolveNames(db, shape);
  if ("status" in resolved) return resolved;

  const population = countPopulation(db, resolved.filters);
  const compensationFields = (resolved.fields ?? []).filter((field) => compensation.has(field));
  const compensationMetrics = (resolved.metrics ?? []).filter(
    (metric) => metric.field && compensation.has(metric.field),
  );
  const wantsRowPay = compensationFields.length > 0 || Boolean(resolved.bandCity);
  const wantsMetricPay = compensationMetrics.length > 0;

  if (wantsMetricPay) {
    const blocked = blockCompensationAggregate(resolved, population);
    if (blocked) return blocked;
  }

  if (
    wantsRowPay &&
    population.matched > 0 &&
    population.executives === population.matched &&
    hasPersonOrExecutiveFilter(resolved)
  ) {
    return refused(executiveRefusal(population.names));
  }

  if (resolved.metrics?.length) {
    return runMetrics(db, resolved, asOf, population);
  }

  return runRows(db, resolved, asOf, population);
}

function normalizeShape(query: LedgerQuery): LedgerQuery | LedgerResult {
  const next: LedgerQuery = {
    ...query,
    filters: query.filters ? [...query.filters] : undefined,
    fields: query.fields ? [...query.fields] : undefined,
    metrics: query.metrics ? [...query.metrics] : undefined,
  };

  if (next.band && (next.fields?.length || next.metrics?.length || next.bandCity || next.filters?.length)) {
    return invalid("Look up a published band on its own, or set bandCity on an employee query.");
  }
  if (next.groupBy?.length && !next.metrics?.length) {
    return invalid("groupBy requires metrics.");
  }
  if (next.groupBy?.length && next.fields?.length) {
    return invalid("Use groupBy with metrics, not row fields.");
  }
  if (next.groupBy?.length && next.bandCity) {
    return invalid("bandCity cannot be combined with groupBy.");
  }
  if (next.metrics?.length && next.fields?.length) {
    return invalid("Use either row fields or metrics.");
  }

  for (const metric of next.metrics ?? []) {
    if (metric.fn === "count" && metric.field) return invalid("count does not take a field.");
    if (metric.fn !== "count" && !metric.field) return invalid(`${metric.fn} requires a compensation field.`);
  }

  if ((next.filters?.filter((filter) => filter.field === "name").length ?? 0) > 1) {
    return invalid("Use one name filter.");
  }
  for (const filter of next.filters ?? []) {
    if (typeof filter.value === "string" && filter.value.length > 80) {
      return invalid("Filter value is too long.");
    }
    if (filter.field === "hire_date") continue;
    if (filter.op !== "eq" && filter.op !== "in") {
      return invalid(`${filter.field} only supports eq and in.`);
    }
  }

  if (!next.fields?.length && !next.metrics?.length && !next.band) {
    next.fields = ["full_name", "role", "department", "office_location", "hire_date", "tenure"];
  }

  if (next.orderBy && !SELECT_FIELDS.includes(next.orderBy.field)) {
    return invalid("orderBy field is not selectable.");
  }
  if (next.groupBy?.some((field) => !GROUP_FIELDS.includes(field))) {
    return invalid("groupBy field is not a dimension.");
  }

  return next;
}

function resolveNames(db: LedgerDatabase, query: LedgerQuery): LedgerQuery | LedgerResult {
  const filters = [...(query.filters ?? [])];
  const nameIndex = filters.findIndex((filter) => filter.field === "name");
  if (nameIndex === -1) return { ...query, filters };

  const nameFilter = filters[nameIndex];
  if (nameFilter.op !== "eq" || typeof nameFilter.value !== "string" || !nameFilter.value.trim()) {
    return invalid("A name filter must be an equality match on the full name.");
  }
  if (nameFilter.value.length > 80) return invalid("Name is too long.");

  const matches = db
    .prepare(
      `SELECT employee_id, full_name, role, department, office_location
       FROM employees WHERE lower(full_name) = lower(?)`,
    )
    .all(nameFilter.value)
    .map(plainRow);

  if (matches.length === 0) {
    return {
      status: "not_found",
      message: `I couldn't find an employee named ${nameFilter.value}.`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      message: "More than one employee has that name.",
      candidates: matches.map((row) => ({
        employeeId: String(row.employee_id),
        fullName: String(row.full_name),
        role: String(row.role),
        department: String(row.department),
        officeLocation: String(row.office_location),
      })),
    };
  }

  filters[nameIndex] = {
    field: "employee_id",
    op: "eq",
    value: String(matches[0].employee_id),
  };
  return { ...query, filters };
}

function countPopulation(
  db: LedgerDatabase,
  filters: LedgerQuery["filters"],
): { matched: number; executives: number; names: string[] } {
  const params: SqlValue[] = [];
  const where = buildWhere(filters ?? [], params);
  const totals = plainRow(
    db
      .prepare(
        `SELECT COUNT(*) AS matched,
                SUM(CASE WHEN e.access_level = 'executive' THEN 1 ELSE 0 END) AS executives
         FROM employees e ${where}`,
      )
      .get(...params) as object,
  );
  let names: string[] = [];
  if ((filters ?? []).some((filter) => filter.field === "employee_id")) {
    const nameParams: SqlValue[] = [];
    const nameWhere = buildWhere(filters ?? [], nameParams);
    names = db
      .prepare(`SELECT full_name FROM employees e ${nameWhere}`)
      .all(...nameParams)
      .map((row) => String(plainRow(row).full_name));
  }
  return {
    matched: asNumber(totals.matched) ?? 0,
    executives: asNumber(totals.executives) ?? 0,
    names,
  };
}

function hasPersonOrExecutiveFilter(query: LedgerQuery): boolean {
  return (query.filters ?? []).some((filter) => {
    if (filter.field === "employee_id") return true;
    if (filter.field !== "access_level") return false;
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.some((value) => String(value).toLowerCase() === "executive");
  });
}

function blockCompensationAggregate(
  query: LedgerQuery,
  population: { matched: number; executives: number; names: string[] },
): LedgerResult | undefined {
  const metrics = query.metrics ?? [];
  if (metrics.some((metric) => metric.fn === "min" || metric.fn === "max")) {
    return refused(
      "I can't calculate a minimum or maximum compensation figure. That would identify one person's pay.",
    );
  }
  if (hasPersonOrExecutiveFilter(query) && population.executives === population.matched && population.matched > 0) {
    return refused(executiveRefusal(population.names));
  }
  const narrow = (query.filters ?? []).length > 0;
  if (narrow && population.matched < MIN_COMPENSATION_GROUP) {
    return refused("I can't total compensation for a group that small.");
  }
  return undefined;
}

function executiveRefusal(names: string[]): string {
  if (names.length === 1) {
    return `I can't share ${names[0]}'s compensation. Executive compensation is restricted for a Junior HR Assistant.`;
  }
  return "I can't share that. Executive compensation is restricted for a Junior HR Assistant.";
}

function lookupBands(
  db: LedgerDatabase,
  band: NonNullable<LedgerQuery["band"]>,
  asOf: string,
): LedgerResult {
  const params: SqlValue[] = [band.city];
  let roleClause = "";
  if (band.roleLevel) {
    roleClause = " AND role_level = ?";
    params.push(band.roleLevel);
  }
  const sql = `SELECT city, role_level, salary_band_min_cents, salary_band_max_cents, cost_of_living_index
    FROM salary_bands WHERE lower(city) = lower(?)${roleClause} ORDER BY salary_band_min_cents`;
  const rows = db
    .prepare(sql)
    .all(...params)
    .map((row) => {
      const record = plainRow(row);
      return {
        bandCity: String(record.city),
        roleLevel: String(record.role_level),
        salaryBandMin: formatDollarsFromCents(asNumber(record.salary_band_min_cents) ?? 0),
        salaryBandMax: formatDollarsFromCents(asNumber(record.salary_band_max_cents) ?? 0),
        costOfLivingIndex: String(record.cost_of_living_index),
      };
    });
  if (rows.length === 0) {
    return {
      status: "not_found",
      message: `I couldn't find a salary band for ${band.city}.`,
      asOf,
    };
  }
  return { status: "ok", asOf, rows, rowCount: rows.length, sql };
}

function runMetrics(
  db: LedgerDatabase,
  query: LedgerQuery,
  asOf: string,
  population: { matched: number; executives: number },
): LedgerResult {
  const params: SqlValue[] = [];
  const where = buildWhere(query.filters ?? [], params);
  const groupBy = query.groupBy ?? [];
  const metricSql = (query.metrics ?? []).map((metric) => {
    if (metric.fn === "count") return `COUNT(*) AS count_value`;
    const column = moneyColumns[metric.field ?? ""];
    if (!column) return "";
    if (metric.fn === "avg") return `SUM(e.${column}) AS sum_${metric.field}, COUNT(*) AS n_${metric.field}`;
    return `${metric.fn.toUpperCase()}(e.${column}) AS ${metric.fn}_${metric.field}`;
  });
  const groupSelect = groupBy.map((field) => `${textColumns[field]} AS ${field}`);
  const having =
    groupBy.length > 0 && (query.metrics ?? []).some((metric) => metric.field && compensation.has(metric.field))
      ? ` HAVING COUNT(*) >= ${MIN_COMPENSATION_GROUP}`
      : "";
  const sql = `SELECT ${[...groupSelect, ...metricSql].join(", ")}
    FROM employees e ${where}
    ${groupBy.length ? `GROUP BY ${groupBy.map((field) => textColumns[field]).join(", ")}` : ""}
    ${having}`;

  const records = db.prepare(sql).all(...params).map(plainRow);
  if (groupBy.length === 0) {
    const metrics = shapeMetricRecord(query, records[0] ?? {});
    return {
      status: "ok",
      asOf,
      metrics,
      rowCount: population.matched,
      appliedFilters: query.filters ?? [],
      sql,
    };
  }

  const rows = records.map((record) => {
    const row: Record<string, string> = {};
    for (const field of groupBy) row[outputKey[field]] = String(record[field]);
    Object.assign(row, shapeMetricRecord(query, record));
    return row;
  });
  return {
    status: "ok",
    asOf,
    rows,
    rowCount: rows.length,
    appliedFilters: query.filters ?? [],
    sql,
  };
}

function shapeMetricRecord(query: LedgerQuery, record: Record<string, unknown>): Record<string, string> {
  const metrics: Record<string, string> = {};
  for (const metric of query.metrics ?? []) {
    if (metric.fn === "count") {
      metrics.count = String(asNumber(record.count_value) ?? 0);
      continue;
    }
    const field = metric.field ?? "";
    if (metric.fn === "avg") {
      const sum = asNumber(record[`sum_${field}`]) ?? 0;
      const count = asNumber(record[`n_${field}`]) ?? 0;
      const average = count === 0 ? 0 : Math.round(sum / count);
      metrics[`avg_${field}`] = formatDollarsFromCents(average);
      continue;
    }
    const cents = asNumber(record[`${metric.fn}_${field}`]) ?? 0;
    metrics[`${metric.fn}_${field}`] = formatDollarsFromCents(cents);
  }
  return metrics;
}

function runRows(
  db: LedgerDatabase,
  query: LedgerQuery,
  asOf: string,
  population: { executives: number },
): LedgerResult {
  const params: SqlValue[] = [];
  let join = "";
  if (query.bandCity) {
    join = `LEFT JOIN salary_bands b ON lower(b.city) = lower(?) AND b.role_level = e.role_level`;
    params.push(query.bandCity);
  }
  const whereParams: SqlValue[] = [];
  const where = buildWhere(query.filters ?? [], whereParams);
  params.push(...whereParams);

  const requested = new Set(query.fields ?? []);
  requested.add("employee_id");
  requested.add("full_name");
  if (query.bandCity) requested.add("salary_2025");
  const select = new Set<string>([
    "e.employee_id",
    "e.full_name",
    "e.access_level",
    "e.hire_date",
    "e.role_level",
  ]);
  for (const field of requested) {
    if (plainColumns[field]) select.add(plainColumns[field]);
    if (moneyColumns[field]) {
      select.add(
        `CASE WHEN e.access_level = 'executive' THEN NULL ELSE e.${moneyColumns[field]} END AS ${moneyColumns[field]}`,
      );
    }
  }
  if (query.bandCity) {
    select.add("b.salary_band_min_cents");
    select.add("b.salary_band_max_cents");
    select.add("b.cost_of_living_index");
    select.add("b.city AS band_city");
  }

  let order = "";
  if (query.orderBy) {
    const field = query.orderBy.field;
    const direction = query.orderBy.direction === "desc" ? "DESC" : "ASC";
    if (moneyColumns[field]) {
      order = `ORDER BY CASE WHEN e.access_level = 'executive' THEN NULL ELSE e.${moneyColumns[field]} END ${direction}`;
    } else if (field === "tenure" || field === "hire_date") {
      order = `ORDER BY e.hire_date ${direction}`;
    } else if (plainColumns[field]) {
      order = `ORDER BY ${plainColumns[field]} ${direction}`;
    }
  }

  const limit = query.limit ?? 25;
  params.push(limit);
  const sql = `SELECT ${[...select].join(", ")} FROM employees e ${join} ${where} ${order} LIMIT ?`;
  const records = db.prepare(sql).all(...params).map(plainRow);
  if (records.length === 0) {
    return { status: "not_found", message: "No employees matched that query.", asOf, sql };
  }

  const rows = records.map((record) => shapeRow(record, requested, query.bandCity, asOf));
  const suppressed = population.executives > 0 && (requestedHasPay(requested) || Boolean(query.bandCity));
  return {
    status: "ok",
    asOf,
    rows,
    rowCount: rows.length,
    appliedFilters: query.filters ?? [],
    suppressedCompensation: suppressed || undefined,
    message: suppressed ? "Executive compensation was omitted from these rows." : undefined,
    sql,
  };
}

function requestedHasPay(requested: Set<string>): boolean {
  for (const field of requested) {
    if (compensation.has(field)) return true;
  }
  return false;
}

function shapeRow(
  record: Record<string, unknown>,
  requested: Set<string>,
  bandCity: string | undefined,
  asOf: string,
): Record<string, string> {
  const row: Record<string, string> = {
    employeeId: String(record.employee_id),
    fullName: String(record.full_name),
  };
  for (const field of requested) {
    if (field === "tenure") {
      row.tenure = formatTenure(String(record.hire_date), asOf);
      continue;
    }
    if (moneyColumns[field]) {
      const cents = asNumber(record[moneyColumns[field]]);
      if (cents != null) row[outputKey[field]] = formatDollarsFromCents(cents);
      continue;
    }
    if (plainColumns[field] && record[field] != null && field !== "employee_id" && field !== "full_name") {
      row[outputKey[field]] = String(record[field]);
    }
  }
  if (bandCity) {
    const min = asNumber(record.salary_band_min_cents);
    const max = asNumber(record.salary_band_max_cents);
    const salary = asNumber(record.salary_2025_cents);
    row.bandCity = record.band_city ? String(record.band_city) : bandCity;
    if (record.role_level != null) row.roleLevel = String(record.role_level);
    if (min == null || max == null) {
      row.bandPosition = "unknown";
    } else {
      row.salaryBandMin = formatDollarsFromCents(min);
      row.salaryBandMax = formatDollarsFromCents(max);
      if (record.cost_of_living_index != null) {
        row.costOfLivingIndex = String(record.cost_of_living_index);
      }
      if (salary == null) {
        row.bandPosition = "unknown";
      } else if (salary < min) row.bandPosition = "below_min";
      else if (salary > max) row.bandPosition = "above_max";
      else row.bandPosition = "in_band";
    }
  }
  return row;
}

function buildWhere(filters: NonNullable<LedgerQuery["filters"]>, params: SqlValue[]): string {
  const clauses: string[] = [];
  for (const filter of filters) {
    if (filter.field === "name") continue;
    const column = textColumns[filter.field];
    if (!column) continue;
    const expression = filter.field === "hire_date" ? column : `lower(${column})`;
    if (filter.op === "eq") {
      clauses.push(`${expression} = ${filter.field === "hire_date" ? "?" : "lower(?)"}`);
      params.push(stringValue(filter.value as SqlValue));
      continue;
    }
    if (filter.op === "in") {
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(stringValue);
      clauses.push(`${expression} IN (${values.map(() => (filter.field === "hire_date" ? "?" : "lower(?)")).join(", ")})`);
      params.push(...values);
      continue;
    }
    if (filter.field !== "hire_date") continue;
    if (filter.op === "between" && Array.isArray(filter.value) && filter.value.length === 2) {
      clauses.push(`${column} >= ? AND ${column} <= ?`);
      params.push(stringValue(filter.value[0]), stringValue(filter.value[1]));
      continue;
    }
    if (filter.op === "gte" || filter.op === "lte") {
      clauses.push(`${column} ${filter.op === "gte" ? ">=" : "<="} ?`);
      params.push(stringValue(filter.value as SqlValue));
    }
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}
