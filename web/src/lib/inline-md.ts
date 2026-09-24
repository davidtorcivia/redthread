// Inline markdown for entry summaries. Kept free of Node imports because the
// hover-preview script in Base.astro ships it to the browser.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Only schemes that cannot run script: http(s), mailto, or site-relative paths. */
function isSafeUrl(url: string): boolean {
  const u = url.replace(/\s+/g, ''); // defeats `java\tscript:`
  if (/^(https?:|mailto:)/i.test(u) || /^[/#?]/.test(u)) return true;
  return /^[a-z0-9._-]+(\/|$)/i.test(u) && !/^[a-z][a-z0-9+.-]*:/i.test(u);
}

/** Bold, italic, code, links and [[wikilinks]] (as plain text) to HTML.
 *  Input is escaped first, so the result is safe for set:html / innerHTML. */
export function renderInlineMd(s: string | null | undefined): string {
  return escapeHtml(s)
    .replace(/\[\[([^|\]]+?)\|([^\]]+?)\]\]/g, '$2')
    .replace(/\[\[([^\]]+?)\]\]/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, (_m, text: string, url: string) =>
      isSafeUrl(url) ? `<a href="${url.replace(/"/g, '%22')}">${text}</a>` : text);
}

/** Inline markdown reduced to plain text, for feeds, cards and search data. */
export function plainText(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!)
    .replace(/\s+/g, ' ')
    .trim();
}
