# Configuration

Redthread reads two files in the repo root. Both are gitignored.

- `.env` holds site settings. Start from `.env.example`.
- `config.json` describes your vault. Start from `config.example.json`.

## Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | required | Path to your vault. |
| `SITE_URL` | `http://localhost:8080` | Public origin, such as `https://example.com` (no path). Used for canonical links, social cards, the sitemap, and the feed. |
| `SITE_TITLE` | `Redthread` | Site name in the header, page titles, and social cards. |
| `SITE_DESCRIPTION` | generic | One or two sentences for the homepage, search engines, and `llms.txt`. |
| `PORT` | `8080` | Local port for nginx. It binds to `127.0.0.1` only. |
| `ANALYTICS_SRC` | off | Analytics script URL, such as Umami or Plausible. |
| `ANALYTICS_ID` | off | Site ID for the analytics script. |
| `ANALYTICS_ID_ATTR` | `data-website-id` | Attribute that carries the ID. Use `data-domain` for Plausible. |
| `ANALYTICS_ORIGIN` | empty | Origin of the analytics script, such as `https://umami.example.com`. It's added to the Content-Security-Policy. |
| `VAULT_PULL` | `0` | Set to `1` to run `git pull --ff-only` in the vault before each rebuild check. |
| `REBUILD_INTERVAL` | `300` | Seconds between checks in watch mode. |
| `HEALTHCHECK_URL` | off | A [healthchecks.io](https://healthchecks.io) style URL. It gets pinged after every check, and `/fail` is pinged when a build fails. |

## Vault (`config.json`)

```json
{
  "typeMap": {
    "10 - People": "person",
    "20 - Organizations": "organization"
  },
  "skipPathPatterns": ["Templates/**"],
  "focusFile": "00 - Meta/In Focus.md",
  "clusterResolution": 1.5
}
```

| Key | Purpose |
|---|---|
| `typeMap` | Maps each top-level folder to an entry type. Notes in unmapped folders become plain pages. |
| `skipPathPatterns` | Glob patterns for notes to leave out. They add to the built-in skips for `.obsidian/`, `.trash/`, and `.git/`. |
| `focusFile` | Optional note whose `[[links]]` are pinned to the homepage's "In focus" list. Other slots go to the most active entries of the last 30 days. |
| `clusterResolution` | Cluster granularity. Higher values give more, smaller clusters. |
| `clusterExcludeTypes` | Types that join a neighbor's cluster instead of forming their own. Defaults to place, meta, source, misc, and page. |

Every key is optional. With no `config.json` at all (outside Docker), Redthread maps folders named `People`, `Organizations`, `Programs`, `Events`, `Concepts`, `Places`, `Sources`, `Meta`, and `Misc`.

### Entry types

Each type has its own section of the site:

| Type | URL |
|---|---|
| `person` | `/people/` |
| `organization` | `/organizations/` |
| `program` | `/programs/` |
| `event` | `/events/` |
| `concept` | `/concepts/` |
| `place` | `/places/` |
| `source` | `/sources/` |
| `meta` | `/meta/` |
| `misc` | `/misc/` |
| unmapped | `/pages/` |

## Writing notes

Plain Obsidian markdown works. Link with `[[Note title]]` or `[[Note title|label]]`, and cite with footnotes (`[^1]`). A link resolves by title first, then by alias.

Redthread also reads these frontmatter fields when they're present:

```yaml
aliases: [CIA, The Agency]      # other names links can use
summary: "One or two sentences." # shown in previews, cards, and search
category: "Intelligence"         # short label under the title
tags: [Cold War]
born: 1893-04-07                 # dates: born, died, start, end, date
died: 1969-01-29
location: "Washington, D.C."     # a string or a list
relations:                       # typed links, shown on both pages
  - type: director_of
    with: "[[Central Intelligence Agency]]"
    start: 1953
    end: 1961
    role: "Director"             # optional
    fn: 2                        # optional footnote number as the source
```

Relation types: `employed_by`, `member_of`, `director_of`, `head_of`, `founded`, `owned`, `funded`, `contractor_to`, `represented`, `appointed`, `reported_to`, `investigated`, `prosecuted`, `participant_in`, `subject_of`, `informant_for`, `partner_of`, `relative_of`, `spouse_of`. Add `reverse: true` when the linked note is the subject.

If your vault is a git repository, the homepage's "In focus" list uses its commit history. The changelog uses file modification times.
