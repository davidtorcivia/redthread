// Weighted shortest path over the adjacency graph. No DOM, so the Worker imports it too.

/** Chain of node indices from src to dst, or null when disconnected.
 *
 *  Not plain BFS: entering a node costs 1 + ln(1 + degree), so the route
 *  steers around mega-hubs. Otherwise most paths run through the United
 *  States or the CIA, which documents nothing; the penalty prefers a
 *  specific shared page (Angleton > KK MOUNTAIN > Oliver North). A hop backed
 *  only by a name match in prose (dir 0) costs 2 more, so wikilinked chains win.
 */
export interface PathOptions {
  /** Nodes the path may not pass through (the endpoints excepted). */
  blocked?: Uint8Array;
  /** Cost added to the k-th edge out of v on top of the default, or null to forbid the edge. */
  edgeCost?: (v: number, k: number) => number | null;
}

export function findPath(adj: number[][], dir: number[][], src: number, dst: number, opts: PathOptions = {}): number[] | null {
  if (src === dst) return [src];
  const n = adj.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[src] = 0;
  const heap = new MinHeap();
  heap.push(0, src);
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    if (v === dst) break;
    const neigh = adj[v];
    for (let k = 0; k < neigh.length; k++) {
      const w = neigh[k];
      if (done[w] || (opts.blocked?.[w] && w !== dst)) continue;
      const extra = opts.edgeCost ? opts.edgeCost(v, k) : 0;
      if (extra === null) continue;
      const nd = d + 1 + Math.log(1 + adj[w].length) + (dir[v][k] === 0 ? 2 : 0) + extra;
      if (nd < dist[w]) {
        dist[w] = nd;
        prev[w] = v;
        heap.push(nd, w);
      }
    }
  }
  if (prev[dst] === -1) return null;
  const path = [dst];
  for (let cur = dst; cur !== src; ) {
    cur = prev[cur];
    path.push(cur);
  }
  return path.reverse();
}

/** Wikilinked hops only, falling back to names mentioned together in prose only when no linked
 *  chain exists (about 1 pair in 400). A prose hop is the weakest evidence, and a quarter of
 *  unrestricted paths used one. The site's path pages use this. */
export function findLinkedPath(
  adj: number[][], dir: number[][], src: number, dst: number, blocked?: Uint8Array, bonus?: EdgeBonus,
): number[] | null {
  const b = (v: number, k: number) => (bonus ? bonus(v, adj[v][k]) : 0);
  return findPath(adj, dir, src, dst, { blocked, edgeCost: (v, k) => (dir[v][k] === 0 ? null : b(v, k)) })
    ?? findPath(adj, dir, src, dst, { blocked, edgeCost: b });
}

/** Extra cost of the hop v -> w, usually negative. */
export type EdgeBonus = (v: number, w: number) => number;

/** Up to k routes that never pass through `avoid`, each sharing no intermediate entry with an
 *  earlier one, so they are distinct routes rather than the k shortest. */
export function findRoutes(
  adj: number[][], dir: number[][], src: number, dst: number, avoid: number[] = [], k = 3, bonus?: EdgeBonus,
): number[][] {
  const blocked = new Uint8Array(adj.length);
  for (const v of avoid) blocked[v] = 1;
  const routes: number[][] = [];
  while (routes.length < k) {
    const route = findLinkedPath(adj, dir, src, dst, blocked, bonus);
    if (!route) break;
    routes.push(route);
    if (route.length <= 2) break;
    for (const v of route.slice(1, -1)) blocked[v] = 1;
  }
  return routes;
}

/** Each relation type as a past-tense verb: [subject's, object's]. "X employed_by Y" reads
 *  "X worked for Y" from X and "Y employed X" from Y. Kinship roles aren't used: the vault
 *  records them from either side ("son" can mean the other person's son or father). */
const VERBS: Record<string, [string, string]> = {
  employed_by: ['worked for', 'employed'],
  member_of: ['was a member of', 'counted among its members'],
  director_of: ['was a director of', 'had as a director'],
  head_of: ['headed', 'was headed by'],
  founded: ['founded', 'was founded by'],
  owned: ['owned', 'was owned by'],
  funded: ['funded', 'was funded by'],
  contractor_to: ['was a contractor to', 'contracted'],
  represented: ['represented', 'was represented by'],
  appointed: ['appointed', 'was appointed by'],
  reported_to: ['reported to', 'supervised'],
  investigated: ['investigated', 'was investigated by'],
  prosecuted: ['prosecuted', 'was prosecuted by'],
  participant_in: ['took part in', 'involved'],
  subject_of: ['was a subject of', 'had as a subject'],
  informant_for: ['was an informant for', 'used as an informant'],
  partner_of: ['was a partner of', 'was a partner of'],
  relative_of: ['was related to', 'was related to'],
  spouse_of: ['was married to', 'was married to'],
};

export interface RouteGraph {
  types: string[];
  dir: number[][];
  adj: number[][];
  relations?: [number, number, number][];
  relationTypes?: string[];
}

const relPairs = new WeakMap<object, Map<number, [number, number, number]>>();

/** The first typed relation between a and b, either way round. */
function relationOf(g: RouteGraph, a: number, b: number): [number, number, number] | undefined {
  let pairs = relPairs.get(g);
  if (!pairs) {
    pairs = new Map();
    for (const r of g.relations ?? []) {
      const k = Math.min(r[0], r[1]) * g.adj.length + Math.max(r[0], r[1]);
      if (!pairs.has(k)) pairs.set(k, r);
    }
    relPairs.set(g, pairs);
  }
  return pairs.get(Math.min(a, b) * g.adj.length + Math.max(a, b));
}

/** A hop backed by a sourced typed relation costs less, so those chains win ties (as the
 *  Worker's find_path does), and the route's sentence has verbs to say. */
export const typedBonus = (g: RouteGraph): EdgeBonus => (v, w) => (relationOf(g, v, w) ? -0.5 : 0);

/** How a reads to b along one hop: a typed relation's verb, else the kind of link. */
function hopVerb(g: RouteGraph, a: number, b: number): string {
  const r = relationOf(g, a, b);
  const verbs = r && VERBS[g.relationTypes?.[r[2]] ?? ''];
  if (verbs) return verbs[r[0] === a ? 0 : 1];
  return g.dir[a][g.adj[a].indexOf(b)] === 0 ? 'is named alongside' : 'is linked to';
}

/** A route as one sentence, split into node indices and the words between them:
 *  [0, ' worked for ', 4, ', which was headed by ', 9, '.']. */
export function routeSentence(g: RouteGraph, path: number[]): (number | string)[] {
  const out: (number | string)[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const lead = i === 1 ? ' ' : g.types[a] === 'person' ? ', who ' : ', which ';
    out.push(lead + hopVerb(g, a, path[i]) + ' ', path[i]);
  }
  out.push('.');
  return out;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    const k = this.keys, v = this.vals;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.keys, v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
