import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainText, renderInlineMd } from '../src/lib/inline-md.ts';

test('summaries render inline markdown and escape HTML', () => {
  assert.equal(renderInlineMd('**a** *b* `c` [[T|d]] [[e]] <i>'), '<strong>a</strong> <em>b</em> <code>c</code> d e &lt;i&gt;');
  assert.equal(renderInlineMd(null), '');
});

test('links keep only schemes that cannot run script', () => {
  assert.equal(renderInlineMd('[x](https://example.org/?a=1&b=2)'), '<a href="https://example.org/?a=1&amp;b=2">x</a>');
  assert.equal(renderInlineMd('[x](/people/a/)'), '<a href="/people/a/">x</a>');
  assert.equal(renderInlineMd('[x](javascript:alert)'), 'x');
  assert.equal(renderInlineMd('[x](java\tscript:alert)'), 'x');
  assert.equal(renderInlineMd('[x](data:text/html,hi)'), 'x');
  assert.equal(renderInlineMd('[x](https://a.org/"onmouseover=")'), '<a href="https://a.org/&quot;onmouseover=&quot;">x</a>');
});

test('plain text drops markup', () => {
  assert.equal(plainText(' **Bold** [[T|shown]] [link](https://x.org)  _it_ '), 'Bold shown link it');
  assert.equal(plainText('<b>AT&amp;T</b> &quot;x&quot;'), 'AT&T "x"');
});
