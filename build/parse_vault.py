#!/usr/bin/env python3
"""Parse an Obsidian vault into the JSON indices the Astro frontend reads.

Writes entities, slug_index, links, related, previews, activity, adjacency,
communities, focus and stats (.json), corpus.jsonl for search, and a cleaned
markdown twin of every entry under md/.
"""

import argparse
import datetime as dt
import fnmatch
import hashlib
import html
import json
import math
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import frontmatter
import networkx as nx
from markdown_it import MarkdownIt


DEFAULT_CONFIG = {
    # Louvain resolution for /clusters/ (higher gives more, smaller clusters)
    # and the types attached to a neighbour's cluster instead of seeding one.
    "clusterResolution": 1.5,
    "clusterExcludeTypes": ["place", "meta", "source", "misc", "page"],
    "skipPathPatterns": [".obsidian/**", ".obsidian-*/**", ".trash/**", ".git/**"],
    # Top-level vault folder -> entity type. Unmapped folders become "page".
    "typeMap": {
        "People": "person",
        "Organizations": "organization",
        "Programs": "program",
        "Events": "event",
        "Concepts": "concept",
        "Places": "place",
        "Sources": "source",
        "Meta": "meta",
        "Misc": "misc",
    },
    # Optional note whose [[wikilinks]] are pinned to the homepage "In focus" list.
    "focusFile": None,
}

# Site URL directory per entity type.
TYPE_DIRS = {
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

# Index notes and narratives link out to hundreds of entries, so only these
# types are ranked as hubs and bridges.
RANKABLE_TYPES = {"person", "organization", "program", "event", "concept", "place"}
FOCUS_TYPES = {"person", "organization", "program", "event", "concept"}

# [[Target]], [[Target#Section]] or [[Target|Display]].
WIKILINK = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]")
# Media embeds are not rendered.
EMBED = re.compile(r"!\[\[([^\]]+?)\]\]")
FOOTNOTE_DEF = re.compile(r"^\[\^([^\]]+?)\]:\s*(.+?)$", re.MULTILINE)
FN_REF = re.compile(r"\[\^([^\]]+?)\]")
TAG = re.compile(r"<[^>]+>")

# Double-encoded UTF-8 ('Ã±' for 'ñ').
MOJIBAKE_RE = re.compile(r'[\u00c2\u00c3\u00e2][\u0080-\u00bf]')


def _json_default(o: Any) -> Any:
    if isinstance(o, dt.date):
        return o.isoformat()
    if isinstance(o, set):  # YAML !!set
        return sorted(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def write_json(path: Path, obj: Any, pretty: bool = False) -> None:
    fmt = {"indent": 2} if pretty else {"separators": (",", ":")}
    path.write_text(json.dumps(obj, ensure_ascii=False, default=_json_default, **fmt),
                    encoding="utf-8")


# ---------- text helpers ----------

def fix_mojibake(s: str) -> tuple[str, bool]:
    """Return (text, was_fixed); only changes text whose latin-1 round trip decodes cleanly."""
    if not s or not MOJIBAKE_RE.search(s):
        return s, False
    try:
        recovered = s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s, False
    return recovered, recovered != s


def fix_mojibake_in_value(v: Any) -> tuple[Any, int]:
    """Repair every string inside nested lists and dicts. Returns (value, fix_count)."""
    if isinstance(v, str):
        fixed, did = fix_mojibake(v)
        return fixed, int(did)
    if isinstance(v, list):
        pairs = [fix_mojibake_in_value(x) for x in v]
        return [x for x, _ in pairs], sum(n for _, n in pairs)
    if isinstance(v, dict):
        pairs = {k: fix_mojibake_in_value(x) for k, x in v.items()}
        return {k: x for k, (x, _) in pairs.items()}, sum(n for _, n in pairs.values())
    return v, 0


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower().strip())
    s = re.sub(r"[\s_]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-") or "untitled"


def normalize_target(target: str) -> str:
    """Link-resolution key: case-insensitive, whitespace-collapsed."""
    return re.sub(r"\s+", " ", target).strip().lower()


def should_skip(rel: Path, patterns: list[str]) -> bool:
    """Patterns containing a slash match the relative path, others the filename."""
    return any(fnmatch.fnmatch(rel.as_posix() if "/" in p else rel.name, p) for p in patterns)


def split_wikilink(m: re.Match) -> tuple[str, str, str]:
    """(target, display, section) for a WIKILINK match. Display keeps any #section."""
    target = m.group(1).strip()
    display = (m.group(2) or "").strip() or target
    target, _, section = target.partition("#")
    return target.strip(), display, section.strip()


def extract_wikilinks(body: str) -> list[dict[str, str]]:
    links = []
    for m in WIKILINK.finditer(EMBED.sub("", body)):
        target, display, section = split_wikilink(m)
        links.append({"target": target, "display": display, "section": section})
    return links


def extract_footnotes(body: str) -> tuple[list[dict[str, str]], str]:
    """Pull footnote definitions out of body. Returns (notes, body_without_defs)."""
    notes = [{"id": m.group(1).strip(), "text": m.group(2).strip()}
             for m in FOOTNOTE_DEF.finditer(body)]
    body = FOOTNOTE_DEF.sub("", body).rstrip()
    # The "### Footnotes" header is empty once its definitions are gone.
    body = re.sub(r"#+\s*Footnotes\s*$", "", body, flags=re.MULTILINE).rstrip()
    return notes, body


def entity_aliases(e: dict[str, Any]) -> list[str]:
    """String entries of frontmatter `aliases`, which may be a string or a list."""
    raw = e.get("frontmatter", {}).get("aliases") or []
    if isinstance(raw, str):
        raw = [raw]
    return [a for a in raw if isinstance(a, str)] if isinstance(raw, list) else []


def make_href_resolver(entities: list[dict[str, Any]], slug_index: dict[str, str]):
    """Return href(target, section) -> site URL, or None when no entry matches."""
    dir_of = {e["id"]: TYPE_DIRS.get(e["type"], "pages") for e in entities}

    def href(target: str, section: str = "") -> str | None:
        eid = slug_index.get(normalize_target(target))
        if not eid:
            return None
        url = f"/{dir_of[eid]}/{eid}/"
        return f"{url}#{slugify(section)}" if section else url
    return href


# ---------- frontmatter ----------

def _date_str(val: Any) -> str | None:
    """PyYAML reads `1904` as int and `1904-08-30` as a date; both become strings."""
    if val is None:
        return None
    if isinstance(val, dt.date):
        return val.isoformat()
    return str(val).strip() or None


def _extract_dates(fm: dict[str, Any]) -> dict[str, str]:
    """Optional born/died/start/end/date, each YYYY or YYYY-MM-DD."""
    out = {}
    for key in ("born", "died", "start", "end", "date"):
        s = _date_str(fm.get(key))
        if s:
            out[key] = s
    return out


def _extract_location(fm: dict[str, Any]) -> list[str]:
    raw = fm.get("location")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [s for s in (str(x).strip() for x in raw) if s]


