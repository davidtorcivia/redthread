// The agent skill published under /.well-known/agent-skills/ (Agent Skills Discovery RFC
// v0.2.0): how to research this archive with its MCP server and API. One function builds the
// SKILL.md, so the index's digest always matches the file served.
import { createHash } from 'node:crypto';
import { absUrl, AGENT_API, SITE_TITLE } from './site.ts';

export const SKILL_NAME = 'archive-research';
export const SKILL_PATH = `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`;
export const SKILL_DESCRIPTION = `Research ${SITE_TITLE}, a footnoted, cross-linked archive, through its MCP server or GET API: find entries, read them with citations, trace connections, compare dated accounts, and search by source.`;

export function skillMarkdown(): string {
  const mcp = absUrl('/mcp');
  return `---
name: ${SKILL_NAME}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# Researching ${SITE_TITLE}

${SITE_TITLE} is a cross-linked archive of people, organizations, programs, events, concepts and places. Entries are written from cited sources, and every claim carries a footnote. Use this skill when a question is about anything the archive covers, or when you need sourced connections between entities.

## Connect

- MCP server (streamable HTTP, no authentication): \`${mcp}\`. In Claude Code: \`claude mcp add --transport http ${SITE_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'archive'} ${mcp}\`.
- The same tools over GET, returning JSON, are described at \`${absUrl('/api/openapi')}\`.
- Both are rate limited per IP. On HTTP 429, wait and retry.

## Workflow

1. **Find the entry.** \`search\` matches by meaning and by name. Use \`search_lexical\` for exact spellings, codenames, quotations and \`"quoted phrases"\`. Use \`search_semantic\` when names would mislead the ranking.
2. **Read it.** \`get_entry\` returns the full markdown: frontmatter with aliases, dates and typed relations, then the body with footnotes. Quote and cite from here, not from search snippets.
3. **Follow connections.** \`neighbors\` lists directly linked entries. \`similar\` finds related material the links miss.
4. **Trace a chain.** \`find_path\` from one entry to another. By default it uses wikilinks only. Pass \`exclude\` to route around hubs such as "united-states", \`k\` for distinct alternative routes, and \`edges: "relations"\` to use only typed, footnoted relations (member_of, employed_by, funded...), the best-sourced links in the archive.
5. **Compare dates.** \`timeline\` with a \`year\`, a range, or an \`entry\` returns every dated statement with its footnotes, grouped by the date as written. Conflicting accounts ("late 1974" against "winter 1975") sit side by side. Report the conflict and both sources rather than picking one.
6. **Search by source.** \`search_citations\` finds a book, archive, author or URL in the footnotes and lists every entry and typed relation that cites it.
7. **Bulk work.** \`list_entries\` pages through frontmatter. For everything at once, download \`${absUrl('/entries.json')}\` and \`${absUrl('/fulltext.json')}\`.

## Reading the evidence

- Typed relations carry a role ("membership as alleged", "office not stated") and the footnote that sources them. Keep those qualifiers when you repeat the claim.
- A path hop marked "named together in prose" means two entries are only mentioned on the same page. Treat it as weak evidence.
- Statements in \`timeline\` marked \`source_inherited\` took the next footnote in their paragraph. Check the footnote text before relying on it.

## Citing

Cite entries by their \`url\` (deep links to sections where given), and name the underlying source from the footnote, not just the archive.
`;
}

/** The discovery index. Lists the skill only where the MCP server and API exist. */
export function skillIndex() {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: AGENT_API
      ? [{
        name: SKILL_NAME,
        type: 'skill-md',
        description: SKILL_DESCRIPTION,
        url: SKILL_PATH,
        digest: `sha256:${createHash('sha256').update(skillMarkdown()).digest('hex')}`,
      }]
      : [],
  };
}
