// WebGL2 renderer for the graph's edges and idle nodes, drawn on a canvas under the engine's
// 2D canvas (which keeps active nodes, cluster names and labels). Every frame redraws every
// edge and node on the GPU, so pans and zooms need no cached bitmaps.
// Lines are quads widened in the vertex shader and antialiased by distance in the fragment
// shader; nodes are quads shaded as discs with the paper outline and bridge ring of the 2D pass.
import type { EdgeView } from './graph-edges';

const EDGE_VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec4 ends;
layout(location=2) in vec4 color;
layout(location=3) in vec2 style;
uniform vec3 view; uniform vec2 res; uniform float minLen;
out vec4 vColor; out float vAcross; out float vAlong; out float vWidth; out float vDashed;
void main() {
  vec2 a = ends.xy * view.z + view.xy, b = ends.zw * view.z + view.xy;
  vec2 d = b - a; float len = length(d);
  if (len <= minLen) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = d / len, nrm = vec2(-dir.y, dir.x);
  float hw = style.x * 0.5 + 1.0;
  vec2 p = mix(a, b, corner.x) + nrm * corner.y * hw;
  vAcross = corner.y * hw; vAlong = corner.x * len; vWidth = style.x; vDashed = style.y; vColor = color;
  gl_Position = vec4(p / res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
}`;

const EDGE_FS = `#version 300 es
precision highp float;  // vAlong reaches thousands of px; mediump breaks the dashes on phones
in vec4 vColor; in float vAcross; in float vAlong; in float vWidth; in float vDashed;
uniform float dpr; uniform float alpha;
out vec4 frag;
void main() {
  if (vDashed > 0.5 && mod(vAlong, 8.0) >= 3.0) discard;
  float cover = clamp((vWidth * 0.5 - abs(vAcross)) * dpr + 0.5, 0.0, 1.0);
  float a = vColor.a * cover * alpha;
  frag = vec4(vColor.rgb * a, a);
}`;

const NODE_VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec2 pos;
layout(location=2) in float size;
layout(location=3) in vec4 color;
layout(location=4) in vec2 look;
uniform vec3 view; uniform vec2 res; uniform vec2 radii;
out vec2 vLocal; out float vR; out vec4 vColor; out vec2 vLook;
void main() {
  if (look.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float r = clamp(size * sqrt(max(0.01, view.z)), radii.x, radii.y);
  float reach = r + (look.y > 0.5 ? 3.0 : 1.5);
  vec2 c = vec2(corner.x * 2.0 - 1.0, corner.y);
  vec2 p = pos * view.z + view.xy + c * reach;
  vLocal = c * reach; vR = r; vColor = color; vLook = look;
  gl_Position = vec4(p / res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
}`;

const NODE_FS = `#version 300 es
precision mediump float;
in vec2 vLocal; in float vR; in vec4 vColor; in vec2 vLook;
uniform float dpr; uniform vec3 paper; uniform vec3 gold;
out vec4 frag;
void main() {
  float d = length(vLocal);
  vec4 c = vec4(vColor.rgb, 1.0) * clamp((vR - d) * dpr + 0.5, 0.0, 1.0);
  if (vR > 3.0) { float o = clamp((0.65 - abs(d - vR)) * dpr + 0.5, 0.0, 1.0); c = vec4(paper, 1.0) * o + c * (1.0 - o); }
  if (vLook.y > 0.5 && vR > 2.0) { float g = clamp((0.5 - abs(d - vR - 2.0)) * dpr + 0.5, 0.0, 1.0); c = vec4(gold, 1.0) * g + c * (1.0 - g); }
  frag = c * vLook.x;
}`;

/** Bytes per edge instance: x0 y0 x1 y1 (float), rgba (bytes), width dashed (float). */
const EDGE_STRIDE = 28;

/** `css` at alpha `a` (0-1), from the cached opaque reading, so a fading alpha adds no entries. */
export function cssRgbaAlpha(css: string, a: number): [number, number, number, number] {
  const [r, g, b] = cssRgba(css);
  return [r, g, b, Math.round(Math.max(0, Math.min(1, a)) * 255)];
}

/** RGBA 0-255 for any CSS colour, read back from a 1x1 canvas, cached. */
const colorCache = new Map<string, [number, number, number, number]>();
let probe: CanvasRenderingContext2D | null = null;
export function cssRgba(css: string): [number, number, number, number] {
  let c = colorCache.get(css);
  if (!c) {
    probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })!;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    colorCache.set(css, c = [d[0], d[1], d[2], d[3]]);
  }
  return c;
}

