// Agent Skills Discovery index (RFC v0.2.0).
import type { APIRoute } from 'astro';
import { skillIndex } from '../../../lib/agent-skill.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(skillIndex(), null, 2), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
