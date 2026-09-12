/**
 * Shared canvas network engine for the per-entity Local network widget
 * (components/NetworkGraph.astro) and the full /network/ page
 * (pages/network.astro). Owns rendering, hit-testing, pan/zoom/touch,
 * selection, tooltips, the selection panel and the generic controls
 * (layout cycle, refit, edges, inferred, multi, colour, fullscreen,
 * drawers, opacity/highlight/force sliders).
 *
 * The caller owns the data (which nodes and edges exist), the layouts,
 * and any controls specific to its view (type chips, 2-hop). It installs
 * data with setGraph() and mutates node x/y/visible directly.
 */

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  count: number;
  bridgeRank: number;
  bridgeScore: number;
  hubRank: number;
  hubScore: number;
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
  /** 'entity' = small local graph (bigger nodes, label everyone);
   *  'full' = whole vault (thin edges, labels only for landmarks / zoom). */
  profile: 'entity' | 'full';
  layouts: Layout[];
  /** Inferred (NER) edges drawn by default? */
  showImplicit: boolean;
  /** Element that gets the .fullscreen class. Defaults to root. */
  fullscreenEl?: HTMLElement;
  /** Force slider handler. The engine only tracks the multiplier. */
  onForceSlider?: (mult: number, prevMult: number, g: GraphEngine) => void;
}

import { TYPE_LABELS, entityHref } from './entity-types';

const PROFILES = {
  entity: { bgAlpha: 0.42, lineW: 0.9, implW: 0.7, hoverW: 1.4, selW: 2.2, goldW: 3.0, focusAlpha: 0.7, zoomMax: 20, fitPad: 30, labelAll: true, hoverFont: 12 },
  full: { bgAlpha: 0.32, lineW: 0.7, implW: 0.6, hoverW: 1.1, selW: 1.8, goldW: 2.6, focusAlpha: 0.55, zoomMax: 50, fitPad: 40, labelAll: false, hoverFont: 13 },
};

// Second-hop nodes render at this fraction of first-hop opacity.
const HOP2_OPACITY = 0.6;

export function readColors(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
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
    accentSoft: get('--accent-soft', '#c97a6a'),
    ink: get('--ink', '#1a1814'),
    paper: get('--paper', '#f7f2e7'),
    gold: get('--gold', '#8a6e25'),
  };
}

