/** Leading four-digit year of a "YYYY" or "YYYY-MM-DD" date. */
export function yearOf(s?: string): number | null {
  const m = s?.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** Describe only known dates; a missing end date does not establish ongoing activity. */
export function formatDates(dates: { born?: string; died?: string; start?: string; end?: string; date?: string }): string {
  const year = (s?: string) => s?.match(/^(-?\d{1,4})(?:-|$)/)?.[1] || s;
  const born = year(dates.born), died = year(dates.died);
  if (born && died) return born === died ? born : `${born}–${died}`;
  if (born) return `Born ${born}`;
  if (died) return `Died ${died}`;
  const start = year(dates.start), end = year(dates.end);
  if (start && end) return start === end ? start : `${start}–${end}`;
  return start || (end ? `Ended ${end}` : year(dates.date)) || '';
}
