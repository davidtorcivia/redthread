/**
 * OG card template + canonicalization for the cache key.
 *
 * The renderer is pure (entity-in → element-out); side-effects (font I/O,
 * cache, satori invocation) live in og-render.ts. Splitting them keeps the
 * cache-key hash deterministic — `cardInputs()` is the *only* thing that
 * feeds the per-entity hash, and `CARD_TEMPLATE_HASH` is the *only* thing
 * that captures "renderer changed".
 *
 * Brand language pulled from src/styles/global.css:
 *   paper #f7f2e7 / ink #1a1814 / accent #94322a / muted #6a6258
 *   type colors: person #8a5a1f, organization #2d6864, program #3f3d8b,
 *                event #94322a, concept #5e6b32, place #735237, source #6a6258
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Entity, EntityType } from './types.ts';

const COLORS = {
  paper: '#f7f2e7',
  paper2: '#efe9d9',
  ink: '#1a1814',
  ink2: '#2e2a22',
  muted: '#6a6258',
  line: '#d8cfb9',
  accent: '#94322a',
};

const TYPE_COLOR: Record<string, string> = {
  person: '#8a5a1f',
  organization: '#2d6864',
  program: '#3f3d8b',
  event: '#94322a',
  concept: '#5e6b32',
  place: '#735237',
  source: '#6a6258',
  meta: '#6a6258',
  misc: '#6a6258',
  page: '#6a6258',
};

const TYPE_LABEL: Record<string, string> = {
  person: 'Person',
  organization: 'Organization',
  program: 'Program',
  event: 'Event',
  concept: 'Concept',
  place: 'Place',
  source: 'Source',
  meta: 'Meta',
  misc: 'Misc',
  page: 'Page',
};

// React-element factory without JSX or React. Satori only inspects
// { type, props } shapes, so this is enough.
type Node = { type: string; props: Record<string, unknown> };
type Child = Node | string | null | false | undefined | Child[];

function h(type: string, props: Record<string, unknown> | null, ...children: Child[]): Node {
  const flat: (Node | string)[] = [];
  const walk = (c: Child) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(walk);
    else flat.push(c as Node | string);
  };
  for (const c of children) walk(c);
  return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } };
}

function plainSummary(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tags use snake_case in the vault (Child_Pornography, u.s.-military);
// the card surface reads as prose so we normalize underscores to spaces.
function prettyTag(t: string): string {
  return String(t).replace(/_/g, ' ');
}

function yearOf(s: string | undefined): string | null {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? m[1] : String(s);
}

function dateline(entity: CardInput): { label: string; value: string } | null {
  const d = entity.dates || {};
  const born = yearOf(d.born), died = yearOf(d.died);
  const start = yearOf(d.start), end = yearOf(d.end);
  const date = yearOf(d.date);
  if (born || died) return { label: 'Lifespan', value: `${born ?? '?'}–${died ?? 'present'}` };
  if (start || end) return { label: 'Active', value: `${start ?? '?'}–${end ?? 'present'}` };
  if (date) return { label: 'Date', value: date };
  return null;
}

// Chips: label and value share visual baseline via center-alignment +
// matched lineHeight. Satori's `alignItems: baseline` drifts when font
// sizes differ, which is why we don't use it here.
function MetaChip(label: string, value: string, color?: string): Node {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 16px',
      backgroundColor: '#fbf7ee',
      border: `1px solid ${COLORS.line}`,
      borderRadius: 4,
      fontFamily: 'Inter Tight',
    },
  },
    h('span', {
      style: {
        fontSize: 18,
        textTransform: 'uppercase',
        letterSpacing: 1.4,
        color: COLORS.muted,
        fontWeight: 500,
        lineHeight: 1,
      },
    }, label),
    h('span', {
      style: { fontSize: 22, color: color || COLORS.ink, fontWeight: 600, lineHeight: 1 },
    }, value),
  );
}

/**
 * Inputs to the card — the *exact* fields the template reads. The cache
 * key is computed over this shape, so widening it requires bumping the
 * template hash (handled automatically since this file's source is
 * hashed below).
 */
export interface CardInput {
  type: EntityType | 'page';
  title: string;
  summary: string | null;
  category: string | null;
  dates: { born?: string; died?: string; start?: string; end?: string; date?: string };
  locations: string[];
  tags: string[];
  mention_count: number;
  bridge_rank?: number;
}

