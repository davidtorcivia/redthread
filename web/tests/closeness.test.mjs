import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeness } from '../src/scripts/graph-rank.ts';

test('closeness: an ordinary entry ranks by shared links over sqrt(degree)', () => {
  // Entry with 100 links: a specific neighbour (20 shared of 30) beats a hub (60 shared of 1,200).
  assert(closeness(20, 30, 100) > closeness(60, 1200, 100));
});

test('closeness: a hub discounts other hubs harder', () => {
  // For a 1,000-link hub, sqrt would rank the other hub (400 of 1,300) above a specific
  // tie (12 of 15); the steeper power puts the specific tie first.
  assert(400 / Math.sqrt(1300) > 12 / Math.sqrt(15));
  assert(closeness(12, 15, 1000) > closeness(400, 1300, 1000));
});

test('closeness: under 3 shared links, only the shared count orders neighbours', () => {
  assert(closeness(2, 2, 50) > closeness(1, 1, 50));
  assert(closeness(3, 100, 50) > closeness(2, 2, 50));
});