# Typed relations, from frontmatter:
#
#   relations:
#     - type: employed_by
#       with: "[[Central Intelligence Agency]]"
#       start: 1973
#       end: 1977
#       role: "assistant legislative counsel"
#       fn: 1
#
# The page is the subject and `with` the object; `reverse: true` swaps them, so
# a program page can record "Terry Waite subject_of Sun Streak". `fn` is the
# declaring page's footnote. There is no generic "associate" type on purpose:
# untyped co-mention is already covered by related, backlinks and implicit links.
RELATION_TYPES: dict[str, tuple[str, str]] = {
    "employed_by": ("Employed by", "Employer of"),
    "member_of": ("Member of", "Members"),
    "director_of": ("Director of", "Directors"),
    "head_of": ("Head of", "Headed by"),
    "founded": ("Founded", "Founded by"),
    "owned": ("Owned", "Owned by"),
    "funded": ("Funded", "Funded by"),
    "contractor_to": ("Contractor to", "Contractors"),
    "represented": ("Represented", "Represented by"),
    "appointed": ("Appointed", "Appointed by"),
    "reported_to": ("Reported to", "Supervised"),
    "investigated": ("Investigated", "Investigated by"),
    "prosecuted": ("Prosecuted", "Prosecuted by"),
    "participant_in": ("Took part in", "Participants"),
    "subject_of": ("Subject of", "Subjects"),
    "informant_for": ("Informant for", "Informants"),
    "partner_of": ("Partner of", "Partner of"),
    "relative_of": ("Relative of", "Relative of"),
    "spouse_of": ("Spouse of", "Spouse of"),
}

# On a symmetric relation, `role` is what the declaring page's subject is to
# the other ("father"), so the other page must show the other person's role.
SYMMETRIC_RELATIONS = {t for t, (a, b) in RELATION_TYPES.items() if a == b}
# When only one page declares a role, the role the other person must have.
# Roles missing here have no safe inverse and are dropped from that side.
_ROLE_INVERSE = {
    "father": "child", "mother": "child", "parent": "child",
    "son": "parent", "daughter": "parent", "child": "parent",
    "brother": "sibling", "sister": "sibling", "sibling": "sibling",
    "husband": "spouse", "wife": "spouse", "spouse": "spouse",
    "cousin": "cousin", "distant cousin": "distant cousin", "partner": "partner",
}

_REL_TARGET = re.compile(r"^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$")


def _extract_relations(fm: dict[str, Any], title: str) -> list[dict[str, Any]]:
    raw = fm.get("relations")
    if not isinstance(raw, list):
        return []
    out = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        rtype = str(r.get("type") or "").strip()
        target = str(r.get("with") or "").strip()
        if rtype not in RELATION_TYPES or not target:
            sys.stderr.write(f"[warn] bad relation on {title}: {r}\n")
            continue
        m = _REL_TARGET.match(target)
        if m:
            target = m.group(1).strip()
        out.append({
            "type": rtype,
            "with_title": target,
            "reverse": bool(r.get("reverse")),
            "start": _date_str(r.get("start")),
            "end": _date_str(r.get("end")),
            "role": str(r["role"]).strip() if r.get("role") else None,
            "fn": str(r["fn"]).strip() if r.get("fn") is not None else None,
        })
    return out


def resolve_relations(entities: list[dict[str, Any]], slug_index: dict[str, str]) -> None:
    """Turn each entity's relations_raw into `relations` (subject side) and
    `relations_in` (object side).

    A fact is kept once per (subject, type, object, start), so declaring it on
    both pages does not double it. Symmetric types are undirected, and each page
    keeps its own role and footnote.
    """
    by_id = {e["id"]: e for e in entities}
    facts: dict[tuple, dict[str, Any]] = {}
    for e in entities:
        for r in e.get("relations_raw", []):
            other_id = slug_index.get(normalize_target(r["with_title"]))
            subj, obj = (e["id"], e["title"]), (other_id, r["with_title"])
            if r["reverse"]:
                subj, obj = obj, subj
            sk, ok = subj[0] or subj[1].lower(), obj[0] or obj[1].lower()
            sym = r["type"] in SYMMETRIC_RELATIONS
            key = (r["type"], frozenset((sk, ok)), r["start"]) if sym else (sk, r["type"], ok, r["start"])
            f = facts.get(key)
            if f is None:
                f = facts[key] = {**r, "subj": subj, "obj": obj, "declared_on": e["id"], "roles": {}, "fns": {}}
            if sym and r["role"]:
                f["roles"].setdefault(e["id"], r["role"])
            if sym and r["fn"]:
                f["fns"].setdefault(e["id"], r["fn"])
    for e in entities:
        e["relations"] = []
        e["relations_in"] = []
        e.pop("relations_raw", None)

    def row(f: dict[str, Any], page: tuple, other: tuple, label: str) -> dict[str, Any]:
        """The fact as shown on `page`, pointing at `other`."""
        # A footnote number only means something on the page that declared it.
        out = {"type": f["type"], "start": f["start"], "end": f["end"],
               "fn": f["fn"], "fn_page": f["declared_on"]}
        role = f["role"]
        if f["type"] in SYMMETRIC_RELATIONS:
            if page[0] in f["fns"]:
                out.update(fn=f["fns"][page[0]], fn_page=page[0])
            role = f["roles"].get(other[0])
            if not role and (mirror := f["roles"].get(page[0])):
                role = _ROLE_INVERSE.get(mirror.lower())
        return {**out, "role": role, "label": label, "other_id": other[0], "other_title": other[1]}

    for f in facts.values():
        label, inverse = RELATION_TYPES[f["type"]]
        if f["subj"][0] in by_id:
            by_id[f["subj"][0]]["relations"].append(row(f, f["subj"], f["obj"], label))
        if f["obj"][0] in by_id:
            by_id[f["obj"][0]]["relations_in"].append(row(f, f["obj"], f["subj"], inverse))


def _str_or_none(v: Any) -> str | None:
    return None if v is None else str(v)


def parse_file(path: Path, vault_root: Path, type_map: dict[str, str]) -> dict[str, Any] | None:
    """Return an entity record, or None if the file cannot be parsed."""
    try:
        # frontmatter only sees `---` at offset 0, and some files carry two
        # BOMs, so utf-8-sig is not enough.
        post = frontmatter.loads(path.read_text(encoding="utf-8").lstrip("﻿"))
    except Exception as e:
        sys.stderr.write(f"[warn] frontmatter parse failed: {path} ({e})\n")
        return None

    rel = path.relative_to(vault_root)
    title = path.stem
    body, body_fixed = fix_mojibake(post.content or "")
    fm, fm_fixes = fix_mojibake_in_value(dict(post.metadata or {}))
    footnotes, body = extract_footnotes(body)
    tags = fm.get("tags") or []
    tags = [str(t) for t in (tags if isinstance(tags, list) else [tags]) if t is not None]
    try:
        mtime = dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        mtime = None

    return {
        "id": slugify(title),
        "title": title,
        "type": type_map.get(rel.parts[0], "page"),
        "path": rel.as_posix(),
        "category": _str_or_none(fm.get("category")),
        "summary": _str_or_none(fm.get("summary")),
        "tags": tags,
        "frontmatter": fm,
        "body_md": body,
        "footnotes": footnotes,
        "wikilinks": extract_wikilinks(body),
        "mtime": mtime,
        "dates": _extract_dates(fm),
        "locations": _extract_location(fm),
        "relations_raw": _extract_relations(fm, title),
        "mojibake_fixes": int(body_fixed) + fm_fixes,  # popped by main()
    }


