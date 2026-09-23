import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSourceIndex } from '../src/lib/source-index.ts';

const entry = (id, title, footnotes) => ({ id, title, type: 'person', footnotes });

test('one online work groups by URL and retains exact citing notes', () => {
  const rows = buildSourceIndex([
    entry('one', 'One', [{ id: '1', text: 'First account. https://example.org/report#p2' }]),
    entry('two', 'Two', [{ id: '3', text: 'Another citation. https://example.org/report#p4' }]),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageCount, 2);
  assert.equal(rows[0].noteCount, 2);
  assert.deepEqual(rows[0].uses.map((use) => use.notes[0].id), ['1', '3']);
});

test('a note with several links stays separate from either linked work', () => {
  const rows = buildSourceIndex([
    entry('one', 'One', [{ id: '1', text: 'Two sources. https://example.org/a https://example.org/b' }]),
    entry('two', 'Two', [{ id: '2', text: 'One source. https://example.org/a' }]),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.urls.length).sort(), [1, 2]);
});

test('unlinked citations group only when their text matches', () => {
  const rows = buildSourceIndex([
    entry('one', 'One', [{ id: '1', text: 'Author. *Book*. 1992.' }]),
    entry('two', 'Two', [{ id: '2', text: 'Author. *Book*. 1992.' }, { id: '3', text: 'Author. *Book*. 1993.' }]),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.pageCount === 2).noteCount, 2);
});
