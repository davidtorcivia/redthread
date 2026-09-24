"""Unit tests for the vault parser. Stdlib unittest only; run under the build venv:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
"""
import datetime as dt
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_vault as pv  # noqa: E402


def wl(target, display=None, section=""):
    return {"target": target, "display": display or target, "section": section}


def make_entity(eid, title, type="concept", aliases=None, wikilinks=None, **fm):
    """Just enough of a parse_file() record for the link and alias functions."""
    if aliases is not None:
        fm["aliases"] = aliases
    return {"id": eid, "title": title, "type": type, "frontmatter": fm,
            "wikilinks": wikilinks or []}


def edge(s, t, kind="explicit", **extra):
    return {"source": s, "target_id": t, "target_title": t, "display": t,
            "section": "", "kind": kind, **extra}


class TestTextHelpers(unittest.TestCase):
    def test_normalize_target(self):
        self.assertEqual(pv.normalize_target("  Central   Intelligence\tAgency "),
                         "central intelligence agency")

    def test_slugify(self):
        self.assertEqual(pv.slugify("Hello World!"), "hello-world")
        self.assertEqual(pv.slugify("  A__B  "), "a-b")
        self.assertEqual(pv.slugify("!!!"), "untitled")
        self.assertEqual(pv.slugify(""), "untitled")

    def test_fix_mojibake(self):
        self.assertEqual(pv.fix_mojibake("PeÃ±a"), ("Peña", True))
        self.assertEqual(pv.fix_mojibake("Peña"), ("Peña", False))


class TestExtractWikilinks(unittest.TestCase):
    def test_plain_and_piped(self):
        links = pv.extract_wikilinks("see [[Alpha]] and [[Beta|the second]]")
        self.assertEqual(links, [wl("Alpha"), wl("Beta", "the second")])

    def test_section(self):
        self.assertEqual(pv.extract_wikilinks("[[Page#History]]"),
                         [wl("Page", "Page#History", "History")])
        self.assertEqual(pv.extract_wikilinks("[[Page#History|read more]]"),
                         [wl("Page", "read more", "History")])

    def test_embeds_are_skipped(self):
        links = pv.extract_wikilinks("![[image.png]] but [[Real]] counts")
        self.assertEqual([l["target"] for l in links], ["Real"])


class TestExtractFootnotes(unittest.TestCase):
    def test_pulls_defs_and_strips_header(self):
        notes, clean = pv.extract_footnotes("Claim.[^1]\n\n### Footnotes\n\n[^1]: The source.")
        self.assertEqual(notes, [{"id": "1", "text": "The source."}])
        self.assertEqual(clean, "Claim.[^1]")


class TestFrontmatterFields(unittest.TestCase):
    def test_date_str(self):
        self.assertEqual(pv._date_str(1904), "1904")
        self.assertEqual(pv._date_str(dt.date(1904, 8, 30)), "1904-08-30")
        self.assertIsNone(pv._date_str(None))
        self.assertIsNone(pv._date_str("   "))

    def test_extract_dates_known_keys_only(self):
        fm = {"born": 1950, "end": dt.date(2001, 9, 11), "irrelevant": "x"}
        self.assertEqual(pv._extract_dates(fm), {"born": "1950", "end": "2001-09-11"})

    def test_extract_location(self):
        self.assertEqual(pv._extract_location({"location": "NYC"}), ["NYC"])
        self.assertEqual(pv._extract_location({"location": ["A", " B "]}), ["A", "B"])
        self.assertEqual(pv._extract_location({}), [])
        self.assertEqual(pv._extract_location({"location": 7}), [])


