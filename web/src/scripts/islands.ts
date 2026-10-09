// The Clusters layout shared by /network/ and the entity graph: each group in its
// own disc, packed outward from the first, with its community's name beside it.
import type { GraphEngine, GraphNode } from './graph-canvas';

export interface Island {
  members: GraphNode[];
  /** Shown beside the island: a community label ("Lead · Second · Third") or a plain name. */
  label?: string;
}

export interface IslandSpacing {
  /** Island radius = sqrt(members) * per + base, in layout units. */
  per: number;
  base: number;
  /** Margin between the island's edge and its outermost dots. */
  inset: number;
  /** Clear space between islands. */
  gap: number;
}

/** Place islands in the given order, the first at the origin and each next one as
 *  close to the centre as the canvas aspect allows. Inside an island of a single
 *  community, the parser's weighted positions (`positions[node.g]`) put entries that
 *  cite each other side by side, re-centred and rescaled for whichever members are
 *  present; mixed islands get a sunflower spiral, most-mentioned at the centre. */
export function layoutIslands(
  g: GraphEngine, islands: Island[], spacing: IslandSpacing, positions?: [number, number][] | null,
): void {
  const placed: { x: number; y: number; radius: number }[] = [];
  const { W, H } = g.canvasSize();
  const aspect = Math.max(.7, Math.min(2.1, W / H));
  for (const { members, label } of islands) {
    const radius = Math.sqrt(members.length) * spacing.per + spacing.base;
    let best = { x: 0, y: 0, score: placed.length ? Infinity : 0 };
    for (const other of placed) {
      for (let step = 0; step < 96; step++) {
        const angle = step / 96 * Math.PI * 2;
        const x = other.x + Math.cos(angle) * (radius + other.radius + spacing.gap);
        const y = other.y + Math.sin(angle) * (radius + other.radius + spacing.gap);
        if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.radius + radius + spacing.gap - 5)) continue;
        const score = (x * x) / (aspect * aspect) + y * y;
        if (score < best.score) best = { x, y, score };
      }
    }
    placed.push({ x: best.x, y: best.y, radius });
    const inner = radius - spacing.inset;
    const c = members[0].community;
    if (positions && c >= 0 && members.every((n) => n.community === c && n.g !== undefined)) {
      let cx = 0, cy = 0, max = 0;
      for (const n of members) { cx += positions[n.g!][0]; cy += positions[n.g!][1]; }
      cx /= members.length;
      cy /= members.length;
      for (const n of members) max = Math.max(max, Math.hypot(positions[n.g!][0] - cx, positions[n.g!][1] - cy));
      for (const n of members) {
        n.x = best.x + (positions[n.g!][0] - cx) / (max || 1) * inner;
        n.y = best.y + (positions[n.g!][1] - cy) / (max || 1) * inner;
      }
    } else {
      members.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
      members.forEach((n, i) => {
        const angle = i * 2.399963229728653;
        const distance = Math.sqrt(i / Math.max(1, members.length - 1)) * inner;
        n.x = best.x + Math.cos(angle) * distance;
        n.y = best.y + Math.sin(angle) * distance;
      });
    }
    // The name hugs the dots, not the island's nominal radius.
    let extent = 0;
    for (const n of members) extent = Math.max(extent, Math.hypot(n.x - best.x, n.y - best.y));
    if (label) g.annotations.push({ x: best.x, y: best.y, r: extent + 8, text: label });
  }
}
