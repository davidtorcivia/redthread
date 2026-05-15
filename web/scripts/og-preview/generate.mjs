// Generates a handful of representative OG cards into ./out/ for design
// review. Standalone — does not touch the Astro build. Once the design is
// approved, the same renderCard() will be moved into an Astro endpoint.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { renderCard, renderGenericCard } from './card.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const webRoot = resolve(here, '../..');
const outDir = resolve(here, 'out');
mkdirSync(outDir, { recursive: true });

// Fontsource ships TTF+woff per weight in node_modules/@fontsource/<face>/files/.
// satori accepts either; woff loads faster and is smaller.
function loadFont(packageName, weight) {
  const file = resolve(
    webRoot,
    `node_modules/@fontsource/${packageName}/files/${packageName}-latin-${weight}-normal.woff`,
  );
  return readFileSync(file);
}

const fonts = [
  { name: 'Source Serif 4', data: loadFont('source-serif-4', 400), weight: 400, style: 'normal' },
  { name: 'Source Serif 4', data: loadFont('source-serif-4', 700), weight: 700, style: 'normal' },
  { name: 'Inter Tight',    data: loadFont('inter-tight', 400),    weight: 400, style: 'normal' },
  { name: 'Inter Tight',    data: loadFont('inter-tight', 500),    weight: 500, style: 'normal' },
  { name: 'Inter Tight',    data: loadFont('inter-tight', 700),    weight: 700, style: 'normal' },
];

async function renderToPng(element) {
  const svg = await satori(element, { width: 1200, height: 630, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  return resvg.render().asPng();
}

// Pick one entity per type plus a couple of edge cases (long title,
// no-summary, bridge-ranked person, multi-location event).
function pickSamples(entities) {
  const byType = new Map();
  for (const e of entities) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
  }
  const pick = (type, fn) => (byType.get(type) || []).find(fn);
  const picks = [];

  // Strong representatives — prefer entities with summary + tags + meta so
  // each card actually exercises the template's full vocabulary.
  picks.push({
    name: 'person-rich',
    entity: pick('person', (e) => e.summary && e.summary.length > 60 && e.bridge_rank)
         || pick('person', (e) => e.summary && e.bridge_rank)
         || pick('person', (e) => e.summary && e.tags.length > 0),
  });
  picks.push({
    name: 'organization',
    entity: pick('organization', (e) => e.summary && e.summary.length > 60 && e.tags.length > 0)
         || pick('organization', (e) => e.summary),
  });
  picks.push({
    name: 'event',
    entity: pick('event', (e) => e.summary && (e.dates.start || e.dates.date))
         || pick('event', (e) => e.summary),
  });
  picks.push({
    name: 'program',
    entity: pick('program', (e) => e.summary && e.summary.length > 40)
         || pick('program', () => true),
  });
  picks.push({
    name: 'concept',
    entity: pick('concept', (e) => e.summary && e.summary.length > 80)
         || pick('concept', (e) => e.summary),
  });
  picks.push({
    name: 'place',
    entity: pick('place', (e) => e.summary && e.summary.length > 60)
         || pick('place', (e) => e.summary),
  });

  // Edge cases — make sure layout doesn't blow up.
  picks.push({
    name: 'edge-long-title',
    entity: pick('person', (e) => e.title.length > 32 && e.summary)
         || pick('organization', (e) => e.title.length > 32 && e.summary),
  });
  picks.push({
    name: 'edge-no-summary',
    entity: pick('person', (e) => !e.summary && e.mention_count > 0)
         || pick('organization', (e) => !e.summary),
  });

  return picks.filter((p) => p.entity);
}

async function main() {
  const entities = JSON.parse(readFileSync(resolve(repoRoot, 'data/entities.json'), 'utf-8'));
  const samples = pickSamples(entities);

  const manifest = [];
  for (const { name, entity } of samples) {
    process.stdout.write(`rendering ${name} (${entity.id})… `);
    const t0 = Date.now();
    const png = await renderToPng(renderCard(entity));
    const file = `${name}.png`;
    writeFileSync(resolve(outDir, file), png);
    console.log(`${Date.now() - t0}ms`);
    manifest.push({ file, name, entity });
  }

  // Generic browse page card
  process.stdout.write('rendering generic-browse… ');
  const t0 = Date.now();
  const generic = await renderToPng(renderGenericCard({
    title: 'People',
    description: 'Everyone catalogued in the Info Web — operators, journalists, witnesses, principals.',
    kind: 'Browse',
  }));
  writeFileSync(resolve(outDir, 'generic-browse.png'), generic);
  console.log(`${Date.now() - t0}ms`);
  manifest.push({
    file: 'generic-browse.png',
    name: 'generic-browse',
    entity: { type: 'page', title: 'People', category: 'Browse', summary: 'Browse all people', tags: [], mention_count: 0, dates: {}, locations: [] },
  });

  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${manifest.length} cards to ${outDir}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
