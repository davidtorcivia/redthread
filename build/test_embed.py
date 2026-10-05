"""Unit tests for build/embed.py. Run with the parser tests:

    .venv/bin/python -m unittest discover -s build -p 'test_*.py'
"""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import embed  # noqa: E402


def ent(eid, body, title=None, summary=None, toc=None, type="person", **fm):
    return {"id": eid, "title": title or eid.title(), "type": type, "summary": summary,
            "body_md": body, "toc": toc or [], "frontmatter": fm}


def words(n, w="word"):
    return " ".join([w] * n)


class FakeEmbedder:
    """Deterministic full-width vectors (wider than DIMS, like the API); counts what it embeds."""

    def __init__(self):
        self.calls = 0

    def embed(self, texts):
        self.calls += len(texts)
        return np.stack([np.random.default_rng(abs(hash(t)) % 2**32).standard_normal(2 * embed.DIMS) for t in texts])


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

    def test_anchors_match_escaped_markup_and_repeated_headings(self):
        body = "\n\n".join([words(50), "### Sullivan & *Cromwell*", words(50), "### Caracas", words(50),
                             "### Caracas", words(50)])
        toc = [{"text": "Sullivan &amp; Cromwell", "id": "sullivan-cromwell"},
               {"text": "Caracas", "id": "caracas"}, {"text": "Caracas", "id": "caracas-2"}]
        chunks = embed.chunk_entity(ent("a", body, toc=toc))
        self.assertEqual([c["anchor"] for c in chunks], ["", "sullivan-cromwell", "caracas", "caracas-2"])
        self.assertEqual(chunks[1]["heading"], "Sullivan & Cromwell")

    def test_aliases_from_both_keys_strings_and_mappings(self):
        fm = {"alias": "Tony Russo", "aliases": [{"UFO": "Live"}, "Tony Russo", 1995, None]}
        self.assertEqual(embed.aliases_of(fm), ["Tony Russo", "UFO: Live", "1995"])
        self.assertTrue(embed.chunk_entity(ent("a", words(50), title="A", **fm))[0]["text"].startswith(
            "A (also Tony Russo, UFO: Live, 1995)\n"))

    def test_summary_not_repeated_when_body_opens_with_it(self):
        text = embed.chunk_entity(ent("a", f"Sum here. {words(50)}", summary="Sum here."))[0]["text"]
        self.assertEqual(text.count("Sum here."), 1)

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

    def test_primary_year_and_snippet(self):
        self.assertEqual(embed.primary_year({"dates": {"died": "1969-01-29", "born": "c. 1893"}}), 1969)
        self.assertIsNone(embed.primary_year({}))
        self.assertEqual(embed.snippet("Title\nshort body"), "short body")
        long = embed.snippet("T\n" + words(100))
        self.assertTrue(long.endswith("…") and len(long) <= embed.SNIPPET_CHARS + 1)

    def test_empty_body_falls_back_to_summary(self):
        self.assertEqual(len(embed.chunk_entity(ent("a", "", summary="Only a summary."))), 1)
        self.assertEqual(embed.chunk_entity(ent("a", "")), [])


class PostTests(unittest.TestCase):
    def reply(self, rows):
        return io.BytesIO(json.dumps({"success": True, "result": {"data": rows}}).encode())

    def test_short_reply_is_retried_then_raised(self):
        e = embed.Embedder("acct", "tok", "m")
        with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: self.reply([[0.1]])) as op, \
                mock.patch("time.sleep"):
            with self.assertRaises(ValueError):
                e._post(["a", "b"])
        self.assertEqual(op.call_count, 5)

    def test_auth_error_is_not_retried(self):
        err = embed.urllib.error.HTTPError("u", 401, "no", {}, None)
        with mock.patch("urllib.request.urlopen", side_effect=err) as op:
            with self.assertRaises(embed.urllib.error.HTTPError):
                embed.Embedder("acct", "tok", "m")._post(["a"])
        self.assertEqual(op.call_count, 1)

    def test_transient_failure_then_success(self):
        replies = [ConnectionResetError(), self.reply([[1.0], [2.0]])]
        with mock.patch("urllib.request.urlopen", side_effect=replies), mock.patch("time.sleep"):
            self.assertEqual(embed.Embedder("acct", "tok", "m")._post(["a", "b"]), [[1.0], [2.0]])