# ---------- link resolution ----------

def build_slug_index(entities: list[dict[str, Any]]) -> dict[str, str]:
    """Map normalized titles and frontmatter aliases to entity ids.

    A title always beats another entity's alias. An alias claimed by two
    entities is left unresolved rather than guessed.
    """
    idx: dict[str, str] = {}
    collisions = []
    for e in entities:
        key = normalize_target(e["title"])
        if key in idx and idx[key] != e["id"]:
            collisions.append((key, idx[key], e["id"]))
        idx[key] = e["id"]
    if collisions:
        sys.stderr.write(f"[warn] {len(collisions)} title collisions; first few:\n")
        for k, a, b in collisions[:5]:
            sys.stderr.write(f"  {k!r}: {a} ↔ {b}\n")

    title_keys = set(idx)
    alias_claims: dict[str, set[str]] = defaultdict(set)
    for e in entities:
        for a in entity_aliases(e):
            key = normalize_target(a)
            if key and key not in title_keys:
                alias_claims[key].add(e["id"])
    added = ambiguous = 0
    for key, eids in alias_claims.items():
        if len(eids) == 1:
            idx[key] = next(iter(eids))
            added += 1
        else:
            ambiguous += 1
    if added or ambiguous:
        sys.stderr.write(f"[info] slug index: +{added} alias keys resolved, "
                         f"{ambiguous} ambiguous alias(es) skipped\n")
    return idx


def resolve_links(
    entities: list[dict[str, Any]], slug_index: dict[str, str]
) -> tuple[list[dict[str, Any]], Counter]:
    """One edge per wikilink. Unresolved links keep target_id None and are counted."""
    edges = []
    unresolved: Counter = Counter()
    for e in entities:
        for wl in e["wikilinks"]:
            target_id = slug_index.get(normalize_target(wl["target"]))
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


def resolved_edges(edges: list[dict[str, Any]], valid):
    """Yield (source, target, kind, weight) for edges between two distinct entities in `valid`."""
    for e in edges:
        s, t = e["source"], e.get("target_id")
        if t and s != t and s in valid and t in valid:
            yield s, t, e["kind"], e.get("count", 1)


def compute_relationships(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]], top_n: int = 20
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int], dict[str, int]]:
    """Return (related, mention_count, page_density).

    Two entities co-occur on page P when both are among P's wikilinks, or one of
    them is P. related[id] lists top co-occurring entities, with up to five `via`
    pages as evidence.
    """
    by_id = {e["id"]: e for e in entities}
    page_ents: dict[str, set[str]] = {}
    linked: dict[str, set[str]] = {}
    for edge in edges:
        if edge["target_id"]:
            page_ents.setdefault(edge["source"], {edge["source"]}).add(edge["target_id"])
            if edge["kind"] == "explicit":
                linked.setdefault(edge["source"], {edge["source"]}).add(edge["target_id"])

    # Wikilinks only (NER matches are too noisy). A page's own subject is the best
    # evidence, so its pairs count double and are all a dense page (>40) keeps.
    pair_pages: dict[tuple[str, str], list[str]] = defaultdict(list)
    pair_weight: dict[tuple[str, str], float] = defaultdict(float)
    doc_freq: Counter = Counter()
    for src, ents in linked.items():
        doc_freq.update(ents)
        w = 1 / math.log2(1 + len(ents))
        dense = len(ents) > 40
        items = sorted(ents)
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                own = src in (a, b)
                if dense and not own:
                    continue
                pair_pages[(a, b)].append(src)
                pair_weight[(a, b)] += 2 * w if own else w

    per_entity: dict[str, list[tuple[str, list[str], float]]] = defaultdict(list)
    for (a, b), pages in pair_pages.items():
        per_entity[a].append((b, pages, pair_weight[(a, b)]))
        per_entity[b].append((a, pages, pair_weight[(a, b)]))

    # IDF weighting keeps mega-hubs (CIA, United States) from topping every list.
    n_pages = len(linked)

    def score(nid: str, weight: float) -> float:
        return weight * math.log(n_pages / doc_freq[nid])

    # A page touching few entities is tighter evidence than a sprawling one.
    def via(eid: str, pages: list[str]) -> list[dict[str, Any]]:
        tight = sorted((p for p in pages if p != eid), key=lambda p: len(linked[p]))[:5]
        return [{"id": p, "title": by_id[p]["title"], "type": by_id[p]["type"]} for p in tight]

    related = {}
    for eid, rels in per_entity.items():
        rels.sort(key=lambda x: (-score(x[0], x[2]), x[0]))
        related[eid] = [
            {"id": rid, "count": len(pages), "type": by_id[rid]["type"],
             "title": by_id[rid]["title"], "summary": by_id[rid].get("summary"),
             "via": via(eid, pages)}
            for rid, pages, _ in rels[:top_n]
        ]

    inbound: dict[str, set[str]] = defaultdict(set)
    for s, t, _, _ in resolved_edges(edges, by_id):
        inbound[t].add(s)
    mention_count = {eid: len(srcs) for eid, srcs in inbound.items()}
    page_density = {eid: len(ents) for eid, ents in page_ents.items()}
    return related, mention_count, page_density


# ---------- implicit links (NER) ----------

# Surface forms spelled like proper nouns that are not entity references.
NER_STOPWORDS = {
    "the", "and", "but", "for", "with", "from", "into", "about", "also",
    "this", "that", "these", "those", "they", "them", "their", "there",
    "when", "where", "what", "which", "who", "whom", "whose", "while",
    "would", "could", "should", "after", "before", "during", "between",
    "us", "usa", "u.s.", "u.s", "u.s.a", "u.s.a.",
    "ad", "bc", "ce", "bce",
    "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
}

# Link displays like [[United States|American]] or [[Nancy Hamilton|wife]] that must
# never be mined as aliases, or every "American" or "wife" in prose would match.
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
    # Generic institutions; each vault page is one specific instance
    "superior court", "labor",
}

NER_MIN_ALIAS_LEN = 3
# A display used only once is usually contextual phrasing, not a name.
NER_MIN_MINED_DISPLAY_COUNT = 2
TITLE_TOKEN = re.compile(r"[A-Za-z][\w'’.-]*")


