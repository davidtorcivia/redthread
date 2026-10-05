import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTop, nameRank, quietMarks } from '../src/scripts/search-rank.ts';

const row = (href, title = href) => ({ href, title });

test('top results: strong name matches, then meaning, then substrings, one row per page', () => {
  const names = [[3, row('/people/sub/')], [0, row('/people/exact/')], [2, row('/people/word/')]];
  const meaning = [row('/people/exact/#early-life'), row('/events/meant/'), row('/people/sub/#x')];
  assert.deepEqual(mergeTop(names, meaning).map((r) => r.href), ['/people/exact/', '/people/word/', '/events/meant/', '/people/sub/#x']);
  assert.equal(mergeTop(names, meaning, 2).length, 2);
});

test('name rank and quiet stopword marks', () => {
  assert.equal(nameRank(['allen dulles', 'allen welsh dulles'], 'dulles'), 2);
  assert.equal(nameRank(['cia'], 'cia'), 0);
  assert.equal(
    quietMarks('<mark>the</mark> <mark>CIA</mark> ran <mark>Of</mark> <mark>pigs</mark>'),
    'the <mark>CIA</mark> ran Of <mark>pigs</mark>',
  );
});
