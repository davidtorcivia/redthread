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
  /** File modification time (ISO 8601), emitted by parse_vault. Used as a
   *  dateModified fallback in schema.org and for sitemap lastmod. */
  mtime?: string;
  /** Top-50 bridge entity. Bridge = community-span entropy of the pages
   *  that cite this entry (Louvain communities). Lower rank = stronger
   *  bridge — an entry that keeps turning up in distant clusters. */
  bridge_rank?: number;
  /** Bridge score: H(citing-page community distribution) · log(1 + k) / sqrt(m). */
  bridge_score?: number;
  /** Number of distinct Louvain communities among the pages citing this
   *  entry. Companion to bridge_rank. */
  community_span?: number;
  /** Top-50 hub entity by PageRank on the directed mention graph.
   *  Lower rank = stronger hub. The famous, well-evidenced central
   *  nodes — distinct from Bridge, which is structural connectivity. */
  hub_rank?: number;
  /** PageRank score in roughly [0, 1] (sums to 1 across all nodes). */
  hub_score?: number;
  /** Louvain community id assigned to this entity. Stable within a
   *  build given the fixed seed, but may shift between builds when the
   *  underlying graph changes. */
  community_id?: number;
  /**
   * Date fields populated from frontmatter when present. All values are
   * normalized to strings ("YYYY" or "YYYY-MM-DD") regardless of how
   * YAML parsed the input.
   */
  dates: {
    born?: string;
    died?: string;
    start?: string;
    end?: string;
    date?: string;
  };
  /**
   * Free-text location names from frontmatter. Future backfill will also
   * geocode these into a coords field on `frontmatter` for the map view.
   */
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
  /** Up to 5 pages where this pair co-occurred — the evidence behind the connection. */
  via?: RelatedVia[];
}

export interface Edge {
  source: string;
  target_id: string | null;
  // explicit-only fields
  target_title?: string;
  display?: string;
  section?: string;
  // implicit-only fields
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
