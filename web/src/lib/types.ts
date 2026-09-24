export type EntityType =
  | 'person'
  | 'organization'
  | 'program'
  | 'event'
  | 'concept'
  | 'place'
  | 'source'
  | 'meta'
  | 'misc'
  | 'page';

export interface Wikilink {
  target: string;
  display: string;
  section: string;
}

export interface Footnote {
  id: string;
  text: string;
  html?: string;
}

export interface TocEntry {
  level: number; // 2, 3, or 4
  text: string;
  id: string;
}

/** A typed relation from frontmatter `relations:` (see parse_vault.py
 *  RELATION_TYPES). `other_id` is null when the other side has no page.
 *  `fn` is a footnote id on the page `fn_page` that declared the relation. */
export interface Relation {
  type: string;
  label: string;
  other_id: string | null;
  other_title: string;
  start: string | null;
  end: string | null;
  role: string | null;
  fn: string | null;
  fn_page: string;
}

export interface Entity {
  id: string;
  title: string;
  type: EntityType;
  path: string;
  category: string | null;
  summary: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  body_md: string;
  body_html: string;
  toc: TocEntry[];
  footnotes: Footnote[];
  wikilinks: Wikilink[];
  mention_count: number;
  page_density: number;
  /** Relations this page is the subject of, and inverses of relations
   *  other pages declare about it. */
  relations?: Relation[];
  relations_in?: Relation[];
  /** Source file modification time (ISO 8601). */
  mtime?: string;
  /** Rank among the top bridges: entries cited from many distinct clusters. 1 is strongest. */
  bridge_rank?: number;
  /** Bridge score: H(citing-page community distribution) · log(1 + k) / sqrt(m). */
  bridge_score?: number;
  /** Distinct Louvain communities among the pages citing this entry. */
  community_span?: number;
  /** Rank among the top hubs by PageRank on the mention graph. 1 is strongest. */
  hub_rank?: number;
  /** PageRank score in roughly [0, 1] (sums to 1 across all nodes). */
  hub_score?: number;
  /** Louvain community; ids can shift between builds as the graph changes. */
  community_id?: number;
  /** Frontmatter dates, normalized to "YYYY" or "YYYY-MM-DD". */
  dates: {
    born?: string;
    died?: string;
    start?: string;
    end?: string;
    date?: string;
  };
  /** Free-text location names from frontmatter. */
  locations: string[];
}

export interface RelatedVia {
  id: string;
  title: string;
  type: EntityType;
}

export interface Related {
  id: string;
  count: number;
  type: EntityType;
  title: string;
  summary: string | null;
  /** Up to 5 pages where this pair co-occurred: the evidence for the connection. */
  via?: RelatedVia[];
}

export interface Edge {
  source: string;
  target_id: string | null;
  // Explicit (wikilink) edges only.
  target_title?: string;
  display?: string;
  section?: string;
  // Implicit (named in prose) edges only.
  surface?: string;
  count?: number;
  kind: 'explicit' | 'implicit';
}

export interface ImplicitMention {
  id: string;
  title: string;
  type: EntityType;
  summary: string | null;
  surface: string;
  count: number;
}

export interface Backlink {
  source_id: string;
  source_title: string;
  source_type: EntityType;
  display: string;
}
