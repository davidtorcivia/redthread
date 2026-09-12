/** Entity type → URL directory and display label. One copy for every
 *  client script; lib/data.ts carries the build-time equivalent. */
export const TYPE_DIRS: Record<string, string> = {
  person: 'people', organization: 'organizations', program: 'programs',
  event: 'events', concept: 'concepts', place: 'places',
  source: 'sources', meta: 'meta', misc: 'misc', page: 'pages',
};
export const TYPE_LABELS: Record<string, string> = {
  person: 'Person', organization: 'Organization', program: 'Program',
  event: 'Event', concept: 'Concept', place: 'Place',
  source: 'Source', meta: 'Meta', misc: 'Misc', page: 'Page',
};
export function entityHref(type: string, id: string): string {
  return `/${TYPE_DIRS[type] || 'pages'}/${id}/`;
}
