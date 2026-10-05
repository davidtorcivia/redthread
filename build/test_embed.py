"""Unit tests for build/embed.py. Run with the parser tests:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import embed  # noqa: E402


def ent(eid, body, title=None, summary=None, toc=None, type="person", **fm):
    return {"id": eid, "title": title or eid.title(), "type": type, "summary": summary,
            "body_md": body, "toc": toc or [], "frontmatter": fm}


def words(n, w="word"):
    return " ".join([w] * n)


class FakeEmbedder:
    """Deterministic vectors from the text hash; counts what it was asked to embed."""

    def __init__(self):
        self.calls = 0

    def embed(self, texts):
        self.calls += len(texts)
        return np.stack([np.random.default_rng(abs(hash(t)) % 2**32).standard_normal(embed.DIMS) for t in texts])


class ChunkTests(unittest.TestCase):
    def test_plain_keeps_link_text(self):
        self.assertEqual(embed.plain("[[Central Intelligence Agency|CIA]] and [[Iran#History]] [x](/a/)[^1]"),
                         "CIA and Iran x")

    def test_sections_carry_toc_anchors_and_title(self):
        body = f"{words(50)}\n\n### Early Life\n\n{words(50, 'early')}\n\n### Career\n\n{words(50, 'career')}"
        toc = [{"text": "Early Life", "id": "early-life"}, {"text": "Career", "id": "career"}]
        chunks = embed.chunk_entity(ent("a", body, title="Alpha", summary="Sum.", toc=toc, aliases=["Al"]))
        self.assertEqual([c["anchor"] for c in chunks], ["", "early-life", "career"])
        self.assertTrue(chunks[0]["text"].startswith("Alpha (also Al)\nSum."))
        self.assertTrue(chunks[1]["text"].startswith("Alpha: Early Life\n"))

    def test_short_section_folds_into_previous(self):
        body = f"{words(50)}\n\n### Tiny\n\nshort text"
        chunks = embed.chunk_entity(ent("a", body))
        self.assertEqual(len(chunks), 1)
        self.assertIn("Tiny\nshort text", chunks[0]["text"])

    def test_long_section_splits_on_paragraphs(self):
        body = "\n\n".join(words(200) for _ in range(3))
        chunks = embed.chunk_entity(ent("a", body))
        self.assertEqual(len(chunks), 3)
        self.assertTrue(all(len(c["text"].split()) <= embed.MAX_WORDS + 5 for c in chunks))

    def test_empty_body_falls_back_to_summary(self):
        self.assertEqual(len(embed.chunk_entity(ent("a", "", summary="Only a summary."))), 1)
        self.assertEqual(embed.chunk_entity(ent("a", "")), [])


class IndexTests(unittest.TestCase):
    def test_quantize_preserves_ranking(self):
        m = embed.normalize(np.random.default_rng(1).standard_normal((50, 64)), 64)
        q, scale = embed.quantize(m)
        approx = q.astype(np.float32) * scale[:, None]
        self.assertLess(np.abs(approx - m).max(), 0.01)
        self.assertEqual(int(np.argmax(approx @ m[7])), 7)

    def test_similar_excludes_self_and_orders_by_score(self):
        v = embed.normalize(np.array([[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]], dtype=np.float32), 2)
        out = embed.similar(["a", "b", "c"], ["a", "b", "c", "c"], v, k=2)
        self.assertEqual([s["id"] for s in out["a"]], ["b", "c"])
        self.assertNotIn("a", [s["id"] for s in out["a"]])

    def test_build_embeds_only_changed_sections_and_survives_missing_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            ents = [ent("a", words(60, "alpha")), ent("b", words(60, "beta")), ent("m", words(60), type="meta")]
            (data / "entities.json").write_text(json.dumps(ents))
            fake = FakeEmbedder()
            self.assertTrue(embed.build(data, fake))
            self.assertEqual(fake.calls, 2)
            index = json.loads((data / "semantic" / "index.json").read_text())
            self.assertEqual([c[0] for c in index["chunks"]], ["a", "b"])
            self.assertEqual(len((data / "semantic" / "vectors.bin").read_bytes()), 2 * embed.DIMS)

            ents[1]["body_md"] = words(60, "gamma")
            (data / "entities.json").write_text(json.dumps(ents))
            self.assertTrue(embed.build(data, fake))
            self.assertEqual(fake.calls, 3)

            before = (data / "semantic" / "index.json").read_text()
            ents.append(ent("c", words(60, "delta")))
            (data / "entities.json").write_text(json.dumps(ents))
            self.assertFalse(embed.build(data, None))
            self.assertEqual((data / "semantic" / "index.json").read_text(), before)


if __name__ == "__main__":
    unittest.main()
