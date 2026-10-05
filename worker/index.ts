// Cloudflare Worker in front of the static site. Serves /api/* and /mcp (research tools over
// the semantic index), OG images and markdown twins from R2 (also by Accept: text/markdown on
// the page URL), and everything else from assets.
import type { Adjacency } from '../web/src/scripts/adjacency.ts';
import { handleRpc, SERVER_INFO, SUPPORTED } from './mcp.ts';
import { Corpus, type Index } from './search.ts';
import type { Fulltext, Rec } from './research.ts';
import { ToolError, TOOLS, runTool, type Data } from './tools.ts';

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
const API: Record<string, string> = {
  search: 'search', semantic: 'search_semantic', lexical: 'search_lexical', citations: 'search_citations',
  entry: 'get_entry', neighbors: 'neighbors', path: 'find_path', similar: 'similar', timeline: 'timeline', entries: 'list_entries',
};
const MD_TYPE = 'text/markdown; charset=utf-8';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

type Loaded = Omit<Data, 'origin' | 'embed' | 'markdown' | 'entries' | 'fulltext'>;
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

/** A JSON asset, fetched once per isolate; a failed fetch is retried by the next call. */
function lazyAsset<T>(path: string): (env: Env, origin: string) => Promise<T> {
  let p: Promise<T> | null = null;
  return (env, origin) => {
    p ??= env.ASSETS.fetch(new Request(origin + path))
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${path}: ${r.status}`))))
      .catch((err) => { p = null; throw err; });
    return p;
  };
}
const entriesAsset = lazyAsset<Rec[]>('/entries.json');
// fulltext.json (~19 MB, growing) is in R2: static assets cap at 25 MiB per file.
// ponytail: with entries.json it takes ~30 MB of heap; D1 with FTS5 if that outgrows the isolate.
let fulltextLoad: Promise<Fulltext> | null = null;
function fulltextObject(env: Env): Promise<Fulltext> {
  fulltextLoad ??= env.BUCKET.get('fulltext.json')
    .then((o) => (o ? (new Response(o.body).json() as Promise<Fulltext>) : Promise.reject(new Error('fulltext.json missing from R2'))))
    .catch((err) => { fulltextLoad = null; throw err; });
  return fulltextLoad;
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
    entries: () => entriesAsset(env, origin),
    fulltext: () => fulltextObject(env),
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

/** RFC 9727 catalog: the REST API (described by /api/openapi) and the MCP server. */
const catalog = (origin: string) => ({
  linkset: [
    {
      anchor: `${origin}/api/`,
      'service-desc': [{ href: `${origin}/api/openapi`, type: 'application/openapi+json' }],
      'service-doc': [{ href: `${origin}/llms.txt`, type: 'text/markdown' }],
    },
    {
      anchor: `${origin}/mcp`,
      'service-desc': [{ href: `${origin}/mcp/server-card`, type: CARD_TYPE }],
      'service-doc': [{ href: `${origin}/llms.txt`, type: 'text/markdown' }],
    },
  ],
});

const CARD_TYPE = 'application/mcp-server-card+json';

/** MCP Server Card (SEP-2127, schema v1). serverInfo, endpoint and capabilities repeat the
 *  identity in the shape of the earlier draft, which some discovery checkers still read. */
const serverCard = (origin: string) => ({
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: `${new URL(origin).hostname.split('.').reverse().join('.')}/${SERVER_INFO.name}`,
  version: SERVER_INFO.version,
  title: SERVER_INFO.title,
  // The registry's server.json caps description at 100 characters.
  description: 'Search a footnoted, cross-linked research archive by meaning, text, source and date.',
  websiteUrl: origin,
  remotes: [{ type: 'streamable-http', url: `${origin}/mcp`, supportedProtocolVersions: SUPPORTED }],
  serverInfo: SERVER_INFO,
  endpoint: `${origin}/mcp`,
  capabilities: { tools: { listChanged: false } },
});

/** AI Catalog / ARD manifest (domain-level discovery) with the one MCP server. */
const aiCatalog = (origin: string) => {
  const host = new URL(origin).hostname;
  return {
    specVersion: '1.0',
    host: { displayName: SERVER_INFO.title, identifier: `did:web:${host}` },
    entries: [{
      identifier: `urn:air:${host}:mcp:${SERVER_INFO.name}`,
      displayName: `${SERVER_INFO.title} research archive`,
      type: CARD_TYPE,
      url: `${origin}/mcp/server-card`,
      // Sample questions registries embed to match this server to queries.
      representativeQueries: [
        'who ran the CIA mind control program MKULTRA',
        'find the connection between two people through documented links',
        'what sources say about an event, with conflicting dates side by side',
        'which entries cite a given book or archive',
      ],
    }],
  };
};

/** Appended to every markdown page, which is what agents read: where the research tools are. */
const agentNote = (origin: string) =>
  `\n\n---\n\n*${SERVER_INFO.title} has an MCP server for agents at ${origin}/mcp (streamable HTTP, no auth): search by meaning, exact text, source or date, and follow typed, footnoted connections. Setup and the same tools over GET: ${origin}/llms.txt*\n`;

/** OpenAPI for the GET endpoints, built from the same tool schemas MCP lists. */
function openapi(origin: string) {
  const paths: Record<string, object> = {};
  for (const [path, name] of Object.entries(API)) {
    const tool = TOOLS.find((t) => t.name === name)!;
    const { properties, required } = tool.inputSchema as { properties: Record<string, { description?: string }>; required?: readonly string[] };
    paths[`/api/${path}`] = {
      get: {
        operationId: name,
        summary: tool.title,
        description: tool.description,
        parameters: Object.entries(properties).map(([key, schema]) => ({
          name: name === 'search' && key === 'query' ? 'q' : key,
          in: 'query',
          required: required?.includes(key) ?? false,
          description: schema.description,
          schema: { ...schema, description: undefined },
          ...((schema as { type?: string }).type === 'array' ? { style: 'form', explode: false } : {}),
        })),
        responses: {
          200: { description: 'Tool result', content: { 'application/json': {} } },
          400: { description: 'Invalid arguments' },
          429: { description: 'Rate limited; see Retry-After' },
          503: { description: 'Temporarily unavailable' },
        },
      },
    };
  }
  return { openapi: '3.1.0', info: { title: SERVER_INFO.title, version: SERVER_INFO.version }, servers: [{ url: origin }], paths };
}

async function api(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'use GET' }, 405, { Allow: 'GET' });
  if (url.pathname === '/api/openapi') return json(openapi(url.origin), 200, { 'Content-Type': 'application/openapi+json', 'Cache-Control': 'public, max-age=3600' });
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

/** OG images, markdown twins (R2 keeps the asset count down) and fulltext.json (too big for an asset). */
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
    const md = url.pathname.endsWith('.md'), data = url.pathname.endsWith('.json');
    const r = new Response(md ? (await new Response(o.body).text()) + agentNote(url.origin) : o.body, {
      headers: {
        'Content-Type': md ? MD_TYPE : data ? 'application/json' : o.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': md || data ? 'public, max-age=300' : 'public, max-age=86400',
        ...(md ? {} : { ETag: o.httpEtag }),
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

/** Accept: text/markdown gets the page's markdown twin (llms.txt for the home page); pages
 * without a twin, and every other client, get HTML. Both carry Vary: Accept. */
async function negotiate(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  let res: Response;
  if (!(req.headers.get('Accept') ?? '').includes('text/markdown')) {
    res = await env.ASSETS.fetch(req);
  } else if (url.pathname === '/') {
    res = await env.ASSETS.fetch(new Request(url.origin + '/llms.txt', req));
    if (res.ok) {
      res = new Response(res.body, res);
      res.headers.set('Content-Type', MD_TYPE);
    }
  } else {
    // /people/sam-lake/ -> /people/sam-lake.md; a miss falls back to the HTML page.
    const twin = new URL(url.pathname.replace(/\/$/, '') + '.md', url.origin);
    res = await fromBucket(req, env, ctx, twin);
  }
  res = new Response(res.body, res);
  res.headers.append('Vary', 'Accept');
  // RFC 9727: the catalog lists the API and the MCP server.
  res.headers.append('Link', '</.well-known/api-catalog>; rel="api-catalog"');
  return res;
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') return mcp(req, env, ctx, url);
    if (url.pathname.startsWith('/api/')) return api(req, env, ctx, url);
    if (url.pathname === '/mcp/server-card' || url.pathname === '/.well-known/mcp/server-card.json') {
      return json(serverCard(url.origin), 200, { 'Content-Type': CARD_TYPE, 'Cache-Control': 'public, max-age=3600' });
    }
    if (url.pathname === '/.well-known/ai-catalog.json') {
      return json(aiCatalog(url.origin), 200, { 'Content-Type': 'application/ai-catalog+json', 'Cache-Control': 'public, max-age=3600' });
    }
    if (url.pathname === '/.well-known/api-catalog') {
      return json(catalog(url.origin), 200, { 'Content-Type': 'application/linkset+json', 'Cache-Control': 'public, max-age=3600' });
    }
    if (url.pathname.startsWith('/og/') || url.pathname.endsWith('.md') || url.pathname === '/fulltext.json') return fromBucket(req, env, ctx, url);
    if (url.pathname === '/' || url.pathname.endsWith('/') || !url.pathname.slice(1).includes('.')) return negotiate(req, env, ctx, url);
    return env.ASSETS.fetch(req);
  },
};
