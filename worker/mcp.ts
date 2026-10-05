// Stateless MCP over streamable HTTP: one JSON-RPC request per POST, answered as JSON.
import { ToolError, TOOLS } from './tools.ts';

export type Run = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `This server searches a cross-linked research archive of people, organizations, programs, events, concepts and places, mostly intelligence history, covert operations, finance and political scandal, with footnoted sources.

Typical flow: search (by meaning or by name) -> get_entry for the full markdown with citations -> neighbors, similar or find_path to follow connections. Entry ids are URL slugs; tools also accept an exact title. Cite entries by their url.`;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };

const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message in, one response out (null for notifications). */
export async function handleRpc(run: Run, msg: Rpc): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg?.id, -32600, 'invalid request');
  }
  const { id, method, params = {} } = msg;
  if (id === undefined) return null;
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'theinfoweb', title: 'The Info Web', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      if (typeof params.name !== 'string') return fail(id, -32602, 'params.name is required');
      if (!TOOLS.some((t) => t.name === params.name)) return fail(id, -32602, `unknown tool "${params.name}"`);
      try {
        const out = await run(params.name, params.arguments ?? {});
        // get_entry's markdown reads better unescaped than inside a JSON string.
        const text = out && typeof out === 'object' && 'markdown' in out ? String((out as any).markdown) : JSON.stringify(out);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        if (err instanceof ToolError) return reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
        throw err;
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}
