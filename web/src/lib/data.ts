// Build-time access to the parser's JSON output in ../../../data. Every loader is lazy and memoized.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Entity, Edge, Backlink, EntityType, Related, ImplicitMention } from './types.ts';
import { TYPE_DIRS as DIRS, TYPE_LABELS as LABELS } from '../scripts/entity-types.ts';
import { yearOf } from './dates.ts';

export { renderInlineMd } from './inline-md.ts';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data');

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, name), 'utf-8')) as T;
}

/** Loads an optional data file; older or partial parser runs may not have written it. */
function loadOptional<T>(name: string, fallback: T): T {
  try {
    return loadJson<T>(name);
  } catch {
    return fallback;
  }
}

function memo<T>(load: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= load());
}

export const TYPE_DIRS = DIRS as Record<EntityType, string>;
export const TYPE_LABELS = LABELS as Record<EntityType, string>;
export const TYPE_PLURALS: Record<EntityType, string> = {
  person: 'People',
  organization: 'Organizations',
  program: 'Programs',
  event: 'Events',
  concept: 'Concepts',
  place: 'Places',
  source: 'Sources',
  meta: 'Meta',
  misc: 'Misc',
  page: 'Pages',
};
/** Types with their own browse page, in navigation order. */
export const BROWSE_TYPES: EntityType[] = ['person', 'organization', 'program', 'event', 'concept', 'place'];

export function hrefFor(e: Pick<Entity, 'id' | 'type'>): string {
  return `/${TYPE_DIRS[e.type]}/${e.id}/`;
}

export interface ActivityEntry {
  id: string;
  title: string;
  type: EntityType;
  category: string | null;
  summary: string | null;
  mtime: string;
}

/** Recently edited entries, newest first. */
export const activity = memo(() => loadOptional<ActivityEntry[]>('activity.json', []));
export const entities = memo(() => loadJson<Entity[]>('entities.json'));
export const edges = memo(() => loadJson<Edge[]>('links.json'));
const byId = memo(() => new Map(entities().map((e) => [e.id, e])));

export function entity(id: string): Entity | undefined {
  return byId().get(id);
}

export function entitiesByType(type: EntityType): Entity[] {
  return entities().filter((e) => e.type === type);
}

const relatedById = memo(() => new Map(Object.entries(loadJson<Record<string, Related[]>>('related.json'))));
export function related(id: string): Related[] {
  return relatedById().get(id) ?? [];
}

/** Most-mentioned entries, optionally of one type. */
export function topHubs(limit = 20, type?: EntityType): Entity[] {
  const pool = type ? entitiesByType(type) : entities();
  return [...pool]
    .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
    .slice(0, limit);
}

const implicitById = memo(() => {
  const m = new Map<string, ImplicitMention[]>();
  const ents = byId();
  // The parser already drops wikilinked targets; this guards against slug mismatches.
  const explicitTargets = new Map<string, Set<string>>();
  for (const edge of edges()) {
    if (edge.kind !== 'explicit' || !edge.target_id) continue;
    let s = explicitTargets.get(edge.source);
    if (!s) explicitTargets.set(edge.source, (s = new Set()));
    s.add(edge.target_id);
  }
  for (const edge of edges()) {
    if (edge.kind !== 'implicit' || !edge.target_id) continue;
    const target = ents.get(edge.target_id);
    if (!target || explicitTargets.get(edge.source)?.has(edge.target_id)) continue;
    const list = m.get(edge.source) ?? [];
    list.push({
      id: target.id,
      title: target.title,
      type: target.type,
      summary: target.summary,
      surface: edge.surface ?? target.title,
      count: edge.count ?? 1,
    });
    m.set(edge.source, list);
  }
  // Weight by inverse document frequency so a target named on nearly every page
  // doesn't lead every list.
  const df = new Map<string, number>();
  for (const list of m.values()) for (const x of list) df.set(x.id, (df.get(x.id) ?? 0) + 1);
  const score = (x: ImplicitMention) => x.count * Math.log((m.size + 1) / (df.get(x.id) ?? 1));
  for (const [src, list] of m) {
    const relatedIds = new Set(related(src).map((r) => r.id));
    const filtered = list.filter((x) => !relatedIds.has(x.id));
    filtered.sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));
    m.set(src, filtered);
  }
  return m;
});

/** Entries named in this page's prose but neither wikilinked nor already in its
 *  related list, most distinctive first. */
export function implicitMentions(sourceId: string): ImplicitMention[] {
  return implicitById().get(sourceId) ?? [];
}

