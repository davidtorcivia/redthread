// Atom feed of dispatches, full text, the same data as /dispatches/.
import type { APIRoute } from 'astro';
import { dispatches, dispatchHref } from '../lib/data.ts';
import { escapeHtml as esc, plainText } from '../lib/inline-md.ts';
import { absUrl, SITE_TITLE } from '../lib/site.ts';

const EPOCH = '1970-01-01T00:00:00Z';

function rfc3339(date: string): string {
  const d = new Date(date ? (date.length === 10 ? date + 'T12:00:00Z' : date) : EPOCH);
  return Number.isNaN(d.getTime()) ? EPOCH : d.toISOString();
}

export const GET: APIRoute = () => {
  const items = dispatches().slice(0, 50);
  const entries = items.map((d) => {
    // The id predates pagination and must never change; the link follows the dispatch's page.
    const id = esc(absUrl(`/dispatches/#${d.id}`));
    const page = absUrl(dispatchHref(d.id).split('#')[0]);
    const url = esc(`${page}#${d.id}`);
    // Relative links and anchors resolve against the dispatch's page in feed readers.
    const body = d.body_html.replaceAll('href="/', `href="${absUrl('/')}`).replaceAll('href="#', `href="${page}#`);
    const notes = d.footnotes.length
      ? '<h3>Sources</h3><ol>' + d.footnotes.map((f) => `<li>${f.html ?? esc(f.text)}</li>`).join('') + '</ol>'
      : '';
    return [
      '  <entry>',
      `    <title>${esc(d.title)}</title>`,
      `    <link href="${url}"/>`,
      `    <id>${id}</id>`,
      `    <updated>${rfc3339(d.date)}</updated>`,
      d.summary ? `    <summary>${esc(plainText(d.summary))}</summary>` : '',
      `    <content type="html">${esc(body + notes)}</content>`,
      '  </entry>',
    ].filter(Boolean).join('\n');
  });

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${esc(SITE_TITLE)}: Dispatches</title>`,
    '  <subtitle>Dated, sourced narratives of findings that tie entries together.</subtitle>',
    `  <link href="${esc(absUrl('/dispatches.xml'))}" rel="self"/>`,
    `  <link href="${esc(absUrl('/dispatches/'))}"/>`,
    `  <id>${esc(absUrl('/dispatches/'))}</id>`,
    `  <updated>${items.length ? rfc3339(items[0].date) : EPOCH}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');

  return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
};
