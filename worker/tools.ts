// The research tools behind /api/* and /mcp. Pure apart from the Data callbacks, so tests
// can drive them with fixtures.
import type { Adjacency } from '../web/src/scripts/adjacency.ts';
import { TYPE_DIRS } from '../web/src/scripts/entity-types.ts';
import { findPath } from '../web/src/scripts/graph-path.ts';
import { count, datesIn, has, isoKey, notesIn, phrase, sentences, snippet, stripNotes, terms, type DateRef, type Fulltext, type Rec, type Relation } from './research.ts';
import { Corpus, type Filters } from './search.ts';

export interface Data {
  origin: string;
  corpus: Corpus | null;
  adj: Adjacency;
  similar: Record<string, { id: string; score: number }[]>;
  /** Raw model vector for a query, or null when embedding is unavailable. */
  embed(query: string): Promise<number[] | null>;
  /** A markdown twin by site path ("people/allen-dulles.md"), or null. */
  markdown(path: string): Promise<string | null>;
  /** entries.json and fulltext.json (build/research.py), loaded on first use. */
  entries(): Promise<Rec[]>;
  fulltext(): Promise<Fulltext>;
}

export class ToolError extends Error {}

export const ENTRY_TYPES = ['person', 'organization', 'program', 'event', 'concept', 'place', 'source'];

type Args = Record<string, unknown>;

const str = (a: Args, k: string, required = false): string | undefined => {
  const v = a[k];
  if (v == null || v === '') {
    if (required) throw new ToolError(`"${k}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`"${k}" must be a string`);
  return v;
};

const int = (a: Args, k: string, min: number, max: number, dflt?: number): number | undefined => {
  const v = a[k];
  if (v == null || v === '') return dflt;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolError(`"${k}" must be an integer`);
  return Math.min(max, Math.max(min, n));
};

/** A list argument: an array, or a comma-separated string from a query string. */
const list = (a: Args, k: string): string[] => {
  const v = a[k];
  if (v == null || v === '') return [];
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  throw new ToolError(`"${k}" must be a list of strings`);
};

function typeArg(a: Args): string | undefined {
  const type = str(a, 'type');
  if (type && !ENTRY_TYPES.includes(type)) throw new ToolError(`"type" must be one of ${ENTRY_TYPES.join(', ')}`);
  return type;
}

/** Derived indexes, built once per loaded array. */
function memo<K extends object, V>(f: (k: K) => V): (k: K) => V {
  const cache = new WeakMap<K, V>();
  return (k) => {
    if (!cache.has(k)) cache.set(k, f(k));
    return cache.get(k)!;
  };
}

const recIndex = memo((recs: Rec[]) => new Map(recs.map((r) => [r.id, r])));

function adjIndex(d: Data, idOrName: string): number {
  const i = d.adj.ids.indexOf(idOrName.trim());
  if (i >= 0) return i;
  const e = d.corpus?.resolve(idOrName);
  const j = e == null ? -1 : d.adj.ids.indexOf(d.corpus!.index.entries[e][0]);
  if (j < 0) throw new ToolError(`no entry "${idOrName}"; use search to find its id`);
  return j;
}

function ref(d: Data, i: number) {
  const id = d.adj.ids[i], type = d.adj.types[i];
  const dir = TYPE_DIRS[type] || 'pages';
  return { id, title: d.adj.titles[i], type, url: `${d.origin}/${dir}/${id}/`, markdown_url: `${d.origin}/${dir}/${id}.md` };
}

const recRef = (d: Data, r: Rec) => ({
  id: r.id, title: r.title, type: r.type, url: d.origin + r.path, markdown_url: d.origin + r.path.replace(/\/$/, '.md'),
});

async function search(d: Data, a: Args, semanticOnly = false) {
  if (!d.corpus) throw new ToolError('the search index is not built on this site');
  const query = str(a, 'query', true)!.slice(0, 500);
  const f: Filters = { type: typeArg(a), tag: str(a, 'tag'), yearFrom: int(a, 'year_from', -9999, 9999), yearTo: int(a, 'year_to', -9999, 9999) };
  const limit = int(a, 'limit', 1, 25, 10)!;
  const raw = await d.embed(query);
  if (semanticOnly && !raw) throw new ToolError('the embedding service is unavailable; retry, or use search_lexical');
  const c = d.corpus;
  const hits = c.search(query, raw ? c.queryVector(raw) : null, f, limit, !semanticOnly);
  return {
    query,
    mode: semanticOnly ? 'semantic only' : raw ? 'semantic' : 'names only',
    results: hits.map((h) => {
      const [id, title, type, summary, tags, year] = c.index.entries[h.entry];
      const dir = TYPE_DIRS[type] || 'pages';
      const url = `${d.origin}/${dir}/${id}/`;
      return {
        id, title, type, year, summary, tags, url, markdown_url: `${d.origin}/${dir}/${id}.md`,
        sections: h.chunks.map((ci) => {
          const [, anchor, heading, snippet] = c.index.chunks[ci];
          return { heading: heading || null, url: anchor ? `${url}#${anchor}` : url, snippet };
        }),
      };
    }),
  };
}

