// Semantic + name search over the index build/embed.py writes. Pure: no Workers APIs, so
// Node tests import it directly.

/** [id, title, type, summary, tags, primary year, aliases] */
export type Entry = [string, string, string, string, string[], number | null, string[]];
/** [entry index, section anchor, heading, snippet] */
export type Chunk = [number, string, string, string];

export interface Index {
  model: string;
  dims: number;
  query_prefix: string;
  lead_weight: number;
  entries: Entry[];
  chunks: Chunk[];
}

export interface Filters {
  type?: string;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
}

export interface Hit {
  entry: number;
  score: number;
  /** Best-matching chunks of this entry, strongest first (empty for a name-only match). */
  chunks: number[];
}

const RRF_K = 60;
const POOL = 50;

/** 0 exact, 1 prefix, 2 word prefix, 3 substring, 9 no match; the site search's quickRank. */
export function nameRank(keys: string[], q: string): number {
  let best = 9;
  for (const k of keys) {
    const r = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(' ' + q) ? 2 : k.includes(q) ? 3 : 9;
    if (r < best) best = r;
  }
  return best;
}

export class Corpus {
  readonly byId = new Map<string, number>();
  readonly index: Index;
  private readonly vectors: Int8Array;
  private readonly scales: Float32Array;
  private readonly names: string[][];
  private readonly lead: Int32Array;

  constructor(index: Index, vectors: Int8Array, scales: Float32Array) {
    this.index = index;
    this.vectors = vectors;
    this.scales = scales;
    if (vectors.length !== index.chunks.length * index.dims || scales.length !== index.chunks.length) {
      throw new Error(`index has ${index.chunks.length} chunks but the vectors hold ${scales.length}`);
    }
    index.entries.forEach((e, i) => this.byId.set(e[0], i));
    this.names = index.entries.map((e) => [e[1], ...e[6]].map((k) => k.toLowerCase()));
    // Chunks are written entry by entry, so an entry's first chunk is its opening section.
    this.lead = new Int32Array(index.entries.length).fill(-1);
    index.chunks.forEach((c, i) => { if (this.lead[c[0]] < 0) this.lead[c[0]] = i; });
  }

  /** Truncate a full-width model vector to the index width and renormalize. */
  queryVector(raw: ArrayLike<number>): Float32Array {
    const v = Float32Array.from({ length: this.index.dims }, (_, i) => raw[i] ?? 0);
    const n = Math.hypot(...v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  private allowed(i: number, f: Filters): boolean {
    const [, , type, , tags, year] = this.index.entries[i];
    if (f.type && type !== f.type) return false;
    if (f.tag) {
      const t = f.tag.toLowerCase();
      if (!tags.some((x) => x.toLowerCase() === t)) return false;
    }
    if (f.yearFrom != null && (year == null || year < f.yearFrom)) return false;
    if (f.yearTo != null && (year == null || year > f.yearTo)) return false;
    return true;
  }

  /** Chunk scores against a query vector. */
  private chunkScores(qv: Float32Array): Float32Array {
    const { dims, chunks } = this.index;
    const out = new Float32Array(chunks.length);
    const v = this.vectors;
    for (let c = 0, off = 0; c < chunks.length; c++, off += dims) {
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += v[off + d] * qv[d];
      out[c] = dot * this.scales[c];
    }
    return out;
  }

  /** Entries by best section plus lead_weight times the opening section, strongest first. */
  private dense(qv: Float32Array, f: Filters): { ranked: number[]; scores: Float32Array; entryScore: Float32Array } {
    const scores = this.chunkScores(qv);
    const n = this.index.entries.length;
    const best = new Float32Array(n).fill(-Infinity);
    this.index.chunks.forEach((c, i) => { if (scores[i] > best[c[0]]) best[c[0]] = scores[i]; });
    for (let e = 0; e < n; e++) if (this.lead[e] >= 0) best[e] += this.index.lead_weight * scores[this.lead[e]];
    const ranked = [...best.keys()].filter((e) => best[e] > -Infinity && this.allowed(e, f));
    ranked.sort((a, b) => best[b] - best[a]);
    return { ranked: ranked.slice(0, POOL), scores, entryScore: best };
  }

  /** Entries whose title or alias matches the query text. */
  byName(query: string, f: Filters = {}): number[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits: [number, number, number][] = [];
    this.names.forEach((keys, i) => {
      const r = nameRank(keys, q);
      if (r < 9 && this.allowed(i, f)) hits.push([r, keys[0].length, i]);
    });
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.slice(0, POOL).map((h) => h[2]);
  }

  /** Reciprocal-rank fusion of the dense and name rankings. With no query vector, names alone. */
  search(query: string, qv: Float32Array | null, f: Filters = {}, limit = 10): Hit[] {
    const names = this.byName(query, f);
    const dense = qv ? this.dense(qv, f) : null;
    const fused = new Map<number, number>();
    for (const list of [names, dense?.ranked ?? []]) {
      list.forEach((e, i) => fused.set(e, (fused.get(e) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return top.map(([entry, score]) => ({
      entry,
      score,
      chunks: dense ? this.topChunks(entry, dense.scores) : [],
    }));
  }

  private topChunks(entry: number, scores: Float32Array, k = 2): number[] {
    const own: number[] = [];
    for (let c = this.lead[entry]; c >= 0 && c < this.index.chunks.length && this.index.chunks[c][0] === entry; c++) own.push(c);
    return own.sort((a, b) => scores[b] - scores[a]).slice(0, k);
  }

  /** Entry index for an id, or for a title or alias that matches exactly or as a prefix. */
  resolve(idOrName: string): number | undefined {
    const direct = this.byId.get(idOrName.trim());
    if (direct != null) return direct;
    const [first] = this.byName(idOrName);
    return first != null && nameRank(this.names[first], idOrName.trim().toLowerCase()) <= 1 ? first : undefined;
  }
}
