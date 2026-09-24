/** Shape of /adjacency.json, written by the parser. Arrays are indexed by node. */
export interface Adjacency {
  ids: string[];
  titles: string[];
  types: string[];
  /** Sorted neighbour indices. */
  adj: number[][];
  /** Parallel to adj: 1 = this page links the neighbour, 2 = the reverse, 3 = both, 0 = inferred. */
  dir: number[][];
  mentions: number[];
  bridges: Record<string, { rank: number; score: number }>;
  hubs: Record<string, { rank: number; score: number }>;
  implicitPairs: [number, number][];
  positions: [number, number][];
  communities: number[];
  communityLabels: string[];
}

let pending: Promise<Adjacency> | null = null;

/** Fetch and parse adjacency.json once per page, however many widgets ask. */
export function loadAdjacency(): Promise<Adjacency> {
  pending ??= fetch(`/adjacency.json?v=${(window as any).__V}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`adjacency.json: HTTP ${r.status}`))))
    .catch((err) => { pending = null; throw err; });
  return pending;
}
