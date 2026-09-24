// Site index for LLM agents (https://llmstxt.org/). Points at browse pages and the
// JSON payloads rather than listing thousands of entries inline.
import type { APIRoute } from 'astro';
import { BROWSE_TYPES, entities, entitiesByType, hrefFor, topHubs, TYPE_DIRS, TYPE_LABELS, TYPE_PLURALS } from '../lib/data.ts';
import { absUrl, SITE_DESCRIPTION, SITE_TITLE } from '../lib/site.ts';

// Brackets in a title would end the markdown link text early.
const linkText = (s: string) => s.replace(/[[\]]/g, '\\$&');

export const GET: APIRoute = () => {
  const lines = [
    `# ${SITE_TITLE}`,
    '',
    `> ${SITE_DESCRIPTION} ${entities().length.toLocaleString()} cross-linked entries.`,
    '',
    `Every entry links to related entries; the dataset is structured as a graph. Entity pages live under \`/people/\`, \`/organizations/\`, \`/programs/\`, \`/events/\`, \`/concepts/\`, \`/places/\`, \`/sources/\`. Each page has a summary, body, related-entity grid, and a local network graph centered on that entity.`,
    '',
    '**Clean markdown companions:** every HTML entity page at `/<type>/<slug>/` has a markdown sibling at `/<type>/<slug>.md`. Each `.md` file contains the original frontmatter plus the body with wikilinks rewritten to absolute site URLs. Prefer these over scraping the HTML. They are also advertised via `<link rel="alternate" type="text/markdown">` in the HTML head.',
    '',
    '## Browse by type',
    '',
    ...BROWSE_TYPES.map((t) => `- [${TYPE_PLURALS[t]}](${absUrl(`/${TYPE_DIRS[t]}/`)}): ${entitiesByType(t).length.toLocaleString()} ${TYPE_LABELS[t].toLowerCase()} entries`),
    `- [Sources](${absUrl('/sources/')}): cited documents and references`,
    '',
    '## Network and graph tools',
    '',
    `- [Network graph](${absUrl('/network/')}): interactive force-directed graph of the full entity network`,
    `- [Path finder](${absUrl('/path/')}): a chain of documented connections between any two entities, steering around the mega-hubs`,
    `- [Bridges](${absUrl('/bridges/')}): entries cited from the most distinct community clusters, plus PageRank hubs`,
    `- [Clusters](${absUrl('/clusters/')}): Louvain communities of the link graph, each named after its most-mentioned members`,
    `- [Tags](${absUrl('/tags/')}): browse by tag`,
    `- [Timeline](${absUrl('/timeline/')}): entries ordered chronologically by primary year`,
    '',
    '## High-centrality entries',
    '',
    'A sampling of the most heavily cross-referenced entries, useful anchors for orientation.',
    '',
  ];
  for (const t of BROWSE_TYPES) {
    const top = topHubs(5, t);
    if (!top.length) continue;
    lines.push(`### ${TYPE_PLURALS[t]}`);
    for (const e of top) {
      const summary = (e.summary ?? '').trim().replace(/\s+/g, ' ');
      const short = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;
      lines.push(`- [${linkText(e.title)}](${absUrl(hrefFor(e))})${short ? `: ${short}` : ''}`);
    }
    lines.push('');
  }
  lines.push(
    '## Raw data',
    '',
    `- [Sitemap](${absUrl('/sitemap.xml')}): full URL list with per-entry last-modified dates`,
    `- [Adjacency JSON](${absUrl('/adjacency.json')}): graph adjacency list: ids, types, and per-node neighbor index. Use this for graph reasoning instead of scraping individual pages.`,
    `- [Previews JSON](${absUrl('/previews.json')}): per-entity title, type, and short summary, used for wikilink hover previews`,
    '',
    '## Optional',
    '',
    `- [Changelog](${absUrl('/changelog/')}): recent vault updates`,
    '',
  );
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
