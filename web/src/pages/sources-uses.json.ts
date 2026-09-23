import type { APIRoute } from 'astro';
import { sourceRecords } from '../lib/source-index.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(Object.fromEntries(
  sourceRecords().map(({ id, uses }) => [id, uses]),
)), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
