// Per-entry social card at /og/<type-dir>/<slug>.png.
import type { APIRoute, GetStaticPaths } from 'astro';
import type { Entity } from '../../../lib/types.ts';
import { entities, TYPE_DIRS } from '../../../lib/data.ts';
import { cardInputs } from '../../../lib/og-card.ts';
import { renderOrCache } from '../../../lib/og-render.ts';

export const getStaticPaths: GetStaticPaths = () =>
  entities().map((entity) => ({ params: { type: TYPE_DIRS[entity.type], slug: entity.id }, props: { entity } }));

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOrCache(cardInputs((props as { entity: Entity }).entity));
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
