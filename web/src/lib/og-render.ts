/**
 * Build-time PNG generation with a content-addressed cache.
 *
 * Cache key = SHA-256 over:
 *   - the card's input shape (CardInput — only the fields the template reads)
 *   - CARD_TEMPLATE_HASH (the template source SHA, computed at module load)
 *   - FONTS_HASH (SHA over all font files, computed once)
 *
 * Cache lives in <project-root>/.og-cache/ and persists across builds.
 * Files are named `<hash>.png`; a manifest tracks "which hashes did this
 * build touch" so unreachable entries can be pruned at the end.
 *
 * The renderer itself, satori and resvg, are loaded lazily — endpoints
 * that hit a cached file never pull them into memory.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, utimesSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CardInput } from './og-card.ts';
import { renderCard, CARD_TEMPLATE_HASH } from './og-card.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const fontsDir = resolve(webRoot, 'src/assets/fonts');
const cacheDir = resolve(webRoot, '.og-cache');

mkdirSync(cacheDir, { recursive: true });

// Track every hash we've served this build so prune can drop the rest.
const touched = new Set<string>();

// Satori's `Weight` is a literal union (100..900). Narrowing here keeps
// the call to satori() type-safe.
type SatoriWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type SatoriFont = { name: string; data: Buffer; weight: SatoriWeight; style: 'normal' };

let _fontCache: { fonts: SatoriFont[]; hash: string } | null = null;

function loadFonts(): { fonts: SatoriFont[]; hash: string } {
  if (_fontCache) return _fontCache;
  const specs: { name: string; weight: SatoriWeight; file: string }[] = [
    { name: 'Source Serif 4', weight: 400, file: 'source-serif-4-latin-400-normal.woff' },
    { name: 'Source Serif 4', weight: 700, file: 'source-serif-4-latin-700-normal.woff' },
    { name: 'Inter Tight',    weight: 400, file: 'inter-tight-latin-400-normal.woff' },
    { name: 'Inter Tight',    weight: 500, file: 'inter-tight-latin-500-normal.woff' },
    { name: 'Inter Tight',    weight: 700, file: 'inter-tight-latin-700-normal.woff' },
  ];
  const h = createHash('sha256');
  const fonts: SatoriFont[] = specs.map((s) => {
    const data = readFileSync(resolve(fontsDir, s.file));
    h.update(s.file).update(data);
    return { name: s.name, data, weight: s.weight, style: 'normal' as const };
  });
  _fontCache = { fonts, hash: h.digest('hex').slice(0, 16) };
  return _fontCache;
}

function cacheKey(input: CardInput): string {
  const { hash: fontsHash } = loadFonts();
  // JSON.stringify with sorted keys would be more defensive, but the
  // CardInput shape is hand-defined and stable; insertion order is
  // controlled by cardInputs() in og-card.ts.
  const payload = JSON.stringify({
    v: 1,
    template: CARD_TEMPLATE_HASH,
    fonts: fontsHash,
    input,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

/**
 * Render or recall the PNG for a card. Returns the buffer + the cache
 * hash (useful for ETag / debugging). Always touches the hash so the
 * GC step at end-of-build won't sweep it.
 */
export async function renderOrCache(input: CardInput): Promise<{ png: Buffer; hash: string; hit: boolean }> {
  const hash = cacheKey(input);
  touched.add(hash);
  const file = resolve(cacheDir, `${hash}.png`);
  if (existsSync(file)) {
    // Bump mtime so the cross-process prune (see pruneCache) can tell this
    // card is still reachable this build. Astro renders OG endpoints in a
    // separate module graph from the astro:build:done integration, so the
    // in-memory `touched` set isn't visible there — mtime is the shared
    // signal. A write (cache miss, below) sets mtime implicitly.
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* ignore */ }
    return { png: readFileSync(file), hash, hit: true };
  }

  // Lazy-load the heavy renderer modules — only loaded on cache miss.
  // Dynamic import keeps cached builds fast (and lets the dev server
  // skip loading the renderer for endpoints that never re-render).
  const [{ default: satori }, { Resvg }] = await Promise.all([
    import('satori'),
    import('@resvg/resvg-js'),
  ]);
  const { fonts } = loadFonts();
  const element = renderCard(input);
  const svg = await satori(element as never, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  writeFileSync(file, png);
  return { png, hash, hit: false };
}

/**
 * Delete cached PNGs that this build didn't reach (orphans from deleted or
 * renamed entities). Called from astro:build:done (see astro.config.mjs).
 *
 * `sinceMs` is the build's start time. Because astro:build:done runs in a
 * different module instance than the page renderers, the in-memory `touched`
 * set is empty there — so when sinceMs is given we prune by file mtime
 * instead: renderOrCache stamps every card it serves (hit or miss) with the
 * current time, so any cache file older than build start is unreachable.
 * Called with no argument (same-instance, e.g. a test), it uses `touched`.
 */
export function pruneCache(sinceMs?: number): { kept: number; pruned: number } {
  let kept = 0, pruned = 0;
  for (const file of readdirSync(cacheDir)) {
    if (!file.endsWith('.png')) continue;
    let keep: boolean;
    if (sinceMs != null) {
      let mtimeMs = 0;
      try { mtimeMs = statSync(resolve(cacheDir, file)).mtimeMs; } catch { /* gone */ }
      keep = mtimeMs >= sinceMs;
    } else {
      keep = touched.has(file.slice(0, -4));
    }
    if (keep) { kept++; continue; }
    try { unlinkSync(resolve(cacheDir, file)); pruned++; } catch { /* ignore */ }
  }
  return { kept, pruned };
}

export function cacheStats(): { touched: number } {
  return { touched: touched.size };
}