def build_alias_map(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, list[tuple[str, int]]]]:
    """Case-sensitive surface form -> entity id, for implicit-link discovery.

    Candidates are weighted: title 100, frontmatter alias 50, a [[Target|Display]]
    display its use count (max 20). A form claimed by several entities goes to
    the top one only if it outweighs the runner-up 3:1. Returns (resolved, ambiguous).
    """
    by_id = {e["id"]: e for e in entities}
    candidates: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def add(alias: str, eid: str, weight: int) -> None:
        a = alias.strip()
        if len(a) >= NER_MIN_ALIAS_LEN and a.lower() not in NER_STOPWORDS and any(c.isalpha() for c in a):
            candidates[a][eid] += weight

    for e in entities:
        add(e["title"], e["id"], 100)
    for e in entities:
        for a in entity_aliases(e):
            add(a, e["id"], 50)

    # A one-word display found in 2+ other titles ("King") is a surname or common
    # noun; a lowercase display must be the target's own title ("remote viewing").
    title_owners: dict[str, set[str]] = defaultdict(set)
    for e in entities:
        for tok in TITLE_TOKEN.findall(e["title"]):
            title_owners[tok].add(e["id"])

    def mined_display_ok(disp: str, tid: str) -> bool:
        if disp[0].islower():
            return disp.lower() == by_id[tid]["title"].lower()
        return " " in disp or len(title_owners.get(disp, set()) - {tid}) < 2

    display_counts: Counter = Counter()
    for edge in edges:
        tid = edge["target_id"]
        disp = edge["display"].strip()
        if (tid and disp and disp != edge["target_title"]
                and disp.lower() not in NER_GENERIC_DISPLAY_BLOCKLIST
                and mined_display_ok(disp, tid)):
            display_counts[(disp, tid)] += 1
    for (disp, tid), count in display_counts.items():
        if count >= NER_MIN_MINED_DISPLAY_COUNT:
            add(disp, tid, min(count, 20))

    resolved: dict[str, str] = {}
    ambiguous: dict[str, list[tuple[str, int]]] = {}
    for alias, by_eid in candidates.items():
        ranked = sorted(by_eid.items(), key=lambda kv: -kv[1])
        if len(ranked) == 1 or ranked[0][1] >= 3 * ranked[1][1]:
            resolved[alias] = ranked[0][0]
        else:
            ambiguous[alias] = ranked[:4]
    return resolved, ambiguous


# Regions never scanned for implicit mentions.
_MASKED = (
    re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~"),
    re.compile(r"`[^`\n]+`"),
    re.compile(r"\[\[[^\]]+?\]\]"),
    re.compile(r"\[[^\]]+\]\([^)]+\)"),
    FN_REF,
    TAG,
)


def _mask_regions(text: str) -> str:
    """Blank out code, links and tags with spaces, keeping offsets intact."""
    out = list(text)
    for rx in _MASKED:
        for m in rx.finditer(text):
            out[m.start():m.end()] = " " * (m.end() - m.start())
    return "".join(out)


def _trie_regex(words) -> str:
    """Alternation of `words` as a prefix trie, longest match first.

    A flat A|B|C retries every alternative at each character; a trie fails on the
    first mismatch, which matters with thousands of aliases.
    """
    trie: dict[str, Any] = {}
    for w in words:
        node = trie
        for ch in w:
            node = node.setdefault(ch, {})
        node[""] = True

    def emit(node: dict[str, Any]) -> str:
        alts = [re.escape(ch) + emit(sub) for ch, sub in sorted(node.items()) if ch]
        if not alts:
            return ""
        body = alts[0] if len(alts) == 1 else "(?:" + "|".join(alts) + ")"
        return f"(?:{body})?" if "" in node else body
    return emit(trie)


# Capitalized words that can stand before a surname without being a first name.
NER_NAME_PREFIXES = {
    "The", "A", "An", "In", "On", "At", "By", "For", "From", "With", "And", "But", "Or", "Nor", "As",
    "After", "Before", "During", "When", "While", "Under", "Over", "Then", "Both", "If", "Of", "To",
    "That", "This", "These", "Those", "Its", "His", "Her", "Their", "Our", "My", "Although", "Because",
    "Since", "Until", "Unlike", "Like", "Via", "Among", "Against", "Between", "Through", "Within",
    "Without", "Why", "How", "Where", "What", "Who", "Whom", "Whose", "Which", "Once", "Also", "Even",
    "Only", "Later", "Soon", "Meanwhile", "However", "Instead", "Thus", "Yet", "So", "Not", "No",
    "Each", "Every", "All", "Some", "Many", "Most", "Several", "Neither", "Either",
    "President", "Presidents", "Senator", "Senators", "Representative", "Congressman",
    "Congresswoman", "Governor", "Governors", "Mayor", "Judge", "Judges", "Justice", "Justices",
    "General", "Generals", "Admiral", "Colonel", "Captain", "Lieutenant", "Major", "Sergeant",
    "Agent", "Director", "Secretary", "Ambassador", "Minister", "Chairman", "Chancellor", "King",
    "Queen", "Prince", "Princess", "Pope", "Father", "Sister", "Sisters", "Brother", "Brothers",
    "Rabbi", "Reverend", "Sir", "Lord", "Lady", "Dame", "Professor", "Detective", "Officer",
    "Sheriff", "Former", "Late", "Young", "Vice", "Deputy", "Acting", "Chief", "Prime", "Premier",
    "Emperor", "Shah", "Sheikh", "Crown", "Attorney", "Commissioner", "Inspector", "Superintendent",
    "Dr", "Mr", "Mrs", "Ms", "St", "Gen", "Col", "Lt", "Sgt", "Capt", "Adm", "Sen", "Rep", "Gov",
    "Prof", "Rev",
}
_WORD_BEFORE = re.compile(r"([A-Z][\w'’.]*) $")


def _names_someone_else(text: str, start: int, surface: str, common: set[str]) -> bool:
    """True when a one-word person alias is really part of another name.

    "Sybol Kennedy" and "James Bond" are other people; "President Kennedy",
    "Carter-Ford" and "E.D. Nixon" are left alone (titles, pairs, initials).
    Headings are Title Case, so there only a common word ("Texts to Begin With") is skipped.
    """
    line_start = text.rfind("\n", 0, start) + 1
    if text[line_start:start].lstrip().startswith("#"):
        return surface.lower() in common
    before = _WORD_BEFORE.search(text, max(line_start, start - 40), start)
    if not before:
        return False
    word = before.group(1)
    return word not in NER_NAME_PREFIXES and not word.endswith(("'s", "’s", "."))