class TestBuildSlugIndex(unittest.TestCase):
    def test_title_and_alias(self):
        idx = pv.build_slug_index([make_entity("cia", "Central Intelligence Agency", aliases=["CIA"])])
        self.assertEqual(idx["central intelligence agency"], "cia")
        self.assertEqual(idx["cia"], "cia")

    def test_title_beats_another_entitys_alias(self):
        idx = pv.build_slug_index([make_entity("a", "Foo"), make_entity("b", "Bar", aliases=["Foo"])])
        self.assertEqual(idx["foo"], "a")

    def test_alias_claimed_by_two_entities_is_dropped(self):
        idx = pv.build_slug_index([make_entity("a", "Alpha", aliases=["Shared"]),
                                   make_entity("b", "Beta", aliases=["Shared"])])
        self.assertNotIn("shared", idx)

    def test_alias_forms(self):
        self.assertEqual(pv.build_slug_index([make_entity("a", "Alpha", aliases="Solo")])["solo"], "a")
        idx = pv.build_slug_index([make_entity("a", "Alpha", aliases=["Good", 123, None])])
        self.assertEqual(idx, {"alpha": "a", "good": "a"})

    def test_title_collision_last_write_wins(self):
        idx = pv.build_slug_index([make_entity("first", "Dup"), make_entity("second", "Dup")])
        self.assertEqual(idx["dup"], "second")


class TestResolveLinks(unittest.TestCase):
    def test_resolves_title_and_alias_case_insensitively(self):
        ents = [make_entity("cia", "Central Intelligence Agency", aliases=["CIA"]),
                make_entity("src", "Source", wikilinks=[wl("Central Intelligence Agency"), wl("cIa")])]
        edges, unresolved = pv.resolve_links(ents, pv.build_slug_index(ents))
        self.assertEqual([e["target_id"] for e in edges], ["cia", "cia"])
        self.assertEqual(len(unresolved), 0)

    def test_unresolved_counted_not_dropped(self):
        ents = [make_entity("src", "Source", wikilinks=[wl("Nowhere")])]
        edges, unresolved = pv.resolve_links(ents, pv.build_slug_index(ents))
        self.assertEqual(len(edges), 1)
        self.assertIsNone(edges[0]["target_id"])
        self.assertEqual(unresolved["Nowhere"], 1)


class TestBuildAliasMap(unittest.TestCase):
    def test_unique_title_resolves(self):
        resolved, _ = pv.build_alias_map([make_entity("a", "Solo Org")], [])
        self.assertEqual(resolved["Solo Org"], "a")

    def test_title_vs_alias_collision_is_ambiguous(self):
        # Title weight 100 is under 3x the alias weight 50.
        resolved, ambiguous = pv.build_alias_map(
            [make_entity("a", "Foo"), make_entity("b", "Bar", aliases=["Foo"])], [])
        self.assertIn("Foo", ambiguous)
        self.assertNotIn("Foo", resolved)

    def test_short_numeric_and_stopword_forms_skipped(self):
        resolved, _ = pv.build_alias_map(
            [make_entity("a", "Org", aliases=["AB", "1980"]), make_entity("b", "the")], [])
        self.assertEqual(resolved, {"Org": "a"})

    def _display_edges(self, target_id, target_title, display, n=2):
        return [{**edge(f"s{i}", target_id), "target_title": target_title, "display": display}
                for i in range(n)]

    def test_display_word_shared_by_other_titles_not_mined(self):
        ents = [make_entity("joe-king", "Joe King", "person"),
                make_entity("mlk", "Martin Luther King Jr.", "person"),
                make_entity("jc", "J.C. King", "person")]
        resolved, _ = pv.build_alias_map(ents, self._display_edges("joe-king", "Joe King", "King"))
        self.assertNotIn("King", resolved)

    def test_display_word_unique_to_target_is_mined(self):
        ents = [make_entity("reagan", "Ronald Reagan", "person"),
                make_entity("nancy", "Nancy Reagan", "person")]
        resolved, _ = pv.build_alias_map(ents, self._display_edges("reagan", "Ronald Reagan", "Reagan"))
        self.assertEqual(resolved["Reagan"], "reagan")

    def test_generic_institution_display_not_mined(self):
        ents = [make_entity("labor-party", "Labor Party", "organization")]
        edges = [edge(f"s{i}", "labor-party", display="Labor") for i in range(3)]
        resolved, _ = pv.build_alias_map(ents, edges)
        self.assertNotIn("Labor", resolved)

    def test_lowercase_display_only_when_it_is_the_title(self):
        ents = [make_entity("simwa", "SIMWA", "organization"), make_entity("rv", "Remote Viewing")]
        edges = (self._display_edges("simwa", "SIMWA", "agreement")
                 + self._display_edges("rv", "Remote Viewing", "remote viewing"))
        resolved, _ = pv.build_alias_map(ents, edges)
        self.assertNotIn("agreement", resolved)
        self.assertEqual(resolved["remote viewing"], "rv")


