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

import { TYPE_LABELS } from './entity-types';

/** Why two consecutive path nodes are connected, from adjacency `dir`
 *  bits (1 = a's page links b, 2 = b's page links a, 0 = inferred). */
export function hopReason(data: any, a: number, b: number): string {
  const k = data.adj[a].indexOf(b);
  const d = k >= 0 && data.dir ? data.dir[a][k] : 0;
  if (d === 3) return 'Both pages link to each other';
  if (d === 1) return `linked from ${data.titles[a]}’s page`;
  if (d === 2) return `linked from ${data.titles[b]}’s page`;
  return 'Inferred from names mentioned together';
}

/** Render a found path as the shared <ol class="path-chain"> used by
 *  /path/ and the entity-page widget, with the evidence for each hop. */
export function renderChain(data: any, path: number[], hrefOf: (id: string) => string): HTMLOListElement {
  const ol = document.createElement('ol');
  ol.className = 'path-chain';
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    const type = data.types[idx];
    const li = document.createElement('li');
    li.className = `path-node type-${type}`;
    if (i === 0) li.classList.add('is-start');
    if (i === path.length - 1) li.classList.add('is-end');
    const a = document.createElement('a');
    a.className = 'pn-link';
    a.href = hrefOf(data.ids[idx]);
    const t = document.createElement('span');
    t.className = 'pn-type';
    t.textContent = TYPE_LABELS[type] || type;
    const title = document.createElement('span');
    title.className = 'pn-title';
    title.textContent = data.titles[idx];
    a.append(t, title);
    li.appendChild(a);
    ol.appendChild(li);
    if (i < path.length - 1) {
      const hop = document.createElement('li');
      hop.className = 'path-arrow';
      const arrow = document.createElement('span');
      arrow.textContent = '→';
      arrow.setAttribute('aria-hidden', 'true');
      const why = document.createElement('span');
      why.className = 'path-why';
      why.textContent = hopReason(data, idx, path[i + 1]);
      hop.append(arrow, why);
      ol.appendChild(hop);
    }
  }
  return ol;
}