def find_implicit_links(
    entities: list[dict[str, Any]], alias_map: dict[str, str], explicit_edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """One implicit edge per (page, entity) named in the page's prose but not wikilinked.

    Matching is case-sensitive, so 'Bell' matches and the ordinary word 'bell' does not.
    """
    if not alias_map:
        return [], {"implicit_edge_count": 0}

    linked: dict[str, set[str]] = defaultdict(set)
    for edge in explicit_edges:
        if edge["target_id"]:
            linked[edge["source"]].add(edge["target_id"])

    # `\b` misbehaves on multi-word and accented forms, so reject an
    # adjacent letter or digit with lookarounds instead.
    pattern = re.compile(rf"(?<![A-Za-z0-9])(?:{_trie_regex(alias_map)})(?![A-Za-z0-9])")

    type_of = {e["id"]: e["type"] for e in entities}
    word_counts: Counter = Counter()
    for e in entities:
        word_counts.update(re.findall(r"\b[a-z]+\b", e.get("body_md") or ""))
    common = {w for w, n in word_counts.items() if n >= 5}
    # Surnames and first names of people: the forms another person can share.
    name_like = {a for a, t in alias_map.items()
                 if type_of[t] == "person" and " " not in a and a[0].isupper()
                 and sum(c.isupper() for c in a) * 2 < len(a)}

    implicit_edges = []
    surface_counts: Counter = Counter()
    pages_touched = self_skipped = linked_skipped = other_name_skipped = 0
    for e in entities:
        body = e.get("body_md")
        if not body:
            continue
        already = linked.get(e["id"], set())
        per_target: dict[str, dict[str, Any]] = {}
        masked = _mask_regions(body)
        for m in pattern.finditer(masked):
            surface = m.group(0)
            target_id = alias_map[surface]
            if target_id == e["id"]:
                self_skipped += 1
                continue
            if target_id in already:
                linked_skipped += 1
                continue
            if surface in name_like and _names_someone_else(masked, m.start(), surface, common):
                other_name_skipped += 1
                continue
            entry = per_target.setdefault(target_id, {
                "source": e["id"], "target_id": target_id, "surface": surface,
                "count": 0, "kind": "implicit",
            })
            entry["count"] += 1
            surface_counts[surface] += 1
        pages_touched += bool(per_target)
        implicit_edges.extend(per_target.values())

    return implicit_edges, {
        "implicit_edge_count": len(implicit_edges),
        "implicit_pages_touched": pages_touched,
        "implicit_self_refs_skipped": self_skipped,
        "implicit_already_linked_skipped": linked_skipped,
        "implicit_other_name_skipped": other_name_skipped,
        "top_implicit_surfaces": surface_counts.most_common(25),
    }


# ---------- HTML ----------

# Wikilinks and footnote refs are never rewritten inside <code>/<pre> or inside
# a tag's attributes. Other tags stay in play so [[X|*X*]] still matches.
_NOT_TEXT = re.compile(r"<(code|pre)[^>]*>.*?</\1>|<[^>]*\[[\[^][^>]*>", re.DOTALL)
# Autolinking skips existing anchors and tags.
_NOT_BARE = re.compile(r"<a\b[^>]*>.*?</a>|<[^>]+>", re.DOTALL | re.IGNORECASE)
# Bare http(s) URLs; quotes, whitespace and angle brackets end one.
_BARE_URL = re.compile(r'\bhttps?://[^\s<>"\'`)]+', re.IGNORECASE)
# Sentence punctuation that trails a URL far more often than it belongs to it.
_URL_TRAILING_PUNCT = ".,;:!?)]}'\""
HEADING = re.compile(r"<h([234])(?![^>]*\bid=)([^>]*)>(.*?)</h\1>", re.DOTALL)


def _map_text(rendered: str, skip: re.Pattern, fn) -> str:
    """Apply fn to the stretches of `rendered` between `skip` matches."""
    out, last = [], 0
    for m in skip.finditer(rendered):
        out += [fn(rendered[last:m.start()]), m.group(0)]
        last = m.end()
    out.append(fn(rendered[last:]))
    return "".join(out)


def _autolink_one(m: re.Match) -> str:
    url, trail = m.group(0), ""
    while url[-1] in _URL_TRAILING_PUNCT:
        url, trail = url[:-1], url[-1] + trail
    # Wikipedia-style URLs contain balanced parens; an unmatched ")" closes prose.
    if url.endswith(")") and url.count("(") < url.count(")"):
        url, trail = url[:-1], ")" + trail
    return f'<a href="{url}" rel="noopener noreferrer" target="_blank">{url}</a>{trail}'


def autolink_urls(rendered: str) -> str:
    """Link bare URLs (markdown-it's linkify needs the extra linkify-it-py package)."""
    return _map_text(rendered, _NOT_BARE, lambda s: _BARE_URL.sub(_autolink_one, s))


def _process_headings(rendered: str) -> tuple[str, list[dict[str, Any]]]:
    """Give every h2-h4 a unique id. Returns (html, toc entries)."""
    toc: list[dict[str, Any]] = []
    seen: Counter = Counter()

    def repl(m: re.Match) -> str:
        level, attrs, inner = int(m.group(1)), m.group(2), m.group(3)
        text = TAG.sub("", inner).strip()
        if not text:
            return m.group(0)
        base = slugify(text)
        seen[base] += 1
        slug = base if seen[base] == 1 else f"{base}-{seen[base]}"
        toc.append({"level": level, "text": text, "id": slug})
        return f'<h{level} id="{slug}"{attrs}>{inner}</h{level}>'

    return HEADING.sub(repl, rendered), toc


def render_html(entities: list[dict[str, Any]], slug_index: dict[str, str]) -> None:
    """Add body_html and toc to each entity, and html to each footnote."""
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    href_for = make_href_resolver(entities, slug_index)

    def wikilink(m: re.Match) -> str:
        target, display, section = split_wikilink(m)
        target = html.unescape(target)  # markdown-it has already escaped '&' and '"'
        href = href_for(target, section)
        if href:
            return f'<a class="wikilink" href="{href}">{display}</a>'
        # The client turns a click into a vault search for the name.
        return (f'<a class="wikilink unresolved" href="#" data-target="{html.escape(target, quote=True)}" '
                f'title="No entry for this yet. Click to search the vault.">{display}</a>')

    def footnote_ref(m: re.Match) -> str:
        fid = m.group(1).strip()
        return f'<sup class="fn-ref"><a href="#fn-{fid}" id="fnref-{fid}">{fid}</a></sup>'

    def rewrite(rendered: str) -> str:
        return autolink_urls(_map_text(
            rendered, _NOT_TEXT, lambda s: FN_REF.sub(footnote_ref, WIKILINK.sub(wikilink, s))))

    for e in entities:
        e["body_html"], e["toc"] = _process_headings(rewrite(md.render(EMBED.sub("", e["body_md"]))))
        for fn in e["footnotes"]:
            fn["html"] = rewrite(md.renderInline(fn["text"]))


# ---------- graph ----------

def build_adjacency(entities: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    """Undirected link graph as parallel arrays by node index, for the path finder and /network/."""
    ids = [e["id"] for e in entities]
    idx = {eid: i for i, eid in enumerate(ids)}
    adj_sets: list[set[int]] = [set() for _ in ids]
    explicit: set[tuple[int, int]] = set()  # (i, j): i's page links j
    for s, t, kind, _ in resolved_edges(edges, idx):
        si, ti = idx[s], idx[t]
        adj_sets[si].add(ti)
        adj_sets[ti].add(si)
        if kind == "explicit":
            explicit.add((si, ti))
    adj = [sorted(s) for s in adj_sets]
    return {
        "ids": ids,
        "titles": [e["title"] for e in entities],
        "types": [e["type"] for e in entities],
        "adj": adj,
        # Per neighbour j of i: bit 1 = i's page links j, bit 2 = j's page links i.
        "dir": [[(1 if (i, j) in explicit else 0) | (2 if (j, i) in explicit else 0) for j in nb]
                for i, nb in enumerate(adj)],
        "mentions": [e.get("mention_count", 0) for e in entities],
        "bridges": {},  # filled in by main()
        "hubs": {},
        # Pairs with no explicit link either way, drawn dashed under "+ Inferred".
        "implicitPairs": [[i, j] for i, nb in enumerate(adj) for j in nb
                          if j > i and (i, j) not in explicit and (j, i) not in explicit],
    }


def compute_hub_scores(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]], top_n: int = 50,
) -> dict[str, dict[str, Any]]:
    """Top rankable entities by PageRank over the directed link graph.

    Directed, so only being linked to counts: undirected PageRank collapses to
    degree and would crown narrative pages that merely link out a lot.
    """
    if len(entities) < 3:
        return {}
    valid = {e["id"] for e in entities}
    weights: Counter = Counter()
    for s, t, _, w in resolved_edges(edges, valid):
        weights[(s, t)] += w
    g = nx.DiGraph()
    # Entity order, not a set: node order fixes PageRank's float summation order.
    g.add_nodes_from(e["id"] for e in entities)
    g.add_weighted_edges_from((s, t, w) for (s, t), w in weights.items())
    pr = nx.pagerank(g, alpha=0.85, weight="weight")
    rankable = {e["id"] for e in entities if e["type"] in RANKABLE_TYPES}
    ranked = sorted(((k, v) for k, v in pr.items() if k in rankable), key=lambda kv: -kv[1])
    return {eid: {"score": score, "rank": rank}
            for rank, (eid, score) in enumerate(ranked[:top_n], start=1)}


