import type { APIRoute } from 'astro';
import { timelineRecords } from '../lib/timeline.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(timelineRecords()), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
