import { defineConfig } from 'astro/config';

import { SITE_URL } from './src/lib/site.ts';

// Deletes OG cards no page used this build, so renamed or deleted entries don't
// leak PNGs into the persistent cache. Renderers refresh each card's mtime; this
// hook runs in a different module instance, so mtime is the only shared signal.
let buildStart = 0;
const ogPrune = {
  name: 'og-cache-prune',
  hooks: {
    'astro:build:start': () => { buildStart = Date.now(); },
    'astro:build:done': async ({ logger }) => {
      const { pruneCache } = await import('./src/lib/og-render.ts');
      // 2s margin for coarse filesystem mtime resolution.
      const { kept, pruned } = pruneCache(buildStart - 2000);
      logger.info(`og-cache: kept ${kept}, pruned ${pruned}`);
    },
  },
};

export default defineConfig({
  site: SITE_URL,
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  integrations: [ogPrune],
  server: { port: 4321 },
});