/** Instance data for a list of edges: endpoints from node coordinates, one style for all. */
export class EdgeBatch {
  data: ArrayBuffer;
  private f: Float32Array;
  private u: Uint8Array;
  count = 0;
  constructor(capacity: number) {
    this.data = new ArrayBuffer(Math.max(1, capacity) * EDGE_STRIDE);
    this.f = new Float32Array(this.data);
    this.u = new Uint8Array(this.data);
  }
  push(x0: number, y0: number, x1: number, y1: number, rgba: [number, number, number, number], width: number, dashed: boolean): void {
    if ((this.count + 1) * EDGE_STRIDE > this.data.byteLength) this.grow();
    const o = this.count * 7, b = this.count * EDGE_STRIDE + 16;
    this.f[o] = x0; this.f[o + 1] = y0; this.f[o + 2] = x1; this.f[o + 3] = y1;
    this.u[b] = rgba[0]; this.u[b + 1] = rgba[1]; this.u[b + 2] = rgba[2]; this.u[b + 3] = rgba[3];
    this.f[o + 5] = width; this.f[o + 6] = dashed ? 1 : 0;
    this.count++;
  }
  private grow(): void {
    const next = new ArrayBuffer(this.data.byteLength * 2);
    new Uint8Array(next).set(this.u);
    this.data = next;
    this.f = new Float32Array(next);
    this.u = new Uint8Array(next);
  }
}

interface Drawable { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number }

