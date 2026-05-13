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
  footnotes: Footnote[];
  wikilinks: Wikilink[];
  mention_count: number;
  page_density: number;
}

export interface Related {
  id: string;
  count: number;
  type: EntityType;
  title: string;
  summary: string | null;
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
