import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHeader, handleRpc } from '../../worker/mcp.ts';
import { Corpus, nameRank } from '../../worker/search.ts';
import { ToolError, runTool } from '../../worker/tools.ts';
import { datesIn, phrase, sentences, snippet, terms } from '../../worker/research.ts';

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
const rec = (id, title, type, dir, extra = {}) => ({ id, title, type, path: `/${dir}/${id}/`, aliases: [], dates: {}, relations: [], ...extra });
const src = (page, footnote, text) => ({ page, footnote, text });
// beta employed_by gamma (typed, sourced); no wikilink between them goes beta -> delta.
const recs = [
  rec('alpha', 'Alpha Program', 'program', 'programs', { dates: { start: '1974' }, tags: ['CIA'], updated: '2026-01-02' }),
  rec('beta', 'Beta Person', 'person', 'people', {
    updated: '2026-03-01',
    relations: [
      { type: 'employed_by', target: 'gamma', target_title: 'Gamma Place', start: '1975', end: null, role: 'office not stated', source: src('beta', '1', 'Smith, Exempt from Disclosure, 1999.') },
      { type: 'member_of', target: null, target_title: 'No Page Org', start: null, end: null, role: null, source: src('beta', '2', 'Jones 2001.') },
    ],
  }),
  rec('gamma', 'Gamma Place', 'place', 'places', { aliases: ['Gamma'], dates: { start: '1975' } }),
  rec('delta', 'Delta Org', 'organization', 'organizations'),
];
const fulltext = {
  sections: [
    ['alpha', '', '', 'Alpha began in late 1974. It moved.[^1] Gamma hosted it in winter 1975.[^2]'],
    ['beta', 'career', 'Career', 'Beta joined Gamma on October 14, 1988.[^1] In 1990 it closed.\nUnrelated line about 1974.'],
    ['gamma', '', '', 'Gamma opened in 1975. Others say October 18.[^1]'],
    ['delta', '', '', 'Delta said Gamma opened 18 October 1988.[^1] Exempt text here.'],
  ],
  footnotes: {
    alpha: { 1: 'Smith, Exempt from Disclosure, 1999.', 2: 'Doe 2005.' },
    beta: { 1: 'Smith, Exempt from Disclosure, 1999.', 2: 'Jones 2001.' },
    delta: { 1: 'Roe 2010.' },
    gamma: { 1: 'Pilkington (2010) gives 18 October.' },
  },
};
const data = (over = {}) => ({
  origin: 'https://x.test',
  corpus: corpus(),
  adj,
  similar: { alpha: [{ id: 'gamma', score: 0.9 }, { id: 'gone', score: 0.8 }] },
  embed: async () => [1, 0, 0],
  markdown: async (p) => (p === 'programs/alpha.md' ? '# Alpha' : null),
  entries: async () => recs,
  fulltext: async () => fulltext,
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
  const p = await runTool(data(), 'find_path', { from: 'delta', to: 'gamma', edges: 'any' });
  assert.deepEqual(p.path.map((x) => x.id), ['delta', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(p.path.slice(1).map((x) => x.via), ['named together in prose', 'linked both ways', 'linked from the previous entry']);
  const s = await runTool(data(), 'similar', { id: 'alpha' });
  assert.deepEqual(s.similar.map((x) => x.id), ['gamma']);
});

const run = (name, args) => runTool(data(), name, args);
const raw = (msg, headers) => handleRpc(run, { jsonrpc: '2.0', ...msg }, new Headers(headers));
const rpc = async (msg, headers) => (await raw(msg, headers)).body;

test('MCP: initialize, list, call, notifications and errors', async () => {
  const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-11-25');
  assert.deepEqual(await raw({ method: 'notifications/initialized' }), { status: 202, body: null });
  const list = await rpc({ id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['search', 'search_semantic', 'search_lexical', 'search_citations', 'get_entry', 'neighbors', 'find_path', 'similar', 'timeline', 'list_entries']);
  assert.ok(!('run' in list.result.tools[0]));
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(list.result.resultType, undefined);
  const call = await rpc({ id: 3, method: 'tools/call', params: { name: 'get_entry', arguments: { id: 'alpha' } } });
  assert.deepEqual(call.result.content, [{ type: 'text', text: '# Alpha' }]);
  const bad = await rpc({ id: 4, method: 'tools/call', params: { name: 'search', arguments: {} } });
  assert.equal(bad.result.isError, true);
  assert.equal((await rpc({ id: 5, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
  assert.equal((await rpc({ id: 6, method: 'resources/list' })).error.code, -32601);
  assert.deepEqual((await handleRpc(async () => null, { id: 7, method: 'ping' })).status, 400);
  assert.equal((await rpc({ id: 8, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-06-18' })).result.tools.length, 10);
});

// Protocol 2026-07-28: per-request _meta plus mirrored headers.
const V = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} };
const modern = (id, method, params = {}, extra = {}) => raw(
  { id, method, params: { ...params, _meta: meta } },
  { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}), ...extra },
);

test('MCP 2026-07-28: discover, list, call carry resultType, serverInfo and cache hints', async () => {
  const d = await modern(1, 'server/discover');
  assert.equal(d.status, 200);
  assert.equal(d.body.result.resultType, 'complete');
  assert.deepEqual(d.body.result.supportedVersions.slice(0, 2), [V, '2025-11-25']);
  assert.equal(d.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'theinfoweb');
  assert.equal(d.body.result.cacheScope, 'public');
  const l = (await modern(2, 'tools/list')).body.result;
  assert.equal(l.tools.length, 10);
  assert.ok(l.ttlMs > 0);
  const c = (await modern(3, 'tools/call', { name: 'get_entry', arguments: { id: 'alpha' } })).body.result;
  assert.equal(c.resultType, 'complete');
  assert.deepEqual(c.content, [{ type: 'text', text: '# Alpha' }]);
  const e = (await modern(4, 'tools/call', { name: 'search', arguments: {} })).body.result;
  assert.equal(e.isError, true);
  assert.equal((await modern(5, 'ping')).body.result.resultType, 'complete');
});

test('MCP 2026-07-28: header validation, version errors, missing fields, unknown methods', async () => {
  const mismatch = await modern(1, 'tools/call', { name: 'search', arguments: { query: 'x' } }, { 'Mcp-Name': 'similar' });
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [400, -32020]);
  const noMethod = await raw({ id: 2, method: 'tools/list', params: { _meta: meta } }, { 'MCP-Protocol-Version': V });
  assert.deepEqual([noMethod.status, noMethod.body.error.code], [400, -32020]);
  const versionHeader = await modern(3, 'tools/list', {}, { 'MCP-Protocol-Version': '2025-11-25' });
  assert.equal(versionHeader.body.error.code, -32020);
  const encoded = await modern(4, 'tools/call', { name: 'get_entry', arguments: { id: 'alpha' } }, { 'Mcp-Name': '=?base64?Z2V0X2VudHJ5?=' });
  assert.equal(encoded.status, 200);
  const future = await raw({ id: 5, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
    { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' });
  assert.deepEqual([future.status, future.body.error.code, future.body.error.data.requested], [400, -32022, '2099-01-01']);
  assert.ok(future.body.error.data.supported.includes(V));
  const headerOnly = await raw({ id: 6, method: 'tools/list' }, { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' });
  assert.deepEqual([headerOnly.status, headerOnly.body.error.code], [400, -32602]);
  const noCaps = await raw({ id: 7, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } } },
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' });
  assert.deepEqual([noCaps.status, noCaps.body.error.code], [400, -32602]);
  const unknown = await modern(8, 'resources/list');
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, -32601]);
  assert.equal(decodeHeader('=?base64?SGVsbG8sIOS4lueVjA==?='), 'Hello, 世界');
  assert.equal(decodeHeader('plain'), 'plain');
  const crossEra = await raw({ id: 9, method: 'tools/call', params: { name: 'search', arguments: { query: 'x' }, _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } },
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' });
  assert.deepEqual([crossEra.status, crossEra.body.error.code], [400, -32020]);
  const b64Method = await modern(10, 'tools/list', {}, { 'Mcp-Method': '=?base64?dG9vbHMvbGlzdA==?=' });
  assert.equal(b64Method.body.error.code, -32020);
  const numeric = await raw({ id: 11, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': 20260728 } } });
  assert.deepEqual([numeric.status, numeric.body.error.code], [400, -32602]);
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
  assert.ok((await md.text()).startsWith('# A\n'));
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

test('worker: Accept: text/markdown gets the twin, or llms.txt at /, else HTML; all Vary: Accept', async () => {
  store.clear();
  const md = { headers: { Accept: 'text/markdown, text/html;q=0.9' } };
  for (const path of ['/people/a/', '/people/a']) {
    const r = await call(path, md);
    assert.equal(r.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
    assert.ok((await r.text()).startsWith('# A\n'));
    assert.match(r.headers.get('Vary'), /Accept/);
  }
  const home = await call('/', md);
  assert.equal(home.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(await home.text(), 'asset /llms.txt');
  const noTwin = await call('/tags/', md);
  assert.equal(await noTwin.text(), 'asset /tags/');
  const html = await call('/people/a/');
  assert.equal(await html.text(), 'asset /people/a/');
  assert.match(html.headers.get('Vary'), /Accept/);
  assert.equal(await (await call('/_astro/x.js', md)).text(), 'asset /_astro/x.js');
});

test('worker: API catalog and OpenAPI describe every GET endpoint', async () => {
  const cat = await call('/.well-known/api-catalog');
  assert.equal(cat.headers.get('Content-Type'), 'application/linkset+json');
  const { linkset } = await cat.json();
  assert.equal(linkset[0]['service-desc'][0].href, 'https://x.test/api/openapi');
  const spec = await (await call('/api/openapi')).json();
  assert.deepEqual(Object.keys(spec.paths), ['/api/search', '/api/semantic', '/api/lexical', '/api/citations', '/api/entry', '/api/neighbors', '/api/path', '/api/similar', '/api/timeline', '/api/entries']);
  const exclude = spec.paths['/api/path'].get.parameters.find((p) => p.name === 'exclude');
  assert.deepEqual([exclude.style, exclude.explode], ['form', false]);
  const q = spec.paths['/api/search'].get.parameters.find((p) => p.name === 'q');
  assert.equal(q.required, true);
});

test('search_semantic skips the name boost and fails without embeddings', async () => {
  const out = await runTool(data(), 'search_semantic', { query: 'beta person' });
  assert.equal(out.mode, 'semantic only');
  assert.equal(out.results[0].id, 'alpha');
  await assert.rejects(runTool(data({ embed: async () => null }), 'search_semantic', { query: 'x' }), /unavailable/);
});

test('search_lexical: all terms, phrases, filters, snippets with their footnotes', async () => {
  const out = await runTool(data(), 'search_lexical', { query: 'gamma "October 14"' });
  assert.deepEqual(out.results.map((r) => r.id), ['beta']);
  const [sec] = out.results[0].sections;
  assert.equal(sec.url, 'https://x.test/people/beta/#career');
  assert.ok(!sec.snippet.includes('[^'));
  assert.deepEqual(sec.sources, [{ footnote: '1', text: 'Smith, Exempt from Disclosure, 1999.' }]);
  const named = await runTool(data(), 'search_lexical', { query: 'gamma' });
  assert.deepEqual(named.results.map((r) => r.id).sort(), ['alpha', 'beta', 'delta', 'gamma']);
  assert.equal(named.results[0].id, 'gamma');
  assert.deepEqual((await runTool(data(), 'search_lexical', { query: 'gamma', type: 'organization' })).results.map((r) => r.id), ['delta']);
  assert.equal((await runTool(data(), 'search_lexical', { query: 'gam' })).results.length, 0);
});

test('search_citations groups identical footnotes and attaches the relations they source', async () => {
  const out = await runTool(data(), 'search_citations', { query: '"exempt from disclosure"' });
  assert.equal(out.matching_citations, 1);
  assert.deepEqual(out.citing_entries.map((x) => [x.id, x.footnotes]), [['alpha', ['1']], ['beta', ['1']]]);
  const [c] = out.citations;
  assert.equal(c.cited_by_count, 2);
  assert.deepEqual(c.cited_by.map((x) => [x.id, x.footnote]), [['alpha', '1'], ['beta', '1']]);
  assert.deepEqual(c.relations.map((r) => [r.from, r.type, r.to]), [['beta', 'employed_by', 'gamma']]);
});

test('timeline by year range groups dated statements, frontmatter and relation dates', async () => {
  const out = await runTool(data(), 'timeline', { year_from: '1974', year_to: '1975' });
  assert.deepEqual(out.groups.map((g) => g.date), ['1974', 'late 1974', '1975', 'winter 1975', 'October 18']);
  const late = out.groups[1].items[0];
  assert.equal(late.kind, 'statement');
  assert.equal(late.text, 'Alpha began in late 1974.');
  assert.deepEqual(late.sources, [{ footnote: '1', text: 'Smith, Exempt from Disclosure, 1999.' }]);
  assert.equal(late.source_inherited, true);
  assert.deepEqual(out.groups[2].items.map((x) => x.kind), ['start', 'relation start', 'statement']);
  await assert.rejects(runTool(data(), 'timeline', { year_from: 1900, year_to: 1990 }), /at most/);
  await assert.rejects(runTool(data(), 'timeline', {}), /give/);
  await assert.rejects(runTool(data(), 'timeline', { year_from: 1980, year_to: 1970 }), /must not be after/);
});

test('timeline by entry reads linking pages and keeps sentences about it', async () => {
  const out = await runTool(data(), 'timeline', { entry: 'gamma' });
  // beta neighbors gamma; delta does not, so its date stays out.
  // "In 1990 it closed." follows a sentence naming Gamma; beta's next paragraph does not.
  assert.deepEqual(out.groups.map((g) => g.date), ['1975', 'October 18', 'October 14 1988', '1990']);
  assert.deepEqual(out.groups[0].items.map((x) => x.kind), ['start', 'relation start', 'statement']);
  // A year-less date takes the year of the text before it, or in a footnote the entry's own year.
  assert.deepEqual(out.groups[1].items.map((x) => x.kind), ['statement', 'footnote']);
  assert.equal(out.groups[2].items[0].entry.id, 'beta');
  assert.equal(out.groups[3].items[0].text, 'In 1990 it closed.');
});

test('text helpers: date forms, inferred years, abbreviations, inherited footnotes', () => {
  const ds = datesIn('In late 1974 or winter of 1975, on October 14, 1988 or 18 October 1988, March 1975, mid-1970s, 1990; October 20.');
  assert.deepEqual(ds.map((x) => [x.text, x.key]), [
    ['late 1974', 19741000], ['winter of 1975', 19750100], ['October 14, 1988', 19881014], ['18 October 1988', 19881018],
    ['March 1975', 19750300], ['1990', 19900000], ['October 20', 19901020],
  ]);
  assert.equal(ds.at(-1).inferred, true);
  assert.deepEqual(datesIn('Aired October 18.'), []);
  assert.deepEqual(datesIn('Book (2010) says 18 October.', { year: 1988, fixed: true }).map((x) => x.key), [20100000, 19881018]);
  const ss = sentences('He joined the U.S. Army under Gen. Smith in 1974. He left.[^1] Alone.\nNext para.[^2]');
  assert.deepEqual(ss.map((x) => [x.text, x.notes, x.inherited, x.para]), [
    ['He joined the U.S. Army under Gen. Smith in 1974.', ['1'], true, 0],
    ['He left.', ['1'], false, 0],
    ['Alone.', [], false, 0],
    ['Next para.', ['2'], false, 1],
  ]);
  assert.ok(new RegExp(phrase('Cover-Up Live!'), 'i').test('aired as Cover-Up Live!, then'));
  // Day ranges keep their own year; a number before a word starting like a month is not a date.
  assert.deepEqual(datesIn('Planning began in 1960. The landing ran April 17-19, 1961, and September 13 and 14, 1978.').map((x) => x.key),
    [19600000, 19610417, 19780913]);
  assert.deepEqual(datesIn('In 1974 officials 26 declared it; 14 marked items. Oct. 3 came.').map((x) => x.text), ['1974', 'Oct. 3']);
  assert.deepEqual(sentences('He was released on Nov. 14, 2025.[^3] Then left.').map((x) => x.text), ['He was released on Nov. 14, 2025.', 'Then left.']);
  // A snippet window never cuts a footnote marker in half.
  const long = 'x'.repeat(200) + 'needle' + 'y'.repeat(157) + '[^12] tail';
  assert.ok(snippet(long, /needle/g).includes('[^12]'));
  assert.deepEqual(terms('"Exempt from  Disclosure" C++').map(String), ['/\\bExempt\\s+from\\s+Disclosure\\b/gi', '/\\bC\\+\\+/gi']);
});

test('find_path: typed relations, exclusions, links only, alternatives', async () => {
  const typed = await runTool(data(), 'find_path', { from: 'beta', to: 'gamma', edges: 'relations' });
  assert.deepEqual(typed.path.map((x) => x.id), ['beta', 'gamma']);
  assert.equal(typed.path[1].relations[0].type, 'employed_by');
  assert.equal(typed.path[1].relations[0].source.text, 'Smith, Exempt from Disclosure, 1999.');
  assert.equal((await runTool(data(), 'find_path', { from: 'alpha', to: 'gamma', edges: 'relations' })).path, null);
  const links = await runTool(data(), 'find_path', { from: 'delta', to: 'gamma' });
  assert.equal(links.path, null);
  assert.match(links.note, /try edges "any"/);
  assert.equal((await runTool(data(), 'find_path', { from: 'delta', to: 'gamma', edges: 'any', exclude: 'alpha' })).path, null);
  const k = await runTool(data(), 'find_path', { from: 'delta', to: 'gamma', edges: 'any', k: 3 });
  assert.deepEqual(k.alternatives, []);
  await assert.rejects(runTool(data(), 'find_path', { from: 'a', to: 'b', edges: 'teleport' }), /must be one of/);
});

test('list_entries pages frontmatter with filters', async () => {
  const out = await runTool(data(), 'list_entries', { limit: 2 });
  assert.equal(out.total, 4);
  assert.equal(out.next_offset, 2);
  assert.equal(out.bulk_url, 'https://x.test/entries.json');
  assert.equal(out.entries[0].url, 'https://x.test/programs/alpha/');
  assert.deepEqual((await runTool(data(), 'list_entries', { updated_since: '2026-02-01' })).entries.map((r) => r.id), ['beta']);
  assert.deepEqual((await runTool(data(), 'list_entries', { tag: 'cia' })).entries.map((r) => r.id), ['alpha']);
});

test('timeline keeps same-key groups together; lexical bonus for many sections is bounded', async () => {
  const ft = (sections) => ({ sections, footnotes: {} });
  const t = await runTool(data({ fulltext: async () => ft([
    ['alpha', '', '', 'In late 1974, X.'], ['beta', '', '', 'In October 1974, Y.'], ['delta', '', '', 'In late 1974, Z.'],
  ]) }), 'timeline', { year: 1974 });
  assert.deepEqual(t.groups.map((g) => [g.date, g.items.length]), [['1974', 1], ['late 1974', 2], ['October 1974', 1]]);
  // gamma's title names the query once; delta repeats it across twelve sections.
  const many = Array.from({ length: 12 }, (_, i) => ['delta', `s${i}`, '', 'Gamma Place']);
  const both = await runTool(data({ fulltext: async () => ft([['gamma', '', '', 'Gamma Place'], ...many]) }), 'search_lexical', { query: 'gamma place' });
  assert.equal(both.results[0].id, 'gamma');
});

test('site path finder prefers wikilinks and falls back to prose co-mentions', async () => {
  const { findLinkedPath: sitePath } = await import('../src/scripts/graph-path.ts');
  // 0-1 prose only (short); 0-2-3-1 wikilinked (longer); 4 reachable only through prose.
  const adj = [[1, 2], [0, 3, 4], [0, 3], [1, 2], [1]];
  const dir = [[0, 3], [0, 3, 0], [3, 3], [3, 3], [0]];
  assert.deepEqual(sitePath(adj, dir, 0, 1), [0, 2, 3, 1]);
  assert.deepEqual(sitePath(adj, dir, 0, 4), [0, 1, 4]);
});

test('findRoutes: avoided entries and distinct alternatives', async () => {
  const { findRoutes } = await import('../src/scripts/graph-path.ts');
  // 0 to 4 three ways: through 1, through 2, through 3 (all wikilinked).
  const adj = [[1, 2, 3], [0, 4], [0, 4], [0, 4], [1, 2, 3]];
  const dir = adj.map((l) => l.map(() => 3));
  const all = findRoutes(adj, dir, 0, 4);
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((r) => r[1])).size, 3);
  const without = findRoutes(adj, dir, 0, 4, [1, 2]);
  assert.deepEqual(without, [[0, 3, 4]]);
  assert.deepEqual(findRoutes(adj, dir, 0, 4, [1, 2, 3]), []);
});

test('worker: fulltext.json is served from R2', async () => {
  store.clear();
  const bucket = { get: async (key) => (key === 'fulltext.json' ? { body: new Response('{"sections":[]}').body, httpEtag: '"f"' } : null) };
  const res = await call('/fulltext.json', {}, env({ BUCKET: bucket }));
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(await res.text(), '{"sections":[]}');
});

test('worker: MCP discovery (server card, AI catalog, Link header, note on markdown)', async () => {
  store.clear();
  for (const path of ['/mcp/server-card', '/.well-known/mcp/server-card.json']) {
    const res = await call(path);
    assert.equal(res.headers.get('Content-Type'), 'application/mcp-server-card+json');
    const card = await res.json();
    assert.equal(card.name, 'test.x/theinfoweb');
    assert.deepEqual(card.remotes[0].url, 'https://x.test/mcp');
    assert.equal(card.serverInfo.version, card.version);
    assert.ok(card.description.length <= 100);
  }
  const cat = await (await call('/.well-known/ai-catalog.json')).json();
  assert.equal(cat.entries[0].url, 'https://x.test/mcp/server-card');
  const api = await (await call('/.well-known/api-catalog')).json();
  assert.equal(api.linkset[1]['service-desc'][0].href, 'https://x.test/mcp/server-card');
  assert.match((await call('/people/a/')).headers.get('Link'), /rel="api-catalog"/);
  const md = await (await call('/people/a.md')).text();
  assert.ok(md.startsWith('# A'));
  assert.match(md, /MCP server for agents at https:\/\/x\.test\/mcp/);
});