export class GraphGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private edgeProg: WebGLProgram;
  private nodeProg: WebGLProgram;
  private corner: WebGLBuffer;
  private edgeU: Record<string, WebGLUniformLocation | null>;
  private nodeU: Record<string, WebGLUniformLocation | null>;
  private idle: Drawable;
  private dynamic: Drawable;
  private nodes: Drawable & { look: WebGLBuffer };
  lost = false;
  /** Called when the context is lost, so the engine can redraw in 2D at once. */
  onLost: (() => void) | null = null;

  /** Null where WebGL2 is unavailable or would run in software (a blocklisted GPU, a VM),
   *  which is slower than the 2D path; the engine then draws everything in 2D. `?gl=1`
   *  forces it on and `?gl=0` off, for comparing the two. */
  static create(): GraphGL | null {
    try {
      const flag = new URLSearchParams(location.search).get('gl');
      if (flag === '0') return null;
      const canvas = document.createElement('canvas');
      const force = flag === '1';
      const gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        failIfMajorPerformanceCaveat: !force,
      });
      if (!gl) return null;
      // Chrome hands out SwiftShader without flagging the caveat, so check the renderer too.
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      if (!force && /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i.test(renderer)) return null;
      return new GraphGL(canvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.edgeProg = this.program(EDGE_VS, EDGE_FS);
    this.nodeProg = this.program(NODE_VS, NODE_FS);
    const uniforms = (p: WebGLProgram, names: string[]) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
    this.edgeU = uniforms(this.edgeProg, ['view', 'res', 'minLen', 'dpr', 'alpha']);
    this.nodeU = uniforms(this.nodeProg, ['view', 'res', 'radii', 'dpr', 'paper', 'gold']);
    this.corner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.idle = this.edgeDrawable();
    this.dynamic = this.edgeDrawable();
    this.nodes = this.nodeDrawable();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.onLost?.(); });
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  }

  private edgeDrawable(): Drawable {
    const gl = this.gl;
    const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, EDGE_STRIDE, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, EDGE_STRIDE, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, EDGE_STRIDE, 20);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return { vao, buf, count: 0 };
  }

  /** Node instances: pos (2 float) size (float) rgba (4 bytes) in one buffer, then
   *  alpha and ring (2 float) in a second that changes with every hover or selection. */
  private nodeDrawable(): Drawable & { look: WebGLBuffer } {
    const gl = this.gl;
    const vao = gl.createVertexArray()!, buf = gl.createBuffer()!, look = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 16, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, look);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    return { vao, buf, look, count: 0 };
  }

  /** The idle edges, uploaded once per scene. */
  setIdleEdges(batch: EdgeBatch): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idle.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(batch.data, 0, batch.count * EDGE_STRIDE), gl.STATIC_DRAW);
    this.idle.count = batch.count;
  }

  /** Node positions, sizes and colours, uploaded once per scene. */
  setNodes(x: Float64Array, y: Float64Array, size: Float32Array, rgba: Uint8Array): void {
    const gl = this.gl, n = x.length;
    const data = new ArrayBuffer(n * 16), f = new Float32Array(data), u = new Uint8Array(data);
    for (let i = 0; i < n; i++) {
      f[i * 4] = x[i]; f[i * 4 + 1] = y[i]; f[i * 4 + 2] = size[i];
      u.set(rgba.subarray(i * 4, i * 4 + 4), i * 16 + 12);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodes.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.nodes.count = n;
  }

  /** Size the drawing buffer to the 2D canvas and clear it. */
  begin(width: number, height: number): void {
    const { gl, canvas } = this;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private edgeUniforms(v: EdgeView, W: number, H: number, dpr: number, alpha: number, minLen: number): void {
    const gl = this.gl, u = this.edgeU;
    gl.useProgram(this.edgeProg);
    gl.uniform3f(u.view, v.tx, v.ty, v.scale);
    gl.uniform2f(u.res, W, H);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform1f(u.alpha, alpha);
    gl.uniform1f(u.minLen, minLen);
  }

  /** The idle edges; edges under 1.5px on screen are skipped, as in the 2D pass. */
  drawIdle(v: EdgeView, W: number, H: number, dpr: number, alpha: number): void {
    if (!this.idle.count) return;
    const gl = this.gl;
    this.edgeUniforms(v, W, H, dpr, alpha, 1.5);
    gl.bindVertexArray(this.idle.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.idle.count);
  }

  /** A short-lived batch (lit or relation edges), uploaded and drawn now. */
  drawBatch(batch: EdgeBatch, v: EdgeView, W: number, H: number, dpr: number, alpha: number): void {
    if (!batch.count || alpha <= 0) return;
    const gl = this.gl;
    this.edgeUniforms(v, W, H, dpr, alpha, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(batch.data, 0, batch.count * EDGE_STRIDE), gl.STREAM_DRAW);
    gl.bindVertexArray(this.dynamic.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  /** Nodes, with `look` holding per node an alpha (0 skips it) and a bridge-ring flag. */
  drawNodes(look: Float32Array, v: EdgeView, W: number, H: number, dpr: number, minR: number, maxR: number,
    paper: [number, number, number, number], gold: [number, number, number, number]): void {
    if (!this.nodes.count) return;
    const gl = this.gl, u = this.nodeU;
    gl.useProgram(this.nodeProg);
    gl.uniform3f(u.view, v.tx, v.ty, v.scale);
    gl.uniform2f(u.res, W, H);
    gl.uniform2f(u.radii, minR, maxR);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform3f(u.paper, paper[0] / 255, paper[1] / 255, paper[2] / 255);
    gl.uniform3f(u.gold, gold[0] / 255, gold[1] / 255, gold[2] / 255);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodes.look);
    gl.bufferData(gl.ARRAY_BUFFER, look, gl.STREAM_DRAW);
    gl.bindVertexArray(this.nodes.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodes.count);
  }
}
