import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDates } from '../src/lib/dates.ts';

test('missing end dates do not imply present-day activity', () => {
  assert.equal(formatDates({start:'1996'}), '1996');
  assert.equal(formatDates({born:'1913-04-20'}), 'Born 1913');
  assert.equal(formatDates({died:'1990'}), 'Died 1990');
});
test('known ranges and single dates remain readable', () => {
  assert.equal(formatDates({start:'1971',end:'1994'}), '1971–1994');
  assert.equal(formatDates({born:'1913',died:'1990'}), '1913–1990');
  assert.equal(formatDates({start:'1996',end:'1996'}), '1996');
  assert.equal(formatDates({date:'1963-11-22'}), '1963');
  assert.equal(formatDates({end:'1994'}), 'Ended 1994');
  assert.equal(formatDates({}), '');
});
