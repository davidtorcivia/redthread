// OG card template. Pure JS (no JSX) — uses React-style virtual DOM objects
// directly so we can run this under plain `node` without a build step.
//
// Satori reads these objects, lays them out with yoga, and emits SVG.
//
// Brand language pulled from src/styles/global.css:
//   paper #f7f2e7 / ink #1a1814 / accent #94322a / muted #6a6258
//   type colors: person #8a5a1f, organization #2d6864, program #3f3d8b,
//                event #94322a, concept #5e6b32, place #735237, source #6a6258

const COLORS = {
  paper: '#f7f2e7',
  paper2: '#efe9d9',
  ink: '#1a1814',
  ink2: '#2e2a22',
  muted: '#6a6258',
  muted2: '#8a8275',
  line: '#d8cfb9',
  accent: '#94322a',
  gold: '#8a6e25',
};

const TYPE_COLOR = {
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

const TYPE_LABEL = {
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
function h(type, props, ...children) {
  const flat = [];
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) flat.push(...c.filter((x) => x != null && x !== false));
    else flat.push(c);
  }
  return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } };
}

// Strip markdown noise from summaries so we don't render literal `**` or `[[`.
function plainSummary(s) {
  if (!s) return '';
  return String(s)
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tags in the vault use snake_case for multi-word terms (e.g. Child_Pornography,
// u.s.-military). The card surface reads as prose, so we normalize underscores
// to spaces here — slugs stay intact on the page itself.
function prettyTag(t) {
  return String(t).replace(/_/g, ' ');
}

function yearOf(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? m[1] : String(s);
}

// Compose the single dateline shown on the card. Matches the logic on the
// entity page itself so the card mirrors what users see.
function dateline(entity) {
  const d = entity.dates || {};
  const born = yearOf(d.born), died = yearOf(d.died);
  const start = yearOf(d.start), end = yearOf(d.end);
  const date = yearOf(d.date);
  if (born || died) return { label: 'Lifespan', value: `${born ?? '?'}–${died ?? 'present'}` };
  if (start || end) return { label: 'Active', value: `${start ?? '?'}–${end ?? 'present'}` };
  if (date) return { label: 'Date', value: date };
  return null;
}

// Chips: label and value share the same font size and use center alignment,
// so the two read as a single horizontal line rather than baseline-offset
// (satori's baseline alignment across different font-sizes drifts visibly).
function MetaChip(label, value, color) {
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

export function renderCard(entity) {
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
    // Top accent rule — the brand red across the full width.
    h('div', { style: { display: 'flex', width: '100%', height: 10, backgroundColor: COLORS.accent } }),

    // Subtle paper-grain second stripe.
    h('div', { style: { display: 'flex', width: '100%', height: 4, backgroundColor: COLORS.paper2 } }),

    // Main body
    h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        padding: '56px 72px 48px 72px',
        justifyContent: 'space-between',
      },
    },
      // Top: eyebrow + title + summary
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

        // Title — serif, large. Line-height 1.15 keeps descenders (g/j/p/q/y)
        // safely inside the line box; with 1.05 the bottom of "Signal" got
        // clipped against the next sibling. Generous maxHeight handles
        // 2-line wraps for long titles.
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

        // Summary (optional)
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

      // Bottom row: meta chips + wordmark
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginTop: 32,
        },
      },
        // Chips
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 820 } },
          dl && MetaChip(dl.label, dl.value),
          locations.length > 0 && MetaChip('Location', locations.slice(0, 2).join(', ')),
          entity.mention_count > 0 && MetaChip('Mentions', String(entity.mention_count)),
          entity.bridge_rank && MetaChip('Bridge', `#${entity.bridge_rank}`, COLORS.accent),
          tags.length > 0 && MetaChip('Tags', tags.slice(0, 3).map(prettyTag).join(' · ')),
        ),

        // Wordmark
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

// Render variant used when the page isn't an entity (browse pages, home,
// timeline, etc.). Pulled from the same template but with a generic chip
// and no eyebrow type/category.
export function renderGenericCard({ title, description, kind }) {
  return renderCard({
    type: 'page',
    title,
    summary: description,
    category: kind || null,
    dates: {},
    locations: [],
    tags: [],
    mention_count: 0,
  });
}
