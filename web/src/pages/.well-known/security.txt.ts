// RFC 9116 security contact, from the footer's contact settings. Expires is required; builds
// run on every vault change, so six months from the build keeps it current while the site is.
import type { APIRoute } from 'astro';
import { absUrl, CONTACT_EMAIL, CONTACT_PGP } from '../../lib/site.ts';

const EXPIRES_DAYS = 180;

export const GET: APIRoute = () => new Response(
  CONTACT_EMAIL
    ? [
      `Contact: mailto:${CONTACT_EMAIL}`,
      `Expires: ${new Date(Date.now() + EXPIRES_DAYS * 864e5).toISOString().replace(/\.\d+Z$/, 'Z')}`,
      ...(CONTACT_PGP ? [`Encryption: https://keys.openpgp.org/vks/v1/by-fingerprint/${CONTACT_PGP}`] : []),
      'Preferred-Languages: en',
      `Canonical: ${absUrl('/.well-known/security.txt')}`,
      '',
    ].join('\n')
    : '# No security contact is configured (CONTACT_EMAIL).\n',
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
