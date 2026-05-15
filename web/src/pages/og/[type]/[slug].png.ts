/**
 * Per-entity OG card. Output URL pattern: /og/<type-dir>/<slug>.png
 * (e.g. /og/people/marc-dutroux.png).
 *
 * One endpoint instance per entity, generated at build time via
 * getStaticPaths. Cache hits short-circuit before satori/resvg load —
 * see lib/og-render.ts for the cache key strategy.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import type { Entity } from '../../../lib/types.ts';
import { entities, TYPE_DIRS } from '../../../lib/data.ts';
import { cardInputs } from '../../../lib/og-card.ts';
import { renderOrCache } from '../../../lib/og-render.ts';

export const getStaticPaths: GetStaticPaths = () =>
  entities().map((e) => ({
    params: { type: TYPE_DIRS[e.type], slug: e.id },
    props: { entity: e },
  }));

export const GET: APIRoute = async ({ props }) => {
  const { entity } = props as { entity: Entity };
  const { png } = await renderOrCache(cardInputs(entity));
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      // Tell crawlers (and any CDN in front of nginx) the bytes never
      // change for a given URL — when the entity changes, the cache
      // key changes, but the URL is the same; we accept some staleness
      // on social re-shares in exchange for cheap cacheability.
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
};
