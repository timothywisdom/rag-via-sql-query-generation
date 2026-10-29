export const ROLE_LEVELS = [
  "Entry Level",
  "Individual Contributor",
  "Senior Individual Contributor",
  "Manager",
  "Senior Manager",
  "Director",
  "VP",
  "C-Suite",
] as const;

export type RoleLevel = (typeof ROLE_LEVELS)[number];

export function inferRoleLevel(role: string): RoleLevel {
  const title = role.trim();
  if (/\bchief\b/i.test(title)) return "C-Suite";
  if (/\bVP\b/.test(title) || /\bvice president\b/i.test(title)) return "VP";
  if (/\bdirector\b/i.test(title)) return "Director";
  if (/\bsenior manager\b/i.test(title)) return "Senior Manager";
  if (/\bmanager\b/i.test(title)) return "Manager";
  if (/\b(senior|principal|lead|distinguished|architect)\b/i.test(title)) {
    return "Senior Individual Contributor";
  }
  if (/\b(junior|clerk)\b/i.test(title)) return "Entry Level";
  return "Individual Contributor";
}