async function getEntry(d: Data, a: Args) {
  const r = ref(d, adjIndex(d, str(a, 'id', true)!));
  const md = await d.markdown(r.markdown_url.slice(d.origin.length + 1));
  if (md == null) throw new ToolError(`no markdown for "${r.id}"`);
  return { ...r, markdown: md };
}

function similar(d: Data, a: Args) {
  const i = adjIndex(d, str(a, 'id', true)!);
  const limit = int(a, 'limit', 1, 12, 8)!;
  const near = (d.similar[d.adj.ids[i]] ?? []).slice(0, limit);
  return {
    entry: ref(d, i),
    similar: near.flatMap((s) => {
      const j = d.adj.ids.indexOf(s.id);
      return j < 0 ? [] : [{ ...ref(d, j), score: s.score }];
    }),
  };
}

const LINK = ['named in prose', 'links to', 'linked from', 'links both ways'];
/** How a path step connects to the step before it. */
const HOP = ['named together in prose', 'linked from the previous entry', 'links to the previous entry', 'linked both ways'];

function neighbors(d: Data, a: Args) {
  const i = adjIndex(d, str(a, 'id', true)!);
  const limit = int(a, 'limit', 1, 200, 40)!;
  const order = d.adj.adj[i].map((w, k) => ({ w, dir: d.adj.dir[i][k] }));
  // Wikilinked neighbors first, then the most-mentioned.
  order.sort((x, y) => Number(y.dir > 0) - Number(x.dir > 0) || (d.adj.mentions[y.w] ?? 0) - (d.adj.mentions[x.w] ?? 0));
  return {
    entry: ref(d, i),
    total: order.length,
    neighbors: order.slice(0, limit).map(({ w, dir }) => ({ ...ref(d, w), link: LINK[dir] })),
  };
}

const relOut = (from: string, r: Relation) => ({
  from, type: r.type, to: r.target, to_title: r.target_title, start: r.start, end: r.end, role: r.role, source: r.source,
});

/** The graph of typed frontmatter relations between entries that have pages, over adjacency indices. */
const relationGraph = memo((recs: Rec[]) => {
  let built: { ids: string[]; adj: number[][]; dir: number[][]; pairs: Map<number, ReturnType<typeof relOut>[]> } | null = null;
  return (ids: string[]) => {
    if (built?.ids === ids) return built;
    const n = ids.length, at = new Map(ids.map((id, i) => [id, i]));
    const near = Array.from({ length: n }, () => new Set<number>());
    const pairs = new Map<number, ReturnType<typeof relOut>[]>();
    for (const r of recs) {
      const i = at.get(r.id);
      for (const rel of r.relations) {
        const j = rel.target == null ? undefined : at.get(rel.target);
        if (i == null || j == null || i === j) continue;
        const key = Math.min(i, j) * n + Math.max(i, j);
        pairs.set(key, [...(pairs.get(key) ?? []), relOut(r.id, rel)]);
        near[i].add(j);
        near[j].add(i);
      }
    }
    const adj = near.map((s) => [...s].sort((x, y) => x - y));
    built = { ids, adj, dir: adj.map((l) => l.map(() => 1)), pairs };
    return built;
  };
});

