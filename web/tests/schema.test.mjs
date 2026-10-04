import assert from 'node:assert/strict';
import test from 'node:test';
import { aliasesOf } from '../src/lib/data.ts';
import { entityJsonLd } from '../src/lib/schema.ts';

const entity = (over) => ({
  id: 'x', title: 'X', type: 'person', summary: 'S', tags: [], locations: [], dates: {},
  frontmatter: {}, mtime: '2026-01-02T03:04:05', ...over,
});
const graph = (e) => {
  const [page, thing] = entityJsonLd(entity(e))['@graph'];
  return { page: JSON.parse(JSON.stringify(page)), thing: JSON.parse(JSON.stringify(thing)) };
};

test('aliases merge both frontmatter keys', () => {
  assert.deepEqual(aliasesOf({ frontmatter: { alias: ['A', ' B '], aliases: 'A' } }), ['A', 'B']);
  assert.deepEqual(aliasesOf({ frontmatter: {} }), []);
  assert.deepEqual(aliasesOf({ frontmatter: { alias: [{ 'UFO Cover Up': 'Live!' }, { a: 1, b: 2 }, null, 1995] } }), ['UFO Cover Up: Live!', '1995']);
});

test('person page is a ProfilePage; page-only properties stay off the Person', () => {
  const { page, thing } = graph({
    tags: ['Spy'], locations: ['London'], dates: { born: '1936', died: 'c. 1990' },
    frontmatter: { created: '2026-01-01', alias: ['X', 'Ex'] },
  });
  assert.equal(page['@type'], 'ProfilePage');
  assert.equal(page.dateCreated, '2026-01-01');
  assert.equal(page.keywords, 'Spy');
  assert.deepEqual(page.contentLocation, { '@type': 'Place', name: 'London' });
  assert.equal(page.mainEntity['@id'], thing['@id']);
  assert.equal(thing['@type'], 'Person');
  assert.equal(thing.birthDate, '1936');
  assert.equal(thing.deathDate, undefined);
  assert.equal(thing.alternateName, 'Ex');
  for (const k of ['keywords', 'about', 'location', 'image', 'datePublished', 'dateModified']) {
    assert.equal(thing[k], undefined, k);
  }
});

test('organization, event, program, and source dates map to their own properties', () => {
  assert.equal(graph({ type: 'organization', dates: { start: '1947', end: '1990-05' } }).thing.dissolutionDate, '1990-05');
  const ev = graph({ type: 'event', locations: ['A', 'B'], dates: { date: '1963-11-22' } });
  assert.equal(ev.page['@type'], 'WebPage');
  assert.equal(ev.thing.startDate, '1963-11-22');
  assert.equal(ev.thing.location.length, 2);
  assert.equal(graph({ type: 'program', dates: { start: '1953' } }).thing.temporalCoverage, '1953/..');
  assert.equal(graph({ type: 'program', dates: { start: '~1953' } }).thing.temporalCoverage, undefined);
  assert.equal(graph({ type: 'source', dates: { date: '1975' } }).thing.datePublished, '1975');
});
