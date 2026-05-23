import type { APIRoute } from 'astro';
import {
  entities,
  allTags,
  TYPE_DIRS,
  primaryYear,
} from '../lib/data.ts';

/**
 * Hand-rolled sitemap. Astro's built-in sitemap integration would do this
 * too, but we want per-URL lastmod from entity mtime + sensible changefreq
 * hints by section, which is faster to express directly than to bend the
 * integration around.
 */
export const GET: APIRoute = ({ site }) => {
  // Astro normalises `site` to end in `/`; strip the trailing slash so we
  // can concatenate path strings without doubling up.
  const base = site ? site.toString().replace(/\/+$/, '') : '';

  type Url = { loc: string; lastmod?: string; changefreq?: string; priority?: string };
  const urls: Url[] = [
    { loc: '/',          changefreq: 'weekly',  priority: '1.0' },
    { loc: '/network/',  changefreq: 'weekly',  priority: '0.8' },
    { loc: '/path/',     changefreq: 'monthly', priority: '0.7' },
    { loc: '/bridges/',  changefreq: 'weekly',  priority: '0.7' },
    { loc: '/tags/',     changefreq: 'weekly',  priority: '0.7' },
    { loc: '/timeline/', changefreq: 'weekly',  priority: '0.7' },
    { loc: '/changelog/',changefreq: 'daily',   priority: '0.5' },
  ];

  // Type browse pages (/people/, /organizations/, …).
  const seenDirs = new Set<string>();
  for (const dir of Object.values(TYPE_DIRS)) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    urls.push({ loc: `/${dir}/`, changefreq: 'weekly', priority: '0.6' });
  }

  // Tag browse pages.
  for (const t of allTags()) {
    urls.push({ loc: `/tag/${t.slug}/`, changefreq: 'weekly', priority: '0.5' });
  }

  // Per-entity pages. lastmod from file mtime gives crawlers an accurate
  // re-crawl signal when the vault is edited.
  for (const e of entities()) {
    const dir = TYPE_DIRS[e.type];
    const u: Url = {
      loc: `/${dir}/${e.id}/`,
      changefreq: 'monthly',
      priority: '0.6',
    };
    const mt = (e as { mtime?: string }).mtime;
    if (mt) u.lastmod = mt.slice(0, 10); // YYYY-MM-DD per sitemap spec
    urls.push(u);
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => {
      const parts = [
        `    <loc>${base}${u.loc}</loc>`,
        u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : '',
        u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>` : '',
        u.priority ? `    <priority>${u.priority}</priority>` : '',
      ].filter(Boolean).join('\n');
      return `  <url>\n${parts}\n  </url>`;
    }),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};

// Silence the primaryYear import if tree-shaking gets aggressive.
void primaryYear;
