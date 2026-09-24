// Site identity and build settings, read from the environment (see .env.example).
const env = process.env;

export const SITE_URL = env.SITE_URL || 'http://localhost:8080';
export const SITE_TITLE = env.SITE_TITLE || 'Redthread';
export const SITE_DESCRIPTION = env.SITE_DESCRIPTION || 'A linked archive of people, organizations, programs, and events.';
if (!/^https?:\/\/[^/]+\/?$/.test(SITE_URL)) {
  throw new Error(`SITE_URL must be an origin like https://example.com, got "${SITE_URL}"`);
}
export const SITE_HOST = new URL(SITE_URL).host;

export const ANALYTICS = env.ANALYTICS_SRC && env.ANALYTICS_ID
  ? { src: env.ANALYTICS_SRC, id: env.ANALYTICS_ID, attr: env.ANALYTICS_ID_ATTR || 'data-website-id' }
  : null;

/** Cache-busting version for the shared JSON payloads, computed by build.sh. */
export const BUILD_ID = env.PUBLIC_BUILD_ID || 'dev';

export const pageTitle = (title: string) => title === SITE_TITLE ? title : `${title} | ${SITE_TITLE}`;

/** Crawlers and feed readers need absolute URLs. */
export const absUrl = (path: string) => new URL(path, SITE_URL).href;

/** schema.org CollectionPage for a browse page listing `count` entries. */
export function collectionPage(name: string, description: string, path: string, count: number) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: pageTitle(name),
    description,
    url: absUrl(path),
    isPartOf: { '@id': `${absUrl('/')}#website` },
    mainEntity: { '@type': 'ItemList', numberOfItems: count },
  };
}
