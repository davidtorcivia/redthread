// Build-time OG card PNGs with a content-addressed cache in web/.og-cache/, kept
// across builds. The key covers the card input, template and fonts, so a hit is
// always current. satori and resvg load only on a miss.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, utimesSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CardInput } from './og-card.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fontsDir = resolve(webRoot, 'src/assets/fonts');
const cacheDir = resolve(webRoot, '.og-cache');
mkdirSync(cacheDir, { recursive: true });

type SatoriWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type SatoriFont = { name: string; data: Buffer; weight: SatoriWeight; style: 'normal' };

let fontCache: { fonts: SatoriFont[]; hash: string } | null = null;

function loadFonts(): { fonts: SatoriFont[]; hash: string } {
  if (fontCache) return fontCache;
  const specs: { name: string; weight: SatoriWeight; file: string }[] = [
    { name: 'Source Serif 4', weight: 400, file: 'source-serif-4-latin-400-normal.woff' },
    { name: 'Source Serif 4', weight: 700, file: 'source-serif-4-latin-700-normal.woff' },
    { name: 'Archivo', weight: 500, file: 'archivo-latin-500-normal.woff' },
    { name: 'Archivo', weight: 800, file: 'archivo-latin-800-normal.woff' },
  ];
  const h = createHash('sha256');
  const fonts = specs.map((s): SatoriFont => {
    const data = readFileSync(resolve(fontsDir, s.file));
    h.update(s.file).update(data);
    return { name: s.name, data, weight: s.weight, style: 'normal' };
  });
  return (fontCache = { fonts, hash: h.digest('hex').slice(0, 16) });
}

function cacheKey(input: CardInput, template: string): string {
  const payload = JSON.stringify({ v: 1, template, fonts: loadFonts().hash, input });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export async function renderOrCache(input: CardInput): Promise<Buffer> {
  // Loaded here, not at the top: the prune hook imports this file outside Vite,
  // where og-card's ?raw imports cannot resolve.
  const { renderCard, CARD_TEMPLATE_HASH } = await import('./og-card.ts');
  const file = resolve(cacheDir, `${cacheKey(input, CARD_TEMPLATE_HASH)}.png`);
  if (existsSync(file)) {
    // A fresh mtime marks the card as used by this build; see pruneCache.
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* read-only cache still serves */ }
    return readFileSync(file);
  }
  const [{ default: satori }, { Resvg }] = await Promise.all([import('satori'), import('@resvg/resvg-js')]);
  const svg = await satori(renderCard(input) as never, { width: 1200, height: 630, fonts: loadFonts().fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  writeFileSync(file, png);
  return png;
}

/** Deletes cards no renderer touched since `sinceMs`. Called from astro:build:done,
 *  which runs in a different module instance, so file mtime is the only shared signal. */
export function pruneCache(sinceMs: number): { kept: number; pruned: number } {
  let kept = 0, pruned = 0;
  for (const file of readdirSync(cacheDir)) {
    if (!file.endsWith('.png')) continue;
    const path = resolve(cacheDir, file);
    let mtimeMs = 0;
    try { mtimeMs = statSync(path).mtimeMs; } catch { /* already gone */ }
    if (mtimeMs >= sinceMs) { kept++; continue; }
    try { unlinkSync(path); pruned++; } catch { /* already gone */ }
  }
  return { kept, pruned };
}
