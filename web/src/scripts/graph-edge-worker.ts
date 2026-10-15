// Renders the graph's idle edges off the main thread (see paintIdleLayer in graph-canvas.ts),
// so a pan or zoom never waits on tens of thousands of strokes.
import { renderIdleEdges, type EdgeScene } from './graph-edges';

let scene: EdgeScene | null = null;
let sceneVersion = -1;
let canvas: OffscreenCanvas | null = null;

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
  if (!canvas) canvas = new OffscreenCanvas(cw, ch);
  else if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const c = canvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.setTransform(m.dpr, 0, 0, m.dpr, m.mx * m.dpr, m.my * m.dpr);
  renderIdleEdges(c, scene, m.view, m.W, m.H, Math.max(m.mx, m.my), m.showImplicit);
  const bitmap = canvas.transferToImageBitmap();
  (self as unknown as Worker).postMessage({ id: m.id, bitmap }, [bitmap]);
};
