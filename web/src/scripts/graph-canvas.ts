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
import { EDGE_CROSS, EDGE_FOCAL, EDGE_IMPLICIT, EDGE_SKIP, NODE_BRIDGE, NODE_HOP2, NODE_SKIP, renderIdleEdges, type EdgeScene } from './graph-edges';
import { EdgeBatch, GraphGL, cssRgba, cssRgbaAlpha } from './graph-gl';

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  count: number;
  bridgeRank: number;
  hubRank: number;
  community: number;
  /** Sub-community inside `community`, or -1. */
  sub: number;
  x: number;
  y: number;
  size: number;
  visible: boolean;
  color?: string;
  isFocal?: boolean;
  hop?: number;
  isLandmark?: boolean;
  isolated?: boolean;
  /** Index into adjacency.json, when the graph is built from it. */
  g?: number;
  /** Label priority; higher wins. Defaults to `count`. */
  priority?: number;
}

/** A label pinned to a place in layout space, such as a cluster's name. */
export interface Annotation {
  x: number;
  y: number;
  r: number;
  text: string;
  /** Shown only when zoomed in at least this far past the fitted view. */
  minZoom?: number;
}

export type Edge = [number, number];

/** Edges drawn offscreen for one view, reused until something they show changes. */
interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** What is composited: the canvas, or a bitmap the edge worker sent. */
  image?: CanvasImageSource;
  view: { tx: number; ty: number; scale: number } | null;
  key: string;
}
function newLayer(): Layer {
  const canvas = document.createElement('canvas');
  return { canvas, ctx: canvas.getContext('2d') as CanvasRenderingContext2D, view: null, key: '' };
}

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
  /** Extra lines for the selection panel when one node is selected. */
  describe?: (i: number) => (Node | string)[][];
}

// The full graph has thousands of nodes: smaller dots, fainter edges, and
// labels only for landmarks or nodes big enough on screen. Edges between other
// nodes use edgeInk/edgeAlpha; the entity graph's spokes to its focal entry are fainter,
// and on its Clusters layout so are links between islands (crossEdgeAlpha).
const HOVER_DELAY = 110;
const HOVER_FADE = 160;

