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

/** A relation's span as years: "1953–1961", "from 1953", "until 1961" or "". */
export function relationYears(r: { start?: string | null; end?: string | null }): string {
  const s = r.start?.slice(0, 4), en = r.end?.slice(0, 4);
  if (s && en) return s === en ? s : `${s}–${en}`;
  if (s) return `from ${s}`;
  if (en) return `until ${en}`;
  return '';
}
