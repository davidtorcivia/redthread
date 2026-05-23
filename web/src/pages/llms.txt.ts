import type { APIRoute } from 'astro';
import { entities, entitiesByType, TYPE_DIRS, TYPE_LABELS, TYPE_PLURALS } from '../lib/data.ts';
import type { EntityType } from '../lib/types.ts';

/**
 * llms.txt — concise site index for LLM agents, per https://llmstxt.org/.
 *
 * Format: H1 title, blockquote summary, optional paragraphs, then H2
 * sections with `- [name](url): description` bullets. The "Optional"
 * section at the end is what crawlers may skip when context is tight.
 *
 * We point at the structured browse pages and the raw JSON payloads
 * rather than dumping every entity inline — there are thousands of
 * entries, and the adjacency / previews JSON is what an agent actually
 * wants if it's reasoning across the graph.
 */
export const GET: APIRoute = ({ site }) => {
  const base = site ? site.toString().replace(/\/+$/, '') : '';
  const total = entities().length;

  // Top-mentioned entry per type — gives agents a high-signal sample
  // without listing every page. Sorted by mention_count so the most
  // central entity in each section surfaces first.
  function topByType(t: EntityType, n: number) {
    return entitiesByType(t)
      .slice()
      .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
      .slice(0, n);
  }

  const headlineTypes: EntityType[] = [
    'person', 'organization', 'program', 'event', 'concept', 'place',
  ];

  const lines: string[] = [];
  lines.push('# The Info Web');
  lines.push('');
  lines.push(`> A research vault on intelligence operations, parapsychology, government programs, and the parapolitical record. ${total.toLocaleString()} cross-linked entries on the figures, organizations, programs, events, concepts, and places that recur across declassified documents, investigative journalism, and academic research.`);
  lines.push('');
  lines.push('Every entry links to related entries; the dataset is structured as a graph. Entity pages live under `/people/`, `/organizations/`, `/programs/`, `/events/`, `/concepts/`, `/places/`, `/sources/`. Each page has a summary, body, related-entity grid, and a local network graph centered on that entity.');
  lines.push('');
  lines.push('**Clean markdown companions:** every HTML entity page at `/<type>/<slug>/` has a markdown sibling at `/<type>/<slug>.md`. Each `.md` file contains the original frontmatter plus the body with wikilinks rewritten to absolute site URLs — prefer these over scraping the HTML. They are also advertised via `<link rel="alternate" type="text/markdown">` in the HTML head.');
  lines.push('');

  // ---------------- Browse-by-type ----------------
  lines.push('## Browse by type');
  lines.push('');
  for (const t of headlineTypes) {
    const dir = TYPE_DIRS[t];
    const count = entitiesByType(t).length;
    lines.push(`- [${TYPE_PLURALS[t]}](${base}/${dir}/): ${count.toLocaleString()} ${TYPE_LABELS[t].toLowerCase()} entries`);
  }
  // Less central types — included but lower priority.
  if (entitiesByType('source' as EntityType).length > 0) {
    lines.push(`- [Sources](${base}/sources/): cited documents and references`);
  }
  lines.push('');

  // ---------------- Network tools ----------------
  lines.push('## Network and graph tools');
  lines.push('');
  lines.push(`- [Network graph](${base}/network/): interactive force-directed graph of the full entity network`);
  lines.push(`- [Path finder](${base}/path/): shortest path between any two entities`);
  lines.push(`- [Bridges](${base}/bridges/): cut-vertex analysis — entities whose removal would disconnect parts of the graph`);
  lines.push(`- [Tags](${base}/tags/): browse by tag`);
  lines.push(`- [Timeline](${base}/timeline/): entries ordered chronologically by primary year`);
  lines.push('');

  // ---------------- Top entries per type ----------------
  lines.push('## High-centrality entries');
  lines.push('');
  lines.push('A sampling of the most heavily cross-referenced entries — useful anchors for orientation.');
  lines.push('');
  for (const t of headlineTypes) {
    const top = topByType(t, 5);
    if (top.length === 0) continue;
    lines.push(`### ${TYPE_PLURALS[t]}`);
    for (const e of top) {
      const dir = TYPE_DIRS[e.type];
      const summary = (e.summary ?? '').trim().replace(/\s+/g, ' ');
      const short = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;
      lines.push(`- [${e.title}](${base}/${dir}/${e.id}/)${short ? `: ${short}` : ''}`);
    }
    lines.push('');
  }

  // ---------------- Raw data ----------------
  lines.push('## Raw data');
  lines.push('');
  lines.push(`- [Sitemap](${base}/sitemap.xml): full URL list with per-entry last-modified dates`);
  lines.push(`- [Adjacency JSON](${base}/adjacency.json): graph adjacency list — ids, types, and per-node neighbor index. Use this for graph reasoning instead of scraping individual pages.`);
  lines.push(`- [Previews JSON](${base}/previews.json): per-entity title, type, and short summary — drives wikilink hover previews`);
  lines.push('');

  // ---------------- Optional ----------------
  lines.push('## Optional');
  lines.push('');
  lines.push(`- [Changelog](${base}/changelog/): recent vault updates`);
  lines.push(`- [About / meta](${base}/meta/): notes on methodology, conventions, and the vault itself`);
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
