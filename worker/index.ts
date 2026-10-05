// Cloudflare Worker in front of the static site. Serves /api/* and /mcp (research tools over
// the semantic index), OG images and markdown twins from R2, and everything else from assets.
import type { Adjacency } from '../web/src/scripts/adjacency.ts';
import { handleRpc } from './mcp.ts';
import { Corpus, type Index } from './search.ts';
import { ToolError, runTool, type Data } from './tools.ts';

interface R2Object { body: ReadableStream; httpEtag: string; httpMetadata?: { contentType?: string } }
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  BUCKET: {
    get(key: string): Promise<R2Object | null>;
  };
  AI: { run(model: string, input: unknown): Promise<{ data?: number[][] }> };
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** R2 prefix semantic/<version>/ written by deploy/cloudflare.sh with this deploy. */
  SEMANTIC_VERSION?: string;
  /** Changes on every deploy, so cached tool results never outlive the data they came from. */
  CF_VERSION_METADATA?: { id: string };
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

/** REST paths onto tool names; query parameters become the tool's arguments. */
const API: Record<string, string> = { search: 'search', entry: 'get_entry', neighbors: 'neighbors', path: 'find_path', similar: 'similar' };
const MD_TYPE = 'text/markdown; charset=utf-8';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

type Loaded = Omit<Data, 'origin' | 'embed' | 'markdown'>;
let loaded: { version: string; data: Promise<Loaded> } | null = null;

async function load(env: Env, origin: string): Promise<Loaded> {
  const asset = async (path: string) => {
    const r = await env.ASSETS.fetch(new Request(origin + path));
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r;
  };
  const object = async (name: string) => {
    const o = await env.BUCKET.get(`semantic/${env.SEMANTIC_VERSION}/${name}`);
    if (!o) throw new Error(`semantic/${env.SEMANTIC_VERSION}/${name} missing`);
    return new Response(o.body);
  };
  const adj = (await (await asset('/adjacency.json')).json()) as Adjacency;
  if (!env.SEMANTIC_VERSION) return { adj, corpus: null, similar: {} };
  const [index, vectors, scales, similar] = await Promise.all([
    object('index.json').then((r) => r.json() as Promise<Index>),
    object('vectors.bin').then((r) => r.arrayBuffer()),
    object('scales.bin').then((r) => r.arrayBuffer()),
    object('similar.json').then((r) => r.json() as Promise<Data['similar']>),
  ]);
  return { adj, corpus: new Corpus(index, new Int8Array(vectors), new Float32Array(scales)), similar };
}

/** Index and graph, loaded once per isolate and kept until a deploy changes the version. */
function dataFor(env: Env, origin: string): Promise<Data> {
  const version = env.SEMANTIC_VERSION ?? '';
  if (!loaded || loaded.version !== version) {
    const data = load(env, origin);
    loaded = { version, data };
    // A failed load is retried by the next request rather than cached for the isolate's life.
    data.catch(() => { if (loaded?.data === data) loaded = null; });
  }
  return loaded.data.then((l) => ({
    ...l,
    origin,
    async embed(query: string) {
      if (!l.corpus) return null;
      try {
        const out = await env.AI.run(l.corpus.index.model, { text: [l.corpus.index.query_prefix + query] });
        return out.data?.[0] ?? null;
      } catch {
        return null;  // Search degrades to name matching rather than failing.
      }
    },
    async markdown(path: string) {
      const o = await env.BUCKET.get(path);
      return o ? new Response(o.body).text() : null;
    },
  }));
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  },
});

/** Per-IP limit on the paid paths (query embeddings); absent in local dev. */
async function limited(env: Env, req: Request): Promise<Response | null> {
  if (!env.LIMITER) return null;
  const { success } = await env.LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' });
  return success ? null : json({ error: 'rate limited; retry in a minute' }, 429, { 'Retry-After': '60' });
}