class TestTrieRegex(unittest.TestCase):
    def test_longest_match_with_backtrack(self):
        import re
        words = ["Bush", "Bush Jr", "CIA", "CIA Director", "Soviet Union", "Sov"]
        rx = re.compile(rf"(?<![A-Za-z0-9])(?:{pv._trie_regex(words)})(?![A-Za-z0-9])")
        text = "the CIA Director and CIA Directors, Bush Jr. Bushy Soviet Union Sov"
        self.assertEqual([m.group(0) for m in rx.finditer(text)],
                         ["CIA Director", "CIA", "Bush Jr", "Soviet Union", "Sov"])


class TestImplicitLinks(unittest.TestCase):
    def targets(self, body, alias_map, types):
        ents = [{"id": i, "title": i, "type": t, "body_md": ""} for i, t in types.items()]
        ents.append({"id": "page", "title": "Page", "type": "concept", "body_md": body})
        edges, _ = pv.find_implicit_links(ents, alias_map, [])
        return {e["target_id"] for e in edges}

    def test_surname_after_another_first_name_is_skipped(self):
        people = {"jfk": "person"}
        alias = {"Kennedy": "jfk"}
        self.assertEqual(self.targets("Sybol Kennedy stole a Rolodex.", alias, people), set())
        self.assertEqual(self.targets("President Kennedy spoke.", alias, people), {"jfk"})
        self.assertEqual(self.targets("It began. Kennedy spoke.", alias, people), {"jfk"})
        self.assertEqual(self.targets("the Nixon-Kennedy debate", alias, people), {"jfk"})

    def test_only_people_and_non_acronyms_get_the_name_check(self):
        alias = {"Florida": "fl", "CIA": "cia"}
        types = {"fl": "place", "cia": "organization"}
        self.assertEqual(self.targets("South Florida and Langley CIA", alias, types), {"fl", "cia"})

    def test_common_word_in_heading_is_skipped(self):
        people = {"begin": "person"}
        alias = {"Begin": "begin"}
        prose = " begin" * 5
        self.assertEqual(self.targets("### Texts to Begin With\n" + prose, alias, people), set())
        self.assertEqual(self.targets("Begin signed the accords.\n" + prose, alias, people), {"begin"})


class TestRenderHtml(unittest.TestCase):
    def render(self, body):
        ents = [{"id": "att", "title": "AT&T", "type": "organization", "body_md": body, "footnotes": []}]
        pv.render_html(ents, pv.build_slug_index([make_entity("att", "AT&T")]))
        return ents[0]["body_html"]

    def test_escaped_title_resolves(self):
        self.assertIn('<a class="wikilink" href="/organizations/att/">AT&amp;T</a>', self.render("[[AT&T]]"))

    def test_attributes_and_code_left_alone(self):
        out = self.render('[x](http://a "[[AT&T]]") `[[AT&T]]`')
        self.assertIn('title="[[AT&amp;T]]"', out)
        self.assertIn("<code>[[AT&amp;T]]</code>", out)

    def test_formatted_display_still_links(self):
        self.assertIn('<a class="wikilink" href="/organizations/att/"><em>AT&amp;T</em></a>',
                      self.render("[[AT&T|*AT&T*]]"))


