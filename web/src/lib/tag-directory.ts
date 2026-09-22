import { allTags, entitiesByTag } from './data.ts';

export interface TagDirectoryRow {
  key: string;
  variants: { slug: string; tag: string; count: number }[];
  primary: { slug: string; tag: string; count: number };
  count: number;
  letter: string;
}

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
