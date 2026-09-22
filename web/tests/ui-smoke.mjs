import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:4321';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const visit = path => page.goto(new URL(path, base).href);

try {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await visit('/events/dark-alliance/');
    await page.evaluate(() => document.fonts.ready);
    const heading = await page.locator('.statement-band h1').evaluate(el => ({
      width: el.clientWidth, scroll: el.scrollWidth,
      words: [...el.querySelectorAll('.headline-word')].map(word => word.getClientRects().length),
      page: document.documentElement.scrollWidth, viewport: innerWidth,
    }));
    assert.equal(heading.page, heading.viewport);
    assert(heading.scroll <= heading.width + 1);
    assert(heading.words.every(rects => rects === 1));
    assert(!/present/i.test(await page.locator('.band-facts').innerText()));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await visit('/programs/promis/');
  const toc = page.locator('.toc-disclosure');
  assert.equal(await toc.getAttribute('open'), null);
  const [icon, count] = await Promise.all([
    toc.locator('.toc-toggle').boundingBox(), toc.locator('.toc-count').boundingBox(),
  ]);
  assert(Math.abs(icon.y + icon.height / 2 - count.y - count.height / 2) < 1);
  await toc.locator('summary').click();
  const target = await toc.locator('a').nth(1).getAttribute('href');
  await toc.locator('a').nth(1).click();
  assert(page.url().endsWith(target));
  assert.equal(await toc.getAttribute('open'), null);
  const links = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return {
      resolved: style('.prose a.wikilink:not(.unresolved)').backgroundColor,
      missing: style('.prose a.unresolved').backgroundColor,
      missingLine: style('.prose a.unresolved').borderBottomStyle,
    };
  });
  assert.equal(links.resolved, 'rgb(255, 232, 107)');
  assert.equal(links.missing, 'rgba(0, 0, 0, 0)');
  assert.equal(links.missingLine, 'solid');

  await page.locator('.path-widget').scrollIntoViewIfNeeded();
  assert((await page.locator('.pw-form').boundingBox()).height < 350);
  await page.locator('.pw-input').fill('Remote Viewing');
  await page.locator('.pw-suggest .path-suggest-item').first().waitFor();
  await page.locator('.pw-input').press('Enter');
  await page.locator('.pw-go').click();
  await page.locator('.pw-result .path-node').first().waitFor();
  assert.equal(await page.locator('.pw-result .pn-title').last().innerText(), 'Remote Viewing');
  await page.locator('.pw-input').fill('Central');
  assert(await page.locator('.pw-result').isHidden());

  await visit('/path/?from=promis');
  await page.waitForFunction(() => document.querySelector('#path-from').value === 'PROMIS');
  await page.locator('#path-to').fill('Remote Viewing');
  await page.locator('#path-to-suggest .path-suggest-item').first().waitFor();
  await page.locator('#path-to').press('Enter');
  await page.locator('.path-go').click();
  await page.locator('.path-result .path-node').first().waitFor();
  await page.locator('.path-swap').click();
  assert(await page.locator('.path-result').isHidden());
  await page.locator('.path-go').click();
  await page.locator('.path-result .path-node').first().waitFor();
  assert.equal(await page.locator('.path-result .pn-title').first().innerText(), 'Remote Viewing');

  await visit('/bridges/');
  for (const tab of ['hubs', 'bridges']) {
    await page.locator('#tab-' + tab).click();
    assert(await page.locator('#panel-' + tab + '-list').isVisible());
    assert.deepEqual(await page.locator('.br-tab').evaluateAll(tabs => tabs.map(t => t.hidden)), [false, false]);
  }
  const padding = await page.locator('header.site .bar').evaluate(el => getComputedStyle(el).paddingBottom);
  assert.equal(padding, '18px');

  await visit('/clusters/');
  assert(!/\d(?:people|concepts|organizations|programs|events|places)/i.test(await page.locator('.cluster-meta').first().innerText()));
  await page.locator('#nav-toggle').click();
  await page.locator('.search-trigger').click();
  const input = page.locator('.pagefind-ui__search-input');
  await input.fill('arms shipments');
  await page.locator('.pagefind-ui__result-link').first().waitFor();
  const clear = await page.locator('.pagefind-ui__search-clear').boundingBox();
  const inputBox = await input.boundingBox();
  assert(Math.abs(clear.y + clear.height / 2 - inputBox.y - inputBox.height / 2) < 1);
  await input.fill('zzqxnomatch nonexistentplatypuszzz');
  await page.getByText(/no results for/i).waitFor();
  await page.locator('.pagefind-ui__search-clear').click();
  assert.equal(await input.inputValue(), '');
  await page.locator('#pf-close').click();
  assert(!(await page.locator('main').evaluate(el => el.inert)));

  await visit('/network/');
  await page.locator('.net-canvas').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => /^\d/.test(document.querySelector('.net-stats').textContent));
  await page.locator('.net-search').fill('PROMIS');
  await page.locator('.net-search').press('Enter');
  assert.equal(await page.locator('.gs-title').innerText(), 'PROMIS');
  await page.locator('.gs-deselect').click();
  await page.locator('.graph-options summary').click();
  const panel = await page.locator('.graph-options-panel').boundingBox();
  assert(panel.x >= 0 && panel.x + panel.width <= 391);
  await page.keyboard.press('Escape');

  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  const staticPage = await nojs.newPage();
  await staticPage.goto(new URL('/programs/promis/', base).href);
  assert(await staticPage.locator('.toc-disclosure a').first().isVisible());
  await nojs.close();

  const failed = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const failedPage = await failed.newPage();
  await failedPage.route('**/search-index/pagefind-ui.js', route => route.abort());
  await failedPage.goto(base);
  await failedPage.locator('.search-trigger').click();
  assert(await failedPage.locator('#pf-error').isVisible());
  await failedPage.locator('#pf-close').click();
  await failed.close();

  assert.deepEqual(errors, []);
  console.log('UI smoke checks passed: responsive headings, TOC, links, paths, tabs, search, graph, and failure states.');
} finally {
  await browser.close();
}