class TestParseFile(unittest.TestCase):
    def parse(self, relpath, text, type_map):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / relpath
            p.parent.mkdir(parents=True)
            p.write_text(text, encoding="utf-8")
            return pv.parse_file(p, Path(d), type_map)

    def test_parses_frontmatter_body_and_type(self):
        e = self.parse("people/Test Person.md", (
            "---\nsummary: A test person.\nborn: 1950\naliases:\n  - Tester\ntags:\n  - Spy\n---\n"
            "Bio mentioning [[Some Org]].[^1]\n\n[^1]: a note\n"), {"people": "person"})
        self.assertEqual(e["id"], "test-person")
        self.assertEqual(e["title"], "Test Person")
        self.assertEqual(e["type"], "person")
        self.assertEqual(e["dates"], {"born": "1950"})
        self.assertEqual(e["tags"], ["Spy"])
        self.assertEqual([l["target"] for l in e["wikilinks"]], ["Some Org"])
        self.assertEqual(e["footnotes"], [{"id": "1", "text": "a note"}])
        self.assertEqual(e["frontmatter"]["aliases"], ["Tester"])

    def test_strips_repeated_bom(self):
        # frontmatter is silently read as body unless every BOM is stripped.
        e = self.parse("misc/BOMful.md", "﻿﻿---\nsummary: ok\n---\nbody\n", {})
        self.assertEqual(e["summary"], "ok")
        self.assertEqual(e["type"], "page")

    def test_scalar_tags_and_summary_become_strings(self):
        e = self.parse("misc/Odd.md", "---\ntags: 2024\nsummary: 1999\n---\nbody\n", {})
        self.assertEqual(e["tags"], ["2024"])
        self.assertEqual(e["summary"], "1999")


class TestLoadConfig(unittest.TestCase):
    def load(self, cfg):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            p.write_text(cfg, encoding="utf-8")
            return pv.load_config(p)

    def test_user_patterns_extend_defaults_and_nulls_are_ignored(self):
        cfg = self.load('{"skipPathPatterns": ["Templates/**"], "typeMap": null}')
        self.assertIn(".trash/**", cfg["skipPathPatterns"])
        self.assertIn("Templates/**", cfg["skipPathPatterns"])
        self.assertEqual(cfg["typeMap"], pv.DEFAULT_CONFIG["typeMap"])


class TestRankings(unittest.TestCase):
    def ents(self, *specs):
        out = []
        for spec in specs:
            eid, typ = (spec, "person") if isinstance(spec, str) else spec
            out.append({**make_entity(eid, eid.title(), typ), "summary": None})
        return out

    def test_related_prefers_rare_neighbor_over_ubiquitous_hub(self):
        # hub shares 3 pages with x but is everywhere; rare shares 2. IDF puts rare first.
        ents = self.ents("x", "hub", "rare", "p1", "p2", "p3", "p4", "p5")
        edges = [edge(p, t) for p in ("p1", "p2", "p3") for t in ("x", "hub")]
        edges += [edge(p, "rare") for p in ("p1", "p2")] + [edge(p, "hub") for p in ("p4", "p5")]
        related, _, _ = pv.compute_relationships(ents, edges)
        ids = [r["id"] for r in related["x"]]
        self.assertLess(ids.index("rare"), ids.index("hub"))
        self.assertEqual(related["x"][ids.index("hub")]["count"], 3)

    def test_related_keeps_dense_subject_pairs_and_ignores_ner(self):
        ents = self.ents("big", "x", "y", *[f"f{i}" for i in range(45)])
        edges = [edge("big", t) for t in ("x", *[f"f{i}" for i in range(45)])]
        edges += [edge("y", "x", "implicit", count=3)]
        related, _, _ = pv.compute_relationships(ents, edges)
        self.assertIn("big", [r["id"] for r in related["x"]])  # own page of a dense entry
        self.assertNotIn("f0", [r["id"] for r in related["x"]])  # its cross pairs are dropped
        self.assertNotIn("y", related)  # a name match alone is not co-occurrence

    def test_hub_needs_inbound_links_and_rankable_type(self):
        ents = self.ents(("narr", "meta"), "a", "b", "c")
        edges = [edge("narr", t) for t in ("a", "b", "c")] + [edge("a", "b"), edge("c", "b")]
        hubs = pv.compute_hub_scores(ents, edges)
        self.assertNotIn("narr", hubs)
        self.assertEqual(hubs["b"]["rank"], 1)

    def test_bridge_is_cited_from_multiple_communities(self):
        ents = self.ents(*[f"a{i}" for i in range(5)], *[f"b{i}" for i in range(5)],
                         "link", "local", ("town", "place"), "named")
        edges = [edge(f"{g}{i}", f"{g}{j}") for g in "ab" for i in range(5) for j in range(i + 1, 5)]
        edges += [edge(s, t) for s in ("a0", "a1", "b0", "b1") for t in ("link", "town")]
        edges += [edge(s, "local") for s in ("a0", "a1", "a2", "a3")]
        edges += [edge(s, "named", "implicit", count=1) for s in ("a0", "a1", "b0", "b1")]
        bridges, _ = pv.compute_bridge_scores(ents, edges, resolution=1.0, exclude_types=set())
        self.assertEqual(bridges["link"]["rank"], 1)
        self.assertNotIn("local", bridges)  # cited from one community only
        self.assertNotIn("town", bridges)   # places are never bridges
        self.assertNotIn("named", bridges)  # NER mentions are not citations


