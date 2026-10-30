export const CALLER_HEADER = "x-caller-role";

export const CALLER_ROLES = [
  { value: "junior_hr_assistant", label: "Junior HR Assistant" },
  { value: "staff", label: "Staff" },
  { value: "manager", label: "Manager" },
  { value: "executive", label: "Executive" },
] as const;

export type CallerRole = (typeof CALLER_ROLES)[number]["value"];

export function isCallerRole(value: string): value is CallerRole {
  return CALLER_ROLES.some((role) => role.value === value);
}
