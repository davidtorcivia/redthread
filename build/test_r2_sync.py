"""Unit tests for deploy/r2_sync.py, run with the other build tests."""
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy"))
import r2_sync  # noqa: E402


class FakeR2:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.puts, self.deletes = [], []

    def list(self):
        return self.objects

    def put(self, key, path):
        self.puts.append(key)
        self.objects[key] = {"etag": hashlib.md5(path.read_bytes()).hexdigest(), "last_modified": "9"}

    def delete(self, key):
        self.deletes.append(key)
        del self.objects[key]


def site(root: Path) -> tuple[Path, Path]:
    dist, sem = root / "dist", root / "semantic"
    for rel, body in {"og/people/a.png": b"png", "people/a.md": b"# A", "people/a/index.html": b"<p>",
                      "people/a.md.gz": b"gz", "people/a/deep.md": b"no", "index.html": b"<p>"}.items():
        (dist / rel).parent.mkdir(parents=True, exist_ok=True)
        (dist / rel).write_bytes(body)
    sem.mkdir()
    for f in r2_sync.SEMANTIC_FILES:
        (sem / f).write_bytes(f.encode())
    return dist, sem


class SyncTests(unittest.TestCase):
    def test_site_files_are_og_images_and_markdown_twins(self):
        with tempfile.TemporaryDirectory() as d:
            dist, _ = site(Path(d))
            self.assertEqual(sorted(r2_sync.site_files(dist)), ["og/people/a.png", "people/a.md"])
            (dist / "fulltext.json").write_text("{}")
            self.assertEqual(sorted(r2_sync.site_files(dist)), ["fulltext.json", "og/people/a.png", "people/a.md"])

    def test_upload_sends_only_changed_files_and_versions_the_index(self):
        with tempfile.TemporaryDirectory() as d:
            dist, sem = site(Path(d))
            r2 = FakeR2({"people/a.md": {"etag": hashlib.md5(b"# A").hexdigest()}})
            version = r2_sync.upload(r2, dist, sem)
            self.assertEqual(len(version), 12)
            self.assertEqual(sorted(r2.puts), ["og/people/a.png", *sorted(f"semantic/{version}/{f}" for f in r2_sync.SEMANTIC_FILES)])
            r2.puts.clear()
            self.assertEqual(r2_sync.upload(r2, dist, sem), version)
            self.assertEqual(r2.puts, [])
            (sem / "similar.json").write_bytes(b"changed")
            self.assertNotEqual(r2_sync.upload(r2, dist, sem), version)

    def test_upload_without_an_index_returns_no_version(self):
        with tempfile.TemporaryDirectory() as d:
            dist, sem = site(Path(d))
            (sem / "vectors.bin").unlink()
            self.assertEqual(r2_sync.upload(FakeR2(), dist, sem), "")

    def test_prune_keeps_current_and_previous_index(self):
        with tempfile.TemporaryDirectory() as d:
            dist, _ = site(Path(d))
            objs = {"og/people/a.png": {}, "people/a.md": {}, "notes/x.txt": {}, "backup.md": {}}
            for v, t in (("v1", "1"), ("v2", "2"), ("v3", "3"), ("v4", "4"), ("cur", "5")):
                objs[f"semantic/{v}/index.json"] = {"last_modified": t}
            objs["people/gone.md"] = {}
            r2 = FakeR2(objs)
            r2_sync.prune(r2, dist, "cur", force=True)
            self.assertEqual(sorted(r2.deletes), ["people/gone.md", "semantic/v1/index.json"])

    def test_prune_refuses_to_empty_the_bucket(self):
        with tempfile.TemporaryDirectory() as d:
            dist, _ = site(Path(d))
            r2 = FakeR2({f"people/x{i}.md": {} for i in range(10)})
            with self.assertRaises(SystemExit):
                r2_sync.prune(r2, dist, "")
            self.assertEqual(r2.deletes, [])


class RestTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("time.sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def reply(body):
        return io.BytesIO(json.dumps(body).encode())

    def test_list_follows_the_cursor(self):
        pages = [
            {"result": [{"key": "a"}], "result_info": {"cursor": "c1", "is_truncated": True}},
            {"result": [{"key": "b"}], "result_info": {"cursor": "", "is_truncated": False}},
        ]
        with mock.patch("urllib.request.urlopen", side_effect=[self.reply(p) for p in pages]) as op:
            self.assertEqual(sorted(r2_sync.R2("acct", "tok", "bkt").list()), ["a", "b"])
        self.assertIn("cursor=c1", op.call_args_list[1].args[0].full_url)

    def test_429_waits_and_retries_but_403_does_not(self):
        limited = r2_sync.urllib.error.HTTPError("u", 429, "slow", {"Retry-After": "7"}, None)
        with mock.patch("urllib.request.urlopen", side_effect=[limited, self.reply({"ok": 1})]):
            self.assertEqual(r2_sync.R2("a", "t", "b")._req("GET", "https://x"), {"ok": 1})
        denied = r2_sync.urllib.error.HTTPError("u", 403, "no", {}, None)
        with mock.patch("urllib.request.urlopen", side_effect=denied) as op:
            with self.assertRaises(r2_sync.urllib.error.HTTPError):
                r2_sync.R2("a", "t", "b")._req("GET", "https://x")
        self.assertEqual(op.call_count, 1)

    def test_managed_keys(self):
        self.assertEqual([r2_sync.managed(k) for k in ("og/a/b.png", "semantic/v/x", "people/a.md", "a.md", "x/y/z.md", "notes/x.txt", "fulltext.json")],
                         [True, True, True, False, False, False, True])


if __name__ == "__main__":
    unittest.main()
