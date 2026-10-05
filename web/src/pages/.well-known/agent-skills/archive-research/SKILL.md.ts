// The skill the index lists; its bytes must match the index's digest.
import type { APIRoute } from 'astro';
import { skillMarkdown } from '../../../../lib/agent-skill.ts';

export const GET: APIRoute = () => new Response(skillMarkdown(), {
  headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
});
