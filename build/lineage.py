"""Family trees and institution lineages, built from typed relations alone.

    python build/lineage.py --data data

Reads the parser's entities.json and writes <data>/lineage.json:
    families  connected groups of relative_of / spouse_of facts between people, with the
              parent, sibling and spouse edges a tree can draw
    lineages  one per organization or program with enough dated staff: who founded or joined
              it, everyone who worked there by year, what they went on to run, and dated events
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed import write_atomic  # noqa: E402

FAMILY_MIN_PAGES = 3  # people with their own entry
LINEAGE_MIN_ROWS = 5  # distinct dated members, employees, heads or directors

PARENT = {"father", "mother", "parent"}
CHILD = {"son", "daughter", "child"}
GRANDPARENT = {"grandfather", "grandmother", "maternal grandfather", "paternal grandfather"}
GRANDCHILD = {"grandson", "granddaughter"}
SIBLING = {"brother", "sister", "sibling", "older sister", "younger brother", "half-brother", "half-sister"}
STAFF = {"employed_by", "head_of", "director_of", "member_of", "partner_of"}
# When two spans say the same years, the stronger relation is kept.
_SPAN_RANK = {"head_of": 0, "director_of": 1, "partner_of": 2, "employed_by": 3, "member_of": 4}
LATER = {"head_of", "founded", "director_of"}
ORIGIN_LABELS = ("Founded by", "Funded by", "Owned by", "Participants")
_SUFFIX = re.compile(r"\s+(Jr\.|Sr\.|II|III|IV)$")

Entity = dict[str, Any]


def _year(s: Any) -> int | None:
    m = re.match(r"\d{4}", str(s or ""))
    return int(m.group()) if m else None


def _clip(t: Any, n: int) -> str | None:
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    if not t:
        return None
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def role_class(role: str | None) -> str | None:
    """The kin class a role names, read from its first clause: 'son (born at Hong Kong)' is a child."""
    if not role:
        return None
    r = re.split(r"[;,(]", role.lower())[0].strip()
    for cls, words in (("parent", PARENT), ("child", CHILD), ("gp", GRANDPARENT), ("gc", GRANDCHILD), ("sib", SIBLING)):
        if r in words:
            return cls
    return "other"


def _unique(rels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Relations with one row per (label, target, start year): a fact recorded twice shows once."""
    seen, out = set(), []
    for r in rels:
        k = (r["label"], r["other_title"], _year(r["start"]))
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def dedupe_spans(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop a span the row already states better: an exact repeat, or an open-ended span starting
    inside a span with both dates (director from 1922 beside head 1922 to 1946 keeps the head)."""
    out: list[dict[str, Any]] = []
    for sp in sorted(spans, key=lambda sp: (sp["end"] is None, sp["start"], _SPAN_RANK.get(sp.get("type", ""), 9))):
        if any(o["start"] == sp["start"] and o["end"] == sp["end"] for o in out):
            continue
        if sp["end"] is None and any(o["end"] and o["start"] <= sp["start"] <= o["end"] for o in out):
            continue
        out.append(sp)
    return sorted(out, key=lambda sp: sp["start"])


class Lineage:
    def __init__(self, entities: list[Entity]):
        self.ents = {e["id"]: e for e in entities}
        self.by_title: dict[str, Entity] = {}
        for e in entities:
            for t in [e["title"], *((e.get("frontmatter") or {}).get("aliases") or [])]:
                self.by_title.setdefault(str(t).lower(), e)

    def ref(self, eid: str | None, title: str) -> dict[str, Any]:
        """A name, plus the entry's id and type when it has one, so the page can link it."""
        e = self.ents.get(eid or "")
        return {"title": title, "id": e["id"], "type": e["type"]} if e else {"title": title}

    def summary(self, e: Entity | None) -> str | None:
        return _clip((e or {}).get("summary"), 280)

    @staticmethod
    def is_family(e: Entity | None) -> bool:
        return bool(e) and e["title"].endswith(" family")

    @staticmethod
    def key(r: dict[str, Any]) -> str:
        return r["other_id"] or "t:" + r["other_title"].lower()

    # ---------- families ----------

    def birth_bounds(self) -> dict[str, tuple[int, int]]:
        """(earliest, latest) possible birth year per person key. A recorded birth year is exact.
        Otherwise dated relations bound it: born at most 16 years before the first one, and at
        most 80 before the last. Marriages count, so people without entries get bounds too.
        relative_of dates are left out: they are often the child's birth year."""
        starts: dict[str, list[int]] = collections.defaultdict(list)
        for e in self.ents.values():
            for r in e["relations"] + e["relations_in"]:
                if r["type"] != "relative_of" and (y := _year(r["start"])):
                    starts[e["id"]].append(y)
                    if r["type"] == "spouse_of" and not r["other_id"]:
                        starts[self.key(r)].append(y)
        out = {k: (max(ys) - 80, min(ys) - 16) for k, ys in starts.items()}
        for e in self.ents.values():
            if (b := _year((e.get("dates") or {}).get("born"))) is not None:
                out[e["id"]] = (b, b)
        return out

    def kin_edges(self) -> tuple[list[tuple], dict[str, str]]:
        """Each kin fact once, as (a, b, class, verified, role, start); for parent and grandparent
        edges a is the elder. Two recorded birth years decide the direction, and verified is True.
        Otherwise birth year bounds decide when one person was surely born 12 or more years before
        the other; failing that the role is read as describing the other person, as entry pages
        show it. Either way verified is False."""
        out: dict[tuple, tuple] = {}
        titles: dict[str, str] = {}
        bounds = self.birth_bounds()
        for e in self.ents.values():
            if e["type"] != "person" or self.is_family(e):
                continue
            for r in e["relations"] + e["relations_in"]:
                if r["type"] not in ("relative_of", "spouse_of"):
                    continue
                o = self.ents.get(r["other_id"] or "")
                if self.is_family(o) or (o and o["type"] != "person"):
                    continue
                k = self.key(r)
                titles[k], titles[e["id"]] = r["other_title"], e["title"]
                a, b, verified = e["id"], k, True
                c = "spouse" if r["type"] == "spouse_of" else role_class(r["role"])
                if c in (None, "other"):
                    cls = "other"
                elif c in ("spouse", "sib"):
                    cls = c
                else:
                    cls = "gp" if c in ("gp", "gc") else "parent"
                    other_elder = c in ("parent", "gp")
                    ya, yb = _year(e.get("dates", {}).get("born")), _year((o or {}).get("dates", {}).get("born"))
                    if ya is not None and yb is not None:
                        other_elder = yb < ya
                    else:
                        verified = False
                        ba, bb = bounds.get(e["id"]), bounds.get(k)
                        if ba and bb and bb[1] < ba[0] - 12:
                            other_elder = True
                        elif ba and bb and ba[1] < bb[0] - 12:
                            other_elder = False
                    if other_elder:
                        a, b = b, a
                pk = (frozenset((a, b)), cls)
                prev = out.get(pk)
                if prev is None or (verified and not prev[3]):
                    out[pk] = (a, b, cls, verified, r["role"] if cls == "other" else None, r["start"])
        return list(out.values()), titles

    def notable(self, e: Entity) -> list[str]:
        rows = [r for r in e["relations"] + e["relations_in"]
                if r["label"] in ("Head of", "Founded", "Appointed by", "Director of") and r["other_id"]]
        rows.sort(key=lambda r: (r["label"] != "Head of", r["start"] or "9999"))
        return [f'{r["label"]} {r["other_title"]}' + (f' {r["start"][:4]}' if r["start"] else "") for r in rows[:4]]

    def families(self) -> list[dict[str, Any]]:
        edges, titles = self.kin_edges()
        adj: dict[str, set[str]] = collections.defaultdict(set)
        for a, b, cls, *_ in edges:
            if cls != "other":
                adj[a].add(b)
                adj[b].add(a)
        seen: set[str] = set()
        out = []
        for start in sorted(adj):
            if start in seen:
                continue
            comp, stack = set(), [start]
            while stack:
                x = stack.pop()
                if x not in seen:
                    seen.add(x)
                    comp.add(x)
                    stack += adj[x]
            pages = [self.ents[k] for k in comp if k in self.ents]
            if len(pages) < FAMILY_MIN_PAGES:
                continue
            drawn = {frozenset((a, b)) for a, b, cls, *_ in edges if cls != "other"}
            # The most-mentioned member names the page's URL, so it survives new relatives.
            anchor = max(pages, key=lambda e: (e.get("mention_count", 0), e["id"]))
            people = []
            for k in sorted(comp):
                e = self.ents.get(k)
                d = (e or {}).get("dates") or {}
                people.append({**self.ref(k if e else None, titles[k]), "key": k,
                               "born": _year(d.get("born")), "died": _year(d.get("died")),
                               "summary": self.summary(e), "notes": self.notable(e) if e else []})
            surnames = collections.Counter(_SUFFIX.sub("", e["title"]).split()[-1] for e in sorted(pages, key=lambda e: e["id"]))
            fam_entries = sorted({(r["other_id"], r["other_title"]) for e in pages for r in e["relations"] + e["relations_in"]
                                  if self.is_family(self.ents.get(r["other_id"] or ""))})
            out.append({
                "id": anchor["id"],
                "name": " · ".join(s for s, _ in surnames.most_common(3)),
                "anchor": anchor["id"],
                "people": people,
                "edges": [{"a": a, "b": b, "cls": cls, "verified": v, "start": st}
                          for a, b, cls, v, _, st in edges if a in comp and b in comp and cls != "other"],
                # A pair the tree already draws is not listed again as an unplaced relative.
                "others": [{"a": titles[a], "b": titles[b], "role": _clip(role, 120)}
                           for a, b, cls, _, role, _ in sorted(edges, key=lambda x: (titles[x[0]], titles[x[1]]))
                           if cls == "other" and (a in comp or b in comp) and frozenset((a, b)) not in drawn],
                "familyEntries": [self.ref(i, t) for i, t in fam_entries],
            })
        out.sort(key=lambda f: (-len(f["people"]), f["id"]))
        return out

    # ---------- lineages ----------

    def lineage(self, o: Entity) -> dict[str, Any] | None:
        staff: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        names: dict[str, str] = {}
        for r in o["relations_in"]:
            if r["type"] in STAFF and _year(r["start"]):
                staff[self.key(r)].append({"type": r["type"], "start": _year(r["start"]), "end": _year(r["end"]),
                                           "role": _clip(r["role"], 200)})
                names[self.key(r)] = r["other_title"]
        if len(staff) < LINEAGE_MIN_ROWS:
            return None
        staff = {k: dedupe_spans(v) for k, v in staff.items()}
        people = sorted(staff, key=lambda k: (min(s["start"] for s in staff[k]), names[k]))
        rows = [{**self.ref(k if k in self.ents else None, names[k]), "family": self.is_family(self.ents.get(k)),
                 "summary": self.summary(self.ents.get(k)), "spans": staff[k]} for k in people]

        origins: dict[tuple, dict[str, Any]] = {}
        for r in o["relations_in"]:
            other = self.ents.get(r["other_id"] or "")
            if r["label"] not in ORIGIN_LABELS:
                continue
            # People taking part are staff; organizations and families joining are origins.
            if r["label"] == "Participants" and (not other or (other["type"] == "person" and not self.is_family(other))):
                continue
            a = origins.setdefault((r["label"], r["other_title"]), {
                "label": r["label"], **self.ref(r["other_id"], r["other_title"]), "years": [],
                "summary": self.summary(other), "role": _clip(r["role"], 200)})
            # Several start years for one founding mean the sources disagree; keep them all.
            if (y := _year(r["start"])) and y not in a["years"]:
                a["years"].append(y)

        reached: dict[str, set[str]] = collections.defaultdict(set)
        later = []
        for k in (k for k in people if k in self.ents):
            p, first = self.ents[k], min(s["start"] for s in staff[k])
            roles = []
            for r in _unique(p["relations"]):
                if r["type"] in LATER and r["other_id"] and r["other_id"] != o["id"] and (_year(r["start"]) or 0) >= first:
                    roles.append({"label": r["label"], **self.ref(r["other_id"], r["other_title"]),
                                  "start": _year(r["start"]), "end": _year(r["end"]),
                                  "role": _clip(r["role"], 200), "summary": self.summary(self.ents.get(r["other_id"]))})
                    reached[r["other_title"]].add(p["title"])
            kin = []
            for r in p["relations"] + p["relations_in"]:
                rel = self.ents.get(r["other_id"] or "")
                if r["type"] != "relative_of" or not rel or self.is_family(rel) or rel["type"] != "person":
                    continue
                theirs = _unique([x for x in rel["relations"] if x["type"] in LATER and x["other_id"] and x["other_id"] != o["id"]])
                # Kin role words are left out: the vault records them from either side.
                if theirs and rel["id"] not in {x["id"] for x in kin}:
                    kin.append({**self.ref(rel["id"], rel["title"]), "roles": [
                        {"label": x["label"], "title": x["other_title"], "start": _year(x["start"]), "end": _year(x["end"])}
                        for x in theirs[:3]]})
                    for x in theirs:
                        reached[x["other_title"]].add(f'{p["title"]} via {rel["title"]}')
            if roles or kin:
                roles.sort(key=lambda x: x["start"] or 9999)
                later.append({**self.ref(k, p["title"]), "first": first, "summary": self.summary(p),
                              "roles": roles[:5], "kin": kin[:3]})
        # Places two or more members reached, counting each member once however they got there.
        shared = [{**self.ref(self.by_title.get(t.lower(), {}).get("id"), t), "via": sorted(v)}
                  for t, v in reached.items() if len({m.split(" via ")[0] for m in v}) >= 2]
        shared.sort(key=lambda x: (-len(x["via"]), x["title"]))
        return {"id": o["id"], "title": o["title"], "type": o["type"], "summary": o.get("summary"),
                "origins": sorted(origins.values(), key=lambda a: (min(a["years"] or [9999]), a["title"])),
                "rows": rows, "later": later, "shared": shared[:8],
                "events": self.events(o, [k for k in people if k in self.ents])}

    def _ev_dates(self, e: Entity | None) -> tuple[int | None, int | None]:
        d = (e or {}).get("dates") or {}
        return _year(d.get("start") or d.get("date")), _year(d.get("end"))

    def events(self, o: Entity, members: list[str]) -> list[dict[str, Any]]:
        """Dated events for the timeline, strongest tie first (rank 0 to 2): the organization's own
        typed relations, then events its members took part in, then events its page links to."""
        out: dict[str, dict[str, Any]] = {}

        def add(title: str, start: int | None, end: int | None, how: str, rank: int, ev: Entity | None, role=None):
            if not start:
                return
            cur = out.get(title)
            if cur and cur["rank"] <= rank:
                if how not in cur["how"]:
                    cur["how"].append(how)
                return
            out[title] = {**self.ref(ev["id"] if ev else None, title), "start": start,
                          "end": end if end and end > start else None, "how": [how], "rank": rank,
                          "summary": self.summary(ev), "role": role}

        for r in o["relations"] + o["relations_in"]:
            ev = self.ents.get(r["other_id"] or "")
            # Without an entry, a dated participant_in or subject_of with an end is taken as an event.
            if (ev and ev["type"] == "event") or (not ev and r["type"] in ("participant_in", "subject_of") and r["end"]):
                s, e = self._ev_dates(ev)
                add(r["other_title"], _year(r["start"]) or s, _year(r["end"]) or e, r["label"], 0, ev, _clip(r["role"], 200))
        who: dict[str, list[str]] = collections.defaultdict(list)
        for k in members:
            for r in self.ents[k]["relations"]:
                ev = self.ents.get(r["other_id"] or "")
                if ev and ev["type"] == "event":
                    who[ev["id"]].append(self.ents[k]["title"])
        for eid, ns in sorted(who.items(), key=lambda x: (-len(x[1]), x[0])):
            s, e = self._ev_dates(self.ents[eid])
            add(self.ents[eid]["title"], s, e,
                f'{len(ns)} member{"s" if len(ns) > 1 else ""} took part: ' + ", ".join(ns[:5]), 1, self.ents[eid])
        for w in o.get("wikilinks") or []:
            ev = self.by_title.get(str(w["target"]).lower())
            if ev and ev["type"] == "event":
                s, e = self._ev_dates(ev)
                add(ev["title"], s, e, "Linked from this page", 2, ev)
        return sorted(out.values(), key=lambda x: (x["rank"], x["start"], x["title"]))[:12]

    def lineages(self) -> list[dict[str, Any]]:
        out = [x for e in sorted(self.ents.values(), key=lambda e: e["id"])
               if e["type"] in ("organization", "program") and (x := self.lineage(e))]
        return sorted(out, key=lambda x: (-len(x["rows"]), x["id"]))


def build(data: Path) -> dict[str, Any]:
    lin = Lineage(json.loads((data / "entities.json").read_text(encoding="utf-8")))
    result = {"families": lin.families(), "lineages": lin.lineages()}
    write_atomic(data / "lineage.json", json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode())
    print(f"[lineage] {len(result['families'])} families, {len(result['lineages'])} lineages")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Family trees and institution lineages from typed relations.")
    ap.add_argument("--data", type=Path, default=Path("data"))
    build(ap.parse_args().data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
