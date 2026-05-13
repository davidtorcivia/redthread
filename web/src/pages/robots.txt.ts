import type { APIRoute } from 'astro';

/**
 * robots.txt — points crawlers at the sitemap and disallows the
 * /random/ utility page (it's a JS-driven redirect; indexing it
 * would pollute search results with a single dead landing page).
 */
export const GET: APIRoute = ({ site }) => {
  const base = site ? site.toString().replace(/\/+$/, '') : '';
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /random/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
