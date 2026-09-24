// Hand-rolled so each entry gets its own lastmod and each section its own changefreq.
import type { APIRoute } from 'astro';
import { allTags, BROWSE_TYPES, entities, hrefFor, TYPE_DIRS } from '../lib/data.ts';
import { escapeHtml as esc } from '../lib/inline-md.ts';
import { absUrl } from '../lib/site.ts';

type Url = { loc: string; lastmod?: string; changefreq: string; priority: string };

export const GET: APIRoute = () => {
  const urls: Url[] = [
    { loc: '/',          changefreq: 'weekly',  priority: '1.0' },
    { loc: '/network/',  changefreq: 'weekly',  priority: '0.8' },
    { loc: '/path/',     changefreq: 'monthly', priority: '0.7' },
    { loc: '/bridges/',  changefreq: 'weekly',  priority: '0.7' },
    { loc: '/clusters/', changefreq: 'weekly',  priority: '0.6' },
    { loc: '/tags/',     changefreq: 'weekly',  priority: '0.7' },
    { loc: '/timeline/', changefreq: 'weekly',  priority: '0.7' },
    { loc: '/changelog/',changefreq: 'daily',   priority: '0.5' },
    ...[...BROWSE_TYPES.map((t) => `/${TYPE_DIRS[t]}/`), '/sources/']
      .map((loc) => ({ loc, changefreq: 'weekly', priority: '0.6' })),
    ...allTags().map((t) => ({ loc: `/tag/${t.slug}/`, changefreq: 'weekly', priority: '0.5' })),
    ...entities().map((e) => ({
      loc: hrefFor(e),
      lastmod: e.mtime?.slice(0, 10),
      changefreq: 'monthly',
      priority: '0.6',
    })),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => [
      '  <url>',
      `    <loc>${esc(absUrl(u.loc))}</loc>`,
      u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : '',
      `    <changefreq>${u.changefreq}</changefreq>`,
      `    <priority>${u.priority}</priority>`,
      '  </url>',
    ].filter(Boolean).join('\n')),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
