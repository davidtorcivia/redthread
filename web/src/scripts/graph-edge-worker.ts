// Renders the graph's idle edges, and its nodes for use mid-gesture, off the main thread
// (see paintIdleLayer in graph-canvas.ts), so a pan or zoom never waits on them.
import { renderIdleEdges, renderNodes, type EdgeScene } from './graph-edges';

let scene: EdgeScene | null = null;
let sceneVersion = '';
const canvases: Record<string, OffscreenCanvas> = {};

function surface(name: string, cw: number, ch: number, m: { dpr: number; mx: number; my: number }) {
  let canvas = canvases[name];
  if (!canvas) canvas = canvases[name] = new OffscreenCanvas(cw, ch);
  else if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const c = canvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.setTransform(m.dpr, 0, 0, m.dpr, m.mx * m.dpr, m.my * m.dpr);
  return { canvas, c };
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'scene') {
    scene = m.scene;
    sceneVersion = m.version;
    return;
  }
  if (!scene || m.version !== sceneVersion) {
    self.postMessage({ id: m.id });
    return;
  }
  const cw = Math.round((m.W + 2 * m.mx) * m.dpr), ch = Math.round((m.H + 2 * m.my) * m.dpr);
  const pad = Math.max(m.mx, m.my);
  const out: { id: number; bitmap?: ImageBitmap; nodeBitmap?: ImageBitmap } = { id: m.id };
  if (m.edges) {
    const { canvas, c } = surface('edges', cw, ch, m);
    renderIdleEdges(c, scene, m.view, m.W, m.H, pad, m.showImplicit);
    out.bitmap = canvas.transferToImageBitmap();
  }
  if (m.nodes) {
    const { canvas, c } = surface('nodes', cw, ch, m);
    renderNodes(c, scene, m.view, m.W, m.H, pad, m.opacity, m.focus, m.strength);
    out.nodeBitmap = canvas.transferToImageBitmap();
  }
  (self as unknown as Worker).postMessage(out, [out.bitmap, out.nodeBitmap].filter((b): b is ImageBitmap => !!b));
};