const EDGES = ['any', 'links', 'relations'];

async function path(d: Data, a: Args) {
  const edges = str(a, 'edges') ?? 'links';
  if (!EDGES.includes(edges)) throw new ToolError(`"edges" must be one of ${EDGES.join(', ')}`);
  const s = adjIndex(d, str(a, 'from', true)!), t = adjIndex(d, str(a, 'to', true)!);
  const k = int(a, 'k', 1, 5, 1)!;
  const blocked = new Uint8Array(d.adj.ids.length);
  for (const x of list(a, 'exclude')) blocked[adjIndex(d, x)] = 1;
  // Without entries.json the path still works, unannotated.
  const rg = relationGraph(await d.entries().catch(() => []))(d.adj.ids);
  const n = d.adj.ids.length, pair = (v: number, w: number) => Math.min(v, w) * n + Math.max(v, w);
  const g = edges === 'relations' ? rg : d.adj;
  // A hop backed by a sourced typed relation costs less, so those chains win ties.
  const edgeCost = (v: number, j: number) => (edges === 'links' && g.dir[v][j] === 0 ? null : rg.pairs.has(pair(v, g.adj[v][j])) ? -0.5 : 0);
  const chains: number[][] = [];
  while (chains.length < k) {
    const chain = findPath(g.adj, g.dir, s, t, { blocked, edgeCost });
    if (!chain) break;
    chains.push(chain);
    if (chain.length <= 2) break;
    for (const v of chain.slice(1, -1)) blocked[v] = 1;
  }
  const show = (chain: number[]) => chain.map((v, j) => {
    if (j === 0) return ref(d, v);
    const prev = chain[j - 1], at = d.adj.adj[prev].indexOf(v);
    const relations = rg.pairs.get(pair(prev, v));
    return { ...ref(d, v), via: at < 0 ? 'typed relation' : HOP[d.adj.dir[prev][at]], ...(relations ? { relations } : {}) };
  });
  return {
    from: ref(d, s),
    to: ref(d, t),
    edges,
    path: chains[0] ? show(chains[0]) : null,
    ...(k > 1 ? { alternatives: chains.slice(1).map(show) } : {}),
    ...(chains.length ? {} : { note: edges === 'any' ? 'not connected' : `no chain using only ${edges}; try edges "${edges === 'relations' ? 'links' : 'any'}"` }),
  };
}

async function searchLexical(d: Data, a: Args) {
  const query = str(a, 'query', true)!.slice(0, 500);
  const res = terms(query);
  if (!res.length) throw new ToolError('"query" has no terms');
  const type = typeArg(a), tag = str(a, 'tag')?.toLowerCase();
  const limit = int(a, 'limit', 1, 25, 10)!;
  const [recs, ft] = await Promise.all([d.entries(), d.fulltext()]);
  const byId = recIndex(recs);
  const hits = new Map<string, { best: number; score: number; sections: { i: number; score: number }[] }>();
  let matched = 0;
  ft.sections.forEach(([id, , heading, text], i) => {
    const r = byId.get(id);
    if (!r || (type && r.type !== type) || (tag && !r.tags?.some((x) => String(x).toLowerCase() === tag))) return;
    let score = 0;
    for (const re of res) {
      const c = count(re, text) + count(re, heading);
      if (!c) return;
      score += 1 + Math.log(c);
    }
    matched++;
    const h = hits.get(id) ?? { best: 0, score: 0, sections: [] };
    h.sections.push({ i, score });
    h.best = Math.max(h.best, score);
    h.score = h.best + 0.1 * Math.min(h.sections.length, 10);
    hits.set(id, h);
  });
  // An entry named by the query outranks one that only mentions it.
  for (const [id, h] of hits) if (res.every((re) => has(re, byId.get(id)!.title))) h.score += 2;
  const top = [...hits].sort((x, y) => y[1].score - x[1].score).slice(0, limit);
  return {
    query,
    mode: 'lexical',
    matching_sections: matched,
    matching_entries: hits.size,
    results: top.map(([id, h]) => {
      const r = byId.get(id)!;
      return {
        ...recRef(d, r),
        summary: r.summary ?? null,
        sections: h.sections.sort((x, y) => y.score - x.score).slice(0, 3).map(({ i }) => {
          const [, anchor, heading, text] = ft.sections[i];
          const snip = snippet(text, res[0]);
          return {
            heading: heading || null,
            url: d.origin + r.path + (anchor ? `#${anchor}` : ''),
            snippet: stripNotes(snip),
            sources: notesIn(snip).map((n) => ({ footnote: n, text: ft.footnotes[id]?.[n] ?? null })),
          };
        }),
      };
    }),
  };
}