/** Tool results cached at the edge, keyed by tool, arguments and index version. */
async function cachedTool(env: Env, ctx: Ctx, data: Data, name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = new Request(`${data.origin}/__tool/${name}?v=${env.CF_VERSION_METADATA?.id ?? env.SEMANTIC_VERSION ?? ''}&a=${encodeURIComponent(JSON.stringify(args))}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const out = await runTool(data, name, args);
  // A names-only fallback (embedding failed) is not worth keeping past this request.
  if ((out as { mode?: string }).mode !== 'names only') {
    ctx.waitUntil(cache.put(key, json(out, 200, { 'Cache-Control': 'public, max-age=3600' })));
  }
  return out;
}

async function api(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'use GET' }, 405, { Allow: 'GET' });
  const tool = API[url.pathname.slice('/api/'.length)];
  if (!tool) return json({ error: `unknown endpoint; try ${Object.keys(API).map((k) => '/api/' + k).join(', ')}` }, 404);
  const block = await limited(env, req);
  if (block) return block;
  const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (tool === 'search' && args.q != null && args.query == null) { args.query = args.q; delete args.q; }
  try {
    return json(await cachedTool(env, ctx, await dataFor(env, url.origin), tool, args), 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    if (err instanceof ToolError) return json({ error: err.message }, 400);
    console.error(err);
    return json({ error: 'temporarily unavailable' }, 503, { 'Retry-After': '30' });
  }
}

async function mcp(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // Origin is not checked: the server is public, read-only and takes no credentials, so a
  // cross-origin caller can do nothing a direct one cannot.
  if (req.method !== 'POST') return json({ error: 'MCP endpoint: POST JSON-RPC here (streamable HTTP, stateless)' }, 405, { Allow: 'POST' });
  const block = await limited(env, req);
  if (block) return block;
  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  if (Array.isArray(msg)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batches are not supported' } }, 400);
  // Only tools/call loads the index, so the handshake answers even when the data cannot load.
  const run = async (name: string, args: Record<string, unknown>) => cachedTool(env, ctx, await dataFor(env, url.origin), name, args);
  try {
    const { status, body } = await handleRpc(run, msg as never, req.headers);
    return body ? json(body, status) : new Response(null, { status, headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    console.error(err);
    const id = (msg as { id?: unknown })?.id ?? null;
    return json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'temporarily unavailable' } });
  }
}

/** OG images and markdown twins, which live in R2 to keep the asset count down. */
async function fromBucket(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const cache = (caches as unknown as { default: Cache }).default;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return env.ASSETS.fetch(req);  // malformed escapes: the site's 404 page
  }
  // Keyed on the deploy, not the query: each deploy starts fresh (so OG ?v= busting still
  // works), and made-up query strings cannot force R2 reads.
  const key = new Request(`${url.origin}${url.pathname}?deploy=${env.CF_VERSION_METADATA?.id ?? ''}`);
  const hit = await cache.match(key);
  const res = hit ?? await (async () => {
    const o = await env.BUCKET.get(path);
    if (!o) return null;
    const md = url.pathname.endsWith('.md');
    const r = new Response(o.body, {
      headers: {
        'Content-Type': md ? MD_TYPE : o.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': md ? 'public, max-age=300' : 'public, max-age=86400',
        ETag: o.httpEtag,
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
      },
    });
    ctx.waitUntil(cache.put(key, r.clone()));
    return r;
  })();
  if (!res) return env.ASSETS.fetch(req);  // the site's 404 page
  return req.method === 'HEAD' ? new Response(null, { headers: res.headers }) : res;
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') return mcp(req, env, ctx, url);
    if (url.pathname.startsWith('/api/')) return api(req, env, ctx, url);
    if (url.pathname.startsWith('/og/') || url.pathname.endsWith('.md')) return fromBucket(req, env, ctx, url);
    return env.ASSETS.fetch(req);
  },
};
