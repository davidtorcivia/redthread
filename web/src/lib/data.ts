import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Entity, Edge, Backlink, EntityType, Related, ImplicitMention } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../../data');

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, name), 'utf-8')) as T;
}

let _entities: Entity[] | null = null;
let _edges: Edge[] | null = null;
let _byId: Map<string, Entity> | null = null;
let _backlinksById: Map<string, Backlink[]> | null = null;
let _relatedById: Map<string, Related[]> | null = null;
let _implicitOutboundById: Map<string, ImplicitMention[]> | null = null;

export function entities(): Entity[] {
  if (!_entities) _entities = loadJson<Entity[]>('entities.json');
  return _entities;
}

export function edges(): Edge[] {
  if (!_edges) _edges = loadJson<Edge[]>('links.json');
  return _edges;
}

export function byId(): Map<string, Entity> {
  if (!_byId) _byId = new Map(entities().map((e) => [e.id, e]));
  return _byId;
}

export function entity(id: string): Entity | undefined {
  return byId().get(id);
}

export function entitiesByType(type: EntityType): Entity[] {
  return entities().filter((e) => e.type === type);
}

export function related(id: string): Related[] {
  if (!_relatedById) {
    const raw = loadJson<Record<string, Related[]>>('related.json');
    _relatedById = new Map(Object.entries(raw));
  }
  return _relatedById.get(id) ?? [];
}

export function topHubs(limit = 20, type?: EntityType): Entity[] {
  const pool = type ? entitiesByType(type) : entities();
  return [...pool]
    .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
    .slice(0, limit);
}

/**
 * Entities mentioned in this page's prose without an explicit wikilink.
 * Surfaced from NER's implicit edges, then double-filtered against the
 * Connected-to list and the source entity's own wikilink targets — so a
 * target visible elsewhere on the page never re-appears here. Sorted by
 * mention count, which roughly tracks "what this page is really about".
 */
export function implicitMentions(sourceId: string): ImplicitMention[] {
  if (!_implicitOutboundById) {
    const m = new Map<string, ImplicitMention[]>();
    const ents = byId();
    // Explicit edges per source (defensive — parser already filters, but
    // a fallback here means a slug-resolution mismatch can't leak through).
    const explicitTargets = new Map<string, Set<string>>();
    for (const edge of edges()) {
      if (edge.kind !== 'explicit' || !edge.target_id) continue;
      let s = explicitTargets.get(edge.source);
      if (!s) { s = new Set(); explicitTargets.set(edge.source, s); }
      s.add(edge.target_id);
    }
    for (const edge of edges()) {
      if (edge.kind !== 'implicit') continue;
      if (!edge.target_id) continue;
      const target = ents.get(edge.target_id);
      if (!target) continue;
      // Skip if already explicitly wikilinked from this source.
      if (explicitTargets.get(edge.source)?.has(edge.target_id)) continue;
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
    // Final pass: remove anything that already shows up in Connected-to,
    // so the same entity never duplicates between the two sections.
    for (const [src, list] of m.entries()) {
      const relatedIds = new Set(related(src).map((r) => r.id));
      const filtered = list.filter((x) => !relatedIds.has(x.id));
      filtered.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
      m.set(src, filtered);
    }
    _implicitOutboundById = m;
  }
  return _implicitOutboundById.get(sourceId) ?? [];
}

export function backlinks(id: string): Backlink[] {
  if (!_backlinksById) {
    const m = new Map<string, Backlink[]>();
    const ents = byId();
    for (const edge of edges()) {
      if (!edge.target_id) continue;
      const source = ents.get(edge.source);
      if (!source) continue;
      const list = m.get(edge.target_id) ?? [];
      // De-duplicate by source_id so we don't list the same page 5 times.
      // Implicit edges don't carry a display string; fall back to the
      // source's title so the type stays satisfied.
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
    _backlinksById = m;
  }
  return _backlinksById.get(id) ?? [];
}

export const TYPE_DIRS: Record<EntityType, string> = {
  person: 'people',
  organization: 'organizations',
  program: 'programs',
  event: 'events',
  concept: 'concepts',
  place: 'places',
  source: 'sources',
  meta: 'meta',
  misc: 'misc',
  page: 'pages',
};

export const TYPE_LABELS: Record<EntityType, string> = {
  person: 'Person',
  organization: 'Organization',
  program: 'Program',
  event: 'Event',
  concept: 'Concept',
  place: 'Place',
  source: 'Source',
  meta: 'Meta',
  misc: 'Misc',
  page: 'Page',
};

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

export function hrefFor(e: Pick<Entity, 'id' | 'type'>): string {
  return `/${TYPE_DIRS[e.type]}/${e.id}/`;
}
