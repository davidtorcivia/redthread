// Family trees and institution lineages, drawn from data/lineage.json (build/lineage.py).
// One tooltip serves the page: hover with a mouse; on touch, a tap opens it as a sheet with
// a link to the entry, and a second tap on the same element follows the link.
import { entityHref } from './entity-types';

export interface Ref { title: string; id?: string; type?: string }
export interface Person extends Ref { key: string; born: number | null; died: number | null; summary: string | null; notes: string[] }
export interface KinEdge { a: string; b: string; cls: 'parent' | 'gp' | 'sib' | 'spouse'; verified: boolean; start: string | null }
export interface Family {
  id: string; name: string; anchor: string; people: Person[]; edges: KinEdge[];
  others: { a: string; b: string; role: string | null }[]; familyEntries: Ref[];
}
export interface Span { type: string; start: number; end: number | null; role: string | null }
export interface LineageEvent extends Ref { start: number; end: number | null; how: string[]; rank: number; summary: string | null; role: string | null }
export interface Lineage extends Ref {
  id: string; type: string; summary: string | null;
  origins: (Ref & { label: string; years: number[]; summary: string | null; role: string | null })[];
  rows: (Ref & { family: boolean; summary: string | null; spans: Span[] })[];
  later: (Ref & { first: number; summary: string | null;
    roles: (Ref & { label: string; start: number | null; end: number | null; role: string | null; summary: string | null })[];
    kin: (Ref & { roles: { label: string; title: string; start: number | null; end: number | null }[] })[] })[];
  shared: (Ref & { via: string[] })[];
  events: LineageEvent[];
}
export interface LineageData { families: Family[]; lineages: Lineage[] }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const range = (a: number | null, b: number | null) => (a ? (b && b !== a ? `${a}–${b}` : `${a}`) : '');
const hrefOf = (r: Ref) => (r.id && r.type ? esc(entityHref(r.type, r.id)) : '');
const link = (r: Ref, cls = '') => (hrefOf(r) ? `<a href="${hrefOf(r)}"${cls ? ` class="${cls}"` : ''}>${esc(r.title)}</a>` : `<span class="lv-nopage ${cls}">${esc(r.title)}</span>`);

// ---------- tooltip ----------

interface Tip { kicker?: string; title: string; meta?: string; body?: string | null; list?: string[]; quote?: string | null; color?: string; href?: string }
const TIPS: Tip[] = [];
function tip(t: Tip): string {
  TIPS.push(t);
  return `data-tip="${TIPS.length - 1}" tabindex="0"`;
}

let tipEl: HTMLDivElement;
let tipOn: Element | null = null;
let sheet = false;
let lastPointer = 'mouse';

