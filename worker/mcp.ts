// MCP over streamable HTTP, one JSON-RPC request per POST, answered as JSON. Dual-era:
// requests carrying per-request _meta are served as protocol 2026-07-28; `initialize` and
// requests without _meta follow the handshake-based revisions up to 2025-11-25.
import { ToolError, TOOLS } from './tools.ts';

export type Run = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export interface Reply { status: number; body: object | null }

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const SERVER_INFO = { name: 'theinfoweb', title: 'The Info Web', version: '1.1.0' };
const CAPABILITIES = { tools: { listChanged: false } };
/** The tool list and server description change only on deploy. */
const CACHE = { ttlMs: 3_600_000, cacheScope: 'public' };
const M = 'io.modelcontextprotocol/';

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

export const INSTRUCTIONS = `This server searches a cross-linked research archive of people, organizations, programs, events, concepts and places, mostly intelligence history, covert operations, finance and political scandal, with footnoted sources.

Typical flow: search (by meaning or by name) -> get_entry for the full markdown with citations -> neighbors, similar or find_path to follow connections. Entry ids are URL slugs; tools also accept an exact title. Cite entries by their url.`;

/** Every tool only reads the archive. */
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const toolList = () => TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: ANNOTATIONS }));

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
interface HeaderReader { get(name: string): string | null }

const ok = (id: Rpc['id'], result: unknown, status = 200): Reply => ({ status, body: { jsonrpc: '2.0', id: id ?? null, result } });
const err = (id: Rpc['id'], code: number, message: string, status = 200, data?: unknown): Reply =>
  ({ status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } } });

/** Header values may carry non-ASCII text as =?base64?...?= (UTF-8). */
export function decodeHeader(v: string | null): string | null {
  const m = v?.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

async function callTool(run: Run, id: Rpc['id'], params: Record<string, any>): Promise<{ result: object } | Reply> {
  if (typeof params.name !== 'string') return err(id, -32602, 'params.name is required');
  if (!TOOLS.some((t) => t.name === params.name)) return err(id, -32602, `unknown tool "${params.name}"`);
  try {
    const out = await run(params.name, params.arguments ?? {});
    // get_entry's markdown reads better unescaped than inside a JSON string.
    const text = out && typeof out === 'object' && 'markdown' in out ? String((out as any).markdown) : JSON.stringify(out);
    return { result: { content: [{ type: 'text', text }] } };
  } catch (e) {
    if (e instanceof ToolError) return { result: { content: [{ type: 'text', text: e.message }], isError: true } };
    throw e;
  }
}

/** Handshake-based revisions: answered with 200 and the shapes those revisions define. */
async function legacy(run: Run, id: Rpc['id'], method: string, params: Record<string, any>): Promise<Reply> {
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok(id, {
        protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolList() });
    case 'tools/call': {
      const r = await callTool(run, id, params);
      return 'result' in r ? ok(id, r.result) : r;
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

/** Protocol 2026-07-28: every request stands alone and carries its version in _meta. */
async function modern(run: Run, id: Rpc['id'], method: string, params: Record<string, any>, version: string, headers: HeaderReader): Promise<Reply> {
  // The body is the source of truth; mirrored headers must agree with it so intermediaries
  // that route or rate-limit on them cannot be fooled.
  const mismatch = (name: string, body: string) => {
    const h = decodeHeader(headers.get(name));
    return h === body ? null : err(id, HEADER_MISMATCH, h == null ? `missing ${name} header` : `${name} header "${h}" does not match body value "${body}"`, 400);
  };
  const bad = mismatch('MCP-Protocol-Version', version) ?? mismatch('Mcp-Method', method)
    ?? (method === 'tools/call' && typeof params.name === 'string' ? mismatch('Mcp-Name', params.name) : null);
  if (bad) return bad;
  const caps = params._meta[`${M}clientCapabilities`];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return err(id, -32602, `_meta["${M}clientCapabilities"] is required`, 400);
  }
  const done = (result: object) => ok(id, { resultType: 'complete', ...result, _meta: { [`${M}serverInfo`]: SERVER_INFO } });
  switch (method) {
    case 'server/discover':
      return done({ supportedVersions: SUPPORTED, capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ...CACHE });
    case 'ping':
      return done({});
    case 'tools/list':
      return done({ tools: toolList(), ...CACHE });
    case 'tools/call': {
      const r = await callTool(run, id, params);
      return 'result' in r ? done(r.result) : r;
    }
    default:
      return err(id, -32601, `method not found: ${method}`, 404);
  }
}

/** One JSON-RPC message in; the HTTP status and body out (null body for a notification). */
export async function handleRpc(run: Run, msg: Rpc, headers: HeaderReader = new Headers()): Promise<Reply> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg?.id, -32600, 'invalid request', 400);
  }
  const { id, method } = msg;
  if (id === undefined) return { status: 202, body: null };
  if (id === null) return err(null, -32600, 'request id must not be null', 400);
  const params = msg.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) return err(id, -32602, 'params must be an object', 400);
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : null;
  const bodyVersion = meta?.[`${M}protocolVersion`];
  const headerVersion = headers.get('MCP-Protocol-Version');

  if (method !== 'initialize' && (bodyVersion !== undefined || (headerVersion && !LEGACY.includes(headerVersion)))) {
    const requested = typeof bodyVersion === 'string' ? bodyVersion : headerVersion;
    if (!SUPPORTED.includes(requested as string)) {
      return err(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', 400, { supported: SUPPORTED, requested });
    }
    if (MODERN.includes(requested as string)) {
      if (typeof bodyVersion !== 'string') return err(id, -32602, `_meta["${M}protocolVersion"] is required`, 400);
      return modern(run, id, method, params, bodyVersion, headers);
    }
  }
  return legacy(run, id, method, params);
}
