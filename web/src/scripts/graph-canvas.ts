/**
 * Canvas network engine shared by the entity page's Local network
 * (components/NetworkGraph.astro) and the full graph (pages/network.astro).
 * It owns drawing, hit-testing, pan/zoom/touch, selection, tooltips, search
 * and the generic controls, all found by class inside the root element.
 *
 * The caller owns the data, the layouts and any view-specific controls. It
 * installs a graph with setGraph() and mutates node x/y/visible directly.
 */
import type { Adjacency } from './adjacency';
import { TYPE_LABELS, entityHref, el } from './entity-types';

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  count: number;
  bridgeRank: number;
  hubRank: number;
  community: number;
  x: number;
  y: number;
  size: number;
  visible: boolean;
  color?: string;
  isFocal?: boolean;
  hop?: number;
  isLandmark?: boolean;
  isolated?: boolean;
}

export type Edge = [number, number];

export interface Layout {
  key: string;
  label: string;
  apply: (g: GraphEngine) => void;
}

export interface EngineOptions {
  /** 'entity' is a small local graph; 'full' is the whole vault. */
  profile: 'entity' | 'full';
  layouts: Layout[];
  /** Draw inferred (name-mention) edges from the start. */
  showImplicit: boolean;
  /** Element that gets the .fullscreen class. Defaults to root. */
  fullscreenEl?: HTMLElement;
}

// The full graph has thousands of nodes: smaller dots, fainter edges, and
// labels only for landmarks or nodes big enough on screen.
const PROFILES = {
  entity: { zoomMax: 20, fitPad: 30, minR: 3, maxR: 12, edgeAlpha: .4, labelAll: true, searchZoom: 1.1 },
  full: { zoomMax: 50, fitPad: 40, minR: 1.7, maxR: 9, edgeAlpha: .25, labelAll: false, searchZoom: .8 },
};

function readColors(scope: Element): Record<string, string> {
  const cs = getComputedStyle(scope);
  const get = (v: string, f: string) => (cs.getPropertyValue(v).trim() || f);
  return {
    person: get('--t-person', '#8a5a1f'),
    organization: get('--t-organization', '#2d6864'),
    program: get('--t-program', '#3f3d8b'),
    event: get('--t-event', '#94322a'),
    concept: get('--t-concept', '#5e6b32'),
    place: get('--t-place', '#735237'),
    source: get('--t-source', '#6a6258'),
    muted: get('--muted', '#6a6258'),
    line: get('--line-2', '#c8bca0'),
    accent: get('--accent', '#94322a'),
    ink: get('--ink', '#1a1814'),
    paper: get('--graph-paper', '#fafaf8'),
    gold: get('--gold', '#8a6e25'),
  };
}

/** Golden-angle hue spacing keeps any number of clusters distinct. */
function communityColor(c: number, dark: boolean): string {
  return `hsl(${Math.round((c * 137.508) % 360)}, ${dark ? 52 : 46}%, ${dark ? 65 : 40}%)`;
}

