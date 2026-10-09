// Graph frame-time benchmark against a built site: BASE_URL=http://127.0.0.1:4321 npm run test:graph
// Pans /network/ and two entry graphs at normal speed and with the CPU slowed 4x (a phone),
// printing the median and p90 frame time and any long tasks while the graph loaded.
// Entries are picked from /adjacency.json, so it runs against any vault.
import { chromium } from 'playwright';
import { entityHref } from '../src/scripts/entity-types.ts';

const base = process.env.BASE_URL || 'http://127.0.0.1:4321';
const graph = await (await fetch(new URL('/adjacency.json', base))).json();
const people = graph.ids.map((_, i) => i).filter((i) => graph.types[i] === 'person')
  .sort((a, b) => graph.mentions[b] - graph.mentions[a]);
const href = (i) => entityHref(graph.types[i], graph.ids[i]);

const browser = await chromium.launch();
async function probe(path, sel, cpu, twoHop = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration))))
      .observe({ type: 'longtask', buffered: true });
  });
  await page.goto(new URL(path, base).href);
  await page.locator(sel).scrollIntoViewIfNeeded();
  // The caption reads "Loading connections…" until the graph is drawn, then starts with a count.
  await page.waitForFunction((s) => /^\d/.test(document.querySelector(s + ' .net-stats')?.textContent ?? ''), sel, { timeout: 60000 });
  // The button sits in the closed Options panel, so click it from the page.
  if (twoHop) await page.locator(sel + ' .net-twohop').dispatchEvent('click');
  await page.waitForTimeout(600);
  const longTasks = await page.evaluate(() => window.__long.filter((x) => x > 50));
  const frames = await page.evaluate(async (s) => {
    const c = document.querySelector(s + ' .net-canvas');
    const r = c.getBoundingClientRect();
    const fire = (type, x, y, target = c) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    const times = [];
    let last = performance.now();
    fire('mousedown', r.left + 300, r.top + 200);
    for (let i = 0; i < 40; i++) {
      fire('mousemove', r.left + 300 + i * 5, r.top + 200 + i * 2);
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    fire('mouseup', r.left + 500, r.top + 280, window);
    times.sort((a, b) => a - b);
    return { median: Math.round(times[20]), p90: Math.round(times[36]) };
  }, sel);
  console.log(`${path}${twoHop ? ' (2-hop)' : ''} cpu x${cpu}: pan ${frames.median} ms median, ${frames.p90} ms p90; long tasks ${JSON.stringify(longTasks)}`);
  await ctx.close();
}
for (const cpu of [1, 4]) {
  await probe('/network/', '.network-article', cpu);
  await probe(href(people[10]), '.entity-network', cpu);
  await probe(href(people[0]), '.entity-network', cpu, true);
}
await browser.close();
