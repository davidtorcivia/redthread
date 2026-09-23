import type { APIRoute } from 'astro';
import { sourceSummaries } from '../lib/source-index.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(sourceSummaries()), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
