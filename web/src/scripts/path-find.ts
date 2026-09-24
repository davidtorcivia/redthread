import { loadAdjacency, type Adjacency } from './adjacency';
import { TYPE_LABELS, entityHref, el } from './entity-types';

/** Chain of node indices from src to dst, or null when disconnected.
 *
 *  Not plain BFS: entering a node costs 1 + ln(1 + degree), so the route
 *  steers around mega-hubs. Otherwise most paths run through the United
 *  States or the CIA, which documents nothing; the penalty prefers a
 *  specific shared page (Angleton > KK MOUNTAIN > Oliver North). A hop backed
 *  only by a name match in prose (dir 0) costs 2 more, so wikilinked chains win.
 */
export function findPath(adj: number[][], dir: number[][], src: number, dst: number): number[] | null {
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
      if (done[w]) continue;
      const nd = d + 1 + Math.log(1 + adj[w].length) + (dir[v][k] === 0 ? 2 : 0);
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

/** Why two consecutive path nodes are connected. */
function hopReason(data: Adjacency, a: number, b: number): string {
  const d = data.dir[a][data.adj[a].indexOf(b)];
  if (d === 3) return 'Both pages link to each other';
  if (d === 1) return `linked from ${data.titles[a]}’s page`;
  if (d === 2) return `linked from ${data.titles[b]}’s page`;
  return 'Inferred from names mentioned together';
}

/** A found path as <ol class="path-chain">, with the evidence for each hop. */
export function renderChain(data: Adjacency, path: number[]): HTMLOListElement {
  const ol = el('ol', 'path-chain');
  path.forEach((idx, i) => {
    const type = data.types[idx];
    const li = el('li', `path-node type-${type}`);
    if (i === 0) li.classList.add('is-start');
    if (i === path.length - 1) li.classList.add('is-end');
    const a = el('a', 'pn-link');
    a.href = entityHref(type, data.ids[idx]);
    a.append(el('span', 'pn-type', TYPE_LABELS[type] || type), el('span', 'pn-title', data.titles[idx]));
    li.append(a);
    ol.append(li);
    if (i < path.length - 1) {
      const arrow = el('span', '', '→');
      arrow.setAttribute('aria-hidden', 'true');
      const hop = el('li', 'path-arrow');
      hop.append(arrow, el('span', 'path-why', hopReason(data, idx, path[i + 1])));
      ol.append(hop);
    }
  });
  return ol;
}

/** Up to 8 titles matching q: exact first, then prefix, then substring. */
function suggest(titles: string[], query: string, skip: number): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix: number[] = [], middle: number[] = [];
  for (let i = 0; i < titles.length; i++) {
    if (i === skip) continue;
    const t = titles[i].toLowerCase();
    if (t === q) prefix.unshift(i);
    else if (t.startsWith(q)) prefix.push(i);
    else if (t.includes(q)) middle.push(i);
    if (prefix.length + middle.length > 60) break;
  }
  return prefix.concat(middle).slice(0, 8);
}

/** Turn a text input into a WAI-ARIA combobox over every entry title.
 *  onChange gets the picked node index, or -1 once the text is edited.
 *  `excludeId` keeps one entry (the page you're on) out of the list. */
export function entityCombobox(
  input: HTMLInputElement, list: HTMLElement, onChange: (idx: number) => void, excludeId = '',
): void {
  let data: Adjacency | null = null;
  let results: number[] = [];
  let active = -1;

  const setActive = (i: number) => {
    active = i;
    [...list.children].forEach((o, k) => {
      o.classList.toggle('is-active', k === i);
      o.setAttribute('aria-selected', String(k === i));
    });
    const opt = list.children[i];
    if (opt) {
      input.setAttribute('aria-activedescendant', opt.id);
      opt.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };
  const close = () => {
    list.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };
  const pick = (i: number) => {
    input.value = data!.titles[i];
    onChange(i);
    close();
  };
  // The first keystroke can beat the fetch; render whenever it lands, if still focused.
  const open = () => loadAdjacency().then((d) => {
    if (document.activeElement !== input) return;
    data = d;
    results = suggest(d.titles, input.value, excludeId ? d.ids.indexOf(excludeId) : -1);
    list.replaceChildren(...results.map((i, k) => {
      const type = d.types[i];
      const li = el('li', `path-suggest-item type-${type}`);
      li.id = `${list.id}-opt-${k}`;
      li.setAttribute('role', 'option');
      li.append(el('span', 'ps-type', TYPE_LABELS[type] || type), el('span', 'ps-title', d.titles[i]));
      // mousedown, not click: click lands after the input's blur has closed the list.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      return li;
    }));
    list.classList.toggle('open', results.length > 0);
    input.setAttribute('aria-expanded', String(results.length > 0));
    setActive(-1);
  }, () => {});

  input.addEventListener('input', () => { onChange(-1); open(); });
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    const isOpen = list.classList.contains('open');
    const n = results.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!isOpen) { if (e.key === 'ArrowDown' && input.value) open(); return; }
      e.preventDefault();
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter' && isOpen) {
      e.preventDefault();
      pick(results[Math.max(active, 0)]);
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    }
  });
}
