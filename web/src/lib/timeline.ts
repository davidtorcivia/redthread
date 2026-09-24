import { entities, hrefFor, primaryYear, TYPE_LABELS } from './data.ts';
import { yearOf } from './dates.ts';
import { plainText } from './inline-md.ts';
import type { Entity, EntityType } from './types.ts';

export interface TimelineRecord {
  id: string;
  title: string;
  type: EntityType;
  typeLabel: string;
  href: string;
  year: number;
  kind: string;
  range: string;
  summary: string;
  search: string;
}

/** What happened in `year`, for the row label. */
function kindFor(entity: Entity, year: number): string {
  const dates = entity.dates ?? {};
  if (yearOf(dates.born) === year) return 'Born';
  if (yearOf(dates.start) === year) return entity.type === 'event' || entity.type === 'program' ? 'Began' : 'Started';
  if (yearOf(dates.date) === year) return entity.type === 'event' ? 'Occurred' : 'Dated';
  if (yearOf(dates.died) === year) return 'Died';
  if (yearOf(dates.end) === year) return 'Ended';
  return 'Dated';
}

function shortSummary(value: string | null): string {
  const text = plainText(value);
  return text.length > 220 ? `${text.slice(0, 217).replace(/\s+\S*$/, '').trimEnd()}…` : text;
}

/** Every dated entry, newest first. */
export function timelineRecords(): TimelineRecord[] {
  return entities().flatMap((entity) => {
    const year = primaryYear(entity);
    if (year == null) return [];
    const dates = entity.dates ?? {};
    const begin = yearOf(dates.born) ?? yearOf(dates.start);
    const end = yearOf(dates.died) ?? yearOf(dates.end);
    const range = begin != null && end != null && end > begin ? `${begin}–${end}` : '';
    return [{
      id: entity.id,
      title: entity.title,
      type: entity.type,
      typeLabel: TYPE_LABELS[entity.type],
      href: hrefFor(entity),
      year,
      kind: kindFor(entity, year),
      range,
      summary: shortSummary(entity.summary),
      search: [entity.title, entity.summary ?? '', ...(entity.tags ?? []), String(year), range].join(' ').toLowerCase(),
    }];
  }).sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
}
