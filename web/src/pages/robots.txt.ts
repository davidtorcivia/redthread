// /random/ is a client-side redirect with nothing to index.
import type { APIRoute } from 'astro';
import { absUrl } from '../lib/site.ts';

export const GET: APIRoute = () => new Response(
  ['User-agent: *', 'Allow: /', 'Disallow: /random/', '', `Sitemap: ${absUrl('/sitemap.xml')}`, ''].join('\n'),
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