class IndexTests(unittest.TestCase):
    def test_quantize_preserves_ranking(self):
        m = embed.normalize(np.random.default_rng(1).standard_normal((50, 64)), 64)
        q, scale = embed.quantize(m)
        approx = q.astype(np.float32) * scale[:, None]
        self.assertLess(np.abs(approx - m).max(), 0.01)
        self.assertEqual(int(np.argmax(approx @ m[7])), 7)

    def test_similar_excludes_self_and_orders_by_score(self):
        v = embed.normalize(np.array([[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]], dtype=np.float32), 2)
        out = embed.similar(["a", "b", "c", "d"], ["a", "b", "c", "c"], v, k=2)
        self.assertEqual([s["id"] for s in out["a"]], ["b", "c"])
        self.assertNotIn("d", out)
        self.assertEqual(embed.similar(["a"], ["a"], v[:1]), {})

    def test_similar_past_the_first_block(self):
        rng = np.random.default_rng(2)
        base = embed.normalize(rng.standard_normal((1100, 8)), 8)
        v = np.concatenate([base, base[-1:] + 1e-3])
        ids = [str(i) for i in range(1101)]
        out = embed.similar(ids, ids, embed.normalize(v, 8), k=1)
        self.assertEqual(out["1100"][0]["id"], "1099")
        self.assertEqual(out["1099"][0]["id"], "1100")

    def test_build_embeds_only_changed_sections_and_survives_missing_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            ents = [ent("a", words(60, "alpha")), ent("b", words(60, "beta")), ent("m", words(60), type="meta")]
            (data / "entities.json").write_text(json.dumps(ents))
            fake = FakeEmbedder()
            self.assertTrue(embed.build(data, fake))
            self.assertEqual(fake.calls, 2)
            index = json.loads((data / "semantic" / "index.json").read_text())
            self.assertEqual([index["entries"][c[0]][0] for c in index["chunks"]], ["a", "b"])
            self.assertTrue(index["chunks"][0][3].startswith("alpha alpha"))
            self.assertEqual(len((data / "semantic" / "vectors.bin").read_bytes()), 2 * embed.DIMS)
            cache = embed.load_cache(next((data / "semantic").glob("cache-*.npz")))
            self.assertEqual(next(iter(cache.values())).shape, (2 * embed.DIMS,))

            ents[1]["body_md"] = words(60, "gamma")
            (data / "entities.json").write_text(json.dumps(ents))
            self.assertTrue(embed.build(data, fake))
            self.assertEqual(fake.calls, 3)
            self.assertEqual(len(embed.load_cache(next((data / "semantic").glob("cache-*.npz")))), 2)

            before = (data / "semantic" / "index.json").read_text()
            ents.append(ent("c", words(60, "delta")))
            (data / "entities.json").write_text(json.dumps(ents))
            with self.assertRaises(RuntimeError):
                embed.build(data, None)
            self.assertEqual((data / "semantic" / "index.json").read_text(), before)

    def test_without_credentials_or_index_the_step_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "entities.json").write_text(json.dumps([ent("a", words(60))]))
            self.assertFalse(embed.build(Path(d), None))
            self.assertFalse((Path(d) / "semantic" / "similar.json").exists())

    def test_main_marks_failure_and_clears_it_on_success(self):
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / "semantic" / "FAILED"
            argv = ["embed.py", "--data", d]
            with mock.patch.object(sys, "argv", argv), mock.patch.dict("os.environ", {}, clear=True):
                (Path(d) / "entities.json").write_text("not json")
                self.assertEqual(embed.main(), 0)
                self.assertTrue(marker.exists())
                (Path(d) / "entities.json").write_text(json.dumps([ent("a", words(60))]))
                embed.main()
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
