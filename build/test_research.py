"""Unit tests for build/research.py. Run with the parser tests:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import research  # noqa: E402


class ResearchTests(unittest.TestCase):
    def test_entries_and_fulltext(self):
        entity = {
            "id": "beta", "title": "Beta", "type": "person",
            "frontmatter": {"aliases": ["B"], "tags": ["CIA"], "updated": "2026-01-02", "summary": "S."},
            "dates": {"born": "1937"},
            "body_md": "Lead ‘quoted’ [[Gamma|the place]].[^1]\n\n## Career\nJoined in Ж 1975.[^2]",
            "toc": [{"text": "Career", "id": "career"}],
            "footnotes": [{"id": "1", "text": "Smith “1999”."}, {"id": "2", "text": "Jones."}],
            "relations": [{"type": "employed_by", "other_id": "gamma", "other_title": "Gamma", "start": "1975",
                           "end": None, "role": "office not stated", "fn": "2", "fn_page": "beta"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "entities.json").write_text(json.dumps([entity]))
            research.build(data)
            raw = (data / "research" / "fulltext.json").read_bytes()
            entries = json.loads((data / "research" / "entries.json").read_text())
        # ASCII on disk keeps V8 from widening the whole parsed source.
        self.assertTrue(raw.isascii())
        text = json.loads(raw)
        self.assertEqual(text["sections"], [
            ["beta", "", "", "Lead 'quoted' the place.[^1]"],
            ["beta", "career", "Career", "Joined in Ж 1975.[^2]"],
        ])
        self.assertEqual(text["footnotes"], {"beta": {"1": 'Smith "1999".', "2": "Jones."}})
        [rec] = entries
        self.assertEqual(rec["path"], "/people/beta/")
        self.assertEqual((rec["aliases"], rec["tags"], rec["dates"]), (["B"], ["CIA"], {"born": "1937"}))
        self.assertNotIn("body_md", rec)
        self.assertEqual(rec["relations"][0]["source"], {"page": "beta", "footnote": "2", "text": "Jones."})


if __name__ == "__main__":
    unittest.main()