/** Typed relations by the footnote that sources them: "page#footnote" -> relations. */
const relationsBySource = memo((recs: Rec[]) => {
  const out = new Map<string, ReturnType<typeof relOut>[]>();
  for (const r of recs) {
    for (const rel of r.relations) {
      const key = `${rel.source.page}#${rel.source.footnote}`;
      out.set(key, [...(out.get(key) ?? []), relOut(r.id, rel)]);
    }
  }
  return out;
});

async function searchCitations(d: Data, a: Args) {
  const query = str(a, 'query', true)!.slice(0, 500);
  const res = terms(query);
  if (!res.length) throw new ToolError('"query" has no terms');
  const limit = int(a, 'limit', 1, 25, 10)!;
  const [recs, ft] = await Promise.all([d.entries(), d.fulltext()]);
  const byId = recIndex(recs), bySource = relationsBySource(recs);
  // Identical footnote text on several pages is one citation.
  const groups = new Map<string, { text: string; cites: [string, string][] }>();
  for (const [id, notes] of Object.entries(ft.footnotes)) {
    for (const [fn, text] of Object.entries(notes)) {
      if (!res.every((re) => has(re, text))) continue;
      const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
      const g = groups.get(key) ?? { text, cites: [] };
      g.cites.push([id, fn]);
      groups.set(key, g);
    }
  }
  const top = [...groups.values()].sort((x, y) => y.cites.length - x.cites.length).slice(0, limit);
  // Every entry citing any match: one source cited chapter by chapter is many distinct footnotes.
  const citing = new Map<string, string[]>();
  for (const g of groups.values()) for (const [id, fn] of g.cites) citing.set(id, [...(citing.get(id) ?? []), fn]);
  return {
    query,
    matching_citations: groups.size,
    citing_entries: [...citing].sort((x, y) => y[1].length - x[1].length).slice(0, 100)
      .flatMap(([id, footnotes]) => (byId.has(id) ? [{ ...recRef(d, byId.get(id)!), footnotes }] : [])),
    citations: top.map((g) => ({
      text: g.text,
      cited_by_count: g.cites.length,
      cited_by: g.cites.slice(0, 50).flatMap(([id, fn]) => (byId.has(id) ? [{ ...recRef(d, byId.get(id)!), footnote: fn }] : [])),
      relations: g.cites.flatMap(([id, fn]) => bySource.get(`${id}#${fn}`) ?? []).slice(0, 50),
    })),
  };
}

const MAX_SPAN = 25;

