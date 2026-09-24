// Atom feed of recent edits, the same data as /changelog/.
import type { APIRoute } from 'astro';
import { activity, hrefFor, TYPE_LABELS } from '../lib/data.ts';
import { escapeHtml as esc, plainText } from '../lib/inline-md.ts';
import { absUrl, SITE_TITLE } from '../lib/site.ts';

const EPOCH = '1970-01-01T00:00:00Z';

// Atom needs RFC 3339 with an offset; the parser's mtimes are naive, so read them as UTC.
function rfc3339(iso: string): string {
  if (!iso) return EPOCH;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? EPOCH : d.toISOString();
}

export const GET: APIRoute = () => {
  const entries = activity().slice(0, 50);
  const items = entries.map((e) => {
    const url = esc(absUrl(hrefFor(e)));
    const summary = plainText(e.summary);
    return [
      '  <entry>',
      `    <title>${esc(e.title)}</title>`,
      `    <link href="${url}"/>`,
      `    <id>${url}</id>`,
      `    <updated>${rfc3339(e.mtime)}</updated>`,
      `    <category term="${esc(TYPE_LABELS[e.type] || e.type)}"/>`,
      summary ? `    <summary>${esc(summary)}</summary>` : '',
      '  </entry>',
    ].filter(Boolean).join('\n');
  });

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${esc(SITE_TITLE)}: Changelog</title>`,
    '  <subtitle>Recent additions and revisions to the vault.</subtitle>',
    `  <link href="${esc(absUrl('/feed.xml'))}" rel="self"/>`,
    `  <link href="${esc(absUrl('/'))}"/>`,
    `  <id>${esc(absUrl('/'))}</id>`,
    `  <updated>${entries.length ? rfc3339(entries[0].mtime) : EPOCH}</updated>`,
    ...items,
    '</feed>',
    '',
  ].join('\n');

  return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
};
