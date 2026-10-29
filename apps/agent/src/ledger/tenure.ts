function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date ${value}`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatTenure(hireDate: string, asOf: string): string {
  const hire = parseIsoDate(hireDate);
  const end = parseIsoDate(asOf);
  let years = end.year - hire.year;
  let months = end.month - hire.month;
  if (end.day < hire.day) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return "not yet hired";
  const yearLabel = years === 1 ? "1 year" : `${years} years`;
  const monthLabel = months === 1 ? "1 month" : `${months} months`;
  if (years === 0 && months === 0) return "less than a month";
  if (years === 0) return monthLabel;
  if (months === 0) return yearLabel;
  return `${yearLabel}, ${monthLabel}`;
}
