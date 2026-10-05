import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRpc } from '../../worker/mcp.ts';
import { Corpus, nameRank } from '../../worker/search.ts';
import { ToolError, runTool } from '../../worker/tools.ts';

// Four entries in 3 dims. Chunk vectors are int8 rows scaled by 1/127 (unit length after scaling).
const entries = [
  ['alpha', 'Alpha Program', 'program', 'About alpha.', ['CIA'], 1953, ['Project A']],
  ['beta', 'Beta Person', 'person', 'About beta.', ['FBI'], 1970, []],
  ['gamma', 'Gamma Place', 'place', 'About gamma.', [], null, []],
  ['delta', 'Delta Org', 'organization', 'Mentions alpha in passing.', ['CIA'], 1980, []],
];
// [entry, anchor, heading, snippet]; each entry's first chunk is its opening section.
const chunks = [
  [0, '', '', 'alpha lead'], [0, 'later', 'Later', 'alpha later'],
  [1, '', '', 'beta lead'],
  [2, '', '', 'gamma lead'],
  [3, '', '', 'delta lead'], [3, 'aside', 'Aside', 'delta aside about alpha'],
];
const rows = [[127, 0, 0], [90, 90, 0], [0, 127, 0], [0, 0, 127], [0, 90, 90], [127, 0, 0]];
const index = { model: 'm', dims: 3, query_prefix: '', lead_weight: 0.5, entries, chunks };
const corpus = () => new Corpus(index, Int8Array.from(rows.flat()), new Float32Array(rows.length).fill(1 / 127));
const ids = (c, hits) => hits.map((h) => c.index.entries[h.entry][0]);

test('the entry about a subject outranks one that mentions it in passing', () => {
  const c = corpus();
  // delta's aside matches the query as well as alpha's lead; alpha's lead bonus decides it.
  const hits = c.search('zzz', c.queryVector([1, 0, 0, 99]), {}, 4);
  assert.deepEqual(ids(c, hits).slice(0, 2), ['alpha', 'delta']);
  assert.deepEqual(hits[0].chunks, [0, 1]);
  assert.deepEqual(hits[1].chunks, [5, 4]);
});

test('filters by type, tag and year range', () => {
  const c = corpus();
  const q = c.queryVector([1, 0, 0]);
  assert.deepEqual(ids(c, c.search('zzz', q, { type: 'organization' })), ['delta']);
  assert.deepEqual(ids(c, c.search('zzz', q, { tag: 'cia' })).sort(), ['alpha', 'delta']);
  assert.deepEqual(ids(c, c.search('zzz', q, { yearFrom: 1960, yearTo: 1975 })), ['beta']);
  assert.ok(!ids(c, c.search('zzz', q, { yearFrom: 1900 })).includes('gamma'));
});

test('names rank exact, prefix, word prefix, substring; work without a query vector', () => {
  assert.deepEqual(['x', 'xy', 'a x', 'axb', 'b'].map((k) => nameRank([k], 'x')), [0, 1, 2, 3, 9]);
  const c = corpus();
  assert.deepEqual(ids(c, c.search('project a', null)), ['alpha']);
  assert.deepEqual(c.search('project a', null)[0].chunks, []);
  assert.equal(c.resolve('Beta Person'), 1);
  assert.equal(c.resolve('gamma'), 2);
  assert.equal(c.resolve('mentions'), undefined);
});

test('a vector file that does not match the index is rejected', () => {
  assert.throws(() => new Corpus(index, new Int8Array(3), new Float32Array(1)), /6 chunks/);
});

const adj = {
  ids: ['alpha', 'beta', 'gamma', 'delta'],
  titles: ['Alpha Program', 'Beta Person', 'Gamma Place', 'Delta Org'],
  types: ['program', 'person', 'place', 'organization'],
  // alpha-beta wikilinked both ways, alpha-delta prose only, beta-gamma alpha... see dir.
  adj: [[1, 3], [0, 2], [1], [0]],
  dir: [[3, 0], [3, 1], [2], [0]],
  mentions: [5, 4, 1, 9],
};
const data = (over = {}) => ({
  origin: 'https://x.test',
  corpus: corpus(),
  adj,
  similar: { alpha: [{ id: 'gamma', score: 0.9 }, { id: 'gone', score: 0.8 }] },
  embed: async () => [1, 0, 0],
  markdown: async (p) => (p === 'programs/alpha.md' ? '# Alpha' : null),
  ...over,
});

test('search returns URLs, deep links and snippets', async () => {
  const out = await runTool(data(), 'search', { query: 'alpha', limit: '2' });
  assert.equal(out.mode, 'semantic');
  assert.equal(out.results.length, 2);
  const [first] = out.results;
  assert.equal(first.url, 'https://x.test/programs/alpha/');
  assert.equal(first.markdown_url, 'https://x.test/programs/alpha.md');
  assert.deepEqual(first.sections[1], { heading: 'Later', url: 'https://x.test/programs/alpha/#later', snippet: 'alpha later' });
  const fallback = await runTool(data({ embed: async () => null }), 'search', { query: 'beta person' });
  assert.equal(fallback.mode, 'names only');
  assert.equal(fallback.results[0].id, 'beta');
});

