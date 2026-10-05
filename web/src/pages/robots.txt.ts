// /random/ is a client-side redirect with nothing to index; /api/ and /mcp are for agents, not crawlers.
// Content-Signal (contentsignals.org): the content may be used for training, search and AI answers.
import type { APIRoute } from 'astro';
import { absUrl } from '../lib/site.ts';

export const GET: APIRoute = () => new Response(
  ['User-agent: *', 'Content-Signal: ai-train=yes, search=yes, ai-input=yes', 'Allow: /', 'Disallow: /random/', 'Disallow: /api/', 'Disallow: /mcp', '', `Sitemap: ${absUrl('/sitemap.xml')}`, ''].join('\n'),
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
