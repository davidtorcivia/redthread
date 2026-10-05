// /llms-full.txt (llmstxt.org). The full text is ~19 MB of JSON, so this points at the bulk
// downloads and describes their format instead of inlining the archive.
import type { APIRoute } from 'astro';
import { entities } from '../lib/data.ts';
import { absUrl, AGENT_API, SITE_DESCRIPTION, SITE_TITLE } from '../lib/site.ts';

export const GET: APIRoute = () => new Response([
  `# ${SITE_TITLE}: full text`,
  '',
  `> ${SITE_DESCRIPTION} ${entities().length.toLocaleString()} cross-linked entries. The complete text is published as JSON rather than inlined here.`,
  '',
  '## Full text',
  '',
  ...(AGENT_API ? [
    `- [Full text JSON](${absUrl('/fulltext.json')}): \`{"sections": [[entry id, section anchor, heading, text]], "footnotes": {entry id: {footnote id: text}}}\`. Every entry's body as plain text by heading section, with \`[^n]\` footnote markers kept and links reduced to their text. Join an entry's sections in order for its full body; resolve markers against \`footnotes[entry id]\`. A section's URL is the entry URL plus \`#anchor\`.`,
    `- [Entries JSON](${absUrl('/entries.json')}): one object per entry: \`id\`, \`title\`, \`type\`, \`path\`, \`aliases\`, \`dates\`, \`category\`, \`summary\`, \`tags\`, \`location\`, \`created\`, \`updated\`, and \`relations\` (typed, each with \`role\`, \`start\`, \`end\` and the \`source\` footnote text). No body text.`,
  ] : []),
  `- Per entry: every page at \`/<type>/<slug>/\` has its markdown at \`/<type>/<slug>.md\` (frontmatter, body and footnotes). [Sitemap](${absUrl('/sitemap.xml')}) lists every page.`,
  `- [Adjacency JSON](${absUrl('/adjacency.json')}): the link graph (ids, titles, types, neighbor indices and link directions).`,
  '',
  ...(AGENT_API ? [
    '## Querying instead of downloading',
    '',
    `- MCP server (streamable HTTP, no auth): \`${absUrl('/mcp')}\`. Search by meaning, exact text, source or date; read entries; find paths. GET equivalents: [OpenAPI](${absUrl('/api/openapi')}).`,
    `- Index and setup: [llms.txt](${absUrl('/llms.txt')}).`,
    '',
  ] : []),
].join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