function hexToRgba(hex: string, a: number): string {
  if (hex.startsWith('rgb') || hex.startsWith('hsl')) return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const hrefFor = (n: GraphNode) => entityHref(n.type, n.id);

export class GraphEngine {
  root: HTMLElement;
  shell: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tooltip: HTMLElement;
  panel: HTMLElement;
  COLORS: Record<string, string>;
  P: (typeof PROFILES)['entity'];
  opts: EngineOptions;

  nodes: GraphNode[] = [];
  edges: Edge[] = [];
  neighborSets: Set<number>[] = [];
  implicitEdgeIdx: Set<number> = new Set();
  view = { tx: 0, ty: 0, scale: 1 };
  selectedNodes = new Set<number>();
  selectedEdges = new Set<number>();
  focusNodes: Set<number> | null = null;
  hoveredIdx = -1;
  hoveredEdge = -1;
  multiMode = false;
  edgesVisible = true;
  showImplicit: boolean;
  colorMode: 'type' | 'community' = 'type';
  /** Indexed by community id. */
  communityLabels: string[] = [];
  opacityMult = 1;
  highlightStrength = 1;
  forceMult = 1;
  currentLayout: string;
  private layoutIdx = 0;
  private dpr = 1;
  private drawScheduled = false;

  constructor(root: HTMLElement, opts: EngineOptions) {
    this.root = root;
    this.opts = opts;
    this.P = PROFILES[opts.profile];
    this.shell = root.querySelector('.net-shell') as HTMLElement;
    this.canvas = root.querySelector('.net-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.tooltip = root.querySelector('.net-tooltip') as HTMLElement;
    this.panel = root.querySelector('.net-selection') as HTMLElement;
    this.COLORS = readColors(root);
    this.showImplicit = opts.showImplicit;
    this.currentLayout = opts.layouts[0].key;
    window.addEventListener('themechange', () => {
      this.COLORS = readColors(root);
      this.recolor();
      this.requestDraw();
    });
    window.addEventListener('resize', () => { if (this.nodes.length) this.resize(); });
  }

  // --- Data ---------------------------------------------------------------
  /** Edges are index pairs into `nodes`; `implicit` holds the indices of
   *  edges with no wikilink behind them. */
  setGraph(nodes: GraphNode[], edges: Edge[], implicit: Set<number>): void {
    this.nodes = nodes;
    this.edges = edges;
    this.implicitEdgeIdx = implicit;
    this.neighborSets = Array.from({ length: nodes.length }, () => new Set<number>());
    for (const [a, b] of edges) {
      this.neighborSets[a].add(b);
      this.neighborSets[b].add(a);
    }
    // Indices mean nothing across graphs. Callers that keep a selection
    // snapshot selectedIds() first and restoreSelection() after.
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.hoveredIdx = -1;
    this.hoveredEdge = -1;
    this.recolor();
    this.recomputeFocus();
    this.updateStats();
  }
  private recolor(): void {
    const dark = document.documentElement.dataset.theme === 'dark';
    for (const n of this.nodes) {
      n.color = this.colorMode === 'community' && n.community >= 0
        ? communityColor(n.community, dark)
        : this.COLORS[n.type] || this.COLORS.muted;
    }
  }
  setColorMode(mode: 'type' | 'community'): void {
    this.colorMode = mode;
    this.recolor();
    this.requestDraw();
  }

  // --- Canvas -------------------------------------------------------------
  canvasSize(): { W: number; H: number } {
    return { W: this.canvas.width / this.dpr, H: this.canvas.height / this.dpr };
  }
  resize(): void {
    const rect = this.shell.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.requestDraw();
  }
  requestDraw(): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    requestAnimationFrame(() => { this.drawScheduled = false; this.draw(); });
  }
  private sx(x: number): number { return x * this.view.scale + this.view.tx; }
  private sy(y: number): number { return y * this.view.scale + this.view.ty; }

  fit(): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (!n.visible) continue;
      minX = Math.min(minX, n.x - n.size);
      maxX = Math.max(maxX, n.x + n.size);
      minY = Math.min(minY, n.y - n.size);
      maxY = Math.max(maxY, n.y + n.size);
    }
    if (minX === Infinity) return;
    const { W, H } = this.canvasSize();
    const pad = this.P.fitPad;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.view.scale = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    this.view.tx = (W - w * this.view.scale) / 2 - minX * this.view.scale;
    this.view.ty = (H - h * this.view.scale) / 2 - minY * this.view.scale;
    this.requestDraw();
  }

  /** Run the current layout, refit and redraw. */
  applyLayout(): void {
    this.opts.layouts.find((l) => l.key === this.currentLayout)!.apply(this);
    this.fit();
  }

  /** Stretch the layout around the screen centre, so pan and zoom survive. */
  private scaleLayout(ratio: number): void {
    const { W, H } = this.canvasSize();
    for (const n of this.nodes) { n.x *= ratio; n.y *= ratio; }
    this.view.tx = (W / 2) * (1 - ratio) + this.view.tx * ratio;
    this.view.ty = (H / 2) * (1 - ratio) + this.view.ty * ratio;
    this.requestDraw();
  }

  // --- Selection ----------------------------------------------------------
  private recomputeFocus(): void {
    if (this.selectedNodes.size === 0 && this.selectedEdges.size === 0) {
      this.focusNodes = null;
      return;
    }
    const f = new Set<number>();
    for (const idx of this.selectedNodes) {
      f.add(idx);
      for (const n of this.neighborSets[idx]) f.add(n);
    }
    for (const k of this.selectedEdges) { f.add(this.edges[k][0]); f.add(this.edges[k][1]); }
    this.focusNodes = f;
  }
  /** Call after any change to the selection sets or node visibility. */
  selectionChanged(): void {
    for (const idx of this.selectedNodes) {
      if (!this.nodes[idx].visible) this.selectedNodes.delete(idx);
    }
    for (const k of this.selectedEdges) {
      const [a, b] = this.edges[k];
      if (!this.nodes[a].visible || !this.nodes[b].visible) this.selectedEdges.delete(k);
    }
    this.recomputeFocus();
    this.updateSelectionPanel();
    this.updateStats();
    this.requestDraw();
  }
  private clearSelection(): void {
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.selectionChanged();
  }
  selectedIds(): string[] {
    return [...this.selectedNodes].map((i) => this.nodes[i].id);
  }
  restoreSelection(ids: string[]): void {
    const want = new Set(ids);
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.nodes.forEach((n, i) => { if (want.has(n.id)) this.selectedNodes.add(i); });
    this.selectionChanged();
  }

  // --- Drawing ------------------------------------------------------------
  private radius(n: GraphNode): number {
    const scaled = n.size * Math.sqrt(Math.max(.01, this.view.scale));
    return n.isFocal ? Math.max(9, Math.min(20, scaled)) : Math.max(this.P.minR, Math.min(this.P.maxR, scaled));
  }

  private draw(): void {
    const { nodes, edges, ctx, COLORS } = this;
    const { W, H } = this.canvasSize();
    if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, W, H);
    // A quiet dot grid, independent of the topology.
    ctx.fillStyle = hexToRgba(COLORS.line, .22);
    for (let x = 24; x < W; x += 32) for (let y = 24; y < H; y += 32) ctx.fillRect(x, y, .8, .8);
    if (!nodes.length) return;

    const hasSelection = this.selectedNodes.size > 0 || this.selectedEdges.size > 0;
    const hoverFocus = !hasSelection && this.hoveredIdx >= 0
      ? new Set([this.hoveredIdx, ...this.neighborSets[this.hoveredIdx]]) : null;
    const focus = this.focusNodes || hoverFocus;
    const points = nodes.map((n) => ({ x: this.sx(n.x), y: this.sy(n.y), r: this.radius(n) }));
    const isActive = (i: number) => this.selectedNodes.has(i) || i === this.hoveredIdx || !!nodes[i].isFocal;
    const edgeActive = (i: number) => {
      const [a, b] = edges[i];
      return this.selectedEdges.has(i) || this.selectedNodes.has(a) || this.selectedNodes.has(b) ||
        a === this.hoveredIdx || b === this.hoveredIdx || i === this.hoveredEdge;
    };

    // One path per style (idle before active, linked before inferred), bucketed
    // in a single pass: 34k edges filtered once per style was most of a frame.
    if (this.edgesVisible) {
      const anyActive = hasSelection || this.hoveredIdx >= 0 || this.hoveredEdge >= 0;
      const buckets: number[][] = [[], [], [], []];
      for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i];
        if (!nodes[a].visible || !nodes[b].visible) continue;
        const p = points[a], q = points[b];
        if ((p.x < 0 && q.x < 0) || (p.x > W && q.x > W) || (p.y < 0 && q.y < 0) || (p.y > H && q.y > H)) continue;
        const inferred = this.implicitEdgeIdx.has(i);
        if (inferred && !this.showImplicit) continue;
        buckets[(anyActive && edgeActive(i) ? 2 : 0) + (inferred ? 1 : 0)].push(i);
      }
      buckets.forEach((bucket, k) => {
        if (!bucket.length) return;
        const active = k >= 2, inferred = k % 2 === 1;
        ctx.beginPath();
        ctx.setLineDash(inferred ? [3, 5] : []);
        ctx.lineWidth = active ? 1.3 : .65;
        ctx.strokeStyle = active ? hexToRgba(COLORS.accent, .72) : hexToRgba(COLORS.line, focus ? .09 : this.P.edgeAlpha);
        for (const i of bucket) {
          const p = points[edges[i][0]], q = points[edges[i][1]];
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    const ring = (p: { x: number; y: number }, r: number) => { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); };
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], p = points[i];
      if (!n.visible || p.x + p.r < 0 || p.x - p.r > W || p.y + p.r < 0 || p.y - p.r > H) continue;
      const active = isActive(i);
      const inFocus = !focus || focus.has(i);
      // Second-hop nodes are drawn a little fainter than the first ring.
      ctx.globalAlpha = active ? 1 : (inFocus ? .88 : .13 + .27 * (1 - this.highlightStrength)) *
        this.opacityMult * (n.hop === 2 ? .62 : 1);
      if (active) {
        ctx.fillStyle = hexToRgba(COLORS.accent, .1);
        ring(p, p.r + 7);
        ctx.fill();
      }
      ctx.fillStyle = n.isFocal ? COLORS.accent : n.color || COLORS.muted;
      ring(p, p.r);
      ctx.fill();
      if (p.r > 3) {
        ctx.strokeStyle = COLORS.paper;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
      if (n.bridgeRank && inFocus && p.r > 2) {
        ctx.strokeStyle = COLORS.gold;
        ctx.lineWidth = 1;
        ring(p, p.r + 2);
        ctx.stroke();
      }
      if (active) {
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 1.5;
        ring(p, p.r + 3);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Labels, most important first; each takes the first free spot around its node.
    const candidates = nodes
      .map((n, i) => ({ n, i, p: points[i], tier: isActive(i) ? 0 : focus?.has(i) ? 1 : n.isLandmark ? 2 : 3 }))
      .filter((c) => c.n.visible && c.p.x >= 0 && c.p.x <= W && c.p.y >= 0 && c.p.y <= H &&
        (!focus || focus.has(c.i) || c.tier === 0) &&
        (c.tier < 3 || this.P.labelAll || c.p.r >= 3.3))
      .sort((a, b) => a.tier - b.tier || b.n.count - a.n.count);
    const drawn: { x: number; y: number; w: number; h: number }[] = [];
    const limit = focus ? 48 : Math.max(10, Math.min(38, Math.floor(W / 32)));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const c of candidates) {
      if (drawn.length >= limit && c.tier > 0) continue;
      const important = c.tier === 0, fontSize = important ? 14 : 12;
      ctx.font = `${important ? 700 : 500} ${fontSize}px "Archivo", sans-serif`;
      const maxWidth = Math.min(W - 32, important ? 300 : 190);
      let title = c.n.title;
      while (ctx.measureText(title).width > maxWidth && title.length > 4) title = title.slice(0, -2);
      if (title !== c.n.title) title = title.trimEnd() + '…';
      const w = ctx.measureText(title).width + 10, h = fontSize + 8;
      const { x, y, r } = c.p;
      const box = [
        { x: x + r + 7, y: y - h / 2 },
        { x: x - r - 7 - w, y: y - h / 2 },
        { x: x - w / 2, y: y + r + 6 },
        { x: x - w / 2, y: y - r - 6 - h },
      ]
        .map((o) => ({ x: Math.max(8, Math.min(W - w - 8, o.x)), y: Math.max(8, Math.min(H - h - 8, o.y)), w, h }))
        .find((b) => !drawn.some((d) => b.x < d.x + d.w + 5 && b.x + b.w + 5 > d.x && b.y < d.y + d.h + 3 && b.y + b.h + 3 > d.y));
      if (!box) continue;
      ctx.globalAlpha = important ? 1 : this.opacityMult;
      ctx.fillStyle = hexToRgba(COLORS.paper, .94);
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = important ? COLORS.accent : COLORS.ink;
      ctx.fillText(title, box.x + 5, box.y + 4);
      ctx.globalAlpha = 1;
      drawn.push(box);
    }
  }

  // --- Hit-testing ----------------------------------------------------------
  private hitTest(px: number, py: number): number {
    let best = -1, bestR = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (!n.visible) continue;
      const r = Math.max(7, this.radius(n));
      const dx = this.sx(n.x) - px, dy = this.sy(n.y) - py;
      if (dx * dx + dy * dy <= r * r && r > bestR) { best = i; bestR = r; }
    }
    return best;
  }
  private edgeHitTest(px: number, py: number): number {
    if (!this.edgesVisible) return -1;
    const { W, H } = this.canvasSize();
    let best = -1, bestD = 5;
    for (let k = 0; k < this.edges.length; k++) {
      if (!this.showImplicit && this.implicitEdgeIdx.has(k)) continue;
      const a = this.nodes[this.edges[k][0]], b = this.nodes[this.edges[k][1]];
      if (!a.visible || !b.visible) continue;
      const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
      if ((ax < -10 && bx < -10) || (ax > W + 10 && bx > W + 10) ||
          (ay < -10 && by < -10) || (ay > H + 10 && by > H + 10)) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  private updateStats(): void {
    const stats = this.root.querySelector('.net-stats');
    if (!stats) return;
    const count = this.nodes.filter((n) => n.visible).length;
    const links = this.edges.filter(([a, b], i) =>
      this.nodes[a].visible && this.nodes[b].visible && (this.showImplicit || !this.implicitEdgeIdx.has(i))).length;
    stats.textContent = `${count.toLocaleString()} entries · ${links.toLocaleString()} connections`;
  }

  private wireSearch(): void {
    const input = this.root.querySelector<HTMLInputElement>('.net-search');
    const list = this.root.querySelector<HTMLElement>('.net-search-results');
    if (!input || !list) return;
    let matches: number[] = [], active = -1;
    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const select = (index: number) => {
      const n = this.nodes[index];
      this.selectedNodes.clear();
      this.selectedEdges.clear();
      this.selectedNodes.add(index);
      this.selectionChanged();
      const { W, H } = this.canvasSize();
      this.view.scale = Math.max(this.view.scale, this.P.searchZoom);
      this.view.tx = W / 2 - n.x * this.view.scale;
      this.view.ty = H / 2 - n.y * this.view.scale;
      input.value = n.title;
      close();
      this.requestDraw();
    };
    const show = () => {
      const q = input.value.trim().toLocaleLowerCase();
      const starts = (n: GraphNode) => Number(n.title.toLocaleLowerCase().startsWith(q));
      matches = this.nodes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.visible && n.title.toLocaleLowerCase().includes(q))
        .sort((a, b) => starts(b.n) - starts(a.n) || b.n.count - a.n.count)
        .slice(0, 7)
        .map((x) => x.i);
      list.replaceChildren();
      active = -1;
      input.removeAttribute('aria-activedescendant');
      if (!q) { close(); return; }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (!matches.length) list.append(el('p', '', 'No matching entries in this view.'));
      matches.forEach((i, pos) => {
        const n = this.nodes[i];
        const item = el('button');
        item.type = 'button';
        item.id = `${list.id}-${pos}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.tabIndex = -1;
        item.append(el('span', '', n.title), el('small', '', TYPE_LABELS[n.type] || n.type));
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => select(i));
        list.append(item);
      });
    };
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length) {
        e.preventDefault();
        if (list.hidden) show();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = active < 0 ? (step > 0 ? 0 : matches.length - 1) : (active + step + matches.length) % matches.length;
        list.querySelectorAll('[role=option]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
        input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      }
      if (e.key === 'Enter' && matches.length && !list.hidden) {
        e.preventDefault();
        select(matches[Math.max(0, active)]);
      }
    });
  }

  // --- Interactions -----------------------------------------------------------
  /** Wire pointer, touch, keyboard and every generic control. Call once. */
  wire(): void {
    this.wireSearch();
    const { canvas, tooltip, root } = this;
    canvas.tabIndex = 0;
    let isPanning = false;
    let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
    let downAt: { x: number; y: number } | null = null;
    let lastTap = 0;
    let pinchStart: { dist: number; scale: number; tx: number; ty: number; midX: number; midY: number } | null = null;

    const local = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };
    const navigateTo = (i: number) => {
      if (!this.nodes[i].isFocal) location.href = hrefFor(this.nodes[i]);
    };
    const onDown = (cx: number, cy: number) => {
      isPanning = true;
      panStart = { x: cx, y: cy, tx: this.view.tx, ty: this.view.ty };
      downAt = { x: cx, y: cy };
      canvas.style.cursor = 'grabbing';
    };
    const onUp = (cx: number, cy: number, isTouch: boolean, shift: boolean) => {
      if (!isPanning) return;
      isPanning = false;
      canvas.style.cursor = '';
      const moved = downAt && Math.hypot(cx - downAt.x, cy - downAt.y) > 5;
      downAt = null;
      if (moved) return;
      if (isTouch) {
        const now = Date.now();
        if (now - lastTap < 320) {
          const p = local(cx, cy);
          const hit = this.hitTest(p.x, p.y);
          if (hit >= 0) { navigateTo(hit); return; }
        }
        lastTap = now;
      }
      const p = local(cx, cy);
      this.handleClick(p.x, p.y, shift || this.multiMode);
    };
    const onMove = (cx: number, cy: number) => {
      if (isPanning && panStart) {
        this.view.tx = panStart.tx + (cx - panStart.x);
        this.view.ty = panStart.ty + (cy - panStart.y);
        this.requestDraw();
        tooltip.hidden = true;
        return;
      }
      const p = local(cx, cy);
      const hit = this.hitTest(p.x, p.y);
      const edgeHit = hit < 0 ? this.edgeHitTest(p.x, p.y) : -1;
      if (hit !== this.hoveredIdx || edgeHit !== this.hoveredEdge) {
        this.hoveredIdx = hit;
        this.hoveredEdge = edgeHit;
        this.requestDraw();
      }
      canvas.style.cursor = hit >= 0 || edgeHit >= 0 ? 'pointer' : '';
      if (hit >= 0) this.showNodeTooltip(this.nodes[hit], p.x, p.y);
      else if (edgeHit >= 0) this.showEdgeTooltip(this.edges[edgeHit], p.x, p.y);
      else tooltip.hidden = true;
    };
    const zoomTo = (scale: number) => Math.max(0.05, Math.min(this.P.zoomMax, scale));
    const zoomAt = (px: number, py: number, factor: number) => {
      const newScale = zoomTo(this.view.scale * factor);
      const ratio = newScale / this.view.scale;
      this.view.tx = px - (px - this.view.tx) * ratio;
      this.view.ty = py - (py - this.view.ty) * ratio;
      this.view.scale = newScale;
      this.requestDraw();
      tooltip.hidden = true;
    };

    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    window.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY, false, e.shiftKey));
    canvas.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    canvas.addEventListener('mouseleave', () => {
      if (this.hoveredIdx !== -1 || this.hoveredEdge !== -1) {
        this.hoveredIdx = -1;
        this.hoveredEdge = -1;
        this.requestDraw();
      }
      tooltip.hidden = true;
      canvas.style.cursor = '';
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      zoomAt(p.x, p.y, Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * .002));
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      const p = local(e.clientX, e.clientY);
      const hit = this.hitTest(p.x, p.y);
      if (hit >= 0) navigateTo(hit);
    });
    canvas.addEventListener('keydown', (e) => {
      const pan: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
      if (e.key === 'Escape') this.clearSelection();
      else if (e.key === '/') { e.preventDefault(); root.querySelector<HTMLInputElement>('.net-search')?.focus(); }
      else if (e.key === '0') { e.preventDefault(); this.fit(); }
      else if (pan[e.key]) {
        e.preventDefault();
        this.view.tx += pan[e.key][0];
        this.view.ty += pan[e.key][1];
        this.requestDraw();
      }
    });

    // Touch: pan, pinch, tap, double-tap to open. CSS sets touch-action: none.
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        onDown(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        isPanning = false;
        const [a, b] = e.touches;
        const mid = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        pinchStart = {
          dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
          scale: this.view.scale, tx: this.view.tx, ty: this.view.ty,
          midX: mid.x, midY: mid.y,
        };
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart) {
        const [a, b] = e.touches;
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const newScale = zoomTo(pinchStart.scale * (dist / (pinchStart.dist || 1)));
        const r = newScale / pinchStart.scale;
        this.view.scale = newScale;
        this.view.tx = pinchStart.midX - (pinchStart.midX - pinchStart.tx) * r;
        this.view.ty = pinchStart.midY - (pinchStart.midY - pinchStart.ty) * r;
        this.requestDraw();
      } else if (e.touches.length === 1) {
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinchStart = null;
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        onUp(e.changedTouches[0].clientX, e.changedTouches[0].clientY, true, false);
      }
    });
    canvas.addEventListener('touchcancel', () => { isPanning = false; pinchStart = null; downAt = null; });

    // Generic controls. Every one is optional in the markup.
    const btn = (cls: string) => root.querySelector<HTMLButtonElement>(cls);
    const toggle = (b: HTMLButtonElement | null, on: boolean, label: string) => {
      b?.setAttribute('aria-pressed', String(on));
      if (b) b.textContent = label;
    };
    const layoutBtn = btn('.net-layout');
    layoutBtn?.addEventListener('click', () => {
      const L = this.opts.layouts;
      this.layoutIdx = (this.layoutIdx + 1) % L.length;
      this.currentLayout = L[this.layoutIdx].key;
      layoutBtn.textContent = `Layout: ${L[this.layoutIdx].label}`;
      this.applyLayout();
      this.updateForceSliderVisibility();
    });
    btn('.net-zoom-in')?.addEventListener('click', () => { const { W, H } = this.canvasSize(); zoomAt(W / 2, H / 2, 1.35); });
    btn('.net-zoom-out')?.addEventListener('click', () => { const { W, H } = this.canvasSize(); zoomAt(W / 2, H / 2, 1 / 1.35); });
    btn('.net-fit')?.addEventListener('click', () => this.fit());
    const edgesBtn = btn('.net-edges');
    edgesBtn?.addEventListener('click', () => {
      this.edgesVisible = !this.edgesVisible;
      toggle(edgesBtn, this.edgesVisible, this.edgesVisible ? 'Hide edges' : 'Show edges');
      this.requestDraw();
    });
    const implicitBtn = btn('.net-implicit');
    implicitBtn?.addEventListener('click', () => {
      this.showImplicit = !this.showImplicit;
      toggle(implicitBtn, this.showImplicit, this.showImplicit ? '− Inferred' : '+ Inferred');
      this.updateStats();
      this.requestDraw();
    });
    const multiBtn = btn('.net-multi');
    multiBtn?.addEventListener('click', () => {
      this.multiMode = !this.multiMode;
      toggle(multiBtn, this.multiMode, this.multiMode ? 'Multi: on' : 'Multi: off');
    });
    const colorBtn = btn('.net-color');
    colorBtn?.addEventListener('click', () => {
      this.setColorMode(this.colorMode === 'type' ? 'community' : 'type');
      const byCluster = this.colorMode === 'community';
      toggle(colorBtn, byCluster, byCluster ? 'Colour: Cluster' : 'Colour: Type');
    });
    const fsEl = this.opts.fullscreenEl ?? root;
    const fsBtn = btn('.net-fullscreen');
    const setFullscreen = (on: boolean) => {
      fsEl.classList.toggle('fullscreen', on);
      toggle(fsBtn, on, on ? 'Close' : 'Expand');
      document.body.classList.toggle('net-fullscreen-active', on);
      requestAnimationFrame(() => { this.resize(); this.fit(); });
    };
    fsBtn?.addEventListener('click', () => setFullscreen(!fsEl.classList.contains('fullscreen')));
    const options = () => root.querySelectorAll<HTMLDetailsElement>('.graph-options[open]');
    document.addEventListener('click', (e) => {
      options().forEach((d) => { if (!d.contains(e.target as Node)) d.open = false; });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      options().forEach((d) => { d.open = false; });
      if (fsEl.classList.contains('fullscreen')) setFullscreen(false);
    });
    root.querySelectorAll<HTMLInputElement>('.net-slider-input[data-slider]').forEach((input) => {
      const key = input.dataset.slider;
      const valEl = root.querySelector(`[data-slider-val="${key}"]`);
      input.addEventListener('input', () => {
        const pct = parseInt(input.value, 10);
        if (valEl) valEl.textContent = pct + '%';
        if (key === 'opacity') { this.opacityMult = pct / 100; this.requestDraw(); }
        else if (key === 'highlight') { this.highlightStrength = pct / 100; this.requestDraw(); }
        else if (key === 'force') {
          const ratio = pct / 100 / this.forceMult;
          this.forceMult = pct / 100;
          // Layouts read forceMult when they run; only a live force layout needs rescaling.
          if (this.currentLayout === 'force') this.scaleLayout(ratio);
        }
      });
    });
    this.updateForceSliderVisibility();
    this.panel.querySelector('.gs-deselect')?.addEventListener('click', () => this.clearSelection());
  }
  private updateForceSliderVisibility(): void {
    const slider = this.root.querySelector<HTMLElement>('[data-force-only]');
    if (slider) slider.style.display = this.currentLayout === 'force' ? '' : 'none';
  }

  private handleClick(px: number, py: number, additive: boolean): void {
    const hit = this.hitTest(px, py);
    if (hit < 0) {
      const edgeHit = this.edgeHitTest(px, py);
      if (edgeHit >= 0) {
        if (!additive) { this.selectedNodes.clear(); this.selectedEdges.clear(); }
        if (!this.selectedEdges.delete(edgeHit)) this.selectedEdges.add(edgeHit);
        this.selectionChanged();
      } else if (!additive && (this.selectedNodes.size > 0 || this.selectedEdges.size > 0)) {
        this.clearSelection();
      }
      return;
    }
    if (additive) {
      if (!this.selectedNodes.delete(hit)) this.selectedNodes.add(hit);
    } else {
      // Clicking the only selected node again deselects it.
      const wasOnly = this.selectedNodes.size === 1 && this.selectedEdges.size === 0 && this.selectedNodes.has(hit);
      this.selectedNodes.clear();
      this.selectedEdges.clear();
      if (!wasOnly) this.selectedNodes.add(hit);
    }
    this.selectionChanged();
  }

  // --- Selection panel + tooltips ---------------------------------------------
  private updateSelectionPanel(): void {
    const { panel, nodes, edges } = this;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => panel.querySelector<T>(sel);
    const go = q<HTMLAnchorElement>('.gs-go')!;
    const meta = q('.gs-meta')!;
    const summary = q('.gs-summary')!;
    q('.gs-go-b')?.setAttribute('hidden', '');
    go.textContent = 'Go to page →';
    go.hidden = false;
    meta.classList.remove('hidden-meta');
    summary.hidden = true;
    q('.gs-bridge')!.hidden = true;
    q('.gs-hub')!.hidden = true;

    const nc = this.selectedNodes.size, ec = this.selectedEdges.size;
    panel.hidden = nc + ec === 0;
    if (panel.hidden) return;
    const eyebrow = q('.gs-eyebrow')!, title = q('.gs-title')!, count = q('.gs-count')!;
    eyebrow.className = 'gs-eyebrow';
    count.textContent = '';

    if (nc === 0 && ec === 1) {
      const [a, b] = edges[this.selectedEdges.values().next().value!].map((i) => nodes[i]);
      eyebrow.textContent = 'Connection';
      title.textContent = `${a.title} ↔ ${b.title}`;
      meta.classList.add('hidden-meta');
      go.href = hrefFor(a);
      go.textContent = `Go to ${a.title} →`;
      let goB = q<HTMLAnchorElement>('.gs-go-b');
      if (!goB) {
        goB = el('a', 'gs-go gs-go-b');
        go.after(goB);
      }
      goB.href = hrefFor(b);
      goB.textContent = `Go to ${b.title} →`;
      goB.hidden = false;
      return;
    }
    if (nc === 1 && ec === 0) {
      const n = nodes[this.selectedNodes.values().next().value!];
      eyebrow.textContent = TYPE_LABELS[n.type] || '';
      eyebrow.classList.add(`type-${n.type}`);
      title.textContent = n.title;
      count.textContent = n.count.toLocaleString();
      if (n.bridgeRank) { q('.gs-bridge-rank')!.textContent = '#' + n.bridgeRank; q('.gs-bridge')!.hidden = false; }
      if (n.hubRank) { q('.gs-hub-rank')!.textContent = '#' + n.hubRank; q('.gs-hub')!.hidden = false; }
      if (n.isFocal) go.hidden = true;
      else go.href = hrefFor(n);
      return;
    }

    const link = (n: GraphNode) => {
      const a = el('a', `gs-summary-link type-${n.type}`, n.title);
      a.href = hrefFor(n);
      return a;
    };
    const pieces: Node[][] = [...this.selectedNodes].map((i) => [link(nodes[i])]);
    for (const k of this.selectedEdges) {
      const [a, b] = edges[k];
      pieces.push([link(nodes[a]), el('span', 'gs-summary-link-sep', '↔'), link(nodes[b])]);
    }
    const MAX = 8;
    summary.replaceChildren();
    pieces.slice(0, MAX).forEach((p, i) => summary.append(...(i ? [', '] : []), ...p));
    if (pieces.length > MAX) summary.append(el('span', 'gs-summary-more', `, +${pieces.length - MAX} more`));
    summary.hidden = false;
    eyebrow.textContent = 'Multi-select';
    const parts: string[] = [];
    if (nc) parts.push(`${nc} ${nc === 1 ? 'entity' : 'entities'}`);
    if (ec) parts.push(`${ec} ${ec === 1 ? 'connection' : 'connections'}`);
    title.textContent = parts.join(' · ');
    meta.classList.add('hidden-meta');
    go.hidden = true;
  }

  private placeTooltip(px: number, py: number): void {
    const { tooltip, shell } = this;
    tooltip.hidden = false;
    const sr = shell.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    // Keep it inside both the graph and the viewport; prefer above the pointer.
    const minX = Math.max(8, 8 - sr.left);
    const maxX = Math.min(sr.width - width - 8, innerWidth - sr.left - width - 8);
    const minY = Math.max(8, 8 - sr.top);
    const maxY = Math.min(sr.height - height - 8, innerHeight - sr.top - height - 8);
    const above = py - height - 10;
    const below = py + 14;
    const preferredY = above >= minY || below > maxY ? above : below;
    tooltip.style.left = Math.max(minX, Math.min(px + 14, Math.max(minX, maxX))) + 'px';
    tooltip.style.top = Math.max(minY, Math.min(preferredY, Math.max(minY, maxY))) + 'px';
  }
  private showTooltip(pair: (Node | string)[], meta: string, px: number, py: number): void {
    const row = el('div', 'gt-pair');
    row.append(...pair);
    this.tooltip.replaceChildren(row, el('div', 'gt-meta', meta));
    this.placeTooltip(px, py);
  }
  private showNodeTooltip(n: GraphNode, px: number, py: number): void {
    const meta = [TYPE_LABELS[n.type] || n.type, `${n.count.toLocaleString()} mentions`];
    if (n.bridgeRank) meta.push(`bridge #${n.bridgeRank}`);
    if (n.hubRank) meta.push(`hub #${n.hubRank}`);
    if (this.colorMode === 'community' && n.community >= 0) {
      meta.push(this.communityLabels[n.community] || `cluster ${n.community + 1}`);
    }
    this.showTooltip([el('span', '', n.title)], meta.join(' · '), px, py);
  }
  private showEdgeTooltip([a, b]: Edge, px: number, py: number): void {
    const pair = [el('span', '', this.nodes[a].title), ' ', el('span', 'gt-link', '—'), ' ', el('span', '', this.nodes[b].title)];
    this.showTooltip(pair, 'connection · click to pin', px, py);
  }
}

/** An engine node for global index i of adjacency.json. */
export function nodeFromAdjacency(data: Adjacency, i: number, size: number): GraphNode {
  return {
    id: data.ids[i],
    title: data.titles[i],
    type: data.types[i],
    count: data.mentions[i] || 0,
    bridgeRank: data.bridges[i]?.rank ?? 0,
    hubRank: data.hubs[i]?.rank ?? 0,
    community: data.communities[i] ?? -1,
    x: 0, y: 0, size, visible: true,
  };
}

/** Edges among the nodes in `local` (adjacency index to engine index), in
 *  `local` order, plus the indices of those that are inferred, not linked. */
export function adjacencyEdges(data: Adjacency, local: Map<number, number>): { edges: Edge[]; implicit: Set<number> } {
  const n = data.ids.length;
  const edges: Edge[] = [];
  const byPair = new Map<number, number>();
  for (const [ga, a] of local) {
    for (const gb of data.adj[ga]) {
      const b = local.get(gb);
      if (gb <= ga || b === undefined) continue;
      byPair.set(ga * n + gb, edges.length);
      edges.push([a, b]);
    }
  }
  const implicit = new Set<number>();
  for (const [a, b] of data.implicitPairs) {
    const k = byPair.get(Math.min(a, b) * n + Math.max(a, b));
    if (k !== undefined) implicit.add(k);
  }
  return { edges, implicit };
}
