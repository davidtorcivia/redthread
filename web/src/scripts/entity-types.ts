/** Client-side copies of lib/data.ts's type tables (lib/ reads the vault
 *  at build time, so browser code can't import it), plus a DOM helper. */
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

/** createElement with a class and text. Vault strings go in as text, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