class TestBuildAdjacency(unittest.TestCase):
    def test_dir_bits_follow_link_direction(self):
        ents = [make_entity("a", "A"), make_entity("b", "B"), make_entity("c", "C")]
        edges = [edge("a", "b"), edge("b", "c"), edge("c", "b"), edge("a", "c", "implicit", count=2)]
        adj = pv.build_adjacency(ents, edges)
        idx = {eid: i for i, eid in enumerate(adj["ids"])}

        def d(x, y):
            return adj["dir"][idx[x]][adj["adj"][idx[x]].index(idx[y])]
        self.assertEqual([d("a", "b"), d("b", "a"), d("b", "c"), d("a", "c")], [1, 2, 3, 0])
        self.assertEqual(adj["implicitPairs"], [[idx["a"], idx["c"]]])


class TestSummarizeCommunities(unittest.TestCase):
    def test_label_uses_top_rankable_members(self):
        ents = [make_entity("a", "Alpha", "person"), make_entity("b", "Beta", "organization"),
                make_entity("c", "Gamma", "place"), make_entity("n", "Notes", "meta"),
                make_entity("z", "Zeta", "person")]
        for e, m in zip(ents, (5, 9, 1, 50, 2)):
            e["mention_count"] = m
        out = pv.summarize_communities(ents, {"a": 0, "b": 0, "c": 0, "n": 0, "z": 1})
        self.assertEqual([c["label"] for c in out], ["Beta · Alpha · Gamma", "Zeta"])
        self.assertEqual(out[0]["size"], 4)
        self.assertEqual(out[0]["top"][0]["id"], "n")  # listed, just not in the label


class TestFocus(unittest.TestCase):
    def test_pins_then_scores_then_cluster(self):
        ents = [
            {"id": "a", "path": "10/a.md", "type": "person", "summary": "x", "mention_count": 10, "community_id": 0},
            {"id": "b", "path": "10/b.md", "type": "person", "summary": "x", "mention_count": 1, "community_id": 1},
            {"id": "c", "path": "10/c.md", "type": "person", "summary": "x", "mention_count": 50, "community_id": 1},
            {"id": "p", "path": "60/p.md", "type": "place", "summary": "x", "mention_count": 99, "community_id": 0},
        ]
        comms = [{"label": "L0", "size": 2}, {"label": "L1", "size": 2}]
        edits = Counter({"10/a.md": 3, "10/b.md": 1, "60/p.md": 9})
        f = pv.compute_focus(ents, [{"source": "b", "target_id": "c"}], comms, edits, pins=["c"], slots=2)
        self.assertEqual([p["id"] for p in f["pages"]], ["c", "a"])  # places never picked
        self.assertTrue(f["pages"][0]["pinned"])
        self.assertIn("1 linking page edited", f["pages"][0]["reason"])
        self.assertEqual(f["cluster"]["id"], 0)  # a and p edited in 0, only b in 1


