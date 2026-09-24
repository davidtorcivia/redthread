// Default social card for pages without their own.
import type { APIRoute } from 'astro';
import { renderOrCache } from '../../lib/og-render.ts';
import { SITE_DESCRIPTION, SITE_TITLE } from '../../lib/site.ts';

export const GET: APIRoute = async () => {
  const png = await renderOrCache({
    type: 'page', title: SITE_TITLE, summary: SITE_DESCRIPTION, category: null, dates: {}, mention_count: 0,
  });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
