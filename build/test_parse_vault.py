"""Unit tests for the vault parser's pure, correctness-critical functions.

Stdlib unittest only — no new dependency to pin (matches the supply-chain
stance in requirements.txt). Run from anywhere:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
    # or
    .venv/bin/python build/test_parse_vault.py

Importing parse_vault pulls in frontmatter / markdown_it / pyyaml (the
module's top-level imports), so run under the build venv. networkx/scipy are
imported lazily inside the graph functions and are NOT needed here.

Focus is the data-correctness layer that's hard to eyeball and easy to break
silently: wikilink parsing, title/alias slug resolution (the class of bug
where [[CIA]] rendered as a dead link), edge resolution, and frontmatter
date/location coercion.
"""
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_vault as pv  # noqa: E402


# ---------- fixtures ----------

def wl(target, display=None, section=""):
    return {"target": target, "display": display or target, "section": section}


def make_entity(eid, title, type="concept", aliases=None, wikilinks=None, **fm):
    """Minimal entity record shaped like parse_file()'s output, enough for
    build_slug_index / resolve_links / build_alias_map."""
    front = dict(fm)
    if aliases is not None:
        front["aliases"] = aliases
    return {
        "id": eid,
        "title": title,
        "type": type,
        "frontmatter": front,
        "wikilinks": wikilinks or [],
    }


class TestNormalizeTarget(unittest.TestCase):
    def test_lowercases_and_strips(self):
        self.assertEqual(pv.normalize_target("  CIA  "), "cia")

    def test_collapses_internal_whitespace(self):
        self.assertEqual(pv.normalize_target("Central   Intelligence\tAgency"),
                         "central intelligence agency")

    def test_idempotent(self):
        once = pv.normalize_target("Foo  Bar")
        self.assertEqual(pv.normalize_target(once), once)


