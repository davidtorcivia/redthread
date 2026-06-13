import { defineConfig } from 'astro/config';

// `site` powers canonical URLs, Open Graph og:url, the sitemap, and the
// Sitemap: line in robots.txt. Override per-environment via SITE_URL
// when you deploy somewhere real:
//   SITE_URL=https://yourdomain.com npm run build
const siteUrl = process.env.SITE_URL || 'http://localhost:8080';

// Sweep orphaned OG cards out of .og-cache/ at the end of every build.
// The cache is content-addressed and persists across builds; without this
// hook, every renamed or deleted entity leaks its PNG forever (the cache
// had grown to 470 MB / 7.3k files against ~2.3k live entities). We record
// the build's start time, then prune any cache file older than that — i.e.
// any card no renderer touched this build. mtime is used (not the in-memory
// `touched` set) because build:done runs in a different module instance
// than the page renderers, so that set is invisible here.
let ogBuildStart = 0;
const ogPrune = {
  name: 'og-cache-prune',
  hooks: {
    'astro:build:start': () => { ogBuildStart = Date.now(); },
    'astro:build:done': async ({ logger }) => {
      // 2s margin absorbs any filesystem mtime-resolution truncation.
      const { pruneCache } = await import('./src/lib/og-render.ts');
      const { kept, pruned } = pruneCache(ogBuildStart - 2000);
      logger.info(`og-cache: kept ${kept}, pruned ${pruned}`);
    },
  },
};

export default defineConfig({
  site: siteUrl,
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  integrations: [ogPrune],
  server: { port: 4321 },
});
