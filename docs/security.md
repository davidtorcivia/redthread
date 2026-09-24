# Security

## What gets served

The site is static files behind nginx. There's no server code, database, or login.

`deploy/nginx.conf` sends these headers on every response:

- A Content-Security-Policy that allows only same-origin scripts, plus your analytics origin. JavaScript `eval` stays blocked, and `wasm-unsafe-eval` lets the search index run.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, a strict referrer policy, and a permissions policy that turns off location, camera, and microphone.

The port binds to `127.0.0.1`, so only your proxy or tunnel can reach it.

## Your notes

Raw HTML in notes is escaped, not rendered. Everything in your vault outside `skipPathPatterns` gets published, including frontmatter in the markdown copies, so keep private notes in a skipped folder.

## Dependencies

- Python packages are pinned to exact versions in `build/requirements.txt`.
- npm packages install with `npm ci` from the committed lockfile.
- Renovate waits until a release has been public for 7 days (14 for Astro) before proposing it. Security fixes skip the wait.

## Reporting a problem

Open an issue at https://github.com/davidtorcivia/redthread/issues. For anything sensitive, use GitHub's private vulnerability reporting on the repository.