class TestSlugify(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(pv.slugify("Hello World!"), "hello-world")

    def test_underscores_and_runs(self):
        self.assertEqual(pv.slugify("  A__B  "), "a-b")

    def test_empty_falls_back(self):
        self.assertEqual(pv.slugify("!!!"), "untitled")
        self.assertEqual(pv.slugify(""), "untitled")


class TestExtractWikilinks(unittest.TestCase):
    def test_plain_and_piped(self):
        links = pv.extract_wikilinks("see [[Alpha]] and [[Beta|the second]]")
        self.assertEqual(links[0], {"target": "Alpha", "display": "Alpha", "section": ""})
        self.assertEqual(links[1], {"target": "Beta", "display": "the second", "section": ""})

    def test_section_anchor(self):
        (link,) = pv.extract_wikilinks("[[Page#History]]")
        self.assertEqual(link["target"], "Page")
        self.assertEqual(link["section"], "History")

    def test_section_with_display(self):
        (link,) = pv.extract_wikilinks("[[Page#History|read more]]")
        self.assertEqual(link["target"], "Page")
        self.assertEqual(link["section"], "History")
        self.assertEqual(link["display"], "read more")

    def test_embeds_are_skipped(self):
        links = pv.extract_wikilinks("![[image.png]] but [[Real]] counts")
        self.assertEqual([l["target"] for l in links], ["Real"])

    def test_no_links(self):
        self.assertEqual(pv.extract_wikilinks("nothing here"), [])


class TestExtractFootnotes(unittest.TestCase):
    def test_pulls_defs_and_strips_header(self):
        body = "Claim.[^1]\n\n### Footnotes\n\n[^1]: The source."
        notes, clean = pv.extract_footnotes(body)
        self.assertEqual(notes, [{"id": "1", "text": "The source."}])
        self.assertNotIn("[^1]:", clean)
        self.assertNotIn("Footnotes", clean)


class TestDateCoercion(unittest.TestCase):
    def test_int_year_to_string(self):
        self.assertEqual(pv._date_str(1904), "1904")

    def test_date_object_isoformat(self):
        self.assertEqual(pv._date_str(dt.date(1904, 8, 30)), "1904-08-30")

    def test_none_and_blank(self):
        self.assertIsNone(pv._date_str(None))
        self.assertIsNone(pv._date_str("   "))

    def test_extract_dates_known_keys_only(self):
        fm = {"born": 1950, "end": dt.date(2001, 9, 11), "irrelevant": "x"}
        self.assertEqual(pv._extract_dates(fm), {"born": "1950", "end": "2001-09-11"})

    def test_extract_location_forms(self):
        self.assertEqual(pv._extract_location({"location": "NYC"}), ["NYC"])
        self.assertEqual(pv._extract_location({"location": ["A", " B "]}), ["A", "B"])
        self.assertEqual(pv._extract_location({}), [])
        self.assertEqual(pv._extract_location({"location": 7}), [])


class TestBuildSlugIndex(unittest.TestCase):
    def test_title_indexed_normalized(self):
        idx = pv.build_slug_index([make_entity("a", "Central Intelligence Agency")])
        self.assertEqual(idx["central intelligence agency"], "a")

    def test_alias_resolves_to_entity(self):
        idx = pv.build_slug_index([
            make_entity("cia", "Central Intelligence Agency", aliases=["CIA"]),
        ])
        self.assertEqual(idx["cia"], "cia")
        self.assertEqual(idx["central intelligence agency"], "cia")

    def test_title_beats_another_entitys_alias(self):
        # A is literally titled "Foo"; B merely aliases "Foo". Title must win.
        idx = pv.build_slug_index([
            make_entity("a", "Foo"),
            make_entity("b", "Bar", aliases=["Foo"]),
        ])
        self.assertEqual(idx["foo"], "a")

    def test_alias_claimed_by_two_entities_is_dropped(self):
        idx = pv.build_slug_index([
            make_entity("a", "Alpha", aliases=["Shared"]),
            make_entity("b", "Beta", aliases=["Shared"]),
        ])
        self.assertNotIn("shared", idx)  # ambiguous → unresolved, not a guess

    def test_alias_as_bare_string(self):
        idx = pv.build_slug_index([make_entity("a", "Alpha", aliases="Solo")])
        self.assertEqual(idx["solo"], "a")

    def test_non_string_alias_entries_ignored(self):
        idx = pv.build_slug_index([
            make_entity("a", "Alpha", aliases=["Good", 123, None]),
        ])
        self.assertEqual(idx["good"], "a")
        self.assertIn("alpha", idx)

    def test_self_alias_is_noop(self):
        idx = pv.build_slug_index([make_entity("a", "Name", aliases=["Name"])])
        self.assertEqual(idx["name"], "a")

    def test_title_collision_last_write_wins(self):
        idx = pv.build_slug_index([
            make_entity("first", "Dup"),
            make_entity("second", "Dup"),
        ])
        self.assertEqual(idx["dup"], "second")


class TestResolveLinks(unittest.TestCase):
    def test_resolves_via_title(self):
        ents = [
            make_entity("cia", "Central Intelligence Agency"),
            make_entity("src", "Source", wikilinks=[wl("Central Intelligence Agency")]),
        ]
        idx = pv.build_slug_index(ents)
        edges, unresolved = pv.resolve_links(ents, idx)
        edge = next(e for e in edges if e["source"] == "src")
        self.assertEqual(edge["target_id"], "cia")
        self.assertEqual(len(unresolved), 0)

    def test_resolves_via_alias_case_insensitive(self):
        # The exact regression class: [[cIa]] must resolve through the alias.
        ents = [
            make_entity("cia", "Central Intelligence Agency", aliases=["CIA"]),
            make_entity("src", "Source", wikilinks=[wl("cIa")]),
        ]
        idx = pv.build_slug_index(ents)
        edges, unresolved = pv.resolve_links(ents, idx)
        edge = next(e for e in edges if e["source"] == "src")
        self.assertEqual(edge["target_id"], "cia")
        self.assertEqual(len(unresolved), 0)

    def test_unresolved_counted_not_dropped(self):
        ents = [make_entity("src", "Source", wikilinks=[wl("Nowhere")])]
        idx = pv.build_slug_index(ents)
        edges, unresolved = pv.resolve_links(ents, idx)
        self.assertEqual(len(edges), 1)
        self.assertIsNone(edges[0]["target_id"])
        self.assertEqual(unresolved["Nowhere"], 1)


class TestBuildAliasMap(unittest.TestCase):
    def test_unique_title_resolves(self):
        resolved, _ = pv.build_alias_map([make_entity("a", "Solo Org")], [])
        self.assertEqual(resolved["Solo Org"], "a")

    def test_title_vs_alias_collision_is_ambiguous(self):
        # Title weight 100 vs alias weight 50: 100 < 3*50, so it's ambiguous.
        resolved, ambiguous = pv.build_alias_map([
            make_entity("a", "Foo"),
            make_entity("b", "Bar", aliases=["Foo"]),
        ], [])
        self.assertIn("Foo", ambiguous)
        self.assertNotIn("Foo", resolved)

    def test_short_alias_skipped(self):
        resolved, _ = pv.build_alias_map([make_entity("a", "Org", aliases=["AB"])], [])
        self.assertNotIn("AB", resolved)  # below NER_MIN_ALIAS_LEN

    def test_numeric_only_alias_skipped(self):
        resolved, _ = pv.build_alias_map([make_entity("a", "Decade", aliases=["1980"])], [])
        self.assertNotIn("1980", resolved)  # no alphabetic char

    def test_stopword_title_skipped(self):
        resolved, _ = pv.build_alias_map([make_entity("a", "the")], [])
        self.assertNotIn("the", resolved)


class TestParseFile(unittest.TestCase):
    def _write(self, root: Path, relpath: str, text: str) -> Path:
        p = root / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def test_parses_frontmatter_body_and_type(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            body = (
                "---\n"
                "summary: A test person.\n"
                "born: 1950\n"
                "aliases:\n  - Tester\n"
                "tags:\n  - Spy\n"
                "---\n"
                "Bio mentioning [[Some Org]].[^1]\n\n[^1]: a note\n"
            )
            p = self._write(root, "people/Test Person.md", body)
            e = pv.parse_file(p, root, {"people": "person"})
            assert e is not None  # narrow Optional for the asserts below
            self.assertEqual(e["id"], "test-person")
            self.assertEqual(e["title"], "Test Person")
            self.assertEqual(e["type"], "person")
            self.assertEqual(e["dates"], {"born": "1950"})
            self.assertEqual(e["tags"], ["Spy"])
            self.assertEqual([l["target"] for l in e["wikilinks"]], ["Some Org"])
            self.assertEqual(e["frontmatter"].get("aliases"), ["Tester"])

    def test_strips_leading_bom(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            # Two BOMs back-to-back — the loop in parse_file must strip both,
            # otherwise frontmatter is silently swallowed into the body.
            text = "﻿﻿---\nsummary: ok\n---\nbody\n"
            p = self._write(root, "misc/BOMful.md", text)
            e = pv.parse_file(p, root, {})
            assert e is not None
            self.assertEqual(e["summary"], "ok")
            self.assertEqual(e["type"], "page")  # unknown top dir → default


class TestAliasResolutionRegression(unittest.TestCase):
    """End-to-end guard for the bug fixed in the alias-resolution commit:
    an explicit [[alias]] wikilink to a page that declares that alias must
    produce a resolved edge, not a dead `unresolved` link."""

    def test_alias_wikilink_resolves_end_to_end(self):
        ents = [
            make_entity("project-mkultra", "Project MKUltra", aliases=["MKULTRA", "MK-ULTRA"]),
            make_entity("page", "Some Page", wikilinks=[wl("MKULTRA"), wl("MK-ULTRA")]),
        ]
        idx = pv.build_slug_index(ents)
        edges, unresolved = pv.resolve_links(ents, idx)
        targets = {e["target_id"] for e in edges if e["source"] == "page"}
        self.assertEqual(targets, {"project-mkultra"})
        self.assertEqual(len(unresolved), 0)




class TestMinedDisplayAliases(unittest.TestCase):
    """[[Target|Display]] pairs used 2+ times become NER aliases — unless the
    display is a shared surname/common noun or a stray lowercase word."""

    def _edges(self, target_id, target_title, display, n=2):
        return [{"source": f"s{i}", "target_id": target_id, "target_title": target_title,
                 "display": display, "section": "", "kind": "explicit"} for i in range(n)]

    def test_word_shared_by_other_titles_not_mined(self):
        ents = [make_entity("joe-king", "Joe King", "person"),
                make_entity("mlk", "Martin Luther King Jr.", "person"),
                make_entity("jc", "J.C. King", "person")]
        resolved, _ = pv.build_alias_map(ents, self._edges("joe-king", "Joe King", "King"))
        self.assertNotIn("King", resolved)

    def test_word_unique_to_target_is_mined(self):
        ents = [make_entity("reagan", "Ronald Reagan", "person"),
                make_entity("nancy", "Nancy Reagan", "person")]
        resolved, _ = pv.build_alias_map(ents, self._edges("reagan", "Ronald Reagan", "Reagan"))
        self.assertEqual(resolved["Reagan"], "reagan")

    def test_lowercase_display_only_when_it_is_the_title(self):
        ents = [make_entity("simwa", "SIMWA", "organization"),
                make_entity("rv", "Remote Viewing")]
        edges = (self._edges("simwa", "SIMWA", "agreement")
                 + self._edges("rv", "Remote Viewing", "remote viewing"))
        resolved, _ = pv.build_alias_map(ents, edges)
        self.assertNotIn("agreement", resolved)
        self.assertEqual(resolved["remote viewing"], "rv")


class TestRankings(unittest.TestCase):
    """Related / hub / bridge scoring. Needs networkx (in requirements.txt)."""

    def _edge(self, s, t, kind="explicit"):
        return {"source": s, "target_id": t, "target_title": t, "display": t,
                "section": "", "kind": kind}

    def _ents(self, *specs):
        out = []
        for spec in specs:
            eid, typ = (spec, "person") if isinstance(spec, str) else spec
            e = make_entity(eid, eid.title(), typ)
            e["summary"] = None
            out.append(e)
        return out

    def test_related_prefers_rare_neighbor_over_ubiquitous_hub(self):
        # hub co-occurs with x on 3 pages but sits on every page; rare
        # co-occurs on 2. Raw count ranks hub first; idf weighting flips it.
        ents = self._ents("x", "hub", "rare", "p1", "p2", "p3", "p4", "p5")
        edges = []
        for p in ("p1", "p2", "p3"):
            edges += [self._edge(p, "x"), self._edge(p, "hub")]
        for p in ("p1", "p2"):
            edges.append(self._edge(p, "rare"))
        for p in ("p4", "p5"):
            edges.append(self._edge(p, "hub"))
        related, _, _ = pv.compute_relationships(ents, edges)
        ids = [r["id"] for r in related["x"]]
        self.assertLess(ids.index("rare"), ids.index("hub"))
        self.assertEqual(next(r for r in related["x"] if r["id"] == "hub")["count"], 3)

    def test_hub_needs_inbound_links_and_rankable_type(self):
        ents = self._ents(("narr", "meta"), "a", "b", "c")
        edges = [self._edge("narr", t) for t in ("a", "b", "c")]
        edges += [self._edge("a", "b"), self._edge("c", "b")]
        hubs = pv.compute_hub_scores(ents, edges)
        self.assertNotIn("narr", hubs)
        self.assertEqual(hubs["b"]["rank"], 1)

    def test_bridge_is_cited_from_multiple_communities(self):
        ents = self._ents(*[f"a{i}" for i in range(5)], *[f"b{i}" for i in range(5)],
                          "link", "local", ("town", "place"))
        edges = []
        for grp in ("a", "b"):
            for i in range(5):
                for j in range(i + 1, 5):
                    edges.append(self._edge(f"{grp}{i}", f"{grp}{j}"))
        for src in ("a0", "a1", "b0", "b1"):
            edges += [self._edge(src, "link"), self._edge(src, "town")]
        for src in ("a0", "a1", "a2", "a3"):
            edges.append(self._edge(src, "local"))
        bridges, _ = pv.compute_bridge_scores(ents, pv._pair_weights(ents, edges), edges)
        self.assertEqual(bridges["link"]["rank"], 1)
        self.assertNotIn("local", bridges)   # cited from one community only
        self.assertNotIn("town", bridges)    # places excluded


class TestAdjacencyDirection(unittest.TestCase):
    def test_dir_bits_follow_link_direction(self):
        ents = [make_entity("a", "A"), make_entity("b", "B"), make_entity("c", "C")]
        edges = [
            {"source": "a", "target_id": "b", "kind": "explicit"},   # a -> b only
            {"source": "b", "target_id": "c", "kind": "explicit"},
            {"source": "c", "target_id": "b", "kind": "explicit"},   # b <-> c
            {"source": "a", "target_id": "c", "kind": "implicit", "count": 2},  # inferred only
        ]
        adj = pv.build_adjacency(ents, edges)
        idx = {eid: i for i, eid in enumerate(adj["ids"])}
        def d(x, y):
            return adj["dir"][idx[x]][adj["adj"][idx[x]].index(idx[y])]
        self.assertEqual(d("a", "b"), 1)
        self.assertEqual(d("b", "a"), 2)
        self.assertEqual(d("b", "c"), 3)
        self.assertEqual(d("a", "c"), 0)
        self.assertEqual(adj["implicitPairs"], [[idx["a"], idx["c"]]])


class TestSummarizeCommunities(unittest.TestCase):
    def test_label_uses_top_rankable_members(self):
        ents = [make_entity("a", "Alpha", "person"), make_entity("b", "Beta", "organization"),
                make_entity("c", "Gamma", "place"), make_entity("n", "Notes", "meta"),
                make_entity("z", "Zeta", "person")]
        for e, m in zip(ents, (5, 9, 1, 50, 2)):
            e["mention_count"] = m
        out = pv.summarize_communities(ents, {"a": 0, "b": 0, "c": 0, "n": 0, "z": 1})
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["label"], "Beta · Alpha · Gamma")
        self.assertEqual(out[0]["size"], 4)
        self.assertEqual(out[0]["top"][0]["id"], "n")   # meta page still listed, just not in the label
        self.assertEqual(out[1]["label"], "Zeta")



class FocusTests(unittest.TestCase):
    def test_compute_focus_scores_pins_and_cluster(self):
        from collections import Counter
        ents = [
            {"id": "a", "path": "10/a.md", "type": "person", "summary": "x", "mention_count": 10, "community_id": 0},
            {"id": "b", "path": "10/b.md", "type": "person", "summary": "x", "mention_count": 1, "community_id": 1},
            {"id": "c", "path": "10/c.md", "type": "person", "summary": "x", "mention_count": 50, "community_id": 1},
            {"id": "p", "path": "60/p.md", "type": "place", "summary": "x", "mention_count": 99, "community_id": 0},
        ]
        edges = [{"source": "b", "target_id": "c"}]
        comms = [{"label": "L0", "size": 2}, {"label": "L1", "size": 2}]
        edits = Counter({"10/a.md": 3, "10/b.md": 1, "60/p.md": 9})
        f = pv.compute_focus(ents, edges, comms, edits, pins=["c"], slots=2)
        ids = [p["id"] for p in f["pages"]]
        self.assertEqual(ids, ["c", "a"])          # pin first, then top edited page; place excluded
        self.assertTrue(f["pages"][0]["pinned"])
        self.assertIn("1 linking page edited", f["pages"][0]["reason"])
        self.assertEqual(f["cluster"]["id"], 0)    # a and p edited in 0, only b in 1

class TestRelations(unittest.TestCase):
    def _ents(self):
        a = {"id": "william-barr", "title": "William Barr", "relations_raw": pv._extract_relations({
            "relations": [
                {"type": "employed_by", "with": "[[Central Intelligence Agency|CIA]]", "start": 1973, "end": 1977, "fn": 1},
                {"type": "appointed", "with": "[[Nicholas J. Bua]]", "start": "1991-11-07", "fn": 2},
                {"type": "not_a_type", "with": "[[X]]"},
            ]}, "William Barr")}
        b = {"id": "sun-streak", "title": "Sun Streak", "relations_raw": pv._extract_relations({
            "relations": [{"type": "subject_of", "with": "[[Terry Waite]]", "reverse": True, "fn": 9}]}, "Sun Streak")}
        c = {"id": "central-intelligence-agency", "title": "Central Intelligence Agency", "relations_raw": pv._extract_relations({
            "relations": [{"type": "employed_by", "with": "[[William Barr]]", "reverse": True, "start": 1973}]}, "CIA")}
        w = {"id": "terry-waite", "title": "Terry Waite", "relations_raw": []}
        ents = [a, b, c, w]
        idx = {"william barr": "william-barr", "sun streak": "sun-streak", "terry waite": "terry-waite",
               "central intelligence agency": "central-intelligence-agency"}
        pv.resolve_relations(ents, idx)
        return {e["id"]: e for e in ents}

    def test_bad_type_dropped_and_target_unwrapped(self):
        barr = self._ents()["william-barr"]
        self.assertEqual([r["type"] for r in barr["relations"]], ["employed_by", "appointed"])
        self.assertEqual(barr["relations"][0]["other_id"], "central-intelligence-agency")
        self.assertEqual(barr["relations"][0]["start"], "1973")

    def test_unresolved_target_kept_by_title(self):
        barr = self._ents()["william-barr"]
        self.assertIsNone(barr["relations"][1]["other_id"])
        self.assertEqual(barr["relations"][1]["other_title"], "Nicholas J. Bua")

    def test_inverse_on_object_and_no_double_count(self):
        cia = self._ents()["central-intelligence-agency"]
        self.assertEqual(len(cia["relations_in"]), 1)
        self.assertEqual(cia["relations_in"][0]["label"], "Employer of")
        self.assertEqual(cia["relations_in"][0]["fn_page"], "william-barr")

    def test_reverse_declared_on_object_page(self):
        e = self._ents()
        self.assertEqual(e["terry-waite"]["relations"][0]["label"], "Subject of")
        self.assertEqual(e["terry-waite"]["relations"][0]["fn_page"], "sun-streak")
        self.assertEqual(e["sun-streak"]["relations_in"][0]["other_id"], "terry-waite")


if __name__ == "__main__":
    unittest.main()