def compute_bridge_scores(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]],
    resolution: float, exclude_types: set[str], top_n: int = 50,
) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Louvain communities, and the entities cited from the most communities.

    For an entity cited by m pages spread over k communities with entropy H,
    score = H * log(1 + k) / sqrt(m). Only inbound citations count, so a stub
    that links out widely does not qualify; sqrt(m) keeps mega-hubs off the top.

    Returns ({id: {score, rank, community_id, community_span}}, {id: community}).
    """
    if len(entities) < 3:
        return {}, {}
    type_of = {e["id"]: e["type"] for e in entities}
    pair_w: Counter = Counter()
    for s, t, _, w in resolved_edges(edges, type_of):
        pair_w[(s, t) if s < t else (t, s)] += w
    neighbours: dict[str, Counter] = defaultdict(Counter)
    for (a, b), w in pair_w.items():
        neighbours[a][b] = neighbours[b][a] = w

    # Places and index notes would glue every story into one community, so
    # detect without them, then hang each on its neighbours' main community.
    keep = {n for n, t in type_of.items() if t not in exclude_types}
    # Built in entity order: Louvain depends on iteration order, and a
    # g.subgraph() view iterates a set.
    g = nx.Graph()
    g.add_nodes_from(n for n in type_of if n in keep)
    g.add_weighted_edges_from((a, b, w) for (a, b), w in pair_w.items() if a in keep and b in keep)
    communities = nx.community.louvain_communities(g, weight="weight", resolution=resolution, seed=42)
    cid_of = {n: cid for cid, members in enumerate(communities) for n in members}
    community_of = {n: cid_of[n] for n in type_of if n in cid_of}
    for node in type_of:  # in order: earlier attachments vote for later ones
        if node in keep:
            continue
        votes: Counter = Counter()
        for nb, w in neighbours[node].items():
            if nb in community_of:
                votes[community_of[nb]] += w
        if votes:
            community_of[node] = votes.most_common(1)[0][0]

    # Below this many citing pages, entropy is noise (3 pages from 3 clusters).
    min_inbound = 4
    bridge_types = RANKABLE_TYPES - {"place"}  # places span every cluster by nature
    # A dict as an ordered set, so the entropy below sums in a fixed order.
    inbound: dict[str, dict[str, None]] = defaultdict(dict)
    # Wikilinks only: a stray NER match ("Bond" in "James Bond") lands in an
    # unrelated cluster, which is exactly what this score rewards.
    for s, t, kind, _ in resolved_edges(edges, type_of):
        if kind == "explicit":
            inbound[t][s] = None

    scores = {}
    for node, sources in inbound.items():
        m = len(sources)
        if m < min_inbound or type_of[node] not in bridge_types:
            continue
        bucket = Counter(community_of.get(src, -1) for src in sources)
        if len(bucket) < 2:
            continue
        h = 0.0
        for n in bucket.values():
            h -= n / m * math.log(n / m)
        scores[node] = {
            "score": h * math.log(1 + len(bucket)) / math.sqrt(m),
            "community_id": community_of.get(node, -1),
            "community_span": len(bucket),
        }
    ranked = sorted(scores.items(), key=lambda kv: -kv[1]["score"])[:top_n]
    return {eid: {**p, "rank": rank} for rank, (eid, p) in enumerate(ranked, start=1)}, community_of


def summarize_communities(
    entities: list[dict[str, Any]], community_of: dict[str, int], top_n: int = 12,
) -> list[dict[str, Any]]:
    """One record per community id: a label from its top members, size, type mix, top members."""
    by_id = {e["id"]: e for e in entities}
    members: dict[int, list[str]] = defaultdict(list)
    for eid, cid in community_of.items():
        if eid in by_id:
            members[cid].append(eid)
    out = []
    for cid in range(max(members, default=-1) + 1):
        ids = members.get(cid, [])
        ranked = sorted(ids, key=lambda i: (-by_id[i].get("mention_count", 0), by_id[i]["title"]))
        # A country in every label says nothing, so places only fill gaps.
        rankable = [i for i in ranked if by_id[i]["type"] in RANKABLE_TYPES]
        namers = [i for i in rankable if by_id[i]["type"] != "place"][:3]
        namers += [i for i in rankable if i not in namers][:3 - len(namers)]
        namers = namers or ranked[:3]
        out.append({
            "id": cid,
            "label": " · ".join(by_id[i]["title"] for i in namers) or f"Cluster {cid + 1}",
            "size": len(ids),
            "types": dict(Counter(by_id[i]["type"] for i in ids).most_common()),
            "top": [{"id": i, "title": by_id[i]["title"], "type": by_id[i]["type"],
                     "mention_count": by_id[i].get("mention_count", 0)}
                    for i in ranked[:top_n]],
        })
    return out


def compute_layout_positions(adjacency: dict[str, Any], cache_path: Path) -> list[list[float]]:
    """Spring layout for /network/, normalized to [0, 1000]^2 and parallel to ids.

    Cached by graph shape, since an unchanged graph gives the same layout.
    Bump LAYOUT_VERSION when the solver parameters change.
    """
    n = len(adjacency["ids"])
    LAYOUT_VERSION = "spring:k=1/sqrt(n),it=50,seed=42,v1"
    h = hashlib.sha256(LAYOUT_VERSION.encode())
    h.update(json.dumps(adjacency["ids"], separators=(",", ":")).encode())
    h.update(json.dumps(adjacency["adj"], separators=(",", ":")).encode())
    key = h.hexdigest()
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if cached.get("key") == key and isinstance(cached.get("positions"), list) \
                and len(cached["positions"]) == n:
            print("[layout] cache hit, graph unchanged")
            return cached["positions"]
    except (OSError, ValueError):
        pass

    g = nx.Graph()
    g.add_nodes_from(range(n))
    g.add_edges_from((i, j) for i, nb in enumerate(adjacency["adj"]) for j in nb if j > i)
    pos = nx.spring_layout(g, k=1.0 / (n ** 0.5), iterations=50, seed=42)
    xs = [pos[i][0] for i in range(n)]
    ys = [pos[i][1] for i in range(n)]
    xmin, ymin = min(xs), min(ys)
    dx = max(xs) - xmin or 1.0
    dy = max(ys) - ymin or 1.0
    positions = [[round((pos[i][0] - xmin) / dx * 1000, 2), round((pos[i][1] - ymin) / dy * 1000, 2)]
                 for i in range(n)]
    try:
        cache_path.write_text(json.dumps({"key": key, "positions": positions}, separators=(",", ":")),
                              encoding="utf-8")
    except OSError:
        pass  # the cache is only an optimisation
    return positions


# ---------- In focus (homepage) ----------

def git_edit_counts(vault_root: Path, days: int = 30) -> Counter:
    """Commits per vault-relative .md path in the last `days` days.

    Empty when the vault is not a git checkout. File mtimes are no substitute:
    every pull resets them.
    """
    try:
        out = subprocess.run(
            # quotePath=false keeps non-ASCII paths unquoted; --relative makes paths
            # vault-relative when the vault is a subfolder of a repo.
            ["git", "-C", str(vault_root), "-c", "core.quotePath=false", "log", "--relative",
             f"--since={days}.days", "--name-only", "--pretty=format:"],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return Counter()
    return Counter(line.strip() for line in out.splitlines() if line.strip().endswith(".md"))


def read_focus_pins(path: Path | None, slug_index: dict[str, str]) -> list[str]:
    """Entity ids wikilinked from the focus note, in order."""
    if path is None:
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    ids = (slug_index.get(normalize_target(t)) for t in re.findall(r"\[\[([^\]|#]+)", text))
    return list(dict.fromkeys(i for i in ids if i))


def compute_focus(
    entities: list[dict[str, Any]], edges: list[dict[str, Any]],
    communities: list[dict[str, Any]], edits: Counter,
    pins: list[str], slots: int = 3, days: int = 30,
) -> dict[str, Any]:
    """Pages with momentum, for the homepage.

    Score is the page's own commits plus the commits to pages linking it, as a
    share of its linkers so mega-hubs do not win on volume, scaled by
    log(mentions). Pins take the first slots. The cluster is the community
    with the most edited member pages.
    """
    by_id = {e["id"]: e for e in entities}
    own = Counter({e["id"]: edits[e["path"]] for e in entities if edits[e["path"]]})
    linked: Counter = Counter()
    for edge in edges:
        t = edge.get("target_id")
        if t and t != edge["source"] and own[edge["source"]]:
            linked[t] += own[edge["source"]]
    scored = []
    for e in entities:
        if e["type"] in FOCUS_TYPES and e.get("summary") and own[e["id"]]:
            m = e.get("mention_count", 0)
            scored.append((own[e["id"]] + linked[e["id"]] / max(1, m) * math.log(2 + m), e["id"]))
    scored.sort(key=lambda t: (-t[0], t[1]))
    chosen = [i for i in pins if i in by_id][:slots]
    chosen += [i for _, i in scored if i not in chosen][:slots - len(chosen)]

    def plural(n: int, word: str) -> str:
        return f"{n} {word}{'s' if n != 1 else ''}"

    pages = []
    for i in chosen:
        parts = []
        if own[i]:
            parts.append(plural(own[i], "edit"))
        if linked[i]:
            parts.append(plural(linked[i], "linking page") + " edited")
        pages.append({"id": i, "pinned": i in pins,
                      "reason": f"{', '.join(parts)} in the last {days} days" if parts else ""})

    edited_in = Counter(e["community_id"] for e in entities
                        if own[e["id"]] and e.get("community_id") is not None)
    cluster = None
    if edited_in:
        cid, n = max(edited_in.items(), key=lambda t: (t[1], -t[0]))
        c = communities[cid]
        cluster = {"id": cid, "label": c["label"], "size": c["size"], "edited": n, "days": days}
    return {"days": days, "pages": pages, "cluster": cluster}


# ---------- output ----------

def write_entity_markdown(out_dir: Path, entities: list[dict[str, Any]],
                          slug_index: dict[str, str]) -> None:
    """Write md/<type-dir>/<slug>.md per entity, served beside its HTML page for LLM tools.

    Wikilinks become site URLs and footnote definitions are re-appended, so each file stands alone.
    """
    href_for = make_href_resolver(entities, slug_index)

    def md_link(m: re.Match) -> str:
        target, display, section = split_wikilink(m)
        href = href_for(target, section)
        if not href:
            return display
        display = display.replace("]", r"\]")
        return f"[{display}]({href})"

    written = set()
    for e in entities:
        body = WIKILINK.sub(md_link, e["body_md"])
        if e["footnotes"]:
            body = body.rstrip() + "\n\n" + "\n".join(
                f"[^{n['id']}]: {n['text']}" for n in e["footnotes"]) + "\n"
        post = frontmatter.Post(body, **e["frontmatter"])
        target_dir = out_dir / "md" / TYPE_DIRS.get(e["type"], "pages")
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{e['id']}.md"
        path.write_bytes(frontmatter.dumps(post).encode("utf-8") + b"\n")
        written.add(path)
    # A deleted or renamed note must not stay published from a previous build.
    for stale in set((out_dir / "md").glob("*/*.md")) - written:
        stale.unlink()


def write_outputs(out_dir: Path, entities: list[dict[str, Any]], slug_index: dict[str, str],
                  edges: list[dict[str, Any]], related: dict[str, list[dict[str, Any]]],
                  adjacency: dict[str, Any], communities: list[dict[str, Any]],
                  focus: dict[str, Any], stats: dict[str, Any]) -> None:
    write_entity_markdown(out_dir, entities, slug_index)
    write_json(out_dir / "entities.json", entities, pretty=True)
    write_json(out_dir / "slug_index.json", slug_index, pretty=True)
    write_json(out_dir / "links.json", edges, pretty=True)
    write_json(out_dir / "related.json", related, pretty=True)
    write_json(out_dir / "stats.json", stats, pretty=True)
    write_json(out_dir / "adjacency.json", adjacency)
    write_json(out_dir / "communities.json", communities)
    write_json(out_dir / "focus.json", focus)

    # Newest first, for /changelog/.
    activity = [{k: e.get(k) for k in ("id", "title", "type", "category", "summary", "mtime")}
                for e in entities if e.get("mtime")]
    activity.sort(key=lambda x: x["mtime"], reverse=True)
    write_json(out_dir / "activity.json", activity)

    # Hover previews. `related` is bare ids, since every id has its own entry here.
    write_json(out_dir / "previews.json", {
        e["id"]: {"title": e["title"], "type": e["type"], "category": e["category"],
                  "summary": e["summary"], "related": [r["id"] for r in related.get(e["id"], [])[:5]]}
        for e in entities
    })

    with (out_dir / "corpus.jsonl").open("w", encoding="utf-8") as f:
        for e in entities:
            f.write(json.dumps({
                "id": e["id"], "title": e["title"], "type": e["type"],
                "category": e["category"], "tags": e["tags"], "summary": e["summary"],
                "text": TAG.sub("", e["body_html"]),
            }, ensure_ascii=False, default=_json_default) + "\n")


def load_config(path: Path | None) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if path and path.is_file():
        cfg.update({k: v for k, v in json.loads(path.read_text(encoding="utf-8")).items() if v is not None})
    # User patterns add to the defaults so .obsidian/ and .trash/ are never published.
    cfg["skipPathPatterns"] = DEFAULT_CONFIG["skipPathPatterns"] + [
        p for p in cfg["skipPathPatterns"] if p not in DEFAULT_CONFIG["skipPathPatterns"]]
    return cfg


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="Parse an Obsidian vault into JSON.")
    ap.add_argument("--vault", type=Path, required=True, help="Vault root")
    ap.add_argument("--config", type=Path, default=repo / "config.json",
                    help="Config file (default: config.json in the repo, if present)")
    ap.add_argument("--out", type=Path, default=repo / "data",
                    help="Output directory (default: data/ in the repo)")
    args = ap.parse_args()

    cfg = load_config(args.config)
    vault_root = args.vault.resolve()
    if not vault_root.exists():
        sys.stderr.write(f"[err] vault path does not exist: {vault_root}\n")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)  # the layout cache is written before the outputs
    t0 = time.time()
    md_files = []
    for p in sorted(vault_root.rglob("*.md")):
        if should_skip(p.relative_to(vault_root), cfg["skipPathPatterns"]):
            continue
        # A symlink must not publish a file from outside the vault.
        if not p.resolve().is_relative_to(vault_root):
            sys.stderr.write(f"[warn] skipping link out of the vault: {p}\n")
            continue
        md_files.append(p)
    print(f"[parse] {len(md_files)} markdown files in {vault_root}")

    entities = []
    seen_ids: set[str] = set()
    mojibake_files = []
    mojibake_fixes = 0
    for p in md_files:
        e = parse_file(p, vault_root, cfg["typeMap"])
        if not e:
            continue
        if (n := e.pop("mojibake_fixes")):
            mojibake_fixes += n
            mojibake_files.append(e["path"])
        # Two titles can slugify alike: suffix -2, -3, ... in parse order.
        base, i = e["id"], 2
        while e["id"] in seen_ids:
            e["id"] = f"{base}-{i}"
            i += 1
        seen_ids.add(e["id"])
        entities.append(e)

    slug_index = build_slug_index(entities)
    edges, unresolved = resolve_links(entities, slug_index)
    resolve_relations(entities, slug_index)

    alias_map, ambiguous_aliases = build_alias_map(entities, edges)
    implicit_edges, ner_stats = find_implicit_links(entities, alias_map, edges)
    edges.extend(implicit_edges)

    render_html(entities, slug_index)
    related, mention_count, page_density = compute_relationships(entities, edges)
    for e in entities:  # before build_adjacency, which reads mention_count
        e["mention_count"] = mention_count.get(e["id"], 0)
        e["page_density"] = page_density.get(e["id"], 0)
    adjacency = build_adjacency(entities, edges)

    print(f"[parse] computing Hub PageRank ({len(entities)} nodes)...")
    t = time.time()
    hubs = compute_hub_scores(entities, edges)
    print(f"[parse] hubs done in {time.time() - t:.2f}s")

    print("[parse] detecting communities + Bridge entropy...")
    t = time.time()
    bridges, community_of = compute_bridge_scores(
        entities, edges, resolution=float(cfg["clusterResolution"]),
        exclude_types=set(cfg["clusterExcludeTypes"]))
    print(f"[parse] bridges done in {time.time() - t:.2f}s "
          f"({len(set(community_of.values()))} communities)")

    for e in entities:
        eid = e["id"]
        if eid in hubs:
            e["hub_rank"] = hubs[eid]["rank"]
            e["hub_score"] = hubs[eid]["score"]
        if eid in bridges:
            e["bridge_rank"] = bridges[eid]["rank"]
            e["bridge_score"] = bridges[eid]["score"]
            e["community_span"] = bridges[eid]["community_span"]
        if eid in community_of:
            e["community_id"] = community_of[eid]

    print("[parse] pre-computing network layout positions...")
    t = time.time()
    adjacency["positions"] = compute_layout_positions(adjacency, args.out / ".layout_cache.json")
    print(f"[parse] layout done in {time.time() - t:.1f}s")

    ids = adjacency["ids"]
    adjacency["bridges"] = {
        str(i): {"rank": bridges[eid]["rank"], "score": bridges[eid]["score"],
                 "span": bridges[eid]["community_span"]}
        for i, eid in enumerate(ids) if eid in bridges
    }
    # Alias surface forms other than titles, for the search modal's quick match.
    idx_of = {eid: i for i, eid in enumerate(ids)}
    titles = {e["title"] for e in entities}
    aliases: dict[str, list[str]] = defaultdict(list)
    for surface, eid in alias_map.items():
        if surface not in titles:
            aliases[str(idx_of[eid])].append(surface)
    adjacency["aliases"] = dict(aliases)
    adjacency["communities"] = [community_of.get(eid, -1) for eid in ids]
    communities = summarize_communities(entities, community_of)
    adjacency["communityLabels"] = [c["label"] for c in communities]
    adjacency["hubs"] = {str(i): {"rank": hubs[eid]["rank"], "score": hubs[eid]["score"]}
                         for i, eid in enumerate(ids) if eid in hubs}

    backlinks = Counter(edge["target_id"] for edge in edges if edge["target_id"])
    explicit = [edge for edge in edges if edge["kind"] == "explicit"]
    type_counts = Counter(e["type"] for e in entities)
    stats = {
        "entity_count": len(entities),
        "edge_count": len(edges),
        "explicit_edges": len(explicit),
        "resolved_edges": sum(1 for edge in explicit if edge["target_id"]),
        "unresolved_edges": sum(1 for edge in explicit if not edge["target_id"]),
        "by_type": dict(type_counts),
        "untyped_examples": [e["path"] for e in entities if e["type"] == "page"][:20],
        "entities_missing_category": sum(1 for e in entities if not e["category"] and e["type"] != "meta"),
        "top_unresolved_targets": unresolved.most_common(25),
        "orphan_examples": [e["id"] for e in entities if not backlinks[e["id"]] and not e["wikilinks"]][:30],
        "mojibake_fixes": mojibake_fixes,
        "mojibake_files": len(mojibake_files),
        "mojibake_examples": sorted(mojibake_files)[:10],
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

    focus_file = vault_root / cfg["focusFile"] if cfg["focusFile"] else None
    focus = compute_focus(entities, edges, communities, git_edit_counts(vault_root),
                          read_focus_pins(focus_file, slug_index))
    write_outputs(args.out, entities, slug_index, edges, related, adjacency, communities, focus, stats)

    print(f"[focus] pages={[p['id'] for p in focus['pages']]} "
          f"cluster={focus['cluster'] and focus['cluster']['label']}")
    print(f"[done] {len(entities)} entities, {len(edges)} edges "
          f"({stats['resolved_edges']} resolved, {stats['unresolved_edges']} unresolved) "
          f"in {stats['parse_seconds']}s")
    print(f"[done] by type: {dict(type_counts)}")
    print(f"[done] wrote {args.out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