const PROFILES = {
  entity: { zoomMax: 20, fitPad: 30, minR: 3, maxR: 12, edgeAlpha: .3, edgeInk: 'muted', edgeWidth: .8, focalEdgeAlpha: .3, crossEdgeAlpha: .1, labelAll: true, searchZoom: 1.1 },
  full: { zoomMax: 50, fitPad: 40, minR: 1.7, maxR: 9, edgeAlpha: .25, edgeInk: 'line', edgeWidth: .65, focalEdgeAlpha: .25, crossEdgeAlpha: .25, labelAll: false, searchZoom: .8 },
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
  /** Edge index to the typed relation it carries, drawn solid and labelled. */
  relationEdges = new Map<number, string>();
  /** Set by a layout; cleared before each layout runs. */
  annotations: Annotation[] = [];
  /** Radians the layout has been turned by two-finger rotation since it was laid out. */
  private rotation = 0;
  /** A rotation in progress (WebGL path): screen positions turn by it about a screen point
   *  until release bakes it into the layout. */
  private turn: { c: number; s: number; x: number; y: number } | null = null;
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
  /** How far a selection or hover fades everything else, 0 (not at all) to 1. */
  highlightStrength = 1;
  /** 0 to 1: how far the hover highlight has faded in. It waits HOVER_DELAY ms, then fades over
   *  HOVER_FADE ms, so sweeping the pointer across the graph does not flash every node passed. */
  private hoverMix = 1;
  private hoverFadeStart = 0;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  forceMult = 1;
  currentLayout: string;
  private layoutIdx = 0;
  private dpr = 1;
  private fitScale = 1;
  private drawScheduled = false;
  /** Runs at the start of each frame's draw, so an animated view change paints in the same frame. */
  private beforeDraw: (() => void) | null = null;
  /** True while panning or zooming: the full graph skips labels until it settles. */
  private interacting = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  // Screen positions and radii, reused across frames.
  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private pr = new Float64Array(0);
  private truncated = new Map<string, string>();
  private textWidths = new Map<string, number>();
  /** Edge indices touching each node. */
  incident: number[][] = [];
  // Idle edges, and the selection's edges, each cached for the view they were drawn in.
  // Bumping `version` (positions, visibility, colours or selection changed) redraws both.
  private idleLayer = newLayer();
  /** Extra px past the screen that edgeShown keeps, while a layer with a margin renders. */
  private cullPad = 0;
  private selectionLayer = newLayer();
  private version = 0;
  /** Bumped only by what changes the idle edges (layout, visibility, colours, data), so a
   *  click that only changes the selection keeps the cached idle edges. */
  private edgeVersion = 0;
  private visibleSig = 0;
  /** Bumped when node colours change (colour mode, theme). */
  private colorVersion = 0;
  private scene: { version: string; scene: EdgeScene } | null = null;
  /** undefined until first needed; null where workers or OffscreenCanvas are missing. */
  private edgeWorker: Worker | null | undefined;
  private workerScene = '';
  private edgeRequest: { id: number; key: string; nodeKey: string; view: { tx: number; ty: number; scale: number } } | null = null;
  /** Idle nodes as the worker last drew them, composited instead of drawing each node while
   *  a gesture runs with nothing selected or hovered. */
  private nodeLayer: { image: ImageBitmap | null; key: string; view: { tx: number; ty: number; scale: number } | null } = { image: null, key: '', view: null };
  private edgeRequestId = 0;
  /** WebGL2 renderer for edges and idle nodes, under the 2D canvas; null without WebGL2,
   *  or after its context is lost, when everything draws in 2D (with the worker's help). */
  private gl: GraphGL | null = null;
  private glScene = '';
  private look = new Float32Array(0);

  constructor(root: HTMLElement, opts: EngineOptions) {
    this.root = root;
    this.opts = opts;
    this.P = PROFILES[opts.profile];
    this.shell = root.querySelector('.net-shell') as HTMLElement;
    this.canvas = root.querySelector('.net-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.gl = GraphGL.create();
    if (this.gl) {
      Object.assign(this.gl.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      this.gl.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.style.position = 'relative';
      this.canvas.before(this.gl.canvas);
      this.gl.onLost = () => this.requestDraw();
    }
    // Widths measured in a fallback face are wrong once the web font arrives.
    document.fonts?.addEventListener('loadingdone', () => { this.textWidths.clear(); this.truncated.clear(); this.requestDraw(); });
    this.tooltip = root.querySelector('.net-tooltip') as HTMLElement;
    this.panel = root.querySelector('.net-selection') as HTMLElement;
    this.COLORS = readColors(root);
    this.showImplicit = opts.showImplicit;
    this.currentLayout = opts.layouts[0].key;
    window.addEventListener('themechange', () => {
      this.COLORS = readColors(root);
      this.version++;
      this.edgeVersion++;
      this.recolor();
      this.requestDraw();
    });
    window.addEventListener('resize', () => { if (this.nodes.length) this.resize(); });
    // A folded entry section hides the shell; this catches it being shown again at a new size.
    new ResizeObserver(() => { if (this.nodes.length) this.resize(); }).observe(this.shell);
  }

  // --- Data ---------------------------------------------------------------
  /** Edges are index pairs into `nodes`; `implicit` holds the indices of
   *  edges with no wikilink behind them. */
  setGraph(nodes: GraphNode[], edges: Edge[], implicit: Set<number>): void {
    this.nodes = nodes;
    this.edges = edges;
    this.implicitEdgeIdx = implicit;
    this.relationEdges = new Map();
    this.px = new Float64Array(nodes.length);
    this.py = new Float64Array(nodes.length);
    this.pr = new Float64Array(nodes.length);
    this.neighborSets = Array.from({ length: nodes.length }, () => new Set<number>());
    this.incident = Array.from({ length: nodes.length }, () => [] as number[]);
    this.version++;
    this.edgeVersion++;
    edges.forEach(([a, b], k) => {
      this.incident[a].push(k);
      this.incident[b].push(k);
      this.neighborSets[a].add(b);
      this.neighborSets[b].add(a);
    });
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
    this.colorVersion++;
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
    if (!rect.width || !rect.height) return; // hidden: keep the last size until shown again
    const dpr = Math.max(1, window.devicePixelRatio || 1), w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (w === this.canvas.width && h === this.canvas.height && dpr === this.dpr) return this.requestDraw();
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
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
  /** Screen position of a layout point, turned by any rotation in progress. */
  private project(x: number, y: number): [number, number] {
    const X = this.sx(x), Y = this.sy(y), t = this.turn;
    if (!t) return [X, Y];
    const dx = X - t.x, dy = Y - t.y;
    return [t.x + dx * t.c - dy * t.s, t.y + dx * t.s + dy * t.c];
  }
  private sy(y: number): number { return y * this.view.scale + this.view.ty; }

  /** Turn the layout by `angle` around layout point (cx, cy): node and island positions
   *  change, so every renderer, hit test and label follows with nothing else to know. */
  private rotateLayout(angle: number, cx: number, cy: number): void {
    const c = Math.cos(angle), s = Math.sin(angle);
    for (const p of [...this.nodes, ...this.annotations]) {
      const dx = p.x - cx, dy = p.y - cy;
      p.x = cx + dx * c - dy * s;
      p.y = cy + dx * s + dy * c;
    }
    this.rotation += angle;
    this.version++;
    this.edgeVersion++;
    this.requestDraw();
  }

  /** Fit the visible nodes to the canvas, undoing any rotation first. */
  fit(): void {
    if (this.rotation) this.rotateLayout(-this.rotation, 0, 0);
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
    // Island names sit outside the dots, so leave room for them.
    const pad = this.P.fitPad + (this.annotations.some((a) => !a.minZoom) ? 40 : 0);
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.view.scale = this.fitScale = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    this.view.tx = (W - w * this.view.scale) / 2 - minX * this.view.scale;
    this.view.ty = (H - h * this.view.scale) / 2 - minY * this.view.scale;
    this.requestDraw();
  }

  /** Run the current layout, refit and redraw. */
  applyLayout(): void {
    this.annotations = [];
    this.rotation = 0;
    this.version++;
    this.edgeVersion++;
    this.opts.layouts.find((l) => l.key === this.currentLayout)!.apply(this);
    this.fit();
  }

  /** After the canvas changes size: the Clusters layout packs to the canvas shape,
   *  so it runs again; other layouts just refit. */
  private refitAfterResize(): void {
    this.resize();
    if (this.annotations.length) this.applyLayout();
    else this.fit();
  }

  /** Stretch the layout around the screen centre, so pan and zoom survive. */
  private scaleLayout(ratio: number): void {
    const { W, H } = this.canvasSize();
    for (const n of this.nodes) { n.x *= ratio; n.y *= ratio; }
    this.version++;
    this.edgeVersion++;
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
    this.version++; // positions, visibility or selection
    let sig = 0;
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i].visible) sig = (sig * 31 + i + 1) | 0;
    if (sig !== this.visibleSig) { this.visibleSig = sig; this.edgeVersion++; }
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

  /** Mark a pan or zoom step. The full graph draws labels again once input settles. */
  private moved(): void {
    this.interacting = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.interacting = false; this.requestDraw(); }, 140);
    this.requestDraw();
  }

  /** Width of `text` in the current font, cached. */
  private textWidth(text: string): number {
    const key = `${this.ctx.font}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) this.textWidths.set(key, w = this.ctx.measureText(text).width);
    return w;
  }

  /** `text` cut with an ellipsis to fit `max` px in the current font, cached. */
  private fitText(text: string, max: number): string {
    const key = `${this.ctx.font}|${max}|${text}`;
    let out = this.truncated.get(key);
    if (out === undefined) {
      out = text;
      while (this.ctx.measureText(out).width > max && out.length > 4) out = out.slice(0, -2);
      if (out !== text) out = out.trimEnd() + '…';
      this.truncated.set(key, out);
    }
    return out;
  }

  /** Stroke edges as straight segments, a few hundred per path: one path of
   *  thousands of crossing segments rasterises far slower. */
  private strokeEdges(c: CanvasRenderingContext2D, list: number[], width: number, color: string, dashed: boolean): void {
    if (!list.length) return;
    const { edges, px, py } = this;
    c.setLineDash(dashed ? [3, 5] : []);
    c.lineWidth = width;
    c.strokeStyle = color;
    c.beginPath();
    for (let j = 0; j < list.length; j++) {
      const [a, b] = edges[list[j]];
      c.moveTo(px[a], py[a]);
      c.lineTo(px[b], py[b]);
      if (j % 256 === 255) { c.stroke(); c.beginPath(); }
    }
    c.stroke();
    c.setLineDash([]);
  }

  /** Bring `layer` up to date for the current view, except mid-gesture, when the
   *  old copy is shifted and scaled instead; then composite it onto the canvas.
   *  The layer extends a quarter screen past each edge, so a pan or zoom-out shows
   *  edges already drawn; a gesture that outruns that margin redraws at once. */
  private paintLayer(layer: Layer, key: string, W: number, H: number, alpha: number, render: (c: CanvasRenderingContext2D) => void): void {
    const v = this.view;
    const mx = Math.round(W / 4), my = Math.round(H / 4);
    let at = layer.view;
    const place = (from: { tx: number; ty: number; scale: number }) => {
      const s = v.scale / from.scale;
      return { x: v.tx - from.tx * s - mx * s, y: v.ty - from.ty * s - my * s, w: (W + 2 * mx) * s, h: (H + 2 * my) * s };
    };
    const stale = !at || layer.key !== key || (at.tx !== v.tx || at.ty !== v.ty || at.scale !== v.scale) && (() => {
      if (!this.interacting) return true;
      const r = place(at!);
      return r.x > 0 || r.y > 0 || r.x + r.w < W || r.y + r.h < H;
    })();
    if (stale) {
      const cw = Math.round((W + 2 * mx) * this.dpr), ch = Math.round((H + 2 * my) * this.dpr);
      if (layer.canvas.width !== cw || layer.canvas.height !== ch) {
        layer.canvas.width = cw;
        layer.canvas.height = ch;
      }
      layer.ctx.setTransform(this.dpr, 0, 0, this.dpr, mx * this.dpr, my * this.dpr);
      layer.ctx.clearRect(-mx, -my, W + 2 * mx, H + 2 * my);
      this.cullPad = Math.max(mx, my);
      render(layer.ctx);
      this.cullPad = 0;
      at = layer.view = { ...v };
      layer.key = key;
    }
    const r = place(at!);
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(layer.canvas, r.x, r.y, r.w, r.h);
    this.ctx.globalAlpha = 1;
  }

  /** The idle edges, by flag per edge, rebuilt when edgeVersion moves. */
  private sceneVersion(): string { return `${this.edgeVersion}|${this.colorVersion}`; }

  private edgeScene(): EdgeScene {
    if (this.scene?.version === this.sceneVersion()) return this.scene.scene;
    const { nodes, edges, COLORS, P } = this;
    const pairs = new Uint32Array(edges.length * 2), flags = new Uint8Array(edges.length);
    const x = new Float64Array(nodes.length), y = new Float64Array(nodes.length);
    nodes.forEach((n, i) => { x[i] = n.x; y[i] = n.y; });
    const islands = this.annotations.length > 0;
    edges.forEach(([a, b], k) => {
      pairs[2 * k] = a;
      pairs[2 * k + 1] = b;
      // On the entity graph, links between neighbours are the story (every neighbour links
      // to the focal entry), so they draw stronger than its own.
      const cls = nodes[a].isFocal || nodes[b].isFocal ? EDGE_FOCAL : islands && nodes[a].community !== nodes[b].community ? EDGE_CROSS : 0;
      const skip = this.relationEdges.has(k) || !nodes[a].visible || !nodes[b].visible;
      flags[k] = cls | (this.implicitEdgeIdx.has(k) ? EDGE_IMPLICIT : 0) | (skip ? EDGE_SKIP : 0);
    });
    const palette: string[] = [], paletteIdx = new Map<string, number>();
    const size = new Float32Array(nodes.length), color = new Uint16Array(nodes.length), nodeFlags = new Uint8Array(nodes.length);
    nodes.forEach((n, i) => {
      const c = n.isFocal ? COLORS.accent : n.color || COLORS.muted;
      let ci = paletteIdx.get(c);
      if (ci === undefined) { paletteIdx.set(c, ci = palette.length); palette.push(c); }
      color[i] = ci;
      size[i] = n.size;
      nodeFlags[i] = (!n.visible || n.isFocal ? NODE_SKIP : 0) | (n.bridgeRank ? NODE_BRIDGE : 0) | (n.hop === 2 ? NODE_HOP2 : 0);
    });
    const scene: EdgeScene = {
      pairs, x, y, flags,
      styles: {
        cross: hexToRgba(COLORS.line, P.crossEdgeAlpha),
        focal: hexToRgba(COLORS.line, P.focalEdgeAlpha),
        between: hexToRgba(COLORS[P.edgeInk], P.edgeAlpha),
        width: P.edgeWidth,
      },
      nodes: { size, color, palette, flags: nodeFlags, paper: COLORS.paper, gold: COLORS.gold, minR: P.minR, maxR: P.maxR },
    };
    this.scene = { version: this.sceneVersion(), scene };
    return scene;
  }

  /** The worker that renders idle edges off the main thread, started on first use. */
  private getEdgeWorker(): Worker | null {
    if (this.edgeWorker !== undefined) return this.edgeWorker;
    this.edgeWorker = null;
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || !('transferToImageBitmap' in OffscreenCanvas.prototype)) return null;
    try {
      const w = new Worker(new URL('./graph-edge-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; bitmap?: ImageBitmap; nodeBitmap?: ImageBitmap }>) => {
        const req = this.edgeRequest, { id, bitmap, nodeBitmap } = e.data;
        if (!req || id !== req.id) { bitmap?.close(); nodeBitmap?.close(); return; }
        this.edgeRequest = null;
        const layer = this.idleLayer;
        // A layer redrawn for new edges since the request makes this bitmap stale.
        if (bitmap && req.key === layer.key) {
          if (layer.image && layer.image !== layer.canvas) (layer.image as ImageBitmap).close();
          layer.image = bitmap;
          layer.view = req.view;
        } else bitmap?.close();
        if (nodeBitmap && req.nodeKey === this.nodeKey()) {
          this.nodeLayer.image?.close();
          this.nodeLayer = { image: nodeBitmap, key: req.nodeKey, view: req.view };
        } else nodeBitmap?.close();
        this.requestDraw();
      };
      // A worker that fails to load leaves the main thread to draw, as before.
      w.onerror = () => {
        w.terminate();
        this.edgeWorker = null;
        this.edgeRequest = null;
        this.nodeLayer.image?.close();
        this.nodeLayer = { image: null, key: '', view: null };
        this.requestDraw();
      };
      this.edgeWorker = w;
    } catch { /* stays null */ }
    return this.edgeWorker;
  }

  /** The idle edges, cached a quarter screen past each edge. When only the view changed, the
   *  worker renders the new view while the old bitmap is shifted and scaled, so a gesture
   *  never blocks on it, and it refreshes as often as the worker keeps up. New edges
   *  (layout, filters, theme) and browsers without the worker draw here, as before. */
  /** Upload the idle edges and node data when the scene changes. */
  private syncGL(gl: GraphGL): void {
    const key = `${this.sceneVersion()}|${this.showImplicit}`;
    if (this.glScene === key) return;
    this.glScene = key;
    const s = this.edgeScene(), { pairs, flags, x, y } = s;
    // In the 2D pass's order: between islands, to the focal entry, between neighbours; each
    // linked, then inferred.
    const styles = [[s.styles.between, s.styles.width], [s.styles.focal, .7], [s.styles.cross, .65]] as const;
    const batch = new EdgeBatch(flags.length);
    for (const cls of [2, 1, 0]) {
      const rgba = cssRgba(styles[cls][0]), width = styles[cls][1];
      for (const implicit of [false, true]) {
        if (implicit && !this.showImplicit) continue;
        for (let k = 0; k < flags.length; k++) {
          const f = flags[k];
          if (f & EDGE_SKIP || (f >> 2) !== cls || ((f & EDGE_IMPLICIT) !== 0) !== implicit) continue;
          const a = pairs[2 * k], b = pairs[2 * k + 1];
          batch.push(x[a], y[a], x[b], y[b], rgba, width, implicit);
        }
      }
    }
    gl.setIdleEdges(batch);
    const ns = s.nodes, rgba = new Uint8Array(x.length * 4);
    const palette = ns.palette.map(cssRgba);
    for (let i = 0; i < x.length; i++) rgba.set(palette[ns.color[i]], i * 4);
    gl.setNodes(x, y, ns.size, rgba);
    this.look = new Float32Array(x.length * 2);
  }

  /** Lit edges as drawLitEdges strokes them, as a WebGL batch. */
  private litBatch(lit: Iterable<number>): EdgeBatch {
    const { nodes, edges } = this;
    const linked: number[] = [], inferred: number[] = [], relations: number[] = [];
    for (const k of lit) {
      const [a, b] = edges[k];
      if (!nodes[a].visible || !nodes[b].visible) continue;
      if (this.relationEdges.has(k)) relations.push(k);
      else if (!this.implicitEdgeIdx.has(k)) linked.push(k);
      else if (this.showImplicit) inferred.push(k);
    }
    const n = linked.length + inferred.length;
    const color = cssRgbaAlpha(this.COLORS.accent, Math.max(.2, Math.min(.72, 6 / Math.sqrt(n || 1))));
    const width = n > 150 ? 1 : 1.3;
    const batch = new EdgeBatch(n + relations.length);
    const add = (list: number[], c: [number, number, number, number], w: number, dashed: boolean) => {
      for (const k of list) { const [a, b] = edges[k]; batch.push(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y, c, w, dashed); }
    };
    add(linked, color, width, false);
    add(inferred, color, width, true);
    add(relations, cssRgba(this.COLORS.accent), 2, false);
    return batch;
  }

  /** Where a layer drawn for view `from`, a quarter screen past each edge, lands now. */
  private placeLayer(from: { tx: number; ty: number; scale: number }, W: number, H: number) {
    const v = this.view, s = v.scale / from.scale, mx = Math.round(W / 4), my = Math.round(H / 4);
    return { x: v.tx - from.tx * s - mx * s, y: v.ty - from.ty * s - my * s, w: (W + 2 * mx) * s, h: (H + 2 * my) * s };
  }

  /** The selection's focus as one byte per node, or null with nothing selected. */
  private focusMask(): Uint8Array | null {
    if (!this.focusNodes) return null;
    const m = new Uint8Array(this.nodes.length);
    for (const i of this.focusNodes) m[i] = 1;
    return m;
  }

  private nodeKey(): string {
    const { W, H } = this.canvasSize();
    // A selection fades the nodes outside it, so its bitmap is keyed on the selection too.
    const sel = this.focusNodes ? `${this.version}|${this.highlightStrength}` : '-';
    return `${W}|${H}|${this.dpr}|${this.sceneVersion()}|${this.opacityMult}|${sel}`;
  }

  private paintIdleLayer(W: number, H: number, alpha: number): void {
    const layer = this.idleLayer, v = this.view;
    const mx = Math.round(W / 4), my = Math.round(H / 4), dpr = this.dpr;
    const key = `${W}|${H}|${dpr}|${this.showImplicit}|${this.edgeVersion}`;
    const place = (from: { tx: number; ty: number; scale: number }) => this.placeLayer(from, W, H);
    const moved = (a: { tx: number; ty: number; scale: number } | null) => !a || a.tx !== v.tx || a.ty !== v.ty || a.scale !== v.scale;
    const drawHere = () => {
      const cw = Math.round((W + 2 * mx) * dpr), ch = Math.round((H + 2 * my) * dpr);
      if (layer.canvas.width !== cw || layer.canvas.height !== ch) { layer.canvas.width = cw; layer.canvas.height = ch; }
      layer.ctx.setTransform(dpr, 0, 0, dpr, mx * dpr, my * dpr);
      layer.ctx.clearRect(-mx, -my, W + 2 * mx, H + 2 * my);
      renderIdleEdges(layer.ctx, this.edgeScene(), v, W, H, Math.max(mx, my), this.showImplicit);
      if (layer.image && layer.image !== layer.canvas) (layer.image as ImageBitmap).close();
      layer.image = layer.canvas;
      layer.view = { ...v };
      layer.key = key;
    };
    if (!layer.view || layer.key !== key) drawHere();
    const worker = this.getEdgeWorker();
    if (moved(layer.view)) {
      const r = place(layer.view!), covered = r.x <= 0 && r.y <= 0 && r.x + r.w >= W && r.y + r.h >= H;
      // A jump outside a gesture (a search result) that leaves the old edges short draws here.
      if (!(worker && (this.interacting || covered)) && (!this.interacting || !covered)) drawHere();
    }
    const nodeKey = this.nodeKey();
    const wantEdges = moved(layer.view), wantNodes = this.nodeLayer.key !== nodeKey || moved(this.nodeLayer.view);
    if (worker && !this.edgeRequest && (wantEdges || wantNodes)) {
      const version = this.sceneVersion();
      if (this.workerScene !== version) {
        worker.postMessage({ type: 'scene', version, scene: this.edgeScene() });
        this.workerScene = version;
      }
      const id = ++this.edgeRequestId, view = { ...v };
      this.edgeRequest = { id, key, nodeKey, view };
      worker.postMessage({
        type: 'render', id, version, view, W, H, dpr, mx, my, showImplicit: this.showImplicit,
        edges: wantEdges, nodes: wantNodes, opacity: this.opacityMult,
        focus: this.focusMask(), strength: this.highlightStrength,
      });
    }
    const r = place(layer.view!);
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(layer.image ?? layer.canvas, r.x, r.y, r.w, r.h);
    this.ctx.globalAlpha = 1;
  }

  /** Whether edge k is visible and could cross the screen. */
  private edgeShown(k: number, W: number, H: number): boolean {
    const [a, b] = this.edges[k], { px, py } = this, m = this.cullPad;
    if (!this.nodes[a].visible || !this.nodes[b].visible) return false;
    return !((px[a] < -m && px[b] < -m) || (px[a] > W + m && px[b] > W + m) || (py[a] < -m && py[b] < -m) || (py[a] > H + m && py[b] > H + m));
  }


  /** Highlighted edges: linked, inferred (dashed), then typed relations. */
  private drawLitEdges(c: CanvasRenderingContext2D, lit: Iterable<number>, W: number, H: number): void {
    const linked: number[] = [], inferred: number[] = [], relations: number[] = [];
    for (const k of lit) {
      if (!this.edgeShown(k, W, H)) continue;
      if (this.relationEdges.has(k)) relations.push(k);
      else if (!this.implicitEdgeIdx.has(k)) linked.push(k);
      else if (this.showImplicit) inferred.push(k);
    }
    // A hub lights a thousand lines; fade them as they multiply so the nodes stay legible.
    const n = linked.length + inferred.length;
    const color = hexToRgba(this.COLORS.accent, Math.max(.2, Math.min(.72, 6 / Math.sqrt(n || 1))));
    const width = n > 150 ? 1 : 1.3;
    this.strokeEdges(c, linked, width, color, false);
    this.strokeEdges(c, inferred, width, color, true);
    this.strokeEdges(c, relations, 2, this.COLORS.accent, false);
  }

  private draw(): void {
    // A lost context falls back to 2D before anything projects; a live turn belongs to the
    // GL path, so the rest of that gesture turns under CSS instead.
    if (this.gl?.lost) { this.gl.canvas.remove(); this.gl = null; this.turn = null; }
    this.beforeDraw?.();
    const { nodes, ctx, COLORS, px, py, pr } = this;
    const { W, H } = this.canvasSize();
    if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    // The paper and its dot grid are the shell's CSS background.
    ctx.clearRect(0, 0, W, H);
    if (!nodes.length) return;

    const hasSelection = this.selectedNodes.size > 0 || this.selectedEdges.size > 0;
    if (this.hoverFadeStart) {
      this.hoverMix = Math.min(1, (performance.now() - this.hoverFadeStart) / HOVER_FADE);
      if (this.hoverMix < 1) this.requestDraw();
      else this.hoverFadeStart = 0;
    }
    const hoverFocus = !hasSelection && this.hoveredIdx >= 0 && this.hoverMix > 0
      ? new Set([this.hoveredIdx, ...this.neighborSets[this.hoveredIdx]]) : null;
    const focus = this.focusNodes || hoverFocus;
    // A selection's highlight is immediate; a hover's fades in with hoverMix.
    const mix = this.focusNodes ? 1 : this.hoverMix;
    const strength = this.highlightStrength * mix;
    for (let i = 0; i < nodes.length; i++) {
      [px[i], py[i]] = this.project(nodes[i].x, nodes[i].y);
      pr[i] = this.radius(nodes[i]);
    }
    const isActive = (i: number) => this.selectedNodes.has(i) || i === this.hoveredIdx || !!nodes[i].isFocal;

    const gl = this.gl;
    if (gl) {
      // Every edge and idle node on the GPU, every frame; the 2D canvas above keeps the
      // active nodes, cluster names and labels.
      gl.begin(this.canvas.width, this.canvas.height);
      this.syncGL(gl);
      const t = this.turn;
      gl.turn = t ? [t.c, t.s, t.x, t.y] : [1, 0, 0, 0];
      const v = this.view, dpr = this.dpr;
      if (this.edgesVisible) {
        gl.drawIdle(v, W, H, dpr, focus ? 1 - .64 * strength : 1);
        const selected = new Set(this.selectedEdges);
        for (const i of this.selectedNodes) for (const k of this.incident[i]) selected.add(k);
        if (selected.size) gl.drawBatch(this.litBatch(selected), v, W, H, dpr, 1);
        const hovered = new Set<number>();
        if (this.hoveredIdx >= 0) for (const k of this.incident[this.hoveredIdx]) if (!selected.has(k)) hovered.add(k);
        if (this.hoveredEdge >= 0 && !selected.has(this.hoveredEdge)) hovered.add(this.hoveredEdge);
        if (hovered.size) gl.drawBatch(this.litBatch(hovered), v, W, H, dpr, this.hoverMix);
        const rel = new EdgeBatch(this.relationEdges.size);
        const ink = cssRgbaAlpha(COLORS.ink, focus ? .3 - .15 * mix : .3);
        for (const k of this.relationEdges.keys()) {
          if (selected.has(k) || hovered.has(k)) continue;
          const [a, b] = this.edges[k];
          if (nodes[a].visible && nodes[b].visible) rel.push(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y, ink, 1.2, false);
        }
        gl.drawBatch(rel, v, W, H, dpr, 1);
      }
      const look = this.look;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n.visible || isActive(i)) { look[2 * i] = 0; continue; }
        const inFocus = !focus || focus.has(i);
        look[2 * i] = (inFocus ? .88 : .88 - .75 * strength) * this.opacityMult * (n.hop === 2 ? .62 : 1);
        look[2 * i + 1] = n.bridgeRank && inFocus ? 1 : 0;
      }
      gl.drawNodes(look, v, W, H, dpr, this.P.minR, this.P.maxR, cssRgba(COLORS.paper), cssRgba(COLORS.gold));
    }

    // Without WebGL: idle edges and the selection's edges are cached layers, so hovering
    // reuses them and a pan or zoom shifts them until input settles. Only hover edges and
    // typed relations draw live.
    if (this.edgesVisible && !gl) {
      const key = `${W}|${H}|${this.dpr}|${this.showImplicit}|${this.version}`;
      // A selection or hover fades the idle edges rather than redrawing them.
      this.paintIdleLayer(W, H, focus ? 1 - .64 * strength : 1);
      const selected = new Set(this.selectedEdges);
      for (const i of this.selectedNodes) for (const k of this.incident[i]) selected.add(k);
      if (selected.size) this.paintLayer(this.selectionLayer, key, W, H, 1, (c) => this.drawLitEdges(c, selected, W, H));
      const hovered = new Set<number>();
      if (this.hoveredIdx >= 0) for (const k of this.incident[this.hoveredIdx]) if (!selected.has(k)) hovered.add(k);
      if (this.hoveredEdge >= 0 && !selected.has(this.hoveredEdge)) hovered.add(this.hoveredEdge);
      ctx.save();
      ctx.globalAlpha = this.hoverMix;
      this.drawLitEdges(ctx, hovered, W, H);
      ctx.restore();
      const relations = [...this.relationEdges.keys()].filter((k) => !selected.has(k) && !hovered.has(k) && this.edgeShown(k, W, H));
      this.strokeEdges(ctx, relations, 1.2, hexToRgba(COLORS.ink, focus ? .3 - .15 * mix : .3), false);
    }

    const ring = (x: number, y: number, r: number) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); };
    // Unless a hover is fading in, idle nodes come from the worker's bitmap (refreshed as fast
    // as it keeps up) instead of one path each; with a selection it holds the faded nodes
    // outside it, and those inside draw live on top. A bitmap that no longer covers the screen
    // is used only mid-gesture, as is one drawn at another zoom (radii grow with the square root
    // of the scale, a scaled bitmap linearly); at rest the nodes then draw live until the next
    // one arrives. Requests ride on the edge layer, so hidden edges mean live nodes.
    const nl = this.nodeLayer;
    const nr = this.edgesVisible && nl.image && nl.view && nl.key === this.nodeKey() ? this.placeLayer(nl.view, W, H) : null;
    const exact = nr && nl.view!.scale === this.view.scale && nr.x <= 0 && nr.y <= 0 && nr.x + nr.w >= W && nr.y + nr.h >= H;
    const nodeBitmap = !gl && focus === this.focusNodes && nr && (this.interacting || exact) ? nl : null;
    if (nodeBitmap) ctx.drawImage(nodeBitmap.image!, nr!.x, nr!.y, nr!.w, nr!.h);
    // Active nodes (the focal entry, the selection, the hovered node) go last, on top.
    for (const top of [false, true]) {
      if ((gl || nodeBitmap && !focus) && !top) continue;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i], x = px[i], y = py[i], r = pr[i];
        const active = isActive(i);
        if (active !== top || !n.visible || x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
        const inFocus = !focus || focus.has(i);
        if (nodeBitmap && !inFocus && !active) continue;  // already in the bitmap, faded
        // Second-hop nodes are drawn a little fainter than the first ring.
        ctx.globalAlpha = active ? 1 : (inFocus ? .88 : .88 - .75 * strength) *
          this.opacityMult * (n.hop === 2 ? .62 : 1);
        if (active) {
          ctx.fillStyle = hexToRgba(COLORS.accent, .1);
          ring(x, y, r + 7);
          ctx.fill();
        }
        ctx.fillStyle = n.isFocal ? COLORS.accent : n.color || COLORS.muted;
        ring(x, y, r);
        ctx.fill();
        if (r > 3) {
          ctx.strokeStyle = COLORS.paper;
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }
        if (n.bridgeRank && inFocus && r > 2) {
          ctx.strokeStyle = COLORS.gold;
          ctx.lineWidth = 1;
          ring(x, y, r + 2);
          ctx.stroke();
        }
        if (active) {
          ctx.strokeStyle = COLORS.accent;
          ctx.lineWidth = 1.5;
          ring(x, y, r + 3);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    const drawn: { x: number; y: number; w: number; h: number }[] = [];
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    // Annotations (cluster names): the lead name in full, the rest on a second line.
    // Each sits above its island, else below, right or left, wherever no name is yet.
    const overlaps = (b: { x: number; y: number; w: number; h: number }) =>
      drawn.some((d) => b.x < d.x + d.w + 6 && b.x + b.w + 6 > d.x && b.y < d.y + d.h + 4 && b.y + b.h + 4 > d.y);
    // On a phone the names would bury the links: smaller, see-through, the lead name only,
    // fading out between 1.6x and 2.5x the fitted zoom and gone while something is selected.
    const narrow = W < 600;
    const zoomed = this.view.scale / (this.fitScale || 1);
    const annoAlpha = !narrow ? 1 : this.focusNodes ? 0 : Math.max(0, Math.min(1, (2.5 - zoomed) / .9));
    const headFont = narrow ? '700 10px "Archivo", sans-serif' : '700 12px "Archivo", sans-serif';
    for (const a of annoAlpha > .05 ? this.annotations : []) {
      if (a.minZoom && this.view.scale < this.fitScale * a.minZoom) continue;
      const [lead, ...rest] = a.text.split(' · ');
      ctx.font = headFont;
      const head = lead.toUpperCase();
      const headW = Math.min(this.textWidth(head), W - 26);
      ctx.font = '500 11px "Archivo", sans-serif';
      const tail = rest.length && !narrow ? this.fitText(rest.join(' · '), Math.round(Math.max(headW, 160) / 20) * 20) : '';
      const w = Math.max(headW, tail ? this.textWidth(tail) : 0) + (narrow ? 6 : 10), h = tail ? 34 : narrow ? 15 : 20;
      const r = a.r * this.view.scale, [x, y] = this.project(a.x, a.y);
      const box = [[x - w / 2, y - r - h - 2], [x - w / 2, y + r + 4], [x + r + 6, y - h / 2], [x - r - 6 - w, y - h / 2]]
        .map(([bx, by]) => ({ x: bx, y: by, w, h }))
        .find((b) => b.x >= 0 && b.x + b.w <= W && b.y >= 0 && b.y + b.h <= H && !overlaps(b));
      if (!box) continue;
      ctx.globalAlpha = annoAlpha;
      ctx.fillStyle = hexToRgba(COLORS.paper, narrow ? .6 : .9);
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.font = headFont;
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(this.fitText(head, W - 26), box.x + (narrow ? 3 : 5), box.y + (narrow ? 3 : 4));
      if (tail) {
        ctx.font = '500 11px "Archivo", sans-serif';
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(tail, box.x + 5, box.y + 19);
      }
      ctx.globalAlpha = 1;
      drawn.push(box);
    }
    if (this.interacting && this.opts.profile === 'full') return;

    // Entry labels, most important first; each takes the first free spot around its node.
    // Landmarks only orient a layout that has no annotations.
    const landmarks = !this.annotations.length;
    const prio = (n: GraphNode) => n.priority ?? n.count;
    const candidates: { n: GraphNode; i: number; tier: number }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.visible || px[i] < 0 || px[i] > W || py[i] < 0 || py[i] > H) continue;
      const tier = isActive(i) ? 0 : focus?.has(i) ? 1 : n.isLandmark && landmarks ? 2 : 3;
      if (focus && tier > 1) continue;
      if (tier === 3 && !this.P.labelAll && pr[i] < 3.3) continue;
      candidates.push({ n, i, tier });
    }
    candidates.sort((a, b) => a.tier - b.tier || prio(b.n) - prio(a.n));
    const limit = focus ? 48 : Math.max(10, Math.min(38, Math.floor(W / 32)));
    for (const c of candidates) {
      if (drawn.length >= limit && c.tier > 0) continue;
      const important = c.tier === 0, fontSize = important ? 14 : 12;
      ctx.font = `${important ? 700 : 500} ${fontSize}px "Archivo", sans-serif`;
      const title = this.fitText(c.n.title, Math.min(W - 32, important ? 300 : 190));
      const w = this.textWidth(title) + 10, h = fontSize + 8;
      const x = px[c.i], y = py[c.i], r = pr[c.i];
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
  /** The nearest edge within 5px, among those `only` accepts when given. */
  private edgeHitTest(px: number, py: number, only?: (k: number) => boolean): number {
    if (!this.edgesVisible) return -1;
    // Screen positions from the last draw: the pointer is tested against what is on screen.
    const { edges, nodes, px: X, py: Y } = this;
    const lo = Math.min, hi = Math.max;
    let best = -1, bestD2 = 25;
    for (let k = 0; k < edges.length; k++) {
      const [i, j] = edges[k];
      const ax = X[i], ay = Y[i], bx = X[j], by = Y[j];
      // Cheapest test first: the pointer must sit inside the edge's box, padded by 5px.
      if (px < lo(ax, bx) - 5 || px > hi(ax, bx) + 5 || py < lo(ay, by) - 5 || py > hi(ay, by) + 5) continue;
      if (!nodes[i].visible || !nodes[j].visible) continue;
      if (!this.showImplicit && this.implicitEdgeIdx.has(k) && !this.relationEdges.has(k)) continue;
      if (only && !only(k)) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = hi(0, lo(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < bestD2) { bestD2 = d2; best = k; }
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
    let pinchStart: { dist: number; scale: number; tx: number; ty: number; midX: number; midY: number; angle: number; engaged: number | null; turn: number } | null = null;
    // Two-finger rotation: while the fingers turn, the canvases turn under CSS around the
    // pinch point (free to composite); on release the angle is baked into the layout. It
    // engages past 12 degrees of twist, so a plain pinch never tilts the graph.
    const TWIST = .21;
    const layers = () => [canvas, this.gl?.canvas].filter((c): c is HTMLCanvasElement => !!c);
    const showTurn = (angle: number, x: number, y: number) => {
      // With WebGL the whole graph redraws turned each frame, so no corner goes blank; the
      // 2D fallback turns the canvases under CSS instead.
      if (this.gl) {
        this.turn = angle ? { c: Math.cos(angle), s: Math.sin(angle), x, y } : null;
        this.requestDraw();
        return;
      }
      this.turn = null;
      for (const c of layers()) {
        c.style.transformOrigin = `${x}px ${y}px`;
        c.style.transform = angle ? `rotate(${angle}rad)` : '';
      }
    };
    // After endTurn: local() reads the canvas box, which a CSS rotation would distort.
    const startPinch = (touches: TouchList) => {
      const [a, b] = touches;
      const mid = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinchStart = {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        scale: this.view.scale, tx: this.view.tx, ty: this.view.ty,
        midX: mid.x, midY: mid.y,
        angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX), engaged: null, turn: 0,
      };
    };
    const endTurn = () => {
      if (!pinchStart?.turn) return;
      const { turn, midX, midY } = pinchStart;
      showTurn(0, 0, 0);
      const v = this.view;
      this.rotateLayout(turn, (midX - v.tx) / v.scale, (midY - v.ty) / v.scale);
      pinchStart.turn = 0;
    };

    const local = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };
    const navigateTo = (i: number) => {
      if (!this.nodes[i].isFocal) location.href = hrefFor(this.nodes[i]);
    };
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
      this.handleClick(p.x, p.y, shift || this.multiMode, isTouch);
    };
    // A pan or zoom drops the hover, so the gesture can draw nodes from the worker's bitmap.
    const clearHover = () => {
      if (this.hoveredIdx < 0 && this.hoveredEdge < 0) return;
      this.hoveredIdx = this.hoveredEdge = -1;
      clearTimeout(this.hoverTimer);
      canvas.style.cursor = isPanning ? 'grabbing' : '';
    };
    // A fast mouse sends several moves per frame; hit-test only the latest, once per frame.
    let hoverAt: { cx: number; cy: number } | null = null;
    const onMove = (cx: number, cy: number) => {
      if (isPanning && panStart) {
        this.view.tx = panStart.tx + (cx - panStart.x);
        this.view.ty = panStart.ty + (cy - panStart.y);
        clearHover();
        this.moved();
        tooltip.hidden = true;
        return;
      }
      if (!hoverAt) requestAnimationFrame(() => { const at = hoverAt; hoverAt = null; if (at && !isPanning) hoverTest(at.cx, at.cy); });
      hoverAt = { cx, cy };
    };
    const hoverTest = (cx: number, cy: number) => {
      const p = local(cx, cy);
      const hit = this.hitTest(p.x, p.y);
      const edgeHit = hit < 0 ? this.edgeHitTest(p.x, p.y) : -1;
      if (hit !== this.hoveredIdx || edgeHit !== this.hoveredEdge) {
        this.hoveredIdx = hit;
        this.hoveredEdge = edgeHit;
        clearTimeout(this.hoverTimer);
        this.hoverMix = 0;
        this.hoverFadeStart = 0;
        if (hit >= 0 || edgeHit >= 0) {
          this.hoverTimer = setTimeout(() => {
            if (reduceMotion.matches) this.hoverMix = 1;
            else this.hoverFadeStart = performance.now();
            this.requestDraw();
          }, HOVER_DELAY);
        }
        this.requestDraw();
      }
      canvas.style.cursor = hit >= 0 || edgeHit >= 0 ? 'pointer' : '';
      if (hit >= 0) this.showNodeTooltip(this.nodes[hit], p.x, p.y);
      else if (edgeHit >= 0) this.showEdgeTooltip(edgeHit, p.x, p.y);
      else tooltip.hidden = true;
    };
    const zoomTo = (scale: number) => Math.max(0.05, Math.min(this.P.zoomMax, scale));
    const zoomAt = (px: number, py: number, factor: number) => {
      const newScale = zoomTo(this.view.scale * factor);
      const ratio = newScale / this.view.scale;
      this.view.tx = px - (px - this.view.tx) * ratio;
      this.view.ty = py - (py - this.view.ty) * ratio;
      this.view.scale = newScale;
      clearHover();
      this.moved();
      tooltip.hidden = true;
    };
    // Wheel notches and the zoom buttons ease toward an accumulated target instead of
    // jumping, anchored at the latest pointer. Any direct manipulation cancels the glide.
    // `at` is the view the glide last set: a search jump or refit since then ends the glide.
    let glide: { scale: number; px: number; py: number; at: string } | null = null;
    const viewKey = () => `${this.view.scale},${this.view.tx},${this.view.ty}`;
    const stopGlide = () => { glide = null; };
    // Each draw advances the glide 45% of the way (in log scale), so a notch settles in about 6 frames.
    this.beforeDraw = () => {
      if (!glide) return;
      if (glide.at !== viewKey()) { glide = null; return; }
      const left = Math.log(glide.scale / this.view.scale);
      const done = Math.abs(left) < .003;
      zoomAt(glide.px, glide.py, Math.exp(done ? left : left * .45));  // moved() queues the next frame
      glide.at = viewKey();
      if (done) glide = null;
    };
    const smoothZoomAt = (px: number, py: number, factor: number) => {
      if (reduceMotion.matches) { zoomAt(px, py, factor); return; }
      glide = { scale: zoomTo((glide?.scale ?? this.view.scale) * factor), px, py, at: viewKey() };
      this.requestDraw();
    };

    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    // Shift, Ctrl or Cmd adds to the selection (Cmd because Ctrl-click opens the menu on a Mac).
    window.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY, false, e.shiftKey || e.ctrlKey || e.metaKey));
    canvas.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    // The entity graph sits in a scrolling page: the wheel scrolls past it unless the reader
    // asks to zoom, with Ctrl/Cmd (a trackpad pinch sets ctrlKey too) or by clicking the graph.
    // The full graph is the whole page, so it zooms on any wheel.
    let engaged = this.opts.profile === 'full';
    const hint = document.createElement('div');
    hint.className = 'net-wheel-hint';
    hint.textContent = `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + scroll to zoom, or click the graph first`;
    hint.hidden = true;
    canvas.parentElement?.append(hint);
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const showHint = () => {
      hint.hidden = false;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hint.hidden = true; }, 1400);
    };
    canvas.addEventListener('pointerdown', () => { engaged = true; hint.hidden = true; stopGlide(); });
    canvas.addEventListener('mouseleave', () => {
      if (this.opts.profile !== 'full') engaged = false;
      clearTimeout(this.hoverTimer);
      hoverAt = null;
      if (this.hoveredIdx !== -1 || this.hoveredEdge !== -1) {
        this.hoveredIdx = -1;
        this.hoveredEdge = -1;
        this.requestDraw();
      }
      tooltip.hidden = true;
      canvas.style.cursor = '';
    });
    canvas.addEventListener('wheel', (e) => {
      if (!engaged && !e.ctrlKey && !e.metaKey) { showHint(); return; }
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      // Firefox reports lines (deltaMode 1) or pages (2) instead of pixels.
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.canvasSize().H : 1);
      const factor = Math.exp(-Math.max(-100, Math.min(100, dy)) * .002);
      // Trackpad scrolls and pinches already arrive as a stream of small pixel deltas: apply them
      // directly. Mouse-wheel notches (40px and up) glide.
      if (e.deltaMode === 0 && Math.abs(dy) < 40) { stopGlide(); zoomAt(p.x, p.y, factor); }
      else smoothZoomAt(p.x, p.y, factor);
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
      else if (e.key === '0') { e.preventDefault(); stopGlide(); this.fit(); }
      else if (pan[e.key]) {
        e.preventDefault();
        this.view.tx += pan[e.key][0];
        this.view.ty += pan[e.key][1];
        this.moved();
      }
    });

    // Touch: pan, pinch, tap, double-tap to open. CSS sets touch-action: none.
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        onDown(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        isPanning = false;
        startPinch(e.touches);
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
        let twist = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) - pinchStart.angle;
        twist = Math.atan2(Math.sin(twist), Math.cos(twist));  // into -pi..pi
        if (pinchStart.engaged === null && Math.abs(twist) > TWIST) pinchStart.engaged = twist;
        if (pinchStart.engaged !== null) {
          pinchStart.turn = twist - pinchStart.engaged;
          showTurn(pinchStart.turn, pinchStart.midX, pinchStart.midY);
        }
        this.moved();
      } else if (e.touches.length === 1) {
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) { endTurn(); pinchStart = null; }
      // Back to two fingers after a third: the pair may differ, so restart from it.
      else if (e.touches.length === 2 && pinchStart) { endTurn(); startPinch(e.touches); }
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        onUp(e.changedTouches[0].clientX, e.changedTouches[0].clientY, true, false);
      }
    });
    canvas.addEventListener('touchcancel', () => { endTurn(); isPanning = false; pinchStart = null; downAt = null; });

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
    btn('.net-zoom-in')?.addEventListener('click', () => { const { W, H } = this.canvasSize(); smoothZoomAt(W / 2, H / 2, 1.35); });
    btn('.net-zoom-out')?.addEventListener('click', () => { const { W, H } = this.canvasSize(); smoothZoomAt(W / 2, H / 2, 1 / 1.35); });
    btn('.net-fit')?.addEventListener('click', () => { stopGlide(); this.fit(); });
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
    // On a phone, Expand also asks for real fullscreen so the browser's bars go too.
    // iPhone Safari has no element fullscreen; the fixed overlay stands in there.
    const phone = () => matchMedia('(max-width: 900px), (pointer: coarse)').matches;
    const setFullscreen = (on: boolean) => {
      fsEl.classList.toggle('fullscreen', on);
      toggle(fsBtn, on, on ? 'Close' : 'Expand');
      document.body.classList.toggle('net-fullscreen-active', on);
      if (on && phone() && fsEl.requestFullscreen && !document.fullscreenElement) {
        fsEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      } else if (!on && document.fullscreenElement === fsEl) {
        document.exitFullscreen().catch(() => {});
      }
      requestAnimationFrame(() => this.refitAfterResize());
    };
    fsBtn?.addEventListener('click', () => setFullscreen(!fsEl.classList.contains('fullscreen')));
    // Leaving fullscreen by back gesture or Esc closes the overlay too; entering refits.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && fsEl.classList.contains('fullscreen')) setFullscreen(false);
      else requestAnimationFrame(() => this.refitAfterResize());
    });
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
    // On a phone the panel opens compact (name and actions); Details shows the rest.
    const more = this.panel.querySelector<HTMLButtonElement>('.gs-more');
    more?.addEventListener('click', () => {
      const open = this.panel.classList.toggle('is-open');
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Less' : 'Details';
    });
  }
  private updateForceSliderVisibility(): void {
    const slider = this.root.querySelector<HTMLElement>('[data-force-only]');
    if (slider) slider.style.display = this.currentLayout === 'force' ? '' : 'none';
  }

  private handleClick(px: number, py: number, additive: boolean, touch = false): void {
    const hit = this.hitTest(px, py);
    if (hit < 0) {
      // A fingertip on a dense graph is always near some line, so a tap picks only the nearest
      // connection already lit by the selection; anywhere else it clears.
      let lit: Set<number> | undefined;
      if (touch) {
        lit = new Set(this.selectedEdges);
        for (const i of this.selectedNodes) for (const k of this.incident[i]) lit.add(k);
      }
      const edgeHit = this.edgeHitTest(px, py, lit && ((k) => lit!.has(k)));
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
    const context = q('.gs-context');
    if (context) context.hidden = true;

    const nc = this.selectedNodes.size, ec = this.selectedEdges.size;
    panel.hidden = nc + ec === 0;
    panel.classList.remove('is-open');
    const more = q('.gs-more');
    if (more) { more.setAttribute('aria-expanded', 'false'); more.textContent = 'Details'; more.hidden = false; }
    if (panel.hidden) return;
    const eyebrow = q('.gs-eyebrow')!, title = q('.gs-title')!, count = q('.gs-count')!;
    eyebrow.className = 'gs-eyebrow';
    count.textContent = '';

    if (nc === 0 && ec === 1) {
      const k = this.selectedEdges.values().next().value!;
      const [a, b] = edges[k].map((i) => nodes[i]);
      eyebrow.textContent = this.relationEdges.get(k) ?? 'Connection';
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
      if (more) more.hidden = true;  // both names are already on the links
      return;
    }
    if (nc === 1 && ec === 0) {
      const idx = this.selectedNodes.values().next().value!;
      const n = nodes[idx];
      eyebrow.textContent = TYPE_LABELS[n.type] || '';
      eyebrow.classList.add(`type-${n.type}`);
      title.textContent = n.title;
      count.textContent = n.count.toLocaleString();
      if (n.bridgeRank) { q('.gs-bridge-rank')!.textContent = '#' + n.bridgeRank; q('.gs-bridge')!.hidden = false; }
      if (n.hubRank) { q('.gs-hub-rank')!.textContent = '#' + n.hubRank; q('.gs-hub')!.hidden = false; }
      const lines = this.opts.describe?.(idx) ?? [];
      if (context && lines.length) {
        context.replaceChildren(...lines.map((line) => { const p = el('p'); p.append(...line); return p; }));
        context.hidden = false;
      }
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
  private showEdgeTooltip(k: number, px: number, py: number): void {
    const [a, b] = this.edges[k];
    const pair = [el('span', '', this.nodes[a].title), ' ', el('span', 'gt-link', '—'), ' ', el('span', '', this.nodes[b].title)];
    const relation = this.relationEdges.get(k);
    this.showTooltip(pair, `${relation ?? 'connection'} · click to pin`, px, py);
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
    sub: data.subcommunities?.[i] ?? -1,
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
