import { allTags, communities, entitiesByTag, entity } from './data.ts';

export interface TagDirectoryRow {
  key: string;
  variants: { slug: string; tag: string; count: number }[];
  primary: { slug: string; tag: string; count: number };
  count: number;
  letter: string;
}

// Tags that differ only by case, accents or punctuation share a row.
const keyFor = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function tagDirectoryRows(): TagDirectoryRow[] {
  const grouped = new Map<string, ReturnType<typeof allTags>>();
  for (const tag of allTags()) {
    const key = keyFor(tag.tag) || tag.slug;
    const group = grouped.get(key) ?? [];
    group.push(tag);
    grouped.set(key, group);
  }
  return [...grouped].map(([key, variants]) => ({
    key,
    variants,
    primary: variants[0],
    count: variants.length === 1 ? variants[0].count : new Set(variants.flatMap((tag) => entitiesByTag(tag.slug).map((entity) => entity.id))).size,
    letter: variants[0].tag.normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[A-Za-z]/)?.[0]?.toUpperCase() || '',
  })).sort((a, b) => b.count - a.count || a.primary.tag.localeCompare(b.primary.tag));
}

/** Tags grouped under the cluster holding most of their entries, largest clusters first.
 *  A tag spread evenly across subjects (a decade, a country) has no home and is left out. */
export function tagSubjects(rows: TagDirectoryRow[], skip: Set<string>, clusters = 12, perCluster = 12) {
  const homes = new Map<number, TagDirectoryRow[]>();
  for (const row of rows) {
    if (row.count < 3 || skip.has(row.key)) continue;
    const ids = new Set(row.variants.flatMap((tag) => entitiesByTag(tag.slug).map((e) => e.id)));
    const counts = new Map<number, number>();
    for (const id of ids) {
      const cid = entity(id)?.community_id;
      if (cid != null) counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
    const [cid, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [];
    if (cid == null || n / ids.size < 0.5) continue;
    homes.set(cid, [...(homes.get(cid) ?? []), row]);
  }
  return [...communities()].sort((a, b) => b.size - a.size)
    .filter((c) => (homes.get(c.id)?.length ?? 0) >= 3)
    .slice(0, clusters)
    .map((c) => ({ cluster: c, tags: homes.get(c.id)!.slice(0, perCluster), total: homes.get(c.id)!.length }));
}
