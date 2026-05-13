import { defineConfig } from 'astro/config';

// `site` powers canonical URLs, Open Graph og:url, the sitemap, and the
// Sitemap: line in robots.txt. Override per-environment via SITE_URL
// when you deploy somewhere real:
//   SITE_URL=https://yourdomain.com npm run build
const siteUrl = process.env.SITE_URL || 'http://localhost:8080';

export default defineConfig({
  site: siteUrl,
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  server: { port: 4321 },
});
