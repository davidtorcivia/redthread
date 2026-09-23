// Exercises the public CDN, including Rocket Loader's HTML rewriting.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.QA_BASE || 'https://theinfoweb.disinfo.zone';
const browser = await chromium.launch({headless:true});
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({colorScheme: theme === 'dark' ? 'light' : 'dark'});
    await context.addInitScript(theme => {
      localStorage.setItem('iw-theme', theme);
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
    }, theme);
    const page = await context.newPage();
    // The theme must work even if the CDN's deferred-script loader never arrives.
    await page.route('**/*rocket-loader*', route => route.abort());
    for (const path of ['/', '/people/', '/clusters/']) {
      const response = await page.goto(base + path, {waitUntil:'load'});
      assert.equal(response.status(), 200);
      await page.locator('h1').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const frames = await page.evaluate(() => window.themeFrames);
      assert(frames.length > 0, 'Recorded rendered frames');
      for (const frame of frames) {
        assert.equal(frame.theme, theme, 'Theme must precede first rendered frame on ' + path);
        assert.equal(frame.background, theme === 'dark' ? 'rgb(14, 14, 14)' : 'rgb(255, 255, 255)');
      }
      const script = await page.locator('head script').first().evaluate(s => ({
        exempt: s.getAttribute('data-cfasync'), type: s.getAttribute('type'),
      }));
      assert.equal(script.exempt, 'false');
      assert(!script.type || script.type === 'text/javascript', 'CDN must not rewrite the initializer');
      console.log('Passed public first-frame theme:', theme, path, frames.length, 'frames');
    }
    await context.close();
  }
} finally { await browser.close(); }