async function timeline(d: Data, a: Args) {
  const entry = str(a, 'entry');
  const year = int(a, 'year', -9999, 9999);
  let from = year ?? int(a, 'year_from', -9999, 9999), to = year ?? int(a, 'year_to', -9999, 9999);
  if (!entry && from == null && to == null) throw new ToolError('give "year", "year_from" and "year_to", or "entry"');
  if (!entry && (from == null || to == null || to - from >= MAX_SPAN)) {
    if (from == null || to == null) throw new ToolError('a year range needs both "year_from" and "year_to"');
    throw new ToolError(`a year range spans at most ${MAX_SPAN} years`);
  }
  if (from != null && to != null && from > to) throw new ToolError('"year_from" must not be after "year_to"');
  from ??= -9999;
  to ??= 9999;
  const limit = int(a, 'limit', 1, 200, 50)!, offset = int(a, 'offset', 0, 1_000_000, 0)!;
  const [recs, ft] = await Promise.all([d.entries(), d.fulltext()]);
  const byId = recIndex(recs);
  const inRange = (x: DateRef | null): x is DateRef => x != null && x.year >= from! && x.year <= to!;
  const small = (r: Rec) => ({ id: r.id, title: r.title, url: d.origin + r.path });

  // Entry mode reads the entry and its graph neighbors, keeping their sentences about it.
  let target: Rec | undefined, scope: Set<string> | null = null, names: RegExp | null = null;
  if (entry) {
    const i = adjIndex(d, entry);
    target = byId.get(d.adj.ids[i]);
    if (!target) throw new ToolError(`no entry "${entry}"`);
    scope = new Set([target.id, ...d.adj.adj[i].map((w) => d.adj.ids[w])]);
    names = new RegExp([target.title, ...target.aliases].map(phrase).join('|'), 'i');
  }

  type Item = { key: number; date: string; [k: string]: unknown };
  const items: Item[] = [];
  for (const r of target ? [target] : recs) {
    for (const [field, v] of Object.entries(r.dates)) {
      const dt = isoKey(v);
      if (inRange(dt)) items.push({ key: dt.key, date: dt.text, kind: field, entry: small(r) });
    }
  }
  for (const r of recs) {
    for (const rel of r.relations) {
      if (target && r.id !== target.id && rel.target !== target.id) continue;
      for (const [field, v] of [['start', rel.start], ['end', rel.end]] as const) {
        const dt = v ? isoKey(v) : null;
        if (inRange(dt)) items.push({ key: dt.key, date: dt.text, kind: `relation ${field}`, relation: relOut(r.id, rel) });
      }
    }
  }
  // The entry's own year dates its year-less mentions ("aired on 18 October").
  const ownYear = target ? Math.min(...Object.values(target.dates).map((v) => isoKey(v)?.year ?? Infinity)) : Infinity;
  const yearRe = entry ? null : new RegExp(`\\b(?:${Array.from({ length: to - from + 1 }, (_, j) => from! + j).join('|')})\\b`);
  for (const [id, anchor, heading, text] of ft.sections) {
    if (scope && !scope.has(id)) continue;
    if (yearRe && !yearRe.test(text)) continue;
    const own = id === target?.id, r = byId.get(id);
    if (!r || (names && !own && !names.test(text))) continue;
    const ctx = { year: own && Number.isFinite(ownYear) ? ownYear : undefined };
    let named = false, para = -1;
    for (const s of sentences(text)) {
      const ds = datesIn(s.text, ctx).filter(inRange);
      // A sentence counts when it or the one before it in its paragraph names the entry
      // ("... at Livermore. In late 1974, ...").
      const prev = named && s.para === para;
      para = s.para;
      named = !!names?.test(s.text);
      if (names && !own && !named && !prev) continue;
      if (!ds.length) continue;
      items.push({
        key: ds[0].key,
        date: ds[0].text,
        kind: 'statement',
        entry: small(r),
        url: d.origin + r.path + (anchor ? `#${anchor}` : ''),
        section: heading || null,
        text: s.text.length > 600 ? s.text.slice(0, 600) + '…' : s.text,
        ...(ds.length > 1 ? { other_dates: ds.slice(1).map((x) => x.text) } : {}),
        sources: s.notes.map((n) => ({ footnote: n, text: ft.footnotes[id]?.[n] ?? null })),
        ...(s.inherited ? { source_inherited: true } : {}),
      });
    }
  }
  if (target) {
    for (const [fn, text] of Object.entries(ft.footnotes[target.id] ?? {})) {
      // A bare year in a citation is nearly always its publication year, so footnotes need a month.
      const ds = datesIn(text, { year: Number.isFinite(ownYear) ? ownYear : undefined, fixed: true })
        .filter((x) => inRange(x) && x.key % 10000 > 0);
      if (ds.length) {
        items.push({
          key: ds[0].key, date: ds[0].text, kind: 'footnote', entry: small(target), footnote: fn, text,
          ...(ds.length > 1 ? { other_dates: ds.slice(1).map((x) => x.text) } : {}),
        });
      }
    }
  }
  // Day-precise dates group by day; vaguer ones by the words used, so "late 1974" and
  // "winter 1975" sit side by side rather than merging into their years.
  const label = (date: string) => date.replace(/\s+/g, ' ').replace(/,/g, '');
  const group = (x: Item) => (x.key % 100 ? String(x.key) : label(x.date).toLowerCase());
  // Equal keys ("late 1974", "October 1974") sort by group, so each group stays together.
  items.sort((x, y) => x.key - y.key || group(x).localeCompare(group(y)));
  const groups: { date: string; items: Omit<Item, 'key' | 'date'>[] }[] = [];
  let lastKey = '';
  for (const item of items.slice(offset, offset + limit)) {
    const { key: _, date, ...rest } = item;
    const k = group(item);
    if (k === lastKey) groups[groups.length - 1].items.push(rest);
    else groups.push({ date: label(date), items: [rest] });
    lastKey = k;
  }
  return {
    ...(target ? { entry: recRef(d, target) } : { year_from: from, year_to: to }),
    total: items.length,
    offset,
    next_offset: offset + limit < items.length ? offset + limit : null,
    groups,
  };
}

