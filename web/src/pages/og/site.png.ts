/**
 * Default OG card for any page that doesn't have a per-entity image —
 * the home page, browse indexes, network/path/tags/timeline, etc.
 * Same template, same cache machinery.
 */
import type { APIRoute } from 'astro';
import { renderOrCache } from '../../lib/og-render.ts';

export const GET: APIRoute = async () => {
  const { png } = await renderOrCache({
    type: 'page',
    title: 'The Info Web',
    summary: 'A vault of people, organizations, programs, events, places, and concepts — and the connections between them.',
    category: null,
    dates: {},
    locations: [],
    tags: [],
    mention_count: 0,
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
};