test('tool arguments are validated', async () => {
  await assert.rejects(runTool(data(), 'search', {}), ToolError);
  await assert.rejects(runTool(data(), 'search', { query: 'x', type: 'planet' }), /must be one of/);
  await assert.rejects(runTool(data(), 'search', { query: 'x', limit: 'many' }), /integer/);
  await assert.rejects(runTool(data({ corpus: null }), 'search', { query: 'x' }), /not built/);
  await assert.rejects(runTool(data(), 'get_entry', { id: 'nobody' }), /use search/);
  await assert.rejects(runTool(data(), 'get_entry', { id: 'beta' }), /no markdown/);
});

test('graph tools: entry, neighbors, path, similar', async () => {
  assert.equal((await runTool(data(), 'get_entry', { id: 'Alpha Program' })).markdown, '# Alpha');
  const n = await runTool(data(), 'neighbors', { id: 'alpha' });
  assert.deepEqual(n.neighbors.map((x) => [x.id, x.link]), [['beta', 'links both ways'], ['delta', 'named in prose']]);
  const p = await runTool(data(), 'find_path', { from: 'delta', to: 'gamma' });
  assert.deepEqual(p.path.map((x) => x.id), ['delta', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(p.path.slice(1).map((x) => x.via), ['named together in prose', 'linked both ways', 'linked from the previous entry']);
  const s = await runTool(data(), 'similar', { id: 'alpha' });
  assert.deepEqual(s.similar.map((x) => x.id), ['gamma']);
});

const rpc = (msg) => handleRpc((name, args) => runTool(data(), name, args), { jsonrpc: '2.0', ...msg });

test('MCP: initialize, list, call, notifications and errors', async () => {
  const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-11-25');
  assert.equal(await rpc({ method: 'notifications/initialized' }), null);
  const list = await rpc({ id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['search', 'get_entry', 'neighbors', 'find_path', 'similar']);
  assert.ok(!('run' in list.result.tools[0]));
  const call = await rpc({ id: 3, method: 'tools/call', params: { name: 'get_entry', arguments: { id: 'alpha' } } });
  assert.deepEqual(call.result.content, [{ type: 'text', text: '# Alpha' }]);
  const bad = await rpc({ id: 4, method: 'tools/call', params: { name: 'search', arguments: {} } });
  assert.equal(bad.result.isError, true);
  assert.equal((await rpc({ id: 5, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
  assert.equal((await rpc({ id: 6, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handleRpc(async () => null, { id: 7, method: 'ping' })).error.code, -32600);
});

// worker/index.ts with in-memory stand-ins for the Cache API, R2, assets and Workers AI.
const store = new Map();
globalThis.caches = {
  default: {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
  },
};
const { default: worker } = await import('../../worker/index.ts');
const env = (over = {}) => ({
  ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { status: new URL(req.url).pathname.endsWith('.md') ? 404 : 200 }) },
  BUCKET: { get: async (key) => (key === 'people/a.md' ? { body: new Response('# A').body, httpEtag: '"e"' } : null) },
  AI: { run: async () => { throw new Error('no AI in tests'); } },
  ...over,
});
const ctx = { waitUntil: (p) => p };
const call = (path, init, e = env()) => worker.fetch(new Request('https://x.test' + path, init), e, ctx);

test('worker: R2 paths, 404 fallback, HEAD, malformed escapes, cache key keeps the query', async () => {
  store.clear();
  const md = await call('/people/a.md');
  assert.equal(md.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(await md.text(), '# A');
  assert.equal((await call('/people/missing.md')).status, 404);
  assert.equal(await (await call('/people/%E0.md')).text(), 'asset /people/%E0.md');
  const head = await call('/people/a.md', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(store.has('https://x.test/people/a.md?deploy='));
  const png = { get: async () => ({ body: new Response('png').body, httpEtag: '"p"' }) };
  await call('/og/people/a.png?v=1', {}, env({ BUCKET: png, CF_VERSION_METADATA: { id: 'd1' } }));
  await call('/og/people/a.png?v=2', {}, env({ BUCKET: png, CF_VERSION_METADATA: { id: 'd1' } }));
  assert.deepEqual([...store.keys()].filter((k) => k.includes('/og/')), ['https://x.test/og/people/a.png?deploy=d1']);
});

test('worker: MCP handshake works when the data cannot load; tool errors stay JSON-RPC', async () => {
  const broken = env({ ASSETS: { fetch: async () => new Response('', { status: 500 }) } });
  const post = (body) => call('/mcp', { method: 'POST', body: JSON.stringify(body) }, broken);
  const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null })).json();
  assert.equal(init.result.serverInfo.name, 'theinfoweb');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const failed = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'neighbors', arguments: { id: 'a' } } })).json();
  assert.equal(failed.error.code, -32603);
  assert.equal((await call('/mcp', { method: 'OPTIONS' })).headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call('/mcp')).status, 405);
  assert.equal((await call('/mcp', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await call('/api/search?q=x', {}, broken)).status, 503);
  assert.equal((await call('/api/nope')).status, 404);
});

test('worker: the rate limiter answers 429 before any work', async () => {
  const limited = env({ LIMITER: { limit: async () => ({ success: false }) } });
  const res = await call('/api/search?q=x', {}, limited);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal((await call('/mcp', { method: 'POST', body: '{}' }, limited)).status, 429);
});
