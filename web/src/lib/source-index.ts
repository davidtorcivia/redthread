import { createHash } from 'node:crypto';
import { entities, hrefFor } from './data.ts';
import type { Entity } from './types.ts';

export interface SourceUse {
  title: string;
  type: string;
  href: string;
  notes: { id: string; text: string }[];
}

export interface SourceRecord {
  id: string;
  title: string;
  citation: string;
  urls: string[];
  domain: string;
  pageCount: number;
  noteCount: number;
  search: string;
  uses: SourceUse[];
}

export type SourceSummary = Omit<SourceRecord, 'uses'>;

function urlsIn(html: string, text: string): string[] {
  const links = [...html.matchAll(/<a\b[^>]*\bhref=(['"])(.*?)\1/gi)].map((match) => match[2].replace(/&amp;/g, '&'));
  const candidates = links.length ? links : text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(candidates.map((candidate) => candidate.replace(/[.,;\])}]+$/, '')).filter((candidate) => {
    try { return ['http:', 'https:'].includes(new URL(candidate).protocol); } catch { return false; }
  }))];
}

function urlKey(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function citationText(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.()-]+$/, '')
    .trim();
}

function titleFor(raw: string, citation: string): string {
  const quoted = raw.match(/[“"]([^”"]{8,180})[”"]/);
  const italic = raw.match(/\*([^*]{8,180})\*/);
  const title = quoted?.[1] ?? italic?.[1];
  return (title ?? citation).replace(/[\s,;.]+$/, '').trim().slice(0, 180) || 'Untitled reference';
}

function textKey(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildSourceIndex(input: Entity[]): SourceRecord[] {
  const grouped = new Map<string, { title: string; citation: string; urls: string[]; uses: Map<string, SourceUse>; noteCount: number }>();
  for (const entity of input) {
    for (const note of entity.footnotes ?? []) {
      if (!note.text?.trim()) continue;
      const urls = urlsIn(note.html ?? '', note.text);
      // One URL identifies a work. A note citing several works stays one
      // composite citation, so none of those URLs inherits unrelated claims.
      const key = urls.length === 1 ? `url:${urlKey(urls[0])}` : `text:${textKey(note.text)}`;
      const citation = citationText(note.text) || urls[0] || 'Untitled reference';
      let group = grouped.get(key);
      if (!group) {
        group = { title: titleFor(note.text, citation), citation, urls, uses: new Map(), noteCount: 0 };
        grouped.set(key, group);
      }
      group.noteCount++;
      const use = group.uses.get(entity.id) ?? {
        title: entity.title,
        type: entity.type,
        href: hrefFor(entity),
        notes: [],
      };
      use.notes.push({ id: note.id, text: note.text });
      group.uses.set(entity.id, use);
    }
  }

  const ids = new Map<string, string>();
  return [...grouped].map(([key, group]) => {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
    if (ids.has(id) && ids.get(id) !== key) throw new Error(`Source ID collision: ${id}`);
    ids.set(id, key);
    const uses = [...group.uses.values()].sort((a, b) => a.title.localeCompare(b.title));
    let domain = '';
    if (group.urls.length === 1) domain = new URL(group.urls[0]).hostname.replace(/^www\./, '');
    const search = [group.title, group.citation, ...group.urls, ...uses.map((use) => use.title)].join(' ').toLowerCase();
    return { id, title: group.title, citation: group.citation, urls: group.urls, domain,
      pageCount: uses.length, noteCount: group.noteCount, search, uses };
  }).sort((a, b) => b.pageCount - a.pageCount || b.noteCount - a.noteCount || a.title.localeCompare(b.title));
}

let cache: SourceRecord[] | null = null;
export function sourceRecords(): SourceRecord[] {
  if (!cache) cache = buildSourceIndex(entities());
  return cache;
}

export function sourceSummaries(): SourceSummary[] {
  return sourceRecords().map(({ uses: _uses, ...summary }) => summary);
}
