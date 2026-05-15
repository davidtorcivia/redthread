// Generates index.html alongside the rendered PNGs. Each card shows at
// real OG dimensions (1200x630, downscaled to fit) so you can judge how
// it'll look on Slack/Twitter/iMessage. Inputs to the card are dumped
// next to the image so it's clear what data drove it.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'out');
const manifest = JSON.parse(readFileSync(resolve(outDir, 'manifest.json'), 'utf-8'));

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fieldRow(label, value) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return '';
  const v = Array.isArray(value) ? value.join(', ') : value;
  return `<tr><th>${esc(label)}</th><td>${esc(v)}</td></tr>`;
}

const cards = manifest.map(({ file, name, entity }) => {
  const e = entity;
  const d = e.dates || {};
  const dateline = d.born || d.died
    ? `${d.born ?? '?'}–${d.died ?? 'present'}`
    : (d.start || d.end ? `${d.start ?? '?'}–${d.end ?? 'present'}` : (d.date ?? ''));
  return `
    <section class="card">
      <header>
        <h2>${esc(name)}</h2>
        <div class="meta">${esc(e.type)} · <code>${esc(e.id ?? '—')}</code></div>
      </header>
      <a class="img" href="${esc(file)}" target="_blank" rel="noopener">
        <img src="${esc(file)}" alt="${esc(name)} OG card" width="1200" height="630" loading="lazy" />
      </a>
      <table class="fields">
        ${fieldRow('Title', e.title)}
        ${fieldRow('Type', e.type)}
        ${fieldRow('Category', e.category)}
        ${fieldRow('Summary', e.summary)}
        ${fieldRow('Dateline', dateline)}
        ${fieldRow('Locations', e.locations)}
        ${fieldRow('Mentions', e.mention_count)}
        ${fieldRow('Bridge rank', e.bridge_rank ? `#${e.bridge_rank}` : null)}
        ${fieldRow('Tags', (e.tags || []).slice(0, 8))}
      </table>
    </section>
  `;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>OG card preview — The Info Web</title>
  <style>
    :root {
      --paper: #f7f2e7; --ink: #1a1814; --muted: #6a6258;
      --accent: #94322a; --line: #d8cfb9; --card: #fbf7ee;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--paper); color: var(--ink); }
    body {
      font-family: 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 32px 24px 80px;
    }
    .page-head {
      max-width: 1280px; margin: 0 auto 24px; padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    .page-head h1 {
      margin: 0 0 6px; font-family: 'Source Serif 4', Georgia, serif;
      font-weight: 700; font-size: 38px; letter-spacing: -0.5px;
    }
    .page-head p { margin: 0; color: var(--muted); font-size: 15px; }
    .grid { max-width: 1280px; margin: 0 auto; display: grid; gap: 36px; }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 8px;
      padding: 18px 22px 22px; box-shadow: 0 1px 0 rgba(0,0,0,0.02);
    }
    .card header {
      display: flex; align-items: baseline; justify-content: space-between;
      margin-bottom: 12px;
    }
    .card h2 {
      margin: 0; font-family: 'Source Serif 4', Georgia, serif;
      font-size: 22px; font-weight: 700; color: var(--ink);
    }
    .card .meta {
      font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px;
      color: var(--muted);
    }
    .card .meta code {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      text-transform: none; letter-spacing: 0; font-size: 12px;
      background: rgba(0,0,0,0.04); padding: 2px 6px; border-radius: 3px;
    }
    .img {
      display: block; line-height: 0; border: 1px solid var(--line);
      border-radius: 6px; overflow: hidden; margin-bottom: 14px;
      background: #000;
    }
    .img img { width: 100%; height: auto; display: block; }
    table.fields {
      width: 100%; border-collapse: collapse; font-size: 13px;
    }
    table.fields th, table.fields td {
      text-align: left; padding: 6px 10px; border-top: 1px solid var(--line);
      vertical-align: top;
    }
    table.fields th {
      width: 140px; color: var(--muted); font-weight: 500;
      text-transform: uppercase; letter-spacing: 1px; font-size: 11px;
    }
    table.fields td { font-family: 'Source Serif 4', Georgia, serif; font-size: 14px; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="page-head">
    <h1>OG card design preview</h1>
    <p>Each card is rendered at 1200 × 630 — the dimensions Slack, Twitter, Facebook, iMessage, etc. expect. Click any image for full-size. The data fields below each card are what was fed into the template.</p>
  </div>
  <div class="grid">
    ${cards}
  </div>
</body>
</html>
`;

writeFileSync(resolve(outDir, 'index.html'), html);
console.log(`wrote ${resolve(outDir, 'index.html')}`);