function tipHTML(t: Tip): string {
  return (t.kicker ? `<div class="tk">${esc(t.kicker)}</div>` : '') + `<div class="tt">${esc(t.title)}</div>` +
    (t.meta ? `<div class="tm">${esc(t.meta)}</div>` : '') +
    (t.body ? `<div class="tb">${esc(t.body)}</div>` : '') +
    (t.list?.length ? `<ul>${t.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '') +
    (t.quote ? `<div class="tq">${esc(t.quote)}</div>` : '') +
    (sheet && t.href ? `<a class="tl" href="${t.href}">Open entry <span aria-hidden="true">→</span></a>` : '') +
    (sheet ? '<button class="tx" type="button" aria-label="Close">×</button>' : '');
}
function place(x: number, y: number) {
  if (sheet) return;
  const r = tipEl.getBoundingClientRect(), pad = 16;
  let left = x + 16, top = y + 18;
  if (left + r.width > innerWidth - pad) left = Math.max(pad, x - r.width - 16);
  if (top + r.height > innerHeight - pad) top = Math.max(pad, y - r.height - 14);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
function openTip(el: Element, x?: number, y?: number) {
  const t = TIPS[Number((el as HTMLElement).dataset.tip)];
  if (!t) return;
  tipOn = el;
  sheet = lastPointer === 'touch' || lastPointer === 'pen';
  tipEl.classList.toggle('lv-sheet', sheet);
  tipEl.innerHTML = tipHTML(t);
  tipEl.style.setProperty('--tip-c', t.color || 'var(--ink)');
  tipEl.hidden = false;
  if (x == null || y == null) { const b = el.getBoundingClientRect(); x = b.left + b.width / 2; y = b.bottom - 8; }
  place(x, y);
  el.dispatchEvent(new CustomEvent('lv-open', { bubbles: true }));
}
function closeTip() {
  if (!tipOn) return;
  const el = tipOn;
  tipOn = null;
  tipEl.hidden = true;
  el.dispatchEvent(new CustomEvent('lv-close', { bubbles: true }));
}
function initTips() {
  tipEl = document.createElement('div');
  tipEl.className = 'lv-tip';
  tipEl.hidden = true;
  tipEl.setAttribute('role', 'tooltip');
  document.body.append(tipEl);
  const target = (e: Event) => (e.target as Element).closest?.('[data-tip]') ?? null;
  document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = target(e);
    if (el && el !== tipOn) openTip(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', (e) => { if (tipOn && e.pointerType === 'mouse') place(e.clientX, e.clientY); });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'mouse' && tipOn && !tipOn.contains(e.relatedTarget as Node)) closeTip();
  });
  // Touch: the first tap on an element opens its sheet; a second tap on it follows its link.
  document.addEventListener('click', (e) => {
    if (lastPointer !== 'touch' && lastPointer !== 'pen') return;
    if (tipEl.contains(e.target as Node)) {
      if ((e.target as Element).closest('.tx')) closeTip();
      return;
    }
    const el = target(e);
    if (!el) return closeTip();
    if (el !== tipOn) {
      e.preventDefault();
      openTip(el);
    }
  }, true);
  document.addEventListener('focusin', (e) => {
    if (lastPointer !== 'keyboard') return;
    const el = target(e);
    if (el) openTip(el); else closeTip();
  });
  document.addEventListener('keydown', (e) => {
    lastPointer = 'keyboard';
    if (e.key === 'Escape') closeTip();
  });
  addEventListener('scroll', () => { if (!sheet) closeTip(); }, { passive: true, capture: true });
}

// ---------- family tree ----------

const W = 176;
function wrap(text: string, n: number): string[] {
  const lines = [''];
  for (const w of text.split(' ')) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length > n && cur) lines.push(w);
    else lines[lines.length - 1] = (cur + ' ' + w).trim();
  }
  return lines.slice(0, 2);
}
function years(p: Person): string {
  if (p.born && p.died) return `${p.born}–${p.died}`;
  if (p.born) return `b. ${p.born}`;
  return p.died ? `d. ${p.died}` : '';
}
const surname = (t: string) => t.replace(/\s+(Jr\.|Sr\.|II|III|IV)$/, '').split(' ').at(-1)!;

function kinLine(f: Family, key: string, byKey: Map<string, Person>): string {
  const name = (x: string) => byKey.get(x)?.title;
  const ps = f.edges.filter((e) => e.cls === 'parent' && e.b === key).map((e) => name(e.a));
  const sp = f.edges.filter((e) => e.cls === 'spouse' && (e.a === key || e.b === key))
    .map((e) => name(e.a === key ? e.b : e.a) + (e.start ? ` (${e.start.slice(0, 4)})` : ''));
  return [ps.length ? `child of ${ps.join(' and ')}` : '', sp.length ? `married ${sp.join(', ')}` : ''].filter(Boolean).join(' · ');
}

interface NodeLabel { width: number; height: number; x: number; y: number; knot?: boolean; unknown?: boolean; label?: string; pair?: string[] }
interface EdgeLabel { minlen: number; kind: 'couple' | 'child' | 'grand'; guess?: boolean }

async function drawTree(f: Family, svg: SVGSVGElement): Promise<{ width: number; height: number; anchor: { x: number; y: number } }> {
  const { graphlib, layout } = await import('@dagrejs/dagre');
  const sn = [...new Set(f.people.map((p) => surname(p.title)))];
  const colorOf = (p: Person) => `var(--lv-s${sn.indexOf(surname(p.title)) % 6})`;
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 30, marginx: 28, marginy: 28 });
  g.setDefaultEdgeLabel(() => ({}));
  const byKey = new Map(f.people.map((p) => [p.key, p]));
  const lines = new Map<string, string[]>();
  for (const p of f.people) {
    lines.set(p.key, wrap(p.title, 22));
    g.setNode(p.key, { width: W, height: 22 + lines.get(p.key)!.length * 16 + (years(p) ? 14 : 0) + (p.notes.length ? 14 : 0) });
  }
  // A couple meets at a knot one rank down; their children hang from it.
  const knots = new Map<string, string>();
  const coupleKey = (a: string, b: string) => [a, b].sort().join('|');
  for (const e of f.edges.filter((e) => e.cls === 'spouse')) {
    const k = 'k:' + coupleKey(e.a, e.b);
    knots.set(coupleKey(e.a, e.b), k);
    g.setNode(k, { width: 10, height: 10, knot: true, label: e.start ? e.start.slice(0, 4) : '', pair: [e.a, e.b] });
    g.setEdge(e.a, k, { minlen: 1, kind: 'couple' });
    g.setEdge(e.b, k, { minlen: 1, kind: 'couple' });
  }
  const parents = new Map<string, KinEdge[]>();
  for (const e of f.edges.filter((e) => e.cls === 'parent')) parents.set(e.b, [...(parents.get(e.b) ?? []), e]);
  // Siblings share parents: group them, and hang a group with no recorded parent from an open knot.
  const root = new Map(f.people.map((p) => [p.key, p.key]));
  const find = (x: string): string => (root.get(x) === x ? x : (root.set(x, find(root.get(x)!)), root.get(x)!));
  for (const e of f.edges.filter((e) => e.cls === 'sib')) root.set(find(e.a), find(e.b));
  const groups = new Map<string, string[]>();
  for (const p of f.people) groups.set(find(p.key), [...(groups.get(find(p.key)) ?? []), p.key]);
  for (const members of groups.values()) {
    const shared = [...new Set(members.flatMap((m) => (parents.get(m) ?? []).map((e) => e.a)))];
    for (const m of members) {
      const own = parents.get(m) ?? [];
      // A sibling without a recorded parent takes the group's parents, drawn as a guess.
      const ps = own.length ? own.map((e) => e.a) : shared;
      const guess = own.length ? own.some((e) => !e.verified) : true;
      if (ps.length >= 2 && knots.has(coupleKey(ps[0], ps[1]))) {
        g.setEdge(knots.get(coupleKey(ps[0], ps[1]))!, m, { minlen: 1, kind: 'child', guess });
      } else if (ps.length) {
        for (const pa of ps) g.setEdge(pa, m, { minlen: 2, kind: 'child', guess });
      } else if (members.length > 1) {
        const k = 'u:' + members[0];
        if (!g.hasNode(k)) g.setNode(k, { width: 10, height: 10, knot: true, unknown: true });
        g.setEdge(k, m, { minlen: 1, kind: 'child' });
      }
    }
  }
  for (const e of f.edges.filter((e) => e.cls === 'gp')) g.setEdge(e.a, e.b, { minlen: 4, kind: 'grand', guess: !e.verified });
  layout(g);

  const node = (id: string) => g.node(id) as unknown as NodeLabel;
  const box = (id: string) => { const n = node(id); return { x: n.x, y: n.y, top: n.y - n.height / 2, bot: n.y + n.height / 2 }; };
  const who = (id: string) => (id.startsWith('k:') ? node(id).pair!.map((x) => byKey.get(x)!.title).join(' and ')
    : id.startsWith('u:') ? 'unrecorded parents' : byKey.get(id)!.title);
  // Orthogonal elbow with rounded corners, from a bottom to a top.
  const elbow = (x1: number, y1: number, x2: number, y2: number) => {
    const my = Math.round(y2 - Math.min(18, (y2 - y1) / 2)), r = Math.min(6, Math.abs(x2 - x1) / 2), dx = Math.sign(x2 - x1);
    if (!dx) return `M${x1},${y1}V${y2}`;
    return `M${x1},${y1}V${my - r}Q${x1},${my} ${x1 + dx * r},${my}H${x2 - dx * r}Q${x2},${my} ${x2},${my + r}V${y2}`;
  };
  let s = '', hits = '';
  for (const ed of g.edges()) {
    const e = g.edge(ed) as unknown as EdgeLabel, a = box(ed.v), b = box(ed.w);
    const cls = ['lv-edge', e.kind === 'couple' && 'couple', e.guess && 'guess', e.kind === 'grand' && 'grand'].filter(Boolean).join(' ');
    // Spouse down to the knot with a square corner, like a pedigree bracket.
    const d = e.kind === 'couple' ? `M${a.x},${a.bot}V${b.y}H${b.x}` : elbow(a.x, node(ed.v).knot ? a.y : a.bot, b.x, b.top);
    const ends = `data-v="${esc(ed.v)}" data-w="${esc(ed.w)}"`;
    s += `<path class="${cls}" ${ends} d="${d}"/>`;
    const t: Tip = e.kind === 'couple'
      ? { kicker: 'Marriage', title: who(ed.w), meta: node(ed.w).label ? `married ${node(ed.w).label}` : 'date not recorded' }
      : { kicker: e.kind === 'grand' ? 'Grandparent and grandchild' : 'Parent and child', title: `${who(ed.v)} → ${who(ed.w)}`,
          meta: e.guess ? 'Direction read from the role text; no birth years to check it' : 'Direction confirmed by birth years' };
    hits += `<path class="lv-hit" ${ends} d="${d}" ${tip(t)}/>`;
  }
  s += hits;
  for (const id of g.nodes()) {
    const n = node(id);
    if (n.knot) {
      const t = n.unknown
        ? tip({ kicker: 'Siblings', title: 'Parents not recorded', body: 'These people are recorded as siblings, but no parent is named for any of them.' })
        : tip({ kicker: 'Marriage', title: who(id), meta: n.label ? `married ${n.label}` : 'date not recorded' });
      s += `<circle class="lv-knot${n.unknown ? ' unknown' : ''}" data-id="${esc(id)}" cx="${n.x}" cy="${n.y}" r="${n.unknown ? 5 : 4.5}"/>`;
      s += `<circle class="lv-knot-hit" cx="${n.x}" cy="${n.y}" r="12" ${t}/>`;
      if (n.label) s += `<text class="lv-knot-l" x="${n.x + 9}" y="${n.y - 5}">m. ${n.label}</text>`;
      continue;
    }
    const p = byKey.get(id)!, x = n.x - W / 2, y = n.y - n.height / 2, href = hrefOf(p);
    const t = tip({ kicker: href ? 'Person' : 'Person · no entry yet', title: p.title, href,
      meta: [years(p), kinLine(f, p.key, byKey)].filter(Boolean).join(' · '), body: p.summary, list: p.notes,
      color: href ? colorOf(p) : 'var(--line-2)' });
    s += `${href ? `<a href="${href}" class="lv-card" data-id="${esc(id)}" ${t}>` : `<g class="lv-card nopage" data-id="${esc(id)}" ${t}>`}`;
    s += `<rect class="bg" x="${x}" y="${y}" width="${W}" height="${n.height}"/>`;
    if (href) s += `<rect x="${x}" y="${y}" width="${W}" height="3" style="fill:${colorOf(p)}"/>`;
    let ty = y + 21;
    for (const l of lines.get(id)!) { s += `<text class="nm" x="${x + 11}" y="${ty}">${esc(l)}</text>`; ty += 16; }
    if (years(p)) { s += `<text class="yr" x="${x + 11}" y="${ty}">${years(p)}</text>`; ty += 14; }
    if (p.notes.length) s += `<text class="nt" x="${x + 11}" y="${ty}">${esc(clip(p.notes[0], 32))}</text>`;
    s += href ? '</a>' : '</g>';
  }
  const gw = g.graph().width ?? 0, gh = g.graph().height ?? 0;
  svg.setAttribute('viewBox', `0 0 ${gw} ${gh}`);
  svg.innerHTML = s;
  const an = node(f.anchor) ?? { x: gw / 2, y: 0 };
  return { width: gw, height: gh, anchor: { x: an.x, y: an.y } };
}

// Light a set of lines and the cards and knots at their ends; fade the rest.
function light(svg: SVGSVGElement, on: Set<Element>, lit: Set<string>) {
  svg.classList.add('lit');
  svg.querySelectorAll('path.lv-edge').forEach((p) => p.classList.toggle('hl', on.has(p)));
  svg.querySelectorAll('[data-id]').forEach((n) => n.classList.toggle('hl', lit.has((n as SVGElement).dataset.id!)));
}
function lightPerson(svg: SVGSVGElement, id: string) {
  const paths = [...svg.querySelectorAll<SVGPathElement>('path.lv-edge')];
  const touch = (n: string) => paths.filter((p) => p.dataset.v === n || p.dataset.w === n);
  const on = new Set<Element>(), lit = new Set([id]);
  for (const p of touch(id)) {
    on.add(p);
    const other = p.dataset.v === id ? p.dataset.w! : p.dataset.v!;
    lit.add(other);
    // Through a marriage knot: the spouse and the children.
    if (/^[ku]:/.test(other)) for (const q of touch(other)) { on.add(q); lit.add(q.dataset.v!); lit.add(q.dataset.w!); }
  }
  light(svg, on, lit);
}
function lightLine(svg: SVGSVGElement, v: string, w: string) {
  const paths = [...svg.querySelectorAll<SVGPathElement>('path.lv-edge')];
  const on = new Set<Element>(paths.filter((p) => p.dataset.v === v && p.dataset.w === w)), lit = new Set([v, w]);
  for (const k of [v, w].filter((n) => n.startsWith('k:'))) {
    for (const q of paths.filter((p) => p.dataset.w === k && p.classList.contains('couple'))) { on.add(q); lit.add(q.dataset.v!); }
  }
  light(svg, on, lit);
}
function lightsOff(svg: SVGSVGElement) {
  svg.classList.remove('lit');
  svg.querySelectorAll('.hl').forEach((n) => n.classList.remove('hl'));
}

export async function renderFamily(root: HTMLElement, f: Family) {
  initTips();
  const canvas = root.querySelector<HTMLElement>('.lv-canvas')!;
  const svg = root.querySelector<SVGSVGElement>('.lv-tree')!;
  const size = await drawTree(f, svg);
  let scale = 1;
  const fit = () => Math.min(1, (canvas.clientWidth - 2) / size.width);
  const apply = (z: number, keepCenter = true) => {
    const cx = (canvas.scrollLeft + canvas.clientWidth / 2) / scale, cy = (canvas.scrollTop + canvas.clientHeight / 2) / scale;
    scale = Math.max(0.3, Math.min(1.6, z));
    svg.setAttribute('width', String(Math.round(size.width * scale)));
    svg.setAttribute('height', String(Math.round(size.height * scale)));
    if (keepCenter) {
      canvas.scrollLeft = cx * scale - canvas.clientWidth / 2;
      canvas.scrollTop = cy * scale - canvas.clientHeight / 2;
    }
  };
  // Phones open a little smaller than full size, centred on the best-known member.
  apply(Math.max(fit(), matchMedia('(max-width: 640px)').matches ? 0.8 : 1), false);
  canvas.scrollLeft = size.anchor.x * scale - canvas.clientWidth / 2;
  canvas.scrollTop = Math.max(0, size.anchor.y * scale - canvas.clientHeight / 3);
  root.querySelector('[data-zoom="in"]')?.addEventListener('click', () => apply(scale * 1.25));
  root.querySelector('[data-zoom="out"]')?.addEventListener('click', () => apply(scale / 1.25));
  root.querySelector('[data-zoom="fit"]')?.addEventListener('click', () => apply(fit()));

  const at = (e: Event) => (e.target as Element).closest?.('.lv-card[data-id], path.lv-hit') ?? null;
  const on = (el: Element) => (el.matches('path.lv-hit')
    ? lightLine(svg, (el as SVGElement).dataset.v!, (el as SVGElement).dataset.w!)
    : lightPerson(svg, (el as SVGElement).dataset.id!));
  svg.addEventListener('lv-open', (e) => { const el = at(e); if (el) on(el); });
  svg.addEventListener('lv-close', () => lightsOff(svg));
}

// ---------- lineage ----------

const KIND: Record<string, string> = { employed_by: 'Employed', head_of: 'Headed', director_of: 'Director', member_of: 'Member', partner_of: 'Partner' };
const FILL: Record<string, string> = { head_of: 'var(--accent)', director_of: 'var(--ink)', partner_of: 'var(--lv-s0)' };

function drawGantt(l: Lineage, names: SVGSVGElement, chart: SVGSVGElement) {
  const rows = l.rows, now = new Date().getFullYear(), narrow = matchMedia('(max-width: 640px)').matches;
  const lo = Math.min(...rows.flatMap((r) => r.spans.map((s) => s.start)));
  const hi = Math.max(...rows.flatMap((r) => r.spans.map((s) => s.end ?? s.start + 1)));
  const x0 = Math.floor(lo / 10) * 10, x1 = Math.min(now, Math.ceil((hi + 1) / 10) * 10);
  const L = narrow ? 128 : 200, Wd = Math.max(narrow ? 560 : 640, Math.min(980, (x1 - x0) * 12)), rowH = narrow ? 22 : 18;
  const X = (y: number) => 8 + (y - x0) / (x1 - x0) * (Wd - 24);
  // Each event gets a lane: its bar, or a diamond for one date, plus its label, clear of the others.
  const evs = l.events.filter((e) => e.start >= x0 && e.start <= x1).sort((a, b) => a.start - b.start);
  const lanes: number[] = [], LANE = 17, labelW = (e: LineageEvent) => e.title.length * 6.3 + 8;
  const placed = evs.map((e) => {
    const xa = X(e.start), xb = e.end ? X(e.end + 1) : xa, left = xb + 6 + labelW(e) > Wd - 4;
    const from = left ? xa - 6 - labelW(e) : xa - 6, to = left ? xb + 6 : xb + 6 + labelW(e);
    let k = lanes.findIndex((end) => end < from);
    if (k < 0) { lanes.push(0); k = lanes.length - 1; }
    lanes[k] = to;
    return { e, xa, xb, left, lane: k };
  });
  const evTop = 6, top = evs.length ? evTop + lanes.length * LANE + 12 : 10, bottom = top + rows.length * rowH, H = bottom + 26;

  let s = `<defs>
    <linearGradient id="lv-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.2"/><stop offset=".6" style="stop-color:var(--accent);stop-opacity:.06"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient>
    <linearGradient id="lv-fade-m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--muted);stop-opacity:.18"/><stop offset="1" style="stop-color:var(--muted);stop-opacity:0"/></linearGradient>
  </defs>`;
  const step = x1 - x0 > 80 ? 20 : 10;
  for (let y = x0; y <= x1; y += step) s += `<line class="grid" x1="${X(y)}" x2="${X(y)}" y1="${top}" y2="${bottom}"/><text class="m" x="${X(y)}" y="${H - 6}" text-anchor="middle">${y}</text>`;
  if (evs.length) s += `<line class="evsep" x1="0" x2="${Wd}" y1="${top - 6}" y2="${top - 6}"/>`;
  for (const { e, xa, xb, left, lane } of placed) {
    const cy = evTop + lane * LANE + 8;
    s += `<g class="ev r${e.rank}" ${tip({ kicker: 'Event', title: e.title, meta: range(e.start, e.end), body: e.summary, list: e.how, quote: e.role, color: 'var(--accent)', href: hrefOf(e) })}>`;
    // The event's span runs down through every row, fading as it goes.
    if (e.end) s += `<rect class="evwash" x="${xa}" y="${top - 6}" width="${Math.max(2, xb - xa)}" height="${bottom - top + 6}" fill="url(#lv-fade${e.rank === 2 ? '-m' : ''})"/>`;
    for (const x of e.end ? [xa, xb] : [xa]) s += `<line class="evedge" x1="${x}" x2="${x}" y1="${cy + 6}" y2="${bottom}"/>`;
    s += e.end ? `<rect class="evbar" x="${xa}" y="${cy - 4}" width="${Math.max(3, xb - xa)}" height="8"/>`
      : `<path class="evbar" d="M${xa},${cy - 5}L${xa + 5},${cy}L${xa},${cy + 5}L${xa - 5},${cy}Z"/>`;
    s += left ? `<text class="evl" x="${xa - 8}" y="${cy + 4}" text-anchor="end">${esc(e.title)}</text>`
      : `<text class="evl" x="${xb + 8}" y="${cy + 4}">${esc(e.title)}</text>`;
    s += `<rect class="evhit" x="${left ? xa - 8 - labelW(e) : xa - 6}" y="${cy - 9}" width="${xb - xa + labelW(e) + 14}" height="18"/></g>`;
  }
  let n = evs.length ? `<text class="m" x="${L - 8}" y="${evTop + 12}" text-anchor="end">Events</text>` : '';
  rows.forEach((r, k) => {
    const y = top + k * rowH, mid = y + rowH / 2;
    const all = r.spans.map((sp) => `${KIND[sp.type]} ${range(sp.start, sp.end)}`);
    const href = hrefOf(r);
    const label = `<text x="${L - 8}" y="${mid + 4}" text-anchor="end" class="${href ? '' : 'm'}${r.family ? ' fam' : ''}">${esc(clip(r.title, narrow ? 19 : 30))}</text>`;
    const t = tip({ kicker: r.family ? 'Family' : href ? 'Person' : 'Person · no entry yet', title: r.title, body: r.summary, list: all, href });
    n += href ? `<a href="${href}" ${t}>${label}</a>` : `<g ${t}>${label}</g>`;
    for (const sp of r.spans) {
      const w = Math.max(4, X(sp.end ?? sp.start + 1) - X(sp.start));
      s += `<rect class="bar${sp.end ? '' : ' open'}" x="${X(sp.start)}" y="${mid - 5}" width="${w}" height="10" style="fill:${FILL[sp.type] || 'var(--line-2)'}" ${tip({
        kicker: `${KIND[sp.type]} · ${l.title}`, title: r.title, meta: sp.end ? range(sp.start, sp.end) : `from ${sp.start}, end not recorded`,
        quote: sp.role, color: FILL[sp.type] || 'var(--line-2)', href })}/>`;
    }
  });
  for (const [el, w, body] of [[names, L, n], [chart, Wd, s]] as const) {
    el.setAttribute('viewBox', `0 0 ${w} ${H}`);
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(H));
    el.innerHTML = body;
  }
}

export function renderLineage(root: HTMLElement, l: Lineage) {
  initTips();
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  q<HTMLElement>('.lv-origins').innerHTML = l.origins.length ? l.origins.map((a) =>
    `<div class="lv-node" ${tip({ kicker: a.label, title: a.title, meta: a.years.join(' / '), body: a.summary, quote: a.role, href: hrefOf(a) })}>` +
    `<div class="k">${esc(a.label)}</div><div class="n">${link(a)}</div>` +
    `<div class="v">${a.years.length > 1 ? `<b>sources give ${a.years.join(' and ')}</b>` : a.years.join('')}</div></div>`).join('')
    : '<p class="lv-empty">No founders, funders or mergers recorded.</p>';
  const redraw = () => drawGantt(l, q('.lv-names'), q('.lv-chart'));
  redraw();
  matchMedia('(max-width: 640px)').addEventListener('change', redraw);
  q<HTMLElement>('.lv-later').innerHTML = l.later.length ? l.later.map((p) =>
    `<div><div class="who" ${tip({ kicker: `Joined ${l.title} ${p.first}`, title: p.title, body: p.summary, href: hrefOf(p) })}>${link(p)} <span>from ${p.first}</span></div><ul>` +
    p.roles.map((r) => `<li ${tip({ kicker: r.label, title: r.title, meta: `${p.title} · ${range(r.start, r.end)}`, body: r.summary, quote: r.role, href: hrefOf(r) })}>` +
      `${esc(r.label)} ${link(r)}${r.start ? ', ' + range(r.start, r.end) : ''}</li>`).join('') +
    p.kin.map((k) => `<li class="kin" ${tip({ kicker: `Relative of ${p.title}`, title: k.title, href: hrefOf(k),
      list: k.roles.map((r) => `${r.label} ${r.title}${r.start ? ' ' + range(r.start, r.end) : ''}`) })}>via ${link(k)}` +
      `: ${k.roles.map((r) => `${esc(r.label.toLowerCase())} ${esc(r.title)}${r.start ? ' ' + r.start : ''}`).join('; ')}</li>`).join('') +
    '</ul></div>').join('') : '<p class="lv-empty">No later roles recorded.</p>';
  q<HTMLElement>('.lv-shared').innerHTML = l.shared.length ? l.shared.map((x) =>
    `<div ${tip({ kicker: `Reached from ${l.title}`, title: x.title, meta: `${new Set(x.via.map((w) => w.split(' via ')[0])).size} members`, list: x.via, color: 'var(--accent)', href: hrefOf(x) })}>` +
    `<b>${link(x)}</b><span>${x.via.map(esc).join(' · ')}</span></div>`).join('')
    : '<p class="lv-empty">No place is reached by more than one member.</p>';
}
