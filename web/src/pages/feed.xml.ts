import type { APIRoute } from 'astro';
import { activity, TYPE_DIRS, TYPE_LABELS } from '../lib/data.ts';
import type { EntityType } from '../lib/types.ts';

/**
 * Atom feed of recent vault activity — the same data behind /changelog/,
 * exposed so readers and aggregators can subscribe to updates. Atom (not
 * RSS) because every entry has a real last-modified timestamp, which Atom's
 * <updated> models cleanly.
 */
const FEED_LIMIT = 50;

function esc(s: string): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!
  ));
}

// Entry summaries carry inline markdown (bold, wikilinks). Strip it to plain
// text for the feed — readers show <summary> as text, not HTML.
function plain(s: string): string {
  return String(s || '')
    .replace(/\[\[([^|\]]+?)\|([^\]]+?)\]\]/g, '$2')
    .replace(/\[\[([^\]]+?)\]\]/g, '$1')
    .replace(/\[([^\]\n]+?)\]\([^)\n]+?\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// mtime is an ISO string without a timezone (e.g. 2026-05-22T21:24:29.4).
// Atom requires RFC 3339 with an offset; treat naive stamps as UTC.
function rfc3339(iso: string, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

export const GET: APIRoute = ({ site }) => {
  const base = site ? site.toString().replace(/\/+$/, '') : '';
  const entries = activity().slice(0, FEED_LIMIT);
  // Feed-level <updated> = newest entry, or a stable fallback when empty.
  const fallback = '1970-01-01T00:00:00Z';
  const updated = entries.length ? rfc3339(entries[0].mtime, fallback) : fallback;

  const items = entries.map((e) => {
    const url = `${base}/${TYPE_DIRS[e.type as EntityType]}/${e.id}/`;
    const summary = plain(e.summary || '');
    return [
      '  <entry>',
      `    <title>${esc(e.title)}</title>`,
      `    <link href="${esc(url)}"/>`,
      `    <id>${esc(url)}</id>`,
      `    <updated>${rfc3339(e.mtime, fallback)}</updated>`,
      `    <category term="${esc(TYPE_LABELS[e.type as EntityType] || e.type)}"/>`,
      summary ? `    <summary>${esc(summary)}</summary>` : '',
      '  </entry>',
    ].filter(Boolean).join('\n');
  });

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>The Info Web — Changelog</title>',
    '  <subtitle>Recent additions and revisions to the vault.</subtitle>',
    `  <link href="${base}/feed.xml" rel="self"/>`,
    `  <link href="${base}/"/>`,
    `  <id>${base}/</id>`,
    `  <updated>${updated}</updated>`,
    ...items,
    '</feed>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
  });
};
