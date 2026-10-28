"""Unit tests for build/lineage.py. Run with the parser tests:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lineage  # noqa: E402


def ent(eid, title, typ="person", born=None, **kw):
    return {"id": eid, "title": title, "type": typ, "dates": {"born": born} if born else {},
            "relations": [], "relations_in": [], "mention_count": 1, **kw}


def rel(typ, other, title, role=None, start=None, end=None, label=""):
    return {"type": typ, "other_id": other, "other_title": title, "role": role, "start": start, "end": end, "label": label}


class RoleTests(unittest.TestCase):
    def test_role_class_reads_first_clause(self):
        self.assertEqual(lineage.role_class("son (born at Hong Kong, 1863)"), "child")
        self.assertEqual(lineage.role_class("maternal grandfather; Sara was his daughter"), "gp")
        self.assertEqual(lineage.role_class("brother-in-law"), "other")
        self.assertIsNone(lineage.role_class(None))


class SpanTests(unittest.TestCase):
    def test_open_span_inside_a_complete_one_is_dropped(self):
        spans = [{"start": 1922, "end": None}, {"start": 1922, "end": 1946}, {"start": 1950, "end": None}]
        self.assertEqual(lineage.dedupe_spans(spans), [{"start": 1922, "end": 1946}, {"start": 1950, "end": None}])

    def test_same_years_keep_the_stronger_relation(self):
        spans = [{"type": "employed_by", "start": 2013, "end": None}, {"type": "head_of", "start": 2013, "end": None}]
        self.assertEqual([sp["type"] for sp in lineage.dedupe_spans(spans)], ["head_of"])

    def test_exact_repeats_merge_and_separate_stints_stay(self):
        spans = [{"start": 2004, "end": None}, {"start": 2004, "end": None}, {"start": 1981, "end": None}]
        self.assertEqual(lineage.dedupe_spans(spans), [{"start": 1981, "end": None}, {"start": 2004, "end": None}])


class FamilyTests(unittest.TestCase):
    def build(self):
        # The son's page calls his father "son": birth years must win over the role.
        father, son, daughter = ent("f", "Ann Smith", born="1900"), ent("s", "Bob Smith", born="1930"), ent("d", "Cat Smith")
        son["relations"] = [rel("relative_of", "f", "Ann Smith", role="son"),
                            rel("relative_of", "d", "Cat Smith", role="sister")]
        father["relations"] = [rel("spouse_of", None, "Dan Jones", start="1925")]
        daughter["relations"] = [rel("relative_of", "f", "Ann Smith", role="mother")]
        loner = ent("x", "Xavier Other")
        return lineage.Lineage([father, son, daughter, loner]).families()

    def test_birth_years_set_direction(self):
        fam = self.build()[0]
        parent = [e for e in fam["edges"] if e["cls"] == "parent" and e["b"] == "s"]
        self.assertEqual(parent, [{"a": "f", "b": "s", "cls": "parent", "verified": True, "start": None}])

    def test_role_sets_direction_without_birth_years(self):
        fam = self.build()[0]
        edge = [e for e in fam["edges"] if e["cls"] == "parent" and "d" in (e["a"], e["b"])]
        self.assertEqual((edge[0]["a"], edge[0]["b"], edge[0]["verified"]), ("f", "d", False))

    def test_a_drawn_pair_is_not_also_listed_as_other(self):
        f, s, d = ent("f", "Ann Smith", born="1900"), ent("s", "Bob Smith", born="1930"), ent("d", "Cat Smith")
        s["relations"] = [rel("relative_of", "f", "Ann Smith", role="son"), rel("relative_of", "d", "Cat Smith", role="sister")]
        f["relations_in"] = [rel("relative_of", "s", "Bob Smith", role=None)]
        fam = lineage.Lineage([f, s, d]).families()[0]
        self.assertEqual(fam["others"], [])

    def test_people_without_pages_join_and_small_groups_are_skipped(self):
        fams = self.build()
        self.assertEqual(len(fams), 1)
        self.assertIn("t:dan jones", {p["key"] for p in fams[0]["people"]})
        self.assertEqual(fams[0]["name"], "Smith")


class LineageTests(unittest.TestCase):
    def test_origins_rows_shared_and_events(self):
        org = ent("o", "Acme", "organization", wikilinks=[{"target": "Big Strike"}])
        dest = ent("dest", "Board", "organization")
        strike = ent("ev", "Big Strike", "event")
        strike["dates"] = {"start": "1930"}
        people = [ent(f"p{i}", f"Person {i}") for i in range(5)]
        org["relations_in"] = [rel("employed_by", p["id"], p["title"], start=str(1900 + i)) for i, p in enumerate(people)]
        org["relations_in"] += [rel("founded", "p0", "Person 0", start="1899", label="Founded by"),
                                rel("founded", "p0", "Person 0", start="1901", label="Founded by")]
        org["relations"] = [rel("participant_in", None, "Old War", start="1910", end="1912", label="Took part in")]
        for p in people[:2]:
            p["relations"] = [rel("head_of", "dest", "Board", start="1950", label="Head of")]
        out = lineage.Lineage([org, dest, strike, *people]).lineage(org)
        self.assertEqual(out["origins"][0]["years"], [1899, 1901])
        self.assertEqual(len(out["rows"]), 5)
        self.assertEqual([(s["title"], s["via"]) for s in out["shared"]], [("Board", ["Person 0", "Person 1"])])
        self.assertEqual([(e["title"], e["rank"]) for e in out["events"]], [("Old War", 0), ("Big Strike", 2)])

    def test_too_few_rows_gives_no_lineage(self):
        org = ent("o", "Tiny", "organization")
        org["relations_in"] = [rel("employed_by", "p", "P", start="1900")]
        self.assertIsNone(lineage.Lineage([org]).lineage(org))


if __name__ == "__main__":
    unittest.main()
