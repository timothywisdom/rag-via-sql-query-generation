export const CALLER_ROLES = ["junior_hr_assistant", "staff", "manager", "executive"] as const;

export type CallerRole = (typeof CALLER_ROLES)[number];

export const CALLER_HEADER = "x-caller-role";

type PayPolicy = {
  visiblePay: readonly string[];
  allowAggregates: boolean;
  allowMinMax: boolean;
  minGroup: number;
};

const policies: Record<CallerRole, PayPolicy> = {
  junior_hr_assistant: {
    visiblePay: ["staff", "manager"],
    allowAggregates: true,
    allowMinMax: false,
    minGroup: 5,
  },
  staff: {
    visiblePay: [],
    allowAggregates: false,
    allowMinMax: false,
    minGroup: 5,
  },
  manager: {
    visiblePay: ["staff"],
    allowAggregates: true,
    allowMinMax: false,
    minGroup: 5,
  },
  executive: {
    visiblePay: ["staff", "manager", "executive"],
    allowAggregates: true,
    allowMinMax: true,
    minGroup: 1,
  },
};

export function isCallerRole(value: string): value is CallerRole {
  return (CALLER_ROLES as readonly string[]).includes(value);
}

export function payPolicy(caller: CallerRole): PayPolicy {
  return policies[caller];
}

export function visiblePayExpression(column: string, visiblePay: readonly string[]): string {
  if (visiblePay.length === 0) return "NULL";
  const list = visiblePay.map((level) => `'${level}'`).join(", ");
  return `CASE WHEN e.access_level IN (${list}) THEN e.${column} ELSE NULL END`;
}
