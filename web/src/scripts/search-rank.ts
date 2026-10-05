// Pure ranking helpers for the search dialog; no imports, so Node tests load them directly.

export interface Row {
  href: string;
  type?: string;
  title: string;
  /** Second line: a matched section's snippet or a summary, as text. */
  detail?: string;
  section?: string;
  /** Pagefind's excerpt: its own escaped text plus <mark>. */
  excerptHtml?: string;
}

export const TOP_MAX = 8;

// Pagefind highlights every query term; marking "the" and "of" in a question only adds noise.
const STOPWORDS = new Set('a an and are as at be by during for from had has have he her his in is it its of on or she that the their they this to was were what when where which who whom why with'.split(' '));

/** 0 exact, 1 prefix, 2 word prefix, 3 substring, 9 no match. */
export function nameRank(keys: string[], q: string): number {
  let best = 9;
  for (const k of keys) {
    const r = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(' ' + q) ? 2 : k.includes(q) ? 3 : 9;
    if (r < best) best = r;
  }
  return best;
}

/** Name matches first (exact, prefix, word prefix), then meaning matches, then substrings; one row per page. */
export function mergeTop(names: [number, Row][], meaning: Row[], max = TOP_MAX): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  const add = (r: Row) => {
    const key = r.href.split('#')[0];
    if (!seen.has(key) && out.length < max) { seen.add(key); out.push(r); }
  };
  names.filter(([rank]) => rank <= 2).forEach(([, r]) => add(r));
  meaning.forEach(add);
  names.filter(([rank]) => rank > 2).forEach(([, r]) => add(r));
  return out;
}

export function quietMarks(html: string): string {
  return html.replace(/<mark>([^<]*)<\/mark>/g, (m, w) => (STOPWORDS.has(w.toLowerCase()) ? w : m));
}

