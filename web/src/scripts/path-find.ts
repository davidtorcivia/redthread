/** Chain of connections between two node indices in an adjacency list.
 *
 *  Not plain BFS: entering a node costs 1 + ln(1 + degree), so the search
 *  steers around mega-hubs. On this vault 177 of 300 random BFS paths ran
 *  through the United States, the CIA, Israel, the FBI or Washington D.C.,
 *  which documents nothing; the penalized path prefers a specific shared
 *  page (Angleton > KK MOUNTAIN > Oliver North instead of Angleton >
 *  United States > Oliver North). Returns null when disconnected.
 */
export function findPath(adj: number[][], src: number, dst: number): number[] | null {
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
    for (let i = 0; i < neigh.length; i++) {
      const w = neigh[i];
      if (done[w]) continue;
      const nd = d + 1 + Math.log(1 + adj[w].length);
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
