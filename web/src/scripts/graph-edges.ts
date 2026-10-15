// Idle-edge drawing shared by the graph engine and its worker (graph-edge-worker.ts):
// the same scene renders on the main thread when no worker is available.

/** Per-edge flags: drawn never, inferred (NER) link, and the class in the upper bits. */
export const EDGE_SKIP = 1;
export const EDGE_IMPLICIT = 2;
/** Class: links between neighbours, links to the focal entry, links between islands. */
export const EDGE_BETWEEN = 0, EDGE_FOCAL = 1 << 2, EDGE_CROSS = 2 << 2;

export interface EdgeScene {
  /** Node index pairs, two per edge. */
  pairs: Uint32Array;
  /** Node layout coordinates. */
  x: Float64Array;
  y: Float64Array;
  flags: Uint8Array;
  styles: { cross: string; focal: string; between: string; width: number };
}

export interface EdgeView { tx: number; ty: number; scale: number }

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function stroke(c: Ctx, list: number[], pairs: Uint32Array, X: Float64Array, Y: Float64Array, width: number, color: string, dashed: boolean): void {
  if (!list.length) return;
  c.setLineDash(dashed ? [3, 5] : []);
  c.lineWidth = width;
  c.strokeStyle = color;
  c.beginPath();
  for (let j = 0; j < list.length; j++) {
    const a = pairs[2 * list[j]], b = pairs[2 * list[j] + 1];
    c.moveTo(X[a], Y[a]);
    c.lineTo(X[b], Y[b]);
    if (j % 256 === 255) { c.stroke(); c.beginPath(); }
  }
  c.stroke();
  c.setLineDash([]);
}

/** Every idle edge that crosses the W x H screen widened by `pad`, in screen coordinates. */
export function renderIdleEdges(c: Ctx, s: EdgeScene, v: EdgeView, W: number, H: number, pad: number, showImplicit: boolean): void {
  const { pairs, flags } = s, n = s.x.length;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = s.x[i] * v.scale + v.tx; Y[i] = s.y[i] * v.scale + v.ty; }
  // By class (between, focal, cross), each linked then inferred.
  const lists: number[][] = [[], [], [], [], [], []];
  for (let k = 0; k < flags.length; k++) {
    const f = flags[k];
    if (f & EDGE_SKIP) continue;
    const implicit = (f & EDGE_IMPLICIT) !== 0;
    if (implicit && !showImplicit) continue;
    const a = pairs[2 * k], b = pairs[2 * k + 1];
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b];
    if ((ax < -pad && bx < -pad) || (ax > W + pad && bx > W + pad) || (ay < -pad && by < -pad) || (ay > H + pad && by > H + pad)) continue;
    // A sub-pixel edge only adds to the wash.
    if ((bx - ax) ** 2 + (by - ay) ** 2 < 2.25) continue;
    lists[(f >> 2) * 2 + (implicit ? 1 : 0)].push(k);
  }
  const { cross, focal, between, width } = s.styles;
  stroke(c, lists[4], pairs, X, Y, .65, cross, false);
  stroke(c, lists[5], pairs, X, Y, .65, cross, true);
  stroke(c, lists[2], pairs, X, Y, .7, focal, false);
  stroke(c, lists[3], pairs, X, Y, .7, focal, true);
  stroke(c, lists[0], pairs, X, Y, width, between, false);
  stroke(c, lists[1], pairs, X, Y, width, between, true);
}
