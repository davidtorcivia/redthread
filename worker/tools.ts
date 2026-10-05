// The research tools behind /api/* and /mcp. Pure apart from the Data callbacks, so tests
// can drive them with fixtures.
import type { Adjacency } from '../web/src/scripts/adjacency.ts';
import { TYPE_DIRS } from '../web/src/scripts/entity-types.ts';
import { findPath } from '../web/src/scripts/graph-path.ts';
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

async function search(d: Data, a: Args) {
  if (!d.corpus) throw new ToolError('the search index is not built on this site');
  const query = str(a, 'query', true)!.slice(0, 500);
  const type = str(a, 'type');
  if (type && !ENTRY_TYPES.includes(type)) throw new ToolError(`"type" must be one of ${ENTRY_TYPES.join(', ')}`);
  const f: Filters = { type, tag: str(a, 'tag'), yearFrom: int(a, 'year_from', -9999, 9999), yearTo: int(a, 'year_to', -9999, 9999) };
  const limit = int(a, 'limit', 1, 25, 10)!;
  const raw = await d.embed(query);
  const c = d.corpus;
  const hits = c.search(query, raw ? c.queryVector(raw) : null, f, limit);
  return {
    query,
    mode: raw ? 'semantic' : 'names only',
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

function path(d: Data, a: Args) {
  const s = adjIndex(d, str(a, 'from', true)!), t = adjIndex(d, str(a, 'to', true)!);
  const chain = findPath(d.adj.adj, d.adj.dir, s, t);
  if (!chain) return { from: ref(d, s), to: ref(d, t), path: null };
  return {
    from: ref(d, s),
    to: ref(d, t),
    path: chain.map((v, k) => {
      if (k === 0) return ref(d, v);
      const prev = chain[k - 1];
      return { ...ref(d, v), via: HOP[d.adj.dir[prev][d.adj.adj[prev].indexOf(v)]] };
    }),
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
    run: search,
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
    description: 'Shortest documented chain of connections between two entries. Steers around mega-hubs such as "United States" so each hop is a specific shared page.',
    inputSchema: { type: 'object', properties: { from: idProp, to: idProp }, required: ['from', 'to'] },
    run: path,
  },
  {
    name: 'similar',
    title: 'Similar entries',
    description: 'Entries most similar in subject matter to one entry, whether or not they link to it. Useful for finding related material the links miss.',
    inputSchema: { type: 'object', properties: { id: idProp, limit: { type: 'integer', minimum: 1, maximum: 12, default: 8 } }, required: ['id'] },
    run: similar,
  },
] as const;

export async function runTool(d: Data, name: string, args: Args): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError(`unknown tool "${name}"`);
  return tool.run(d, args ?? {});
}
