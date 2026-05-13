#!/usr/bin/env python3
"""
Vault parser: walks an Obsidian vault, parses every .md file, and emits
JSON indices consumed by the Astro frontend.

Outputs (to <out>/):
  entities.json    — list of entity records keyed by id (slug)
  slug_index.json  — title/alias → entity_id, for link resolution
  links.json       — directed edges with surrounding context
  stats.json       — build stats and anomaly report
  corpus.jsonl     — one record per entity, used for search indexing
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fnmatch
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def _json_default(o: Any) -> Any:
    if isinstance(o, (_dt.date, _dt.datetime)):
        return o.isoformat()
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def _dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, default=_json_default)

import frontmatter
from markdown_it import MarkdownIt


# ---------- config ----------

DEFAULT_CONFIG = {
    "vaultPath": "..",
    "skipPathPatterns": [
        "DATAVIEW - *.md",
        "MOC - *.md",
        "KEY *.md",
        "TEMP/**",
        ".obsidian/**",
        "IMAGES/**",
        "_web/**",
    ],
    "typeMap": {
        "10 - PEOPLE": "person",
        "20 - ORGANIZATIONS": "organization",
        "30 - PROGRAMS & PROJECTS": "program",
        "40 - EVENTS": "event",
        "50 - CONCEPTS & TECHNOLOGY": "concept",
        "60 - PLACES": "place",
        "80 - SOURCES": "source",
        "00 - META": "meta",
        "90 - MISC": "misc",
    },
}


# ---------- regex ----------

# [[Target]] or [[Target|Display]] — disallow ] and | inside target,
# disallow ] inside display
WIKILINK = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]")

# Image embeds ![[...]] — skip these for now (Phase 0 doesn't render media)
EMBED = re.compile(r"!\[\[([^\]]+?)\]\]")

# Footnote definition: [^id]: text   (must be at start of line)
FOOTNOTE_DEF = re.compile(r"^\[\^([^\]]+?)\]:\s*(.+?)$", re.MULTILINE)


# ---------- helpers ----------

# Mojibake repair: some vault files contain double-encoded UTF-8 (e.g. 'Ã±'
# where 'ñ' was intended). The pattern is U+00C2/U+00C3 followed by a byte
# in 0x80-0xBF. Only fix when the pattern is found AND the recovery round-trips.
MOJIBAKE_RE = re.compile(r'[ÂÃâ][-¿]')


def fix_mojibake(s: str) -> tuple[str, bool]:
    """Return (fixed_text, was_fixed). Conservative: only changes when detected."""
    if not s or not MOJIBAKE_RE.search(s):
        return s, False
    try:
        recovered = s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s, False
    return recovered, recovered != s


def fix_mojibake_in_value(v: Any) -> tuple[Any, int]:
    """Recursively fix string values in dicts/lists. Returns (value, fix_count)."""
    if isinstance(v, str):
        fixed, did = fix_mojibake(v)
        return fixed, 1 if did else 0
    if isinstance(v, list):
        out, n = [], 0
        for item in v:
            x, k = fix_mojibake_in_value(item)
            out.append(x); n += k
        return out, n
    if isinstance(v, dict):
        out, n = {}, 0
        for k, val in v.items():
            x, m = fix_mojibake_in_value(val)
            out[k] = x; n += m
        return out, n
    return v, 0


def slugify(text: str) -> str:
    """Filename → URL slug. lowercase, spaces→hyphens, drop non-alphanum."""
    s = text.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)   # drop punctuation
    s = re.sub(r"[\s_]+", "-", s)    # spaces/underscores → hyphen
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "untitled"


def should_skip(rel_path: Path, patterns: list[str]) -> bool:
    posix = rel_path.as_posix()
    name = rel_path.name
    for pat in patterns:
        if "/" in pat:
            if fnmatch.fnmatch(posix, pat):
                return True
        else:
            if fnmatch.fnmatch(name, pat):
                return True
    return False


def infer_type(rel_path: Path, type_map: dict[str, str]) -> str:
    top = rel_path.parts[0] if rel_path.parts else ""
    return type_map.get(top, "page")


def extract_wikilinks(body: str) -> list[dict[str, str]]:
    """Return [{target, display}, ...] for every [[...]] in body."""
    # Strip embeds first so we don't double-count them
    cleaned = EMBED.sub("", body)
    links: list[dict[str, str]] = []
    for m in WIKILINK.finditer(cleaned):
        target = m.group(1).strip()
        display = (m.group(2) or "").strip() or target
        # Targets may include section anchors: [[Page#section]]
        section = ""
        if "#" in target:
            target, section = target.split("#", 1)
            target = target.strip()
            section = section.strip()
        links.append({"target": target, "display": display, "section": section})
    return links


def extract_footnotes(body: str) -> tuple[list[dict[str, str]], str]:
    """Pull footnote definitions out of body, return (notes, body_without_defs)."""
    notes: list[dict[str, str]] = []
    for m in FOOTNOTE_DEF.finditer(body):
        notes.append({"id": m.group(1).strip(), "text": m.group(2).strip()})
    body_clean = FOOTNOTE_DEF.sub("", body).rstrip()
    # Drop a trailing "### Footnotes" header if all defs were pulled out
    body_clean = re.sub(r"#+\s*Footnotes\s*$", "", body_clean, flags=re.MULTILINE).rstrip()
    return notes, body_clean


def normalize_target(target: str) -> str:
    """Match keys are case-insensitive and ignore extra whitespace."""
    return re.sub(r"\s+", " ", target).strip().lower()


_MOJIBAKE_FIXES: dict[str, Any] = {}


# ---------- core parse ----------

# --------------------------------------------------------------------------
# Date / location schema (read from frontmatter when present).
#
# The site is set up to consume the following optional fields on any entity:
#
#   born:     YYYY or YYYY-MM-DD            (person life-span)
#   died:     YYYY or YYYY-MM-DD            (person life-span)
#   start:    YYYY or YYYY-MM-DD            (events / programs / orgs)
#   end:      YYYY or YYYY-MM-DD            (events / programs / orgs)
#   date:     YYYY or YYYY-MM-DD            (single-day events)
#   location: free text, or [text, text]    (e.g. "Moscow", "U.S. Embassy")
#   coords:   { lat: <float>, lng: <float> }  (future map geocoding)
#
# This vault doesn't carry most of these yet — a future LLM-assisted
# backfill will populate them in batches. The parser, entity meta strip,
# and /timeline/ page all already handle them, so whatever lands becomes
# immediately useful with no code changes.
# --------------------------------------------------------------------------


def _date_str(val: Any) -> str | None:
    """Normalize a frontmatter date-ish value to a string. PyYAML parses
    `born: 1904` as int and `born: 1904-08-30` as a date object — both
    need to come out as plain strings the renderer can compare."""
    if val is None:
        return None
    if isinstance(val, (_dt.date, _dt.datetime)):
        return val.isoformat()
    s = str(val).strip()
    return s or None


def _extract_dates(fm: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in ("born", "died", "start", "end", "date"):
        s = _date_str(fm.get(key))
        if s:
            out[key] = s
    return out


def _extract_location(fm: dict[str, Any]) -> list[str]:
    raw = fm.get("location")
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def parse_file(path: Path, vault_root: Path, type_map: dict[str, str]) -> dict[str, Any] | None:
    """Return an entity record, or None if the file is unparseable."""
    try:
        post = frontmatter.load(path)
    except Exception as e:
        sys.stderr.write(f"[warn] frontmatter parse failed: {path} ({e})\n")
        return None

    rel = path.relative_to(vault_root)
    title = path.stem
    body = post.content or ""

    # Repair double-encoded UTF-8 if present (vault-side corruption)
    body, body_fixed = fix_mojibake(body)
    fm_raw, fm_fixes = fix_mojibake_in_value(dict(post.metadata or {}))
    if body_fixed or fm_fixes:
        # Track in a module-level counter via mutable default — see main()
        _MOJIBAKE_FIXES.setdefault("files", set()).add(rel.as_posix())
        _MOJIBAKE_FIXES["count"] = _MOJIBAKE_FIXES.get("count", 0) + (1 if body_fixed else 0) + fm_fixes

    footnotes, body_no_fn = extract_footnotes(body)
    wikilinks = extract_wikilinks(body_no_fn)

    fm = fm_raw
    tags = fm.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]

    # File modification time — drives the vault-activity feed on /changelog/.
    try:
        mtime = _dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        mtime = None

    return {
        "id": slugify(title),
        "title": title,
        "type": infer_type(rel, type_map),
        "path": rel.as_posix(),
        "category": fm.get("category"),
        "summary": fm.get("summary"),
        "tags": tags,
        "frontmatter": fm,
        "body_md": body_no_fn,
        "footnotes": footnotes,
        "wikilinks": wikilinks,
        "mtime": mtime,
        "dates": _extract_dates(fm),
        "locations": _extract_location(fm),
    }


def build_slug_index(entities: list[dict[str, Any]]) -> dict[str, str]:
    """Map normalized title → entity id. Last-write-wins on collisions (logged)."""
    idx: dict[str, str] = {}
    collisions: list[tuple[str, str, str]] = []
    for e in entities:
        key = normalize_target(e["title"])
        if key in idx and idx[key] != e["id"]:
            collisions.append((key, idx[key], e["id"]))
        idx[key] = e["id"]
    if collisions:
        sys.stderr.write(f"[warn] {len(collisions)} title collisions; first few:\n")
        for k, a, b in collisions[:5]:
            sys.stderr.write(f"  {k!r}: {a} ↔ {b}\n")
    return idx


def compute_relationships(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]], top_n: int = 20
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int], dict[str, int]]:
    """
    Compute three indices:
      related: entity_id -> [{id, count, type, title, summary}, ...] top N by co-occurrence
      mention_count: entity_id -> total inbound mentions (page count)
      page_density: entity_id -> number of distinct entities its page touches

    Co-occurrence definition: two entities co-occur on a page P if both appear
    among P's resolved wikilinks, OR one of them IS P. So Allen Dulles' page
    linking to Angleton creates a (Dulles, Angleton) co-occurrence.
    """
    by_id = {e["id"]: e for e in entities}

    # Per-page entity set
    page_ents: dict[str, set[str]] = {}
    for edge in edges:
        if not edge["target_id"]:
            continue
        s = page_ents.setdefault(edge["source"], {edge["source"]})
        s.add(edge["target_id"])

    # Pair counts. Skip very dense pages (>40 entities) since they swamp the signal.
    pair: Counter = Counter()
    for ents in page_ents.values():
        if len(ents) > 40:
            continue
        items = sorted(ents)
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                pair[(a, b)] += 1

    per_entity: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for (a, b), c in pair.items():
        per_entity[a].append((b, c))
        per_entity[b].append((a, c))

    related: dict[str, list[dict[str, Any]]] = {}
    for eid, rels in per_entity.items():
        rels.sort(key=lambda x: (-x[1], x[0]))
        related[eid] = [
            {
                "id": rid,
                "count": cnt,
                "type": by_id[rid]["type"] if rid in by_id else "page",
                "title": by_id[rid]["title"] if rid in by_id else rid,
                "summary": (by_id[rid].get("summary") if rid in by_id else None),
            }
            for rid, cnt in rels[:top_n]
            if rid in by_id
        ]

    # Mention count: distinct pages that link to this entity
    inbound_pages: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge["target_id"] and edge["source"] != edge["target_id"]:
            inbound_pages[edge["target_id"]].add(edge["source"])
    mention_count = {eid: len(srcs) for eid, srcs in inbound_pages.items()}

    page_density = {eid: len(ents) for eid, ents in page_ents.items()}

    return related, mention_count, page_density


def resolve_links(
    entities: list[dict[str, Any]], slug_index: dict[str, str]
) -> tuple[list[dict[str, Any]], Counter]:
    """Resolve wikilink targets to entity ids. Unresolved counted but not dropped."""
    edges: list[dict[str, Any]] = []
    unresolved: Counter = Counter()
    for e in entities:
        for wl in e["wikilinks"]:
            key = normalize_target(wl["target"])
            target_id = slug_index.get(key)
            if not target_id:
                unresolved[wl["target"]] += 1
            edges.append({
                "source": e["id"],
                "target_title": wl["target"],
                "target_id": target_id,
                "display": wl["display"],
                "section": wl["section"],
                "kind": "explicit",
            })
    return edges, unresolved


# ---------- NER: implicit-link discovery ----------
#
# Surface forms that are clearly NOT entity references even though they're
# spelled like proper nouns. Skip these to avoid junk implicit edges.
NER_STOPWORDS = {
    "the", "and", "but", "for", "with", "from", "into", "about", "also",
    "this", "that", "these", "those", "they", "them", "their", "there",
    "when", "where", "what", "which", "who", "whom", "whose", "while",
    "would", "could", "should", "after", "before", "during", "between",
    "us", "usa", "u.s.", "u.s", "u.s.a", "u.s.a.",  # too generic
    "ad", "bc", "ce", "bce",  # date markers
    "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",  # roman numerals
}

# Generic adjectives + common nouns that vault editors sometimes write as
# display text on a wikilink (e.g. `[[United States|American]]`,
# `[[Nancy Hamilton|wife]]`). We must NOT mine those as aliases — matching
# every occurrence of "American" or "wife" in prose floods the implicit
# graph with junk. Only applies to displays mined from edges, not to
# entity titles or frontmatter aliases.
NER_GENERIC_DISPLAY_BLOCKLIST = {
    # Nationality + ethnicity adjectives
    "american", "soviet", "russian", "british", "english", "israeli",
    "iraqi", "iranian", "chinese", "japanese", "german", "french",
    "italian", "spanish", "mexican", "nicaraguan", "cuban", "colombian",
    "venezuelan", "argentine", "brazilian", "indian", "pakistani",
    "afghan", "vietnamese", "korean", "european", "asian", "african",
    "arab", "jewish", "muslim", "christian", "catholic", "protestant",
    "communist", "socialist", "fascist", "nazi", "liberal", "conservative",
    "western", "eastern", "northern", "southern", "americans", "soviets",
    # Family / relational nouns
    "wife", "husband", "son", "daughter", "father", "mother", "brother",
    "sister", "family", "child", "children", "parents", "spouse",
    "boyfriend", "girlfriend",
    # Generic government / org nouns
    "government", "military", "army", "navy", "state", "federal", "agency",
    "department", "agent", "officer", "official", "leader", "president",
    "general", "captain", "colonel", "secretary", "minister", "ambassador",
    "director", "chief", "head",
    # Generic people nouns
    "man", "woman", "person", "people", "group", "team", "company",
    "country", "city", "nation", "author", "scientist", "researcher",
}

NER_MIN_ALIAS_LEN = 3
# Mined displays must appear at least this many times to graduate to an alias.
# Single-occurrence displays are often one-off contextual phrasing, not a
# canonical surface form.
NER_MIN_MINED_DISPLAY_COUNT = 2


def build_alias_map(
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, list[tuple[str, int]]]]:
    """Build a case-sensitive surface-form → entity_id map for NER.

    Three sources of aliases, weighted by confidence:
      1. Entity title — strongest signal (weight 100)
      2. Frontmatter `aliases:` list (weight 50)
      3. Mined from existing [[Target|Display]] wikilink pairs (weight = use count)

    When multiple entities claim the same surface form, accept the dominant
    one only if it has at least 3x the runner-up's weight; otherwise the
    alias is ambiguous and gets dropped (no edge emitted).

    Returns (resolved_map, ambiguous) where ambiguous lists what was skipped
    for the stats report.
    """
    by_id = {e["id"]: e for e in entities}

    # alias → {entity_id: weight}
    candidates: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def add(alias: str, eid: str, weight: int) -> None:
        a = alias.strip()
        if len(a) < NER_MIN_ALIAS_LEN:
            return
        if a.lower() in NER_STOPWORDS:
            return
        # Must contain at least one letter (skip "1980s", numbers, etc.)
        if not any(c.isalpha() for c in a):
            return
        candidates[a][eid] += weight

    # 1. Titles
    for e in entities:
        add(e["title"], e["id"], 100)

    # 2. Frontmatter aliases
    for e in entities:
        fm_aliases = e.get("frontmatter", {}).get("aliases") or []
        if isinstance(fm_aliases, str):
            fm_aliases = [fm_aliases]
        if not isinstance(fm_aliases, list):
            continue
        for a in fm_aliases:
            if isinstance(a, str):
                add(a, e["id"], 50)

    # 3. Mine [[Target|Display]] pairs from existing edges. Count first, then
    #    promote to alias only if (a) the (display, target) pair appears at
    #    least NER_MIN_MINED_DISPLAY_COUNT times — proving it's a canonical
    #    surface form, not a one-off paraphrase — and (b) the display isn't
    #    a generic adjective/noun like "American" or "wife".
    display_pair_counts: Counter = Counter()
    for edge in edges:
        tid = edge.get("target_id")
        if not tid or tid not in by_id:
            continue
        disp = (edge.get("display") or "").strip()
        if not disp or disp == edge.get("target_title"):
            continue
        if disp.lower() in NER_GENERIC_DISPLAY_BLOCKLIST:
            continue
        display_pair_counts[(disp, tid)] += 1
    for (disp, tid), count in display_pair_counts.items():
        if count >= NER_MIN_MINED_DISPLAY_COUNT:
            # Weight scales with corpus confidence (capped to avoid overpowering
            # an actual entity title that might share the surface form).
            add(disp, tid, min(count, 20))

    # Resolve ambiguity
    resolved: dict[str, str] = {}
    ambiguous: dict[str, list[tuple[str, int]]] = {}
    for alias, by_eid in candidates.items():
        ranked = sorted(by_eid.items(), key=lambda kv: -kv[1])
        if len(ranked) == 1:
            resolved[alias] = ranked[0][0]
            continue
        top_eid, top_w = ranked[0]
        rup_w = ranked[1][1]
        if top_w >= 3 * rup_w:
            resolved[alias] = top_eid
        else:
            ambiguous[alias] = ranked[:4]

    return resolved, ambiguous


# Region masks: skip these parts of body_md when scanning for implicit links.
WIKILINK_SPAN = re.compile(r"\[\[[^\]]+?\]\]")
CODE_FENCE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~", re.MULTILINE)
INLINE_CODE = re.compile(r"`[^`\n]+`")
MD_LINK = re.compile(r"\[[^\]]+\]\([^)]+\)")
FN_REF_SPAN = re.compile(r"\[\^[^\]]+\]")
HTML_TAG = re.compile(r"<[^>]+>")
FRONTMATTER_HEADER = re.compile(r"^#{1,6}\s+Footnotes\s*$", re.MULTILINE)


def _mask_regions(text: str) -> str:
    """Replace regions we shouldn't scan with same-length spaces, preserving
    offsets so match positions in the masked text still line up with original.
    """
    out = list(text)
    for rx in (CODE_FENCE, INLINE_CODE, WIKILINK_SPAN, MD_LINK, FN_REF_SPAN, HTML_TAG):
        for m in rx.finditer(text):
            for i in range(m.start(), m.end()):
                out[i] = " "
    return "".join(out)


def find_implicit_links(
    entities: list[dict[str, Any]],
    alias_map: dict[str, str],
    explicit_edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """For each entity, scan body_md (with wikilinks/code masked out) for
    surface forms in alias_map. Emit one implicit edge per (source, target),
    counting how many surface mentions appeared on the page.

    Crucially, we skip any (source, target) pair where the source already
    has an explicit wikilink to that target — surfacing it as "hidden"
    would be misleading since the connection is already on the page.

    Case-sensitive matching: aliases use their natural casing (titles are
    already capitalized for proper nouns), so 'Reagan' matches 'Reagan' but
    not 'reagan' in lowercase — which avoids false positives like 'bell'
    inside ordinary prose.
    """
    if not alias_map:
        return [], {"implicit_edge_count": 0}

    # Pre-index existing explicit links so we can suppress duplicates.
    explicit_pairs: dict[str, set[str]] = defaultdict(set)
    for edge in explicit_edges:
        tid = edge.get("target_id")
        if tid:
            explicit_pairs[edge["source"]].add(tid)

    # Build a single longest-first alternation. re.compile handles the rest.
    # Word-boundary `\b` doesn't cooperate well with multi-word or accented
    # aliases — emulate with lookarounds that reject letters/digits on either
    # side. This lets 'Soviet Union' match in 'the Soviet Union was'.
    sorted_aliases = sorted(alias_map.keys(), key=lambda a: -len(a))
    pattern = re.compile(
        r"(?<![A-Za-z0-9])(?:" + "|".join(re.escape(a) for a in sorted_aliases) + r")(?![A-Za-z0-9])"
    )

    implicit_edges: list[dict[str, Any]] = []
    surface_counts: Counter = Counter()
    pages_touched: set[str] = set()
    self_skipped = 0
    already_linked_skipped = 0

    for e in entities:
        body = e.get("body_md") or ""
        if not body:
            continue
        masked = _mask_regions(body)
        # Targets this entity ALREADY wikilinks to — don't surface them as
        # "hidden", they're already visible on the page.
        already_linked = explicit_pairs.get(e["id"], set())
        # Dedupe per (source, target): one edge per page, accumulate count
        per_target: dict[str, dict[str, Any]] = {}
        for m in pattern.finditer(masked):
            surface = m.group(0)
            target_id = alias_map.get(surface)
            if not target_id:
                continue
            if target_id == e["id"]:
                self_skipped += 1
                continue
            if target_id in already_linked:
                already_linked_skipped += 1
                continue
            entry = per_target.setdefault(target_id, {
                "source": e["id"],
                "target_id": target_id,
                "surface": surface,
                "count": 0,
                "kind": "implicit",
            })
            entry["count"] += 1
            surface_counts[surface] += 1
        if per_target:
            pages_touched.add(e["id"])
        implicit_edges.extend(per_target.values())

    stats = {
        "implicit_edge_count": len(implicit_edges),
        "implicit_pages_touched": len(pages_touched),
        "implicit_self_refs_skipped": self_skipped,
        "implicit_already_linked_skipped": already_linked_skipped,
        "top_implicit_surfaces": surface_counts.most_common(25),
    }
    return implicit_edges, stats


FN_REF = re.compile(r"\[\^([^\]]+?)\]")
# Match wikilinks even after markdown-it has done its thing.
# markdown-it preserves [[...]] as literal text, so the same pattern works.
WIKILINK_HTML = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]")
# Don't rewrite inside <code> or <pre> spans (rare here, but cheap to guard against)
CODE_SPAN = re.compile(r"<(code|pre)[^>]*>.*?</\1>", re.DOTALL)
# Capture h2/h3/h4 headings AFTER markdown-it has rendered them, so we can
# inject IDs and harvest entries for the table of contents.
HEADING_RE = re.compile(r"<h([234])(?![^>]*\bid=)([^>]*)>(.*?)</h\1>", re.DOTALL)
TAG_STRIP = re.compile(r"<[^>]+>")


def render_html(entities: list[dict[str, Any]], slug_index: dict[str, str]) -> None:
    """Add body_html (and rendered footnote text) to each entity."""
    md = MarkdownIt("commonmark", {"html": False, "linkify": True, "typographer": True}) \
        .enable("table") \
        .enable("strikethrough")

    type_to_dir = {
        "person": "people",
        "organization": "organizations",
        "program": "programs",
        "event": "events",
        "concept": "concepts",
        "place": "places",
        "source": "sources",
        "meta": "meta",
        "misc": "misc",
        "page": "pages",
    }
    id_to_type = {e["id"]: e["type"] for e in entities}

    def replace_wikilink(m: re.Match) -> str:
        target = m.group(1).strip()
        display = (m.group(2) or "").strip() or target
        section = ""
        if "#" in target:
            target, section = target.split("#", 1)
            target = target.strip()
        target_id = slug_index.get(normalize_target(target))
        if not target_id:
            return f'<a class="wikilink unresolved" data-target="{target}">{display}</a>'
        t_type = id_to_type.get(target_id, "page")
        href = f"/{type_to_dir.get(t_type, 'pages')}/{target_id}/"
        if section:
            href += f"#{slugify(section)}"
        return f'<a class="wikilink" href="{href}">{display}</a>'

    def replace_footnote_ref(m: re.Match) -> str:
        fid = m.group(1).strip()
        return (
            f'<sup class="fn-ref"><a href="#fn-{fid}" id="fnref-{fid}">{fid}</a></sup>'
        )

    def rewrite(html: str) -> str:
        # Preserve code spans verbatim, rewrite everywhere else
        parts: list[str] = []
        last = 0
        for m in CODE_SPAN.finditer(html):
            parts.append(_rewrite_outside_code(
                html[last:m.start()], replace_wikilink, replace_footnote_ref))
            parts.append(m.group(0))
            last = m.end()
        parts.append(_rewrite_outside_code(
            html[last:], replace_wikilink, replace_footnote_ref))
        return "".join(parts)

    for e in entities:
        # Strip embeds (we don't render media in Phase 0)
        pre = EMBED.sub("", e["body_md"])
        rendered = rewrite(md.render(pre))
        e["body_html"], e["toc"] = _process_headings(rendered)
        # Render footnote text as inline markdown too — italics, links, etc.
        for fn in e["footnotes"]:
            fn["html"] = rewrite(md.renderInline(fn["text"]))


def _process_headings(html: str) -> tuple[str, list[dict[str, Any]]]:
    """Inject id="..." onto every h2/h3/h4 in body_html and return the
    HTML plus a flat TOC list. Handles duplicate slugs by appending a
    counter; strips inner tags for the TOC text label."""
    entries: list[dict[str, Any]] = []
    seen: Counter = Counter()

    def repl(m: re.Match) -> str:
        level = int(m.group(1))
        existing_attrs = m.group(2) or ""
        inner_html = m.group(3)
        text = TAG_STRIP.sub("", inner_html).strip()
        if not text:
            return m.group(0)
        base = slugify(text) or f"section-{len(entries) + 1}"
        seen[base] += 1
        slug = base if seen[base] == 1 else f"{base}-{seen[base]}"
        entries.append({"level": level, "text": text, "id": slug})
        return f'<h{level} id="{slug}"{existing_attrs}>{inner_html}</h{level}>'

    new_html = HEADING_RE.sub(repl, html)
    return new_html, entries


def _rewrite_outside_code(text: str, wl_repl, fn_repl) -> str:
    text = WIKILINK_HTML.sub(wl_repl, text)
    text = FN_REF.sub(fn_repl, text)
    return text


# ---------- io ----------

def load_config(path: Path | None) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if path and path.exists():
        with path.open("r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def build_neighborhoods(
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    max_neighbors: int = 25,
) -> dict[str, dict[str, Any]]:
    """Per-entity local graph: 1 hop in either direction, capped at
    max_neighbors by edge weight. Each entry has nodes (with title/type/
    mention_count) and edges (with kind + weight). Consumed by the graph
    widget on each entity page.
    """
    by_id = {e["id"]: e for e in entities}

    # Aggregate per-pair edge weights, separately by direction + kind.
    # Pairs we care about: every (source, target) where both are real entities.
    pair_weight: dict[tuple[str, str, str], int] = defaultdict(int)
    for edge in edges:
        s = edge["source"]
        t = edge.get("target_id")
        if not t or s == t:
            continue
        if s not in by_id or t not in by_id:
            continue
        kind = edge.get("kind", "explicit")
        weight = edge.get("count", 1) if kind == "implicit" else 1
        pair_weight[(s, t, kind)] += weight

    # Neighbor adjacency by entity (undirected for scoring).
    neighbors_of: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for (s, t, _k), w in pair_weight.items():
        neighbors_of[s][t] += w
        neighbors_of[t][s] += w

    out: dict[str, dict[str, Any]] = {}
    for ent in entities:
        eid = ent["id"]
        nbr_map = neighbors_of.get(eid, {})
        if not nbr_map:
            continue
        # Rank neighbors by combined edge weight; tie-break by neighbor's
        # mention_count so popular entities surface first.
        ranked = sorted(
            nbr_map.items(),
            key=lambda kv: (-kv[1], -by_id[kv[0]].get("mention_count", 0)),
        )[:max_neighbors]
        keep = {nid for nid, _ in ranked} | {eid}

        nodes = [
            {
                "id": nid,
                "title": by_id[nid]["title"],
                "type": by_id[nid]["type"],
                "mention_count": by_id[nid].get("mention_count", 0),
            }
            for nid in keep
        ]

        # Edges among kept nodes, in either direction. Collapse same-pair
        # explicit + implicit into one entry with both weights (the renderer
        # can use that to style explicit vs implicit differently).
        ng_edges: list[dict[str, Any]] = []
        seen_pairs: set[tuple[str, str]] = set()
        for (s, t, kind), w in pair_weight.items():
            if s not in keep or t not in keep:
                continue
            pair = (s, t) if s < t else (t, s)
            # Aggregate both directions into one undirected edge
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            a, b = pair
            explicit_w = pair_weight.get((a, b, "explicit"), 0) + pair_weight.get((b, a, "explicit"), 0)
            implicit_w = pair_weight.get((a, b, "implicit"), 0) + pair_weight.get((b, a, "implicit"), 0)
            ng_edges.append({
                "source": a,
                "target": b,
                "explicit": explicit_w,
                "implicit": implicit_w,
            })

        out[eid] = {"nodes": nodes, "edges": ng_edges}
    return out


def write_outputs(out_dir: Path, entities: list[dict[str, Any]],
                  slug_index: dict[str, str], edges: list[dict[str, Any]],
                  stats: dict[str, Any],
                  related: dict[str, list[dict[str, Any]]] | None = None,
                  neighborhoods: dict[str, dict[str, Any]] | None = None) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "entities.json").write_text(_dump(entities), encoding="utf-8")
    (out_dir / "slug_index.json").write_text(_dump(slug_index), encoding="utf-8")
    (out_dir / "links.json").write_text(_dump(edges), encoding="utf-8")
    (out_dir / "stats.json").write_text(_dump(stats), encoding="utf-8")
    if related is not None:
        (out_dir / "related.json").write_text(_dump(related), encoding="utf-8")

    # Recent vault activity — derived from file mtimes. Drives /changelog/.
    activity = [
        {
            "id": e["id"],
            "title": e["title"],
            "type": e["type"],
            "category": e.get("category"),
            "summary": e.get("summary"),
            "mtime": e.get("mtime"),
        }
        for e in entities if e.get("mtime")
    ]
    activity.sort(key=lambda x: x["mtime"], reverse=True)
    (out_dir / "activity.json").write_text(
        json.dumps(activity, ensure_ascii=False, separators=(",", ":"), default=_json_default),
        encoding="utf-8",
    )

    # Single slim-record map for hover previews. Loaded once by the browser
    # on first hover, then cached in memory. ~100KB gzipped at this scale.
    previews = {
        e["id"]: {
            "title": e["title"],
            "type": e["type"],
            "category": e["category"],
            "summary": e["summary"],
            "mention_count": e.get("mention_count", 0),
            "related": [
                {"id": r["id"], "title": r["title"], "type": r["type"]}
                for r in (related or {}).get(e["id"], [])[:5]
            ],
        }
        for e in entities
    }
    # Compact form — saves ~60% on this file, which the browser fetches at load
    (out_dir / "previews.json").write_text(
        json.dumps(previews, ensure_ascii=False, separators=(",", ":"), default=_json_default),
        encoding="utf-8",
    )

    # Search corpus — one entity per line, body stripped of HTML
    strip = re.compile(r"<[^>]+>")
    with (out_dir / "corpus.jsonl").open("w", encoding="utf-8") as f:
        for e in entities:
            f.write(json.dumps({
                "id": e["id"],
                "title": e["title"],
                "type": e["type"],
                "category": e["category"],
                "tags": e["tags"],
                "summary": e["summary"],
                "text": strip.sub("", e.get("body_html", "")),
            }, ensure_ascii=False, default=_json_default) + "\n")

    # Per-entity neighborhood data: lazy-loaded by the graph widget on each
    # entity page. One small JSON per entity beats one 10MB monolith because
    # the graph only renders for users who scroll to it.
    if neighborhoods is not None:
        ng_dir = out_dir / "api" / "neighborhood"
        ng_dir.mkdir(parents=True, exist_ok=True)
        # Clean stale files so removed entities don't leave behind ghosts
        for old in ng_dir.glob("*.json"):
            if old.stem not in neighborhoods:
                old.unlink()
        for eid, data in neighborhoods.items():
            (ng_dir / f"{eid}.json").write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=_json_default),
                encoding="utf-8",
            )


# ---------- main ----------

def main() -> int:
    ap = argparse.ArgumentParser(description="Parse an Obsidian vault into JSON.")
    ap.add_argument("--config", type=Path, help="Path to config.json")
    ap.add_argument("--vault", type=Path, help="Vault root (overrides config)")
    ap.add_argument("--out", type=Path, default=Path("_web/data"),
                    help="Output directory (default: _web/data)")
    args = ap.parse_args()

    cfg = load_config(args.config)
    vault_root = (args.vault or Path(cfg["vaultPath"])).resolve()
    if not vault_root.exists():
        sys.stderr.write(f"[err] vault path does not exist: {vault_root}\n")
        return 1

    t0 = time.time()
    md_files = [p for p in vault_root.rglob("*.md")
                if not should_skip(p.relative_to(vault_root), cfg["skipPathPatterns"])]
    print(f"[parse] {len(md_files)} markdown files in {vault_root}")

    entities: list[dict[str, Any]] = []
    seen_ids: dict[str, str] = {}
    for p in md_files:
        e = parse_file(p, vault_root, cfg["typeMap"])
        if not e:
            continue
        # Disambiguate slug collisions deterministically
        base = e["id"]
        if base in seen_ids and seen_ids[base] != e["path"]:
            i = 2
            while f"{base}-{i}" in seen_ids:
                i += 1
            e["id"] = f"{base}-{i}"
        seen_ids[e["id"]] = e["path"]
        entities.append(e)

    slug_index = build_slug_index(entities)
    edges, unresolved = resolve_links(entities, slug_index)

    # NER pass: discover entity mentions in prose that aren't wikilinked.
    # Must run BEFORE render_html so the wikilink-style edges still describe
    # exactly what's in the markdown (implicit edges are graph-only, not
    # rewritten into the rendered prose).
    alias_map, ambiguous_aliases = build_alias_map(entities, edges)
    implicit_edges, ner_stats = find_implicit_links(entities, alias_map, edges)
    edges.extend(implicit_edges)

    render_html(entities, slug_index)
    related, mention_count, page_density = compute_relationships(entities, edges)

    # Attach mention_count to each entity so the frontend can rank hubs cheaply
    for e in entities:
        e["mention_count"] = mention_count.get(e["id"], 0)
        e["page_density"] = page_density.get(e["id"], 0)

    type_counts = Counter(e["type"] for e in entities)
    untyped = [e["path"] for e in entities if e["type"] == "page"][:20]
    no_category = sum(1 for e in entities if not e["category"] and e["type"] != "meta")
    backlink_count: dict[str, int] = defaultdict(int)
    for edge in edges:
        if edge["target_id"]:
            backlink_count[edge["target_id"]] += 1
    orphans = [e["id"] for e in entities
               if backlink_count[e["id"]] == 0 and not e["wikilinks"]][:30]

    explicit_edges = [e for e in edges if e.get("kind") != "implicit"]
    stats = {
        "entity_count": len(entities),
        "edge_count": len(edges),
        "explicit_edges": len(explicit_edges),
        "resolved_edges": sum(1 for e in explicit_edges if e["target_id"]),
        "unresolved_edges": sum(1 for e in explicit_edges if not e["target_id"]),
        "by_type": dict(type_counts),
        "untyped_examples": untyped,
        "entities_missing_category": no_category,
        "top_unresolved_targets": unresolved.most_common(25),
        "orphan_examples": orphans,
        "mojibake_fixes": _MOJIBAKE_FIXES.get("count", 0),
        "mojibake_files": len(_MOJIBAKE_FIXES.get("files", set())),
        "mojibake_examples": sorted(_MOJIBAKE_FIXES.get("files", set()))[:10],
        "ner": {
            "alias_table_size": len(alias_map),
            "ambiguous_aliases_skipped": len(ambiguous_aliases),
            "ambiguous_examples": [
                {"alias": a, "candidates": [{"id": eid, "weight": w} for eid, w in cands]}
                for a, cands in list(ambiguous_aliases.items())[:15]
            ],
            **ner_stats,
        },
        "parse_seconds": round(time.time() - t0, 2),
    }

    neighborhoods = build_neighborhoods(entities, edges)
    write_outputs(args.out, entities, slug_index, edges, stats, related, neighborhoods)

    print(f"[done] {len(entities)} entities, {len(edges)} edges "
          f"({stats['resolved_edges']} resolved, {stats['unresolved_edges']} unresolved) "
          f"in {stats['parse_seconds']}s")
    print(f"[done] by type: {dict(type_counts)}")
    print(f"[done] wrote {args.out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
