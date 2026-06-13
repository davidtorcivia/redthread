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


if __name__ == "__main__":
    unittest.main(verbosity=2)
