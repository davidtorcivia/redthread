// Social card layout (1200x630) as a satori element tree, in the site's type and colors.
import { createHash } from 'node:crypto';
import type { Entity, EntityType } from './types.ts';
import { formatDates } from './dates.ts';
import { plainText } from './inline-md.ts';
import { SITE_HOST, SITE_TITLE } from './site.ts';
import fontMetrics from '../assets/fonts/og-metrics.json' with { type: 'json' };
import cardSource from './og-card.ts?raw';
import datesSource from './dates.ts?raw';
import inlineMdSource from './inline-md.ts?raw';

// Glyph advance widths, so text can be wrapped and fitted without a layout engine.
const metrics = fontMetrics as Record<string, { units: number; widths: Record<string, number> }>;

const TYPE_LABEL: Record<string, string> = {
  person: 'Person', organization: 'Organization', program: 'Program', event: 'Event', concept: 'Concept',
  place: 'Place', source: 'Source', meta: 'Meta', misc: 'Entry', page: 'Index',
};

type Node = { type: string; props: Record<string, unknown> };
type Child = Node | string | null | false | undefined | Child[];

function h(type: string, props: Record<string, unknown> | null, ...children: Child[]): Node {
  const flat = (children as unknown[]).flat(Infinity).filter((c): c is Node | string => c != null && c !== false);
  return { type, props: { ...props, children: flat.length === 1 ? flat[0] : flat } };
}

/** Exactly the fields the card reads; the render cache keys on this object. */
export interface CardInput {
  type: EntityType;
  title: string;
  summary: string | null;
  category: string | null;
  dates: Entity['dates'];
  mention_count: number;
}

export function cardInputs(e: Entity): CardInput {
  return {
    type: e.type, title: e.title, summary: e.summary, category: e.category,
    dates: e.dates || {}, mention_count: e.mention_count || 0,
  };
}

function width(text: string, size: number, font = 'title'): number {
  const m = metrics[font];
  return [...text].reduce((sum, c) => sum + (m.widths[c] ?? m.units * 0.65), 0) / m.units * size;
}

/** Greedy word wrap. Body text also breaks words too long for a line; titles are sized to avoid that. */
function wrap(text: string, size: number, maxWidth: number, font = 'title'): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && width(line + ' ' + word, size, font) > maxWidth) { lines.push(line); line = ''; }
    if (font !== 'title' && width(word, size, font) > maxWidth) {
      let part = '';
      for (const c of word) {
        if (part && width(part + c, size, font) > maxWidth) { lines.push(part); part = ''; }
        part += c;
      }
      line = part;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest title size whose wrapped lines fit the band; otherwise six lines at the minimum, ellipsized. */
function titleLayout(title: string): { lines: string[]; size: number } {
  const text = title.replace(/\s+/g, ' ').trim().toLocaleUpperCase('en-US');
  for (const size of [176, 154, 132, 112, 96, 84, 72, 62, 54, 48, 42]) {
    const lines = wrap(text, size, 1080);
    if (lines.length * size * 1.02 <= 278 && lines.every((line) => width(line, size) <= 1080)) return { lines, size };
  }
  const lines = wrap(text, 42, 1080).slice(0, 6);
  let last = lines[5] || '';
  while (width(last + '…', 42) > 1080) last = last.slice(0, -1);
  if (lines.length === 6) lines[5] = last + '…';
  return { lines, size: 42 };
}

const shorten = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';

export function renderCard(entity: CardInput): Node {
  const isSiteCard = entity.type === 'page' && entity.title === SITE_TITLE;
  const title = titleLayout(entity.title);
  const summaryLines = wrap(plainText(entity.summary), 28, 1080, 'body');
  if (summaryLines.length > 3) {
    summaryLines.length = 3;
    let line = summaryLines[2];
    while (width(line + '…', 28, 'body') > 1080) line = line.includes(' ') ? line.slice(0, line.lastIndexOf(' ')) : line.slice(0, -1);
    summaryLines[2] = line.replace(/[ ,;:.]+$/, '') + '…';
  }
  const facts = [
    formatDates(entity.dates || {}),
    entity.mention_count > 0 ? `${entity.mention_count.toLocaleString('en-US')} mentions` : '',
  ].filter(Boolean).join(' · ');
  const label = [TYPE_LABEL[entity.type] || 'Entry', entity.category].filter(Boolean).join(' / ').toUpperCase();

  return h('div', { style: { width: 1200, height: 630, display: 'flex', flexDirection: 'column', background: '#fff', color: '#0d0d0d', fontFamily: 'Archivo', position: 'relative' } },
    h('div', { style: { display: 'flex', position: 'absolute', top: 0, left: 0, width: 1200, height: 420, background: '#ff4a1c' } }),
    h('div', { style: { display: 'flex', position: 'absolute', top: 32, left: 56, right: 56, justifyContent: 'space-between', alignItems: 'center' } },
      h('span', { style: { fontSize: 28, fontWeight: 800, letterSpacing: -1 } }, SITE_TITLE),
      h('span', { style: { fontSize: 18, fontWeight: 500, maxWidth: 760, textAlign: 'right' } }, shorten(label, 75))),
    h('div', { style: { position: 'absolute', top: 106, left: 56, width: 1088, height: 286, display: 'flex', flexDirection: 'column', justifyContent: 'center' } },
      title.lines.map((line) => h('div', { style: { display: 'flex', fontSize: title.size, fontWeight: 800, lineHeight: 1.02, letterSpacing: -title.size * 0.025, whiteSpace: 'pre' } }, line))),
    h('div', { style: { position: 'absolute', left: 56, top: 444, width: 1088, display: 'flex', flexDirection: 'column', fontFamily: 'Source Serif 4', fontSize: 28, fontWeight: 400, lineHeight: 1.22 } },
      summaryLines.map((line) => h('div', { style: { display: 'flex', whiteSpace: 'pre' } }, line))),
    h('div', { style: { position: 'absolute', left: 56, right: 56, bottom: 24, height: 38, borderTop: '2px solid #0d0d0d', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 19, fontWeight: 500 } },
      h('span', null, isSiteCard ? 'People · Programs · Events · Connections' : facts || TYPE_LABEL[entity.type]),
      h('span', null, SITE_HOST)),
  );
}

// Busts the render cache whenever the layout code, font metrics or site identity change.
// Hashes the sources: the bundled chunk and its function text differ between identical builds.
export const CARD_TEMPLATE_HASH = createHash('sha256')
  .update(cardSource + datesSource + inlineMdSource)
  .update(JSON.stringify(metrics))
  .update(SITE_TITLE + SITE_HOST)
  .digest('hex').slice(0, 16);
