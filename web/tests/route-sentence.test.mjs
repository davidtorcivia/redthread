import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeSentence } from '../src/scripts/graph-path.ts';

// 0 person, 1 org, 2 person, 3 org. 0 employed_by 1, 2 head_of 1; 2–3 only a prose mention.
const g = {
  types: ['person', 'organization', 'person', 'organization'],
  adj: [[1], [0, 2], [1, 3], [2]],
  dir: [[1], [2, 1], [2, 0], [0]],
  relationTypes: ['employed_by', 'head_of'],
  relations: [[0, 1, 0], [2, 1, 1]],
};

test('routeSentence: verbs follow relation direction, pronoun follows the node type', () => {
  assert.deepEqual(routeSentence(g, [0, 1, 2, 3]), [
    0, ' worked for ', 1, ', which was headed by ', 2, ', who is named alongside ', 3, '.',
  ]);
});

test('routeSentence: read backwards, each verb flips to the other side', () => {
  assert.deepEqual(routeSentence(g, [2, 1, 0]), [2, ' headed ', 1, ', which employed ', 0, '.']);
});

test('routeSentence: without relations it falls back to the link', () => {
  const { relations, ...bare } = g;
  assert.deepEqual(routeSentence(bare, [0, 1]), [0, ' is linked to ', 1, '.']);
});
