// Ranking neighbours in the graphs (NetworkGraph.astro, pages/network.astro).

/** How close a neighbour j is to entry i, from the connections they share: shared
 *  over j's degree to a power that grows with i's degree (0.5 up to degree 100, 1 at
 *  1,000). A plain sqrt suits most entries, but for a hub like the CIA every other
 *  hub shares hundreds of links; the steeper discount surfaces William Harvey and
 *  the Office of Technical Service instead. Below 3 shared links, shared count only. */
export function closeness(shared: number, degreeJ: number, degreeI: number): number {
  const power = 0.5 + 0.5 * Math.min(1, Math.max(0, Math.log10(degreeI) - 2));
  return (shared >= 3 ? shared / degreeJ ** power : 0) + shared * 1e-6;
}
