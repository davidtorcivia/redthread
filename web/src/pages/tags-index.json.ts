import type { APIRoute } from 'astro';
import { tagDirectoryRows } from '../lib/tag-directory.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(tagDirectoryRows()), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
