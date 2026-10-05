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
export function findLinkedPath(adj: number[][], dir: number[][], src: number, dst: number): number[] | null {
  return findPath(adj, dir, src, dst, { edgeCost: (v, k) => (dir[v][k] === 0 ? null : 0) }) ?? findPath(adj, dir, src, dst);
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