/** Golden-angle hue spacing: any number of communities, neighbours distinct. */
export function communityColor(c: number): string {
  return `hsl(${Math.round((c * 137.508) % 360)}, 46%, 40%)`;
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
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}
function hrefFor(n: GraphNode): string {
  return entityHref(n.type, n.id);
}

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
  opacityMult = 1.0;
  highlightStrength = 1.0;
  forceMult = 1.0;
  currentLayout: string;
  private layoutIdx = 0;
  private dpr = 1;
  private drawScheduled = false;
  private wired = false;

  constructor(root: HTMLElement, opts: EngineOptions) {
    this.root = root;
    this.opts = opts;
    this.P = PROFILES[opts.profile];
    this.shell = root.querySelector('.net-shell') as HTMLElement;
    this.canvas = root.querySelector('.net-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.tooltip = root.querySelector('.net-tooltip') as HTMLElement;
    this.panel = root.querySelector('.net-selection') as HTMLElement;
    this.COLORS = readColors();
    this.showImplicit = opts.showImplicit;
    this.currentLayout = opts.layouts[0]?.key ?? 'force';
    window.addEventListener('resize', () => { if (this.nodes.length) this.resize(); });
  }

  // --- Data ---------------------------------------------------------------
  /** Install a graph. Edges are index pairs into `nodes`; implicit is the
   *  set of edge indices that have no explicit wikilink behind them. */
  setGraph(nodes: GraphNode[], edges: Edge[], implicit: Set<number>): void {
    this.nodes = nodes;
    this.edges = edges;
    this.implicitEdgeIdx = implicit;
    this.neighborSets = Array.from({ length: nodes.length }, () => new Set<number>());
    for (let k = 0; k < edges.length; k++) {
      const [a, b] = edges[k];
      this.neighborSets[a].add(b);
      this.neighborSets[b].add(a);
    }
    // Indices are meaningless across graphs: drop selection and hover
    // before recomputing focus. Callers that want to keep a selection
    // snapshot selectedIds() first and restoreSelection() after.
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.hoveredIdx = -1;
    this.hoveredEdge = -1;
    this.recolor();
    this.recomputeFocus();
  }
  recolor(): void {
    for (const n of this.nodes) {
      n.color = (this.colorMode === 'community' && n.community >= 0)
        ? communityColor(n.community)
        : (this.COLORS[n.type] || this.COLORS.muted);
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

  fit(padding?: number): void {
    if (!this.nodes.length) return;
    padding = padding ?? this.P.fitPad;
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
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.view.scale = Math.min((W - 2 * padding) / w, (H - 2 * padding) / h);
    this.view.tx = (W - w * this.view.scale) / 2 - minX * this.view.scale;
    this.view.ty = (H - h * this.view.scale) / 2 - minY * this.view.scale;
    this.requestDraw();
  }

  /** Run the current layout, refit and redraw. */
  applyLayout(): void {
    const l = this.opts.layouts.find((x) => x.key === this.currentLayout) ?? this.opts.layouts[0];
    if (l) l.apply(this);
    this.fit();
  }

  // --- Selection ----------------------------------------------------------
  recomputeFocus(): void {
    if (this.selectedNodes.size === 0 && this.selectedEdges.size === 0) {
      this.focusNodes = null; return;
    }
    const f = new Set<number>();
    for (const idx of this.selectedNodes) {
      f.add(idx);
      for (const n of this.neighborSets[idx] || []) f.add(n);
    }
    for (const k of this.selectedEdges) { f.add(this.edges[k][0]); f.add(this.edges[k][1]); }
    this.focusNodes = f;
  }
  /** Call after any change to selection sets or node visibility. */
  selectionChanged(): void {
    for (const idx of [...this.selectedNodes]) {
      if (!this.nodes[idx] || !this.nodes[idx].visible) this.selectedNodes.delete(idx);
    }
    for (const k of [...this.selectedEdges]) {
      const e = this.edges[k];
      if (!e || !this.nodes[e[0]].visible || !this.nodes[e[1]].visible) this.selectedEdges.delete(k);
    }
    this.recomputeFocus();
    this.updateSelectionPanel();
    this.requestDraw();
  }
  clearSelection(): void {
    this.selectedNodes.clear(); this.selectedEdges.clear();
    this.selectionChanged();
  }
  selectedIds(): string[] {
    return [...this.selectedNodes].map((i) => this.nodes[i].id);
  }
  restoreSelection(ids: string[]): void {
    const want = new Set(ids);
    this.selectedNodes.clear(); this.selectedEdges.clear();
    for (let i = 0; i < this.nodes.length; i++) if (want.has(this.nodes[i].id)) this.selectedNodes.add(i);
    this.selectionChanged();
  }

  // --- Drawing ------------------------------------------------------------
  draw(): void {
    const { nodes, edges, ctx, COLORS, P, view } = this;
    if (!nodes.length) return;
    const { W, H } = this.canvasSize();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, W, H);

    const vp = {
      x0: (-50 - view.tx) / view.scale, y0: (-50 - view.ty) / view.scale,
      x1: (W + 50 - view.tx) / view.scale, y1: (H + 50 - view.ty) / view.scale,
    };
    const hasSelection = this.selectedNodes.size > 0 || this.selectedEdges.size > 0;
    const impl = this.implicitEdgeIdx;

    const focusEdges = new Set<number>();
    const hoverEdges = new Set<number>();
    if (this.edgesVisible) {
      if (this.selectedNodes.size > 0) {
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (this.selectedNodes.has(e[0]) || this.selectedNodes.has(e[1])) focusEdges.add(i);
        }
      }
      for (const k of this.selectedEdges) focusEdges.add(k);
      if (this.hoveredIdx >= 0 && !this.selectedNodes.has(this.hoveredIdx)) {
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (e[0] === this.hoveredIdx || e[1] === this.hoveredIdx) hoverEdges.add(i);
        }
      }
      if (this.hoveredEdge >= 0 && !this.selectedEdges.has(this.hoveredEdge)) hoverEdges.add(this.hoveredEdge);
    }

    const segment = (i: number): boolean => {
      const e = edges[i];
      const a = nodes[e[0]], b = nodes[e[1]];
      if (!a.visible || !b.visible) return false;
      if ((a.x < vp.x0 && b.x < vp.x0) || (a.x > vp.x1 && b.x > vp.x1) ||
          (a.y < vp.y0 && b.y < vp.y0) || (a.y > vp.y1 && b.y > vp.y1)) return false;
      ctx.moveTo(this.sx(a.x), this.sy(a.y));
      ctx.lineTo(this.sx(b.x), this.sy(b.y));
      return true;
    };
    const strokeSet = (set: Iterable<number>, wantImplicit: boolean, filter?: (i: number) => boolean) => {
      ctx.beginPath();
      for (const i of set) {
        if (impl.has(i) !== wantImplicit) continue;
        if (filter && !filter(i)) continue;
        segment(i);
      }
      ctx.stroke();
    };

    if (this.edgesVisible) {
      const fadedAlpha = 0.32 - (0.32 - 0.06) * this.highlightStrength;
      const bgAlpha = hasSelection ? fadedAlpha : P.bgAlpha;
      const claimed = (i: number) => focusEdges.has(i) || hoverEdges.has(i);
      const touchesBridge = (i: number) => !!(nodes[edges[i][0]].bridgeRank || nodes[edges[i][1]].bridgeRank);
      const all: number[] = [];
      for (let i = 0; i < edges.length; i++) if (!claimed(i)) all.push(i);

      // Background: explicit solid (plain, then gold for bridge-touching).
      ctx.lineWidth = P.lineW;
      ctx.setLineDash([]);
      ctx.strokeStyle = hexToRgba(COLORS.accentSoft || COLORS.line, bgAlpha);
      strokeSet(all, false, (i) => !touchesBridge(i));
      ctx.strokeStyle = hexToRgba(COLORS.gold, bgAlpha * 0.85);
      strokeSet(all, false, touchesBridge);
      // Background: inferred, dashed, only when toggled on.
      if (this.showImplicit) {
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = P.implW;
        ctx.strokeStyle = hexToRgba(COLORS.accentSoft || COLORS.line, bgAlpha);
        strokeSet(all, true, (i) => !touchesBridge(i));
        ctx.strokeStyle = hexToRgba(COLORS.gold, bgAlpha * 0.85);
        strokeSet(all, true, touchesBridge);
        ctx.setLineDash([]);
      }
      // Hover overlay: always includes inferred edges of the hovered node.
      if (hoverEdges.size) {
        ctx.lineWidth = P.hoverW;
        ctx.strokeStyle = hexToRgba(COLORS.accent, 0.6);
        ctx.setLineDash([]);
        strokeSet(hoverEdges, false);
        ctx.setLineDash([4, 3]);
        strokeSet(hoverEdges, true);
        ctx.setLineDash([]);
      }
      // Selected overlay; edges between two selected nodes go gold.
      if (focusEdges.size) {
        const gold = new Set<number>();
        if (this.selectedNodes.size > 1) {
          for (const i of focusEdges) {
            const e = edges[i];
            if (this.selectedNodes.has(e[0]) && this.selectedNodes.has(e[1])) gold.add(i);
          }
        }
        const notGold = (i: number) => !gold.has(i);
        ctx.lineWidth = P.selW;
        ctx.strokeStyle = COLORS.accent;
        ctx.setLineDash([]);
        strokeSet(focusEdges, false, notGold);
        ctx.setLineDash([5, 4]);
        strokeSet(focusEdges, true, notGold);
        ctx.setLineDash([]);
        if (gold.size) {
          ctx.lineWidth = P.goldW;
          ctx.strokeStyle = COLORS.gold;
          strokeSet(gold, false);
          ctx.setLineDash([5, 4]);
          strokeSet(gold, true);
          ctx.setLineDash([]);
        }
      }
    }

    // Nodes
    const fadeAlpha = 0.55 - (0.55 - 0.08) * this.highlightStrength;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.visible) continue;
      const sx = this.sx(n.x), sy = this.sy(n.y), sr = n.size * view.scale;
      if (sx + sr < 0 || sx - sr > W || sy + sr < 0 || sy - sr > H) continue;
      const isSelected = this.selectedNodes.has(i);
      const isMain = isSelected || i === this.hoveredIdx || !!n.isFocal;
      const inFocus = !this.focusNodes || this.focusNodes.has(i);
      const base = isMain ? 1 : (inFocus ? P.focusAlpha : fadeAlpha);
      const hopMult = (n.hop === 2 && !isMain) ? HOP2_OPACITY : 1;
      ctx.globalAlpha = (isMain ? base : base * this.opacityMult) * hopMult;
      ctx.fillStyle = n.color || COLORS.muted;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (n.isFocal) {
        ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (n.bridgeRank) {
        ctx.strokeStyle = inFocus ? COLORS.gold : hexToRgba(COLORS.gold, 0.2);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 1.2, 0, Math.PI * 2); ctx.stroke();
      }
      if (isSelected && !n.isFocal) {
        ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 3, 0, Math.PI * 2); ctx.stroke();
      } else if (i === this.hoveredIdx && !isSelected && !n.isFocal) {
        ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 2, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Labels with collision detection. Tier 0 always wins; lower tiers
    // are skipped when they would overlap an already-placed label.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const suppressOuter = hasSelection && this.highlightStrength > 0.4;
    const candidates: { i: number; n: GraphNode; sx: number; sy: number; sr: number; tier: number; isHover: boolean }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.visible) continue;
      if (suppressOuter && this.focusNodes && !this.focusNodes.has(i) && i !== this.hoveredIdx) continue;
      const sx = this.sx(n.x), sy = this.sy(n.y);
      if (sx < -200 || sx > W + 200 || sy < -40 || sy > H + 40) continue;
      const sr = n.size * view.scale;
      const isHover = i === this.hoveredIdx || this.selectedNodes.has(i);
      const inFocusSet = !!(this.focusNodes && this.focusNodes.has(i));
      let tier: number;
      if (isHover || n.isFocal) tier = 0;
      else if (inFocusSet || n.isLandmark) tier = 1;
      else if (P.labelAll || sr >= 9) tier = 2;
      else continue;
      candidates.push({ i, n, sx, sy, sr, tier, isHover });
    }
    candidates.sort((a, b) => a.tier - b.tier || b.n.count - a.n.count);
    const drawn: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const c of candidates) {
      const big = c.isHover || !!c.n.isFocal;
      const fontSize = big ? P.hoverFont : (c.n.isLandmark ? 11 : 10);
      ctx.font = `${big || c.n.isLandmark ? 600 : 500} ${fontSize}px "Inter Tight", sans-serif`;
      const metrics = ctx.measureText(c.n.title);
      const padX = 4, padY = 2;
      const labelY = c.sy + c.sr + 4;
      const box = {
        x0: c.sx - metrics.width / 2 - padX, x1: c.sx + metrics.width / 2 + padX,
        y0: labelY - 1, y1: labelY + fontSize + 2 * padY,
      };
      if (c.tier > 0 && drawn.some((d) => !(box.x1 < d.x0 || d.x1 < box.x0 || box.y1 < d.y0 || d.y1 < box.y0))) continue;
      const labelHop = (c.n.hop === 2 && !big) ? HOP2_OPACITY : 1;
      ctx.globalAlpha = (big ? 1 : this.opacityMult) * labelHop;
      ctx.fillStyle = hexToRgba(COLORS.paper, c.isHover ? 0.95 : 0.85);
      ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.fillStyle = c.isHover ? COLORS.accent : COLORS.ink;
      ctx.fillText(c.n.title, c.sx, labelY + padY - 1);
      ctx.globalAlpha = 1;
      drawn.push(box);
    }
  }

  // --- Hit-testing ----------------------------------------------------------
  hitTest(px: number, py: number): number {
    let best = -1, bestR = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (!n.visible) continue;
      const r = Math.max(4, n.size * this.view.scale);
      const dx = this.sx(n.x) - px, dy = this.sy(n.y) - py;
      if (dx * dx + dy * dy <= r * r && r > bestR) { best = i; bestR = r; }
    }
    return best;
  }
  edgeHitTest(px: number, py: number, threshold = 5): number {
    if (!this.edgesVisible) return -1;
    const { W, H } = this.canvasSize();
    let best = -1, bestD = threshold;
    for (let k = 0; k < this.edges.length; k++) {
      if (!this.showImplicit && this.implicitEdgeIdx.has(k)) continue;
      const e = this.edges[k];
      const a = this.nodes[e[0]], b = this.nodes[e[1]];
      if (!a.visible || !b.visible) continue;
      const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
      if ((ax < -10 && bx < -10) || (ax > W + 10 && bx > W + 10) ||
          (ay < -10 && by < -10) || (ay > H + 10 && by > H + 10)) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  // --- Interactions -----------------------------------------------------------
  /** Wire pointer, touch, keyboard and every generic control. Idempotent. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    const { canvas, tooltip, root } = this;
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
      const n = this.nodes[i];
      if (n.isFocal) return;
      window.location.href = hrefFor(n);
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
      if (!moved) {
        if (isTouch) {
          const now = Date.now();
          if (now - lastTap < 320) {
            const p = local(cx, cy);
            const hit = this.hitTest(p.x, p.y);
            if (hit >= 0) { navigateTo(hit); return; }
          }
          lastTap = now;
        }
        this.handleClick(cx, cy, shift);
      }
      downAt = null;
    };
    const onMove = (cx: number, cy: number) => {
      const p = local(cx, cy);
      if (isPanning && panStart) {
        this.view.tx = panStart.tx + (cx - panStart.x);
        this.view.ty = panStart.ty + (cy - panStart.y);
        this.requestDraw();
        tooltip.setAttribute('hidden', '');
        return;
      }
      const hit = this.hitTest(p.x, p.y);
      const edgeHit = hit < 0 ? this.edgeHitTest(p.x, p.y) : -1;
      if (hit !== this.hoveredIdx || edgeHit !== this.hoveredEdge) {
        this.hoveredIdx = hit; this.hoveredEdge = edgeHit;
        this.requestDraw();
      }
      if (hit >= 0) {
        canvas.style.cursor = 'pointer';
        this.showTooltip(this.nodes[hit], p.x, p.y);
      } else if (edgeHit >= 0) {
        canvas.style.cursor = 'pointer';
        const ed = this.edges[edgeHit];
        this.showEdgeTooltip(this.nodes[ed[0]], this.nodes[ed[1]], p.x, p.y);
      } else {
        canvas.style.cursor = '';
        tooltip.setAttribute('hidden', '');
      }
    };
    const zoomAt = (px: number, py: number, factor: number) => {
      const newScale = Math.max(0.05, Math.min(this.P.zoomMax, this.view.scale * factor));
      const ratio = newScale / this.view.scale;
      this.view.tx = px - (px - this.view.tx) * ratio;
      this.view.ty = py - (py - this.view.ty) * ratio;
      this.view.scale = newScale;
      this.requestDraw();
      tooltip.setAttribute('hidden', '');
    };

    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    window.addEventListener('mouseup', (e) => { if (isPanning) onUp(e.clientX, e.clientY, false, e.shiftKey); });
    canvas.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    canvas.addEventListener('mouseleave', () => {
      if (this.hoveredIdx !== -1 || this.hoveredEdge !== -1) { this.hoveredIdx = -1; this.hoveredEdge = -1; this.requestDraw(); }
      tooltip.setAttribute('hidden', '');
      canvas.style.cursor = '';
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      const p = local(e.clientX, e.clientY);
      const hit = this.hitTest(p.x, p.y);
      if (hit >= 0) navigateTo(hit);
    });

    // Touch: pan, pinch, tap, double-tap. touch-action: none in CSS.
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        onDown(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        isPanning = false;
        const a = e.touches[0], b = e.touches[1];
        const r = canvas.getBoundingClientRect();
        pinchStart = {
          dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
          scale: this.view.scale, tx: this.view.tx, ty: this.view.ty,
          midX: (a.clientX + b.clientX) / 2 - r.left,
          midY: (a.clientY + b.clientY) / 2 - r.top,
        };
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart) {
        const a = e.touches[0], b = e.touches[1];
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const newScale = Math.max(0.05, Math.min(this.P.zoomMax, pinchStart.scale * (dist / (pinchStart.dist || 1))));
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
      if (pinchStart && e.touches.length < 2) pinchStart = null;
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        onUp(e.changedTouches[0].clientX, e.changedTouches[0].clientY, true, false);
      }
    });
    canvas.addEventListener('touchcancel', () => { isPanning = false; pinchStart = null; downAt = null; });

    // Generic controls. Every one is optional in the markup.
    const btn = (cls: string) => root.querySelector(cls) as HTMLButtonElement | null;
    const layoutBtn = btn('.net-layout');
    layoutBtn?.addEventListener('click', () => {
      const L = this.opts.layouts;
      this.layoutIdx = (this.layoutIdx + 1) % L.length;
      this.currentLayout = L[this.layoutIdx].key;
      layoutBtn.textContent = `Layout: ${L[this.layoutIdx].label}`;
      this.applyLayout();
      this.updateForceSliderVisibility();
    });
    btn('.net-fit')?.addEventListener('click', () => this.fit());
    const edgesBtn = btn('.net-edges');
    edgesBtn?.addEventListener('click', () => {
      this.edgesVisible = !this.edgesVisible;
      edgesBtn.setAttribute('aria-pressed', String(this.edgesVisible));
      edgesBtn.textContent = this.edgesVisible ? 'Hide edges' : 'Show edges';
      this.requestDraw();
    });
    const implicitBtn = btn('.net-implicit');
    implicitBtn?.addEventListener('click', () => {
      this.showImplicit = !this.showImplicit;
      implicitBtn.setAttribute('aria-pressed', String(this.showImplicit));
      implicitBtn.textContent = this.showImplicit ? '− Inferred' : '+ Inferred';
      this.requestDraw();
    });
    const multiBtn = btn('.net-multi');
    multiBtn?.addEventListener('click', () => {
      this.multiMode = !this.multiMode;
      multiBtn.setAttribute('aria-pressed', String(this.multiMode));
      multiBtn.textContent = this.multiMode ? 'Multi: on' : 'Multi: off';
    });
    const colorBtn = btn('.net-color');
    colorBtn?.addEventListener('click', () => {
      const mode = this.colorMode === 'type' ? 'community' : 'type';
      this.setColorMode(mode);
      colorBtn.setAttribute('aria-pressed', String(mode === 'community'));
      colorBtn.textContent = mode === 'community' ? 'Colour: Community' : 'Colour: Type';
      root.classList.toggle('color-by-community', mode === 'community');
    });
    const fsEl = this.opts.fullscreenEl ?? root;
    const fsBtn = btn('.net-fullscreen');
    const setFullscreen = (on: boolean) => {
      fsEl.classList.toggle('fullscreen', on);
      fsBtn?.setAttribute('aria-pressed', String(on));
      if (fsBtn) fsBtn.textContent = on ? 'Exit' : 'Fullscreen';
      document.body.classList.toggle('net-fullscreen-active', on);
      requestAnimationFrame(() => { this.resize(); this.fit(); });
    };
    fsBtn?.addEventListener('click', () => setFullscreen(!fsEl.classList.contains('fullscreen')));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fsEl.classList.contains('fullscreen')) setFullscreen(false);
    });
    root.querySelectorAll('.net-drawer-toggle').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const drawer = toggle.closest('.net-drawer');
        if (!drawer) return;
        const collapsed = drawer.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
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
          const prev = this.forceMult;
          this.forceMult = pct / 100;
          if (this.currentLayout === 'force') this.opts.onForceSlider?.(this.forceMult, prev, this);
        }
      });
    });
    this.updateForceSliderVisibility();
    this.panel?.querySelector('.gs-deselect')?.addEventListener('click', () => this.clearSelection());
  }
  private updateForceSliderVisibility(): void {
    const el = this.root.querySelector('[data-force-only]') as HTMLElement | null;
    if (el) el.style.display = this.currentLayout === 'force' ? '' : 'none';
  }

  handleClick(cx: number, cy: number, shift: boolean): void {
    const r = this.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const additive = shift || this.multiMode;
    const hit = this.hitTest(px, py);
    if (hit < 0) {
      const edgeHit = this.edgeHitTest(px, py);
      if (edgeHit >= 0) {
        if (additive) {
          if (this.selectedEdges.has(edgeHit)) this.selectedEdges.delete(edgeHit);
          else this.selectedEdges.add(edgeHit);
        } else {
          this.selectedNodes.clear(); this.selectedEdges.clear();
          this.selectedEdges.add(edgeHit);
        }
        this.selectionChanged();
        return;
      }
      if (!additive && (this.selectedNodes.size > 0 || this.selectedEdges.size > 0)) this.clearSelection();
      return;
    }
    if (additive) {
      if (this.selectedNodes.has(hit)) this.selectedNodes.delete(hit);
      else this.selectedNodes.add(hit);
    } else {
      const wasOnly = this.selectedNodes.size === 1 && this.selectedEdges.size === 0 && this.selectedNodes.has(hit);
      this.selectedNodes.clear(); this.selectedEdges.clear();
      if (!wasOnly) this.selectedNodes.add(hit);
    }
    this.selectionChanged();
  }

  // --- Selection panel + tooltips ---------------------------------------------
  updateSelectionPanel(): void {
    const { panel, nodes, edges } = this;
    if (!panel) return;
    const q = (sel: string) => panel.querySelector(sel) as HTMLElement | null;
    const goB = q('.gs-go-b');
    goB?.setAttribute('hidden', '');
    const go = q('.gs-go') as HTMLAnchorElement;
    go.textContent = 'Go to page →';
    go.removeAttribute('hidden');
    q('.gs-meta')?.classList.remove('hidden-meta');
    q('.gs-summary')?.setAttribute('hidden', '');
    q('.gs-bridge')?.setAttribute('hidden', '');
    q('.gs-hub')?.setAttribute('hidden', '');

    const nc = this.selectedNodes.size, ec = this.selectedEdges.size;
    if (nc + ec === 0) { panel.setAttribute('hidden', ''); return; }
    const eyebrow = q('.gs-eyebrow')!, title = q('.gs-title')!, count = q('.gs-count')!;

    if (nc + ec === 1 && ec === 1) {
      const e = edges[this.selectedEdges.values().next().value as number];
      const a = nodes[e[0]], b = nodes[e[1]];
      eyebrow.textContent = 'Connection';
      eyebrow.className = 'gs-eyebrow';
      title.textContent = `${a.title} ↔ ${b.title}`;
      count.textContent = '';
      q('.gs-meta')?.classList.add('hidden-meta');
      go.href = hrefFor(a);
      go.textContent = `Go to ${a.title} →`;
      let goB2 = q('.gs-go-b') as HTMLAnchorElement | null;
      if (!goB2) {
        goB2 = document.createElement('a');
        goB2.className = 'gs-go gs-go-b';
        go.parentNode!.insertBefore(goB2, go.nextSibling);
      }
      goB2.href = hrefFor(b);
      goB2.textContent = `Go to ${b.title} →`;
      goB2.removeAttribute('hidden');
      panel.removeAttribute('hidden');
      return;
    }
    if (nc + ec === 1 && nc === 1) {
      const n = nodes[this.selectedNodes.values().next().value as number];
      eyebrow.textContent = TYPE_LABELS[n.type] || '';
      eyebrow.className = `gs-eyebrow type-${n.type}`;
      title.textContent = n.title;
      count.textContent = n.count.toLocaleString();
      if (n.bridgeRank) { q('.gs-bridge-rank')!.textContent = '#' + n.bridgeRank; q('.gs-bridge')?.removeAttribute('hidden'); }
      if (n.hubRank) { q('.gs-hub-rank')!.textContent = '#' + n.hubRank; q('.gs-hub')?.removeAttribute('hidden'); }
      if (n.isFocal) go.setAttribute('hidden', '');
      else go.href = hrefFor(n);
      panel.removeAttribute('hidden');
      return;
    }
    const link = (n: GraphNode) => `<a href="${hrefFor(n)}" class="gs-summary-link type-${n.type}">${escapeHtml(n.title)}</a>`;
    const pieces: string[] = [];
    for (const i of this.selectedNodes) pieces.push(link(nodes[i]));
    for (const k of this.selectedEdges) {
      const e = edges[k];
      pieces.push(`${link(nodes[e[0]])}<span class="gs-summary-link-sep">↔</span>${link(nodes[e[1]])}`);
    }
    const MAX = 8;
    let html = pieces.slice(0, MAX).join(', ');
    if (pieces.length > MAX) html += `<span class="gs-summary-more">, +${pieces.length - MAX} more</span>`;
    eyebrow.textContent = 'Multi-select';
    eyebrow.className = 'gs-eyebrow';
    const parts: string[] = [];
    if (nc) parts.push(`${nc} ${nc === 1 ? 'entity' : 'entities'}`);
    if (ec) parts.push(`${ec} ${ec === 1 ? 'connection' : 'connections'}`);
    title.textContent = parts.join(' · ');
    count.textContent = '';
    q('.gs-meta')?.classList.add('hidden-meta');
    const sum = q('.gs-summary')!;
    sum.innerHTML = html;
    sum.removeAttribute('hidden');
    go.setAttribute('hidden', '');
    panel.removeAttribute('hidden');
  }

  private placeTooltip(px: number, py: number): void {
    const { tooltip, shell } = this;
    tooltip.removeAttribute('hidden');
    const sr = shell.getBoundingClientRect();
    const maxX = sr.width - tooltip.offsetWidth - 8;
    tooltip.style.left = Math.min(Math.max(8, px + 14), maxX) + 'px';
    tooltip.style.top = Math.max(8, py - tooltip.offsetHeight - 10) + 'px';
  }
  showTooltip(n: GraphNode, px: number, py: number): void {
    this.tooltip.innerHTML =
      '<div class="gt-pair"><span>' + escapeHtml(n.title) + '</span></div>' +
      '<div class="gt-meta">' + escapeHtml(TYPE_LABELS[n.type] || n.type) +
      ' · ' + n.count.toLocaleString() + ' mentions' +
      (n.bridgeRank ? ' · bridge #' + n.bridgeRank : '') +
      (n.hubRank ? ' · hub #' + n.hubRank : '') +
      (this.colorMode === 'community' && n.community >= 0 ? ' · cluster ' + (n.community + 1) : '') +
      '</div>';
    this.placeTooltip(px, py);
  }
  showEdgeTooltip(a: GraphNode, b: GraphNode, px: number, py: number): void {
    this.tooltip.innerHTML =
      '<div class="gt-pair"><span>' + escapeHtml(a.title) + '</span> ' +
      '<span class="gt-link">&mdash;</span> <span>' + escapeHtml(b.title) + '</span></div>' +
      '<div class="gt-meta">connection · click to pin</div>';
    this.placeTooltip(px, py);
  }
}

/** Build engine nodes from adjacency.json for a list of global indices. */
export function nodeFromAdjacency(data: any, i: number, size: number): GraphNode {
  const br = data.bridges?.[String(i)];
  const hu = data.hubs?.[String(i)];
  return {
    id: data.ids[i],
    title: data.titles[i],
    type: data.types[i],
    count: data.mentions[i] || 0,
    bridgeRank: br ? (typeof br === 'object' ? br.rank : br) : 0,
    bridgeScore: br && typeof br === 'object' ? br.score : 0,
    hubRank: hu ? (typeof hu === 'object' ? hu.rank : hu) : 0,
    hubScore: hu && typeof hu === 'object' ? hu.score : 0,
    community: data.communities ? data.communities[i] : -1,
    x: 0, y: 0, size, visible: true,
  };
}

/** Fetch adjacency.json once per page; shared with the path widgets. */
export function loadAdjacency(): Promise<any> {
  const w = window as any;
  if (w._netAdj) return Promise.resolve(w._netAdj);
  if (w._netAdjP) return w._netAdjP;
  w._netAdjP = fetch('/adjacency.json?v=' + w.__V)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('fetch failed'))))
    .then((d) => { w._netAdj = d; return d; })
    .catch((err) => { w._netAdjP = null; throw err; });
  return w._netAdjP;
}
