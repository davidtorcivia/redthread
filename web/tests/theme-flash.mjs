// Run against a built preview: QA_BASE=http://127.0.0.1:4736 node tests/theme-flash.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.QA_BASE || 'http://127.0.0.1:8200';
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of [
    { saved: 'dark', system: 'light', expected: 'dark' },
    { saved: 'light', system: 'dark', expected: 'light' },
    { system: 'dark', expected: 'dark' },
    { system: 'dark', blocked: true, expected: 'dark' },
  ]) {
    const context = await browser.newContext({ colorScheme: scenario.system });
    await context.addInitScript(({ saved, blocked }) => {
      if (blocked) {
        const getItem = Storage.prototype.getItem;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.getItem = function(key) {
          if (key === 'iw-theme') throw new Error('Storage blocked');
          return getItem.call(this, key);
        };
        Storage.prototype.setItem = function(key, value) {
          if (key === 'iw-theme') throw new Error('Storage blocked');
          return setItem.call(this, key, value);
        };
      } else if (saved && !localStorage.getItem('iw-theme')) {
        localStorage.setItem('iw-theme', saved);
      }
    }, scenario);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/*.css', async route => { await gate; await route.continue(); });
    await page.goto(base + '/', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.theme && document.querySelector('style'));
    const early = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.documentElement).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    assert.equal(early.theme, scenario.expected);
    assert.equal(early.background, scenario.expected === 'dark' ? 'rgb(14, 14, 14)' : 'rgb(255, 255, 255)');
    assert.equal(early.scheme, scenario.expected);
    release();
    await page.waitForLoadState('networkidle');
    const button = page.locator('[data-theme-toggle]');
    const target = scenario.expected === 'dark' ? 'light' : 'dark';
    await page.getByRole('button', { name: 'Switch to ' + target + ' theme', exact: true }).waitFor();
    assert.equal(await button.locator(scenario.expected === 'dark' ? '.theme-icon-sun' : '.theme-icon-moon').isVisible(), true);
    await button.click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), target);
    assert.equal(await button.getAttribute('aria-label'), 'Switch to ' + scenario.expected + ' theme');
    assert.equal(await button.locator(target === 'dark' ? '.theme-icon-sun' : '.theme-icon-moon').isVisible(), true);
    if (!scenario.blocked) {
      await page.goto(base + '/people/');
      assert.equal(await page.locator('html').getAttribute('data-theme'), target);
    }
    assert.deepEqual(errors, []);
    console.log('Passed:', JSON.stringify(scenario), 'before CSS, toggle, and navigation');
    await context.close();
  }
} finally {
  await browser.close();
}