export function cardInputs(entity: Entity): CardInput {
  return {
    type: entity.type,
    title: entity.title,
    summary: entity.summary,
    category: entity.category,
    dates: {
      born: entity.dates?.born,
      died: entity.dates?.died,
      start: entity.dates?.start,
      end: entity.dates?.end,
      date: entity.dates?.date,
    },
    locations: (entity.locations ?? []).slice(0, 2),
    tags: (entity.tags ?? []).slice(0, 3),
    mention_count: entity.mention_count ?? 0,
    bridge_rank: entity.bridge_rank,
  };
}

export function renderCard(entity: CardInput): Node {
  const typeLabel = TYPE_LABEL[entity.type] || 'Page';
  const typeColor = TYPE_COLOR[entity.type] || COLORS.muted;
  const dl = dateline(entity);
  const locations = entity.locations || [];
  const tags = entity.tags || [];
  const summary = plainSummary(entity.summary);

  return h('div', {
    style: {
      width: 1200,
      height: 630,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: COLORS.paper,
      fontFamily: 'Source Serif 4',
      color: COLORS.ink,
      position: 'relative',
    },
  },
    h('div', { style: { display: 'flex', width: '100%', height: 10, backgroundColor: COLORS.accent } }),
    h('div', { style: { display: 'flex', width: '100%', height: 4, backgroundColor: COLORS.paper2 } }),

    h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        padding: '56px 72px 48px 72px',
        justifyContent: 'space-between',
      },
    },
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        // Eyebrow
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontFamily: 'Inter Tight',
            fontSize: 22,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 2.5,
            color: typeColor,
            marginBottom: 28,
          },
        },
          h('span', null, typeLabel),
          entity.category && h('span', { style: { color: COLORS.line } }, '•'),
          entity.category && h('span', { style: { color: COLORS.muted, fontWeight: 500 } }, entity.category),
        ),

        // Title — line-height 1.15 keeps descenders (g/j/p/q/y) inside
        // the line box; with 1.05 the bottom of "Signal" got clipped.
        h('div', {
          style: {
            display: 'flex',
            fontSize: entity.title.length > 38 ? 76 : 92,
            lineHeight: 1.15,
            fontWeight: 700,
            letterSpacing: -1,
            color: COLORS.ink,
            marginBottom: 24,
            maxHeight: 260,
            overflow: 'hidden',
            paddingBottom: 4,
          },
        }, entity.title),

        summary && h('div', {
          style: {
            display: 'flex',
            fontSize: 28,
            lineHeight: 1.35,
            color: COLORS.ink2,
            maxHeight: 116,
            overflow: 'hidden',
          },
        }, summary),
      ),

      h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginTop: 32,
        },
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 820 } },
          dl ? MetaChip(dl.label, dl.value) : null,
          locations.length > 0 ? MetaChip('Location', locations.slice(0, 2).join(', ')) : null,
          entity.mention_count > 0 ? MetaChip('Mentions', String(entity.mention_count)) : null,
          entity.bridge_rank ? MetaChip('Bridge', `#${entity.bridge_rank}`, COLORS.accent) : null,
          tags.length > 0 ? MetaChip('Tags', tags.slice(0, 3).map(prettyTag).join(' · ')) : null,
        ),

        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            fontFamily: 'Source Serif 4',
            color: COLORS.ink,
            marginLeft: 24,
          },
        },
          h('div', { style: { display: 'flex', fontSize: 32, fontWeight: 700, color: COLORS.accent, lineHeight: 1.1 } }, 'The Info Web'),
          h('div', {
            style: {
              display: 'flex',
              fontSize: 14,
              fontFamily: 'Inter Tight',
              fontWeight: 600,
              letterSpacing: 1.5,
              color: COLORS.muted,
              marginTop: 4,
            },
          }, 'theinfoweb.disinfo.zone'),
        ),
      ),
    ),
  );
}

/**
 * SHA-256 of this file's source, computed once at module load. Any edit
 * to the template (layout, colors, copy) automatically busts every cache
 * entry without needing a manual version bump.
 */
export const CARD_TEMPLATE_HASH = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    return createHash('sha256').update(readFileSync(self)).digest('hex').slice(0, 16);
  } catch {
    // Fallback for environments where import.meta.url can't be resolved
    // (shouldn't happen at build time, but be defensive).
    return 'unknown';
  }
})();