async function listEntries(d: Data, a: Args) {
  const type = typeArg(a), tag = str(a, 'tag')?.toLowerCase(), since = str(a, 'updated_since');
  const limit = int(a, 'limit', 1, 200, 50)!, offset = int(a, 'offset', 0, 1_000_000, 0)!;
  const rows = (await d.entries()).filter((r) => (!type || r.type === type)
    && (!tag || r.tags?.some((x) => String(x).toLowerCase() === tag))
    && (!since || String(r.updated ?? r.created ?? '') >= since));
  return {
    total: rows.length,
    offset,
    next_offset: offset + limit < rows.length ? offset + limit : null,
    bulk_url: `${d.origin}/entries.json`,
    entries: rows.slice(offset, offset + limit).map((r) => ({ ...r, url: d.origin + r.path })),
  };
}

const idProp = { type: 'string', description: 'Entry id (the URL slug, such as "allen-dulles") or an exact title.' };

export const TOOLS = [
  {
    name: 'search',
    title: 'Search the archive',
    description: 'Search entries by meaning and by name. Returns the best entries with their summary, URLs, and the sections that matched (heading, deep link, snippet). Works for natural-language questions ("CIA chemist who ran the LSD program"), names, aliases and codenames.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language or as a name.' },
        type: { type: 'string', enum: ENTRY_TYPES, description: 'Only entries of this type.' },
        tag: { type: 'string', description: 'Only entries with this tag (case-insensitive), such as "CIA" or "1960s".' },
        year_from: { type: 'integer', description: "Only entries whose earliest known year (birth, start, or date) is at least this." },
        year_to: { type: 'integer', description: 'Only entries whose earliest known year is at most this.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      required: ['query'],
    },
    run: (d: Data, a: Args) => search(d, a),
  },
  {
    name: 'search_semantic',
    title: 'Search by meaning only',
    description: 'Like search, but ranked by meaning alone, without the boost for title and alias matches. Fails rather than falling back when the embedding service is down.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language.' },
        type: { type: 'string', enum: ENTRY_TYPES, description: 'Only entries of this type.' },
        tag: { type: 'string', description: 'Only entries with this tag (case-insensitive).' },
        year_from: { type: 'integer', description: 'Only entries whose earliest known year is at least this.' },
        year_to: { type: 'integer', description: 'Only entries whose earliest known year is at most this.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      required: ['query'],
    },
    run: (d: Data, a: Args) => search(d, a, true),
  },
  {
    name: 'search_lexical',
    title: 'Search the exact text',
    description: 'Full-text search for exact words and "quoted phrases" in every entry body (case-insensitive, all terms must appear in the same section). Returns matching sections with snippets and the footnotes cited in them. Use for names, codenames, quotations and spellings that search by meaning blurs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words and "quoted phrases", all required.' },
        type: { type: 'string', enum: ENTRY_TYPES, description: 'Only entries of this type.' },
        tag: { type: 'string', description: 'Only entries with this tag (case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      required: ['query'],
    },
    run: searchLexical,
  },
  {
    name: 'search_citations',
    title: 'Search by source',
    description: 'Find a source in the footnotes (author, title, archive, URL, "quoted phrase"), and every entry and footnote that cites it, plus the typed relations that footnote sources. Query by provenance rather than content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words and "quoted phrases" that must all appear in the footnote, such as "Exempt from Disclosure" or a domain.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Distinct citations to return.' },
      },
      required: ['query'],
    },
    run: searchCitations,
  },
  {
    name: 'get_entry',
    title: 'Read an entry',
    description: 'Full text of one entry as markdown: frontmatter (aliases, dates, typed relations with sources), body with links rewritten to site URLs, and footnoted citations.',
    inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'] },
    run: getEntry,
  },
  {
    name: 'neighbors',
    title: 'Connected entries',
    description: 'Entries directly connected to one entry in the link graph, wikilinked ones first, each marked "links to", "linked from", "links both ways", or "named in prose".',
    inputSchema: { type: 'object', properties: { id: idProp, limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 } }, required: ['id'] },
    run: neighbors,
  },
  {
    name: 'find_path',
    title: 'Find a chain of connections',
    description: 'Shortest documented chain of connections between two entries. Steers around mega-hubs such as "United States" so each hop is a specific shared page, and prefers hops backed by a sourced typed relation. Each hop lists those relations (type, role, dates, and the footnote that sources it).',
    inputSchema: {
      type: 'object',
      properties: {
        from: idProp,
        to: idProp,
        edges: {
          type: 'string', enum: EDGES, default: 'links',
          description: 'links (default): wikilinks only. any: also hops where two entries are only named together in prose, which mostly run through hubs. relations: only typed frontmatter relations (member_of, employed_by...), each sourced by a footnote.',
        },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Entries the path may not pass through, such as hubs ("united-states"). Comma-separated over GET.' },
        k: { type: 'integer', minimum: 1, maximum: 5, default: 1, description: 'Up to k paths. Each alternative shares no intermediate entry with an earlier one, so these are distinct routes, not the k shortest.' },
      },
      required: ['from', 'to'],
    },
    run: path,
  },
  {
    name: 'similar',
    title: 'Similar entries',
    description: 'Entries most similar in subject matter to one entry, whether or not they link to it. Useful for finding related material the links miss.',
    inputSchema: { type: 'object', properties: { id: idProp, limit: { type: 'integer', minimum: 1, maximum: 12, default: 8 } }, required: ['id'] },
    run: similar,
  },
  {
    name: 'timeline',
    title: 'Dated statements side by side',
    description: 'Everything dated to a year, a year range, or an entry, with its source: frontmatter dates, typed relation start and end dates, and every sentence in the archive that gives a date in range ("October 14, 1988", "late 1974", "winter 1975"), each with the footnotes that source it. Grouped by the date as written and sorted, so conflicting accounts of the same event sit side by side. For an entry, reads that entry and the pages that link to it, keeping their sentences that name it.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'One year.' },
        year_from: { type: 'integer', description: `Start of a range of at most ${MAX_SPAN} years.` },
        year_to: { type: 'integer', description: 'End of the range, inclusive.' },
        entry: { ...idProp, description: 'An entry (usually an event) whose dated statements to collect, across the pages that link to it. Combine with years to narrow.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0, description: 'Skip this many items; use next_offset from the previous page.' },
      },
    },
    run: timeline,
  },
  {
    name: 'list_entries',
    title: 'List entries (frontmatter only)',
    description: 'Page through every entry\'s frontmatter: title, type, aliases, dates, location, tags, summary, and typed relations with their sources. No body text. For everything at once, download bulk_url.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ENTRY_TYPES, description: 'Only entries of this type.' },
        tag: { type: 'string', description: 'Only entries with this tag (case-insensitive).' },
        updated_since: { type: 'string', description: 'Only entries updated on or after this date (YYYY-MM-DD).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    run: listEntries,
  },
] as const;

export async function runTool(d: Data, name: string, args: Args): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError(`unknown tool "${name}"`);
  return tool.run(d, args ?? {});
}
