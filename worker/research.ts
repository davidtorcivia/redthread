// Text helpers for the research tools over entries.json and fulltext.json (build/research.py):
// lexical terms, sentences with their footnotes, and dates. Pure, so Node tests import them.

export interface Relation {
  type: string;
  /** Entry id, or null when the target has no page. */
  target: string | null;
  target_title: string | null;
  start: string | null;
  end: string | null;
  role: string | null;
  /** The footnote backing this relation: the page it is on, its id, and its text. */
  source: { page: string | null; footnote: string | null; text: string | null };
}

/** One entry's frontmatter: everything but the body. */
export interface Rec {
  id: string;
  title: string;
  type: string;
  path: string;
  aliases: string[];
  dates: Record<string, string>;
  category?: string;
  summary?: string;
  tags?: string[];
  location?: string;
  created?: string;
  updated?: string;
  relations: Relation[];
}

/** [entry id, section anchor, heading, plain text with [^n] footnote markers] */
export type Section = [string, string, string, string];

export interface Fulltext {
  sections: Section[];
  /** entry id -> footnote id -> footnote text */
  footnotes: Record<string, Record<string, string>>;
}

const NOTE = /\[\^([^\]]+)\]/g;
export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source for a literal phrase, any whitespace between words, with \b only at edges that
 *  are word characters ("Live!" cannot end at a word boundary). */
export const phrase = (t: string) =>
  `${/^\w/.test(t) ? '\\b' : ''}${escape(t).replace(/\s+/g, '\\s+')}${/\w$/.test(t) ? '\\b' : ''}`;

/** Quoted phrases and bare words as case-insensitive regexes. */
export function terms(query: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim();
    if (t) out.push(new RegExp(phrase(t), 'gi'));
  }
  return out.slice(0, 10);
}

export function count(re: RegExp, text: string, cap = 20): number {
  re.lastIndex = 0;
  let n = 0;
  while (n < cap && re.exec(text)) n++;
  return n;
}

export const has = (re: RegExp, text: string) => count(re, text, 1) > 0;

/** Footnote ids referenced in a text, in order, without repeats. */
export const notesIn = (text: string) => [...new Set([...text.matchAll(NOTE)].map((m) => m[1]))];

export const stripNotes = (text: string) => text.replace(NOTE, '');

/** Text around the first match of re, with any footnote markers it cuts through left intact. */
export function snippet(text: string, re: RegExp, width = 160): string {
  re.lastIndex = 0;
  const m = re.exec(text);
  const at = m?.index ?? 0;
  let start = Math.max(0, at - width), end = Math.min(text.length, at + (m?.[0].length ?? 0) + width);
  // Widen rather than cut through a [^n] marker, so its source is not lost.
  const open = text.lastIndexOf('[^', start);
  if (open >= 0 && open < start && text.indexOf(']', open) >= start) start = open;
  const close = text.lastIndexOf('[^', end);
  if (close >= 0 && close < end && text.indexOf(']', close) >= end) end = text.indexOf(']', close) + 1;
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

export interface Sentence { text: string; notes: string[]; inherited: boolean; /** paragraph index in the section */ para: number }

// Sentence end: . ! ? (then closing quotes and footnote markers) before a capital, except after
// an initial ("U.S.", "John F.") or a common abbreviation.
// ponytail: other abbreviations ("Ave.", "Dept.") still end a sentence early.
const SENTENCE_END = /(?<=[.!?]["')\]]*(?:\[\^[^\]]+\])*)(?<!\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Jr|Sr|Gen|Col|Lt|Capt|Sgt|Maj|Adm|Rev|Sen|Rep|Gov|No|Vol|vs|Inc|Co|Corp|Ltd|ca|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.)\s+(?=["'(]?[A-Z0-9])/;

/** Sentences of a section, each with the footnotes that source it. A sentence without its own
 *  marker takes the next one in its paragraph: a citation closes the run of claims it covers. */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const [p, para] of text.split(/\n+/).entries()) {
    const parts = para.split(SENTENCE_END);
    const rows: Sentence[] = [];
    let next: string[] = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const own = notesIn(parts[i]);
      if (own.length) next = own;
      const t = stripNotes(parts[i]).trim();
      if (t) rows.push({ text: t, notes: own.length ? own : next, inherited: !own.length && next.length > 0, para: p });
    }
    out.push(...rows.reverse());
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?)';
/** Rough month a vague expression points at, for sorting within its year. */
const SEASON: Record<string, number> = { early: 2, winter: 1, spring: 4, mid: 6, summer: 7, late: 10, fall: 10, autumn: 10 };
const QUAL = `(${Object.keys(SEASON).join('|')})`;
const YEAR = '(1[5-9]\\d\\d|20[0-3]\\d)';
// "17-19", "13 and 14", "28 to 29": a day range dated by its first day. Non-capturing, since
// datesIn reads the groups by position.
const DAY_RANGE = '(?:st|nd|rd|th)?(?:\\s*-\\s*\\d{1,2}|\\s+(?:and|to|through)\\s+\\d{1,2})?(?:st|nd|rd|th)?';
// Most specific first, so "October 14, 1988" wins over its bare year.
const DATE = new RegExp([
  `\\b${MONTH}\\s+(\\d{1,2})${DAY_RANGE},?\\s+${YEAR}\\b`,
  `\\b(\\d{1,2})\\s+${MONTH},?\\s+${YEAR}\\b`,
  `\\b${QUAL}[-\\s]+(?:of\\s+)?(?:${MONTH}\\s+)?${YEAR}\\b`,
  `\\b${MONTH},?\\s+${YEAR}\\b`,
  `\\b${MONTH}(?![a-z])\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  `\\b(\\d{1,2})\\s+${MONTH}(?![a-z])`,
  `\\b${YEAR}\\b(?!s)`,
].join('|'), 'gi');

export interface DateRef {
  text: string;
  year: number;
  /** yyyymmdd, 0 for an unknown month or day */
  key: number;
  /** The text gave no year ("October 18"); it was taken from context. */
  inferred?: boolean;
}

/** Dates written in prose: "October 14, 1988", "14 October 1988", "late 1974", "winter of 1975",
 *  "March 1975", "1975", and "October 18" with its year taken from ctx.year: the last full date
 *  seen in the same running text, or a fixed year (a citation's own dates are not context). */
export function datesIn(text: string, ctx: { year?: number; fixed?: boolean } = {}): DateRef[] {
  const out: DateRef[] = [];
  for (const m of text.matchAll(DATE)) {
    const [mon, day, year, qual] = m[1] ? [m[1], m[2], m[3]] : m[5] ? [m[5], m[4], m[6]]
      : m[9] ? [m[8], undefined, m[9], m[7]] : m[11] ? [m[10], undefined, m[11]]
      : m[12] ? [m[12], m[13], undefined] : m[15] ? [m[15], m[14], undefined] : [undefined, undefined, m[16]];
    const y = year ? +year : ctx.year;
    if (y == null || (day && +day > 31)) continue;
    if (year && !ctx.fixed) ctx.year = y;
    const month = mon ? MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1 : qual ? SEASON[qual.toLowerCase()] : 0;
    out.push({ text: m[0], year: y, key: y * 10000 + month * 100 + (day ? +day : 0), ...(year ? {} : { inferred: true }) });
  }
  return out;
}

/** Sort key for a frontmatter date ("1974", "1974-10", "1974-10-14"). */
export function isoKey(v: string): DateRef | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(v));
  return m ? { text: String(v), year: +m[1], key: +m[1] * 10000 + +(m[2] ?? 0) * 100 + +(m[3] ?? 0) } : null;
}
