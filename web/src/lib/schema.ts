// schema.org JSON-LD for an entry page: a WebPage (ProfilePage for people and
// organizations) whose mainEntity is the entry itself. Each property sits on the
// node whose schema.org type defines it, so validators accept the graph.
import { aliasesOf, hrefFor, TYPE_DIRS } from './data.ts';
import { absUrl, pageTitle } from './site.ts';
import type { Entity } from './types.ts';

const SCHEMA_TYPE: Record<string, string> = {
  person: 'Person',
  organization: 'Organization',
  event: 'Event',
  place: 'Place',
  program: 'CreativeWork',
  concept: 'Thing',
  source: 'CreativeWork',
};

/** Frontmatter dates like "c. 1950" or "~1950" are not ISO 8601 and fail validation. */
const iso = (s?: string) => (s && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s) ? s : undefined);

const one = <T>(xs: T[]) => (xs.length === 0 ? undefined : xs.length === 1 ? xs[0] : xs);

export function entityJsonLd(entity: Entity) {
  const url = absUrl(hrefFor(entity));
  const type = SCHEMA_TYPE[entity.type] ?? 'Thing';
  const fm = entity.frontmatter;
  const d = entity.dates ?? {};
  const start = iso(d.start ?? d.date);
  const end = iso(d.end);
  const places = (entity.locations ?? []).map((name) => ({ '@type': 'Place', name }));
  const aliases = aliasesOf(entity).filter((a) => a.toLowerCase() !== entity.title.toLowerCase());

  const thing: Record<string, unknown> = {
    '@type': type,
    '@id': `${url}#entity`,
    name: entity.title,
    url,
    description: entity.summary ?? undefined,
    alternateName: one(aliases),
  };
  if (type === 'Person') {
    thing.birthDate = iso(d.born);
    thing.deathDate = iso(d.died);
  } else if (type === 'Organization') {
    thing.foundingDate = start;
    thing.dissolutionDate = end;
    thing.location = one(places);
  } else if (type === 'Event') {
    thing.startDate = start;
    thing.endDate = end;
    thing.location = one(places);
  } else if (entity.type === 'program' && start) {
    thing.temporalCoverage = `${start}/${end ?? '..'}`;
  } else if (entity.type === 'source') {
    thing.datePublished = start;
  }

  const profile = type === 'Person' || type === 'Organization';
  const created = typeof fm.created === 'string' && fm.created ? fm.created : undefined;
  const page: Record<string, unknown> = {
    '@type': profile ? 'ProfilePage' : 'WebPage',
    '@id': url,
    url,
    name: pageTitle(entity.title),
    description: entity.summary ?? undefined,
    inLanguage: 'en-US',
    isPartOf: { '@id': `${absUrl('/')}#website` },
    breadcrumb: { '@id': `${url}#breadcrumb` },
    mainEntity: { '@id': thing['@id'] },
    image: absUrl(`/og/${TYPE_DIRS[entity.type]}/${entity.id}.png`),
    // Google reads dateCreated on ProfilePage and datePublished on other pages.
    [profile ? 'dateCreated' : 'datePublished']: created,
    dateModified: (typeof fm.updated === 'string' && fm.updated) || entity.mtime || undefined,
    keywords: entity.tags?.length ? entity.tags.map(String).join(', ') : undefined,
    contentLocation: one(places),
  };

  return { '@context': 'https://schema.org', '@graph': [page, thing] };
}