class TestRelations(unittest.TestCase):
    @staticmethod
    def rel(ent_id, title, *relations):
        return {"id": ent_id, "title": title,
                "relations_raw": pv._extract_relations({"relations": list(relations)}, title)}

    def resolved(self):
        ents = [
            self.rel("william-barr", "William Barr",
                     {"type": "employed_by", "with": "[[Central Intelligence Agency|CIA]]",
                      "start": 1973, "end": 1977, "fn": 1},
                     {"type": "appointed", "with": "[[Nicholas J. Bua]]", "start": "1991-11-07", "fn": 2},
                     {"type": "not_a_type", "with": "[[X]]"}),
            self.rel("sun-streak", "Sun Streak",
                     {"type": "subject_of", "with": "[[Terry Waite]]", "reverse": True, "fn": 9}),
            self.rel("central-intelligence-agency", "Central Intelligence Agency",
                     {"type": "employed_by", "with": "[[William Barr]]", "reverse": True, "start": 1973}),
            self.rel("terry-waite", "Terry Waite"),
        ]
        pv.resolve_relations(ents, pv.build_slug_index(ents))
        return {e["id"]: e for e in ents}

    def test_bad_type_dropped_and_target_unwrapped(self):
        barr = self.resolved()["william-barr"]
        self.assertEqual([r["type"] for r in barr["relations"]], ["employed_by", "appointed"])
        self.assertEqual(barr["relations"][0]["other_id"], "central-intelligence-agency")
        self.assertEqual(barr["relations"][0]["start"], "1973")

    def test_unresolved_target_kept_by_title(self):
        barr = self.resolved()["william-barr"]
        self.assertIsNone(barr["relations"][1]["other_id"])
        self.assertEqual(barr["relations"][1]["other_title"], "Nicholas J. Bua")

    def test_inverse_on_object_and_no_double_count(self):
        cia = self.resolved()["central-intelligence-agency"]
        self.assertEqual(len(cia["relations_in"]), 1)
        self.assertEqual(cia["relations_in"][0]["label"], "Employer of")
        self.assertEqual(cia["relations_in"][0]["fn_page"], "william-barr")

    def test_reverse_declared_on_object_page(self):
        e = self.resolved()
        self.assertEqual(e["terry-waite"]["relations"][0]["label"], "Subject of")
        self.assertEqual(e["terry-waite"]["relations"][0]["fn_page"], "sun-streak")
        self.assertEqual(e["sun-streak"]["relations_in"][0]["other_id"], "terry-waite")

    def kin(self, dad_rel, kid_rel=None):
        kid_rels = [{"type": "relative_of", "with": "[[Dad]]", **kid_rel}] if kid_rel else []
        ents = [self.rel("dad", "Dad", {"type": "relative_of", "with": "[[Kid]]", **dad_rel}),
                self.rel("kid", "Kid", *kid_rels)]
        pv.resolve_relations(ents, {"dad": "dad", "kid": "kid"})
        return {e["id"]: e["relations"] + e["relations_in"] for e in ents}

    def test_symmetric_declared_twice_is_one_row_with_other_persons_role(self):
        rows = self.kin({"role": "father"}, {"role": "son"})
        self.assertEqual([(r["other_id"], r["role"]) for r in rows["dad"]], [("kid", "son")])
        self.assertEqual([(r["other_id"], r["role"]) for r in rows["kid"]], [("dad", "father")])

    def test_symmetric_each_page_shows_its_own_footnote(self):
        rows = self.kin({"role": "father", "fn": 1}, {"role": "son", "fn": 2})
        self.assertEqual((rows["dad"][0]["fn"], rows["dad"][0]["fn_page"]), ("1", "dad"))
        self.assertEqual((rows["kid"][0]["fn"], rows["kid"][0]["fn_page"]), ("2", "kid"))

    def test_symmetric_one_side_inverts_role(self):
        rows = self.kin({"role": "father"})
        self.assertEqual([(r["other_id"], r["role"]) for r in rows["dad"]], [("kid", "child")])
        self.assertEqual([(r["other_id"], r["role"]) for r in rows["kid"]], [("dad", "father")])


if __name__ == "__main__":
    unittest.main()
