// Theme must be set before first paint, survive toggling and navigation, and work
// with storage blocked or behind a CDN script rewriter (e.g. Cloudflare Rocket Loader).
// BASE_URL=http://127.0.0.1:4321 node tests/theme-flash.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://127.0.0.1:4321';
const KEY = 'iw-theme';
const canvas = theme => theme === 'dark' ? 'rgb(14, 14, 14)' : 'rgb(255, 255, 255)';
const browser = await chromium.launch({ headless: true });

try {
  // Before any stylesheet arrives: the inline initializer alone sets theme and canvas.
  for (const scenario of [
    { saved: 'dark', system: 'light', expected: 'dark' },
    { saved: 'light', system: 'dark', expected: 'light' },
    { system: 'dark', expected: 'dark' },
    { system: 'dark', blocked: true, expected: 'dark' },
  ]) {
    const context = await browser.newContext({ colorScheme: scenario.system });
    await context.addInitScript(({ saved, blocked, KEY }) => {
      if (blocked) {
        for (const method of ['getItem', 'setItem']) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (key, ...rest) {
            if (key === KEY) throw new Error('Storage blocked');
            return original.call(this, key, ...rest);
          };
        }
      } else if (saved && !localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, saved);
      }
    }, { ...scenario, KEY });
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
    assert.equal(early.background, canvas(scenario.expected));
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

  // Every rendered frame carries the saved theme, even when the CDN's deferred loader never arrives.
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await context.addInitScript(({ theme, KEY }) => {
      localStorage.setItem(KEY, theme);
      window.themeFrames = [];
      const sample = () => {
        if (document.body) {
          window.themeFrames.push({
            theme: document.documentElement.dataset.theme,
            background: getComputedStyle(document.documentElement).backgroundColor,
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { theme, KEY });
    const page = await context.newPage();
    await page.route('**/*rocket-loader*', route => route.abort());
    for (const path of ['/', '/people/', '/clusters/']) {
      const response = await page.goto(base + path, { waitUntil: 'load' });
      assert.equal(response.status(), 200);
      await page.locator('h1').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const frames = await page.evaluate(() => window.themeFrames);
      assert(frames.length > 0, 'Recorded rendered frames');
      for (const frame of frames) {
        assert.equal(frame.theme, theme, 'Theme must precede first rendered frame on ' + path);
        assert.equal(frame.background, canvas(theme));
      }
      const script = await page.locator('head script').first().evaluate(s => ({
        exempt: s.getAttribute('data-cfasync'), type: s.getAttribute('type'),
      }));
      assert.equal(script.exempt, 'false');
      assert(!script.type || script.type === 'text/javascript', 'CDN must not rewrite the initializer');
      console.log('Passed first-frame theme:', theme, path, frames.length, 'frames');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
