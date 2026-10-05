"""Bulk research data for the Worker's research tools, also served as public downloads.

    python build/research.py --data data

Reads the parser's entities.json and writes to <data>/research/:
    entries.json  one record per entry: frontmatter fields (no body) and typed relations,
                  each with the text of the footnote that sources it
    fulltext.json     {"sections": [[entry id, anchor, heading, text]], "footnotes": {entry id:
                  {footnote id: text}}}. Section text is plain (link markup reduced to its
                  visible text) and keeps its [^n] footnote markers.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed import _HEADING, _heading_key, aliases_of, plain, write_atomic  # noqa: E402
from parse_vault import TYPE_DIRS  # noqa: E402

FIELDS = ("category", "summary", "tags", "location", "created", "updated")
# Typographic punctuation to ASCII, so V8 holds nearly every string at one byte per character:
# fulltext.json parsed in the Worker drops from about 54 MB of heap to about half.
_ASCII = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-",
                        "\u2014": "-", "\u2026": "...", "\u00a0": " "})


def sections(e: dict[str, Any]) -> list[list[str]]:
    """[anchor, heading, text] per heading section, anchors matched to the parser's toc."""
    toc = [(_heading_key(t["text"]), t["id"]) for t in e.get("toc") or []]
    out: list[list[Any]] = [["", "", []]]
    for line in (e.get("body_md") or "").splitlines():
        m = _HEADING.match(line)
        if not m:
            out[-1][2].append(line)
            continue
        key, anchor = _heading_key(m.group(2)), ""
        for j, (k, tid) in enumerate(toc):
            if k == key:
                anchor = tid
                del toc[:j + 1]
                break
        out.append([anchor, re.sub(r"[*`]", "", plain(m.group(2))).strip(), []])
    return [[a, h, t] for a, h, lines in out if (t := plain("\n".join(lines), keep_notes=True).strip().translate(_ASCII))]


def record(e: dict[str, Any], notes: dict[str, dict[str, str]]) -> dict[str, Any]:
    fm = e.get("frontmatter") or {}
    r: dict[str, Any] = {
        "id": e["id"], "title": e["title"].translate(_ASCII), "type": e["type"],
        "path": f"/{TYPE_DIRS.get(e['type'], 'pages')}/{e['id']}/",
        # ASCII like the section text, so the Worker's title and alias matching finds them there.
        "aliases": [a.translate(_ASCII) for a in aliases_of(fm)], "dates": e.get("dates") or {},
    }
    r.update({k: fm[k] for k in FIELDS if fm.get(k) not in (None, "", [])})
    r["relations"] = [{
        "type": rel["type"],
        "target": rel.get("other_id"),
        "target_title": rel.get("other_title"),
        "start": rel.get("start"),
        "end": rel.get("end"),
        "role": rel.get("role"),
        "source": {"page": rel.get("fn_page"), "footnote": rel.get("fn"),
                   "text": notes.get(rel.get("fn_page") or "", {}).get(str(rel.get("fn")))},
    } for rel in e.get("relations") or []]
    return r


def build(data: Path) -> None:
    entities = json.loads((data / "entities.json").read_text())
    notes = {e["id"]: {str(f["id"]): f["text"] for f in e.get("footnotes") or []} for e in entities}
    out = data / "research"
    out.mkdir(exist_ok=True)
    # ASCII-only: V8 keeps the parsed source alive (string values slice it), so a single non-Latin-1
    # character would double its size in the Worker.
    dump = lambda obj: json.dumps(obj, separators=(",", ":")).encode()  # noqa: E731
    write_atomic(out / "entries.json", dump([record(e, notes) for e in entities]))
    write_atomic(out / "fulltext.json", dump({
        "sections": [[e["id"], *s] for e in entities for s in sections(e)],
        "footnotes": {k: {n: t.translate(_ASCII) for n, t in v.items()} for k, v in notes.items() if v},
    }))
    print(f"[research] {len(entities)} entries -> {out}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Bulk research data for the Worker's research tools.")
    ap.add_argument("--data", type=Path, default=Path("data"))
    build(ap.parse_args().data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