const backlinksById = memo(() => {
  const m = new Map<string, Backlink[]>();
  const ents = byId();
  for (const edge of edges()) {
    if (!edge.target_id) continue;
    const source = ents.get(edge.source);
    if (!source) continue;
    const list = m.get(edge.target_id) ?? [];
    if (!list.some((b) => b.source_id === source.id)) {
      list.push({
        source_id: source.id,
        source_title: source.title,
        source_type: source.type,
        display: edge.display ?? edge.surface ?? source.title,
      });
    }
    m.set(edge.target_id, list);
  }
  return m;
});

/** Pages linking to or naming this entry, one row per source page. */
export function backlinks(id: string): Backlink[] {
  return backlinksById().get(id) ?? [];
}

/** Lowercase, hyphenated URL slug. Tags may be YAML numbers, hence `unknown`. */
function tagSlug(tag: unknown): string {
  return String(tag ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function tagHref(tag: unknown): string {
  return `/tag/${tagSlug(tag)}/`;
}

/** Tags by slug, keeping the first-seen spelling for display. */
const tagIndex = memo(() => {
  const m = new Map<string, { tag: string; entities: Entity[] }>();
  for (const e of entities()) {
    for (const t of e.tags ?? []) {
      if (t == null) continue;
      const display = String(t);
      const slug = tagSlug(display);
      if (!slug) continue;
      let entry = m.get(slug);
      if (!entry) m.set(slug, (entry = { tag: display, entities: [] }));
      entry.entities.push(e);
    }
  }
  return m;
});

export function allTags(): { slug: string; tag: string; count: number }[] {
  return Array.from(tagIndex(), ([slug, { tag, entities: es }]) => ({ slug, tag, count: es.length }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function entitiesByTag(slug: string): Entity[] {
  return tagIndex().get(slug)?.entities ?? [];
}

/** Earliest known year, used to place an entry on the timeline. */
export function primaryYear(e: Entity): number | null {
  const d = e.dates ?? {};
  for (const s of [d.born, d.start, d.date, d.died, d.end]) {
    const year = yearOf(s);
    if (year != null) return year;
  }
  return null;
}

/** Top bridges (entries cited from many distinct clusters), strongest first. */
export function bridgeEntities(): Entity[] {
  return entities()
    .filter((e) => e.bridge_rank != null)
    .sort((a, b) => a.bridge_rank! - b.bridge_rank!);
}

/** Top hubs by PageRank, strongest first. */
export function hubEntities(): Entity[] {
  return entities()
    .filter((e) => e.hub_rank != null)
    .sort((a, b) => a.hub_rank! - b.hub_rank!);
}

export interface UnresolvedTarget {
  /** Link text as written in the vault, first spelling seen. */
  target: string;
  count: number;
  sources: Pick<Entity, 'id' | 'title' | 'type'>[];
}

/** Wikilink targets with no entry, grouped case-insensitively, most-linked first. */
export const unresolvedTargets = memo(() => {
  const ents = byId();
  const m = new Map<string, UnresolvedTarget & { seen: Set<string> }>();
  for (const edge of edges()) {
    if (edge.kind !== 'explicit' || edge.target_id || !edge.target_title) continue;
    const key = edge.target_title.trim().toLowerCase();
    if (!key) continue;
    let t = m.get(key);
    if (!t) m.set(key, (t = { target: edge.target_title.trim(), count: 0, sources: [], seen: new Set() }));
    t.count++;
    const src = ents.get(edge.source);
    if (src && !t.seen.has(src.id)) {
      t.seen.add(src.id);
      t.sources.push({ id: src.id, title: src.title, type: src.type });
    }
  }
  return [...m.values()]
    .map(({ seen: _seen, ...t }): UnresolvedTarget => t)
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
});

export interface Community {
  id: number;
  label: string;
  size: number;
  types: Record<string, number>;
  top: Pick<Entity, 'id' | 'title' | 'type' | 'mention_count'>[];
}

/** Smaller clusters are fragments: grouped together on /clusters/ and not shown on entry pages. */
export const CLUSTER_MIN_SIZE = 5;

/** Louvain communities, indexed by Entity.community_id. */
export const communities = memo(() => loadOptional<Community[]>('communities.json', []));

export function communityOf(e: Entity): Community | undefined {
  return e.community_id == null ? undefined : communities()[e.community_id];
}

export interface Focus {
  days: number;
  pages: { id: string; pinned: boolean; reason: string }[];
  cluster: { id: number; label: string; size: number; edited: number; days: number } | null;
}

/** Homepage "In focus": recently active pages plus pinned ones, and the most-edited cluster. */
export const focus = memo(() => loadOptional<Focus>('focus.json', { days: 30, pages: [], cluster: null }));
