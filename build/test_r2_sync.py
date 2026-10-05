"""Unit tests for deploy/r2_sync.py, run with the other build tests."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

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
            objs = {"og/people/a.png": {}, "people/a.md": {}}
            for v, t in (("old", "1"), ("prev", "2"), ("cur", "3")):
                objs[f"semantic/{v}/index.json"] = {"last_modified": t}
            objs["people/gone.md"] = {}
            r2 = FakeR2(objs)
            r2_sync.prune(r2, dist, "cur", force=True)
            self.assertEqual(sorted(r2.deletes), ["people/gone.md", "semantic/old/index.json"])

    def test_prune_refuses_to_empty_the_bucket(self):
        with tempfile.TemporaryDirectory() as d:
            dist, _ = site(Path(d))
            r2 = FakeR2({f"people/x{i}.md": {} for i in range(10)})
            with self.assertRaises(SystemExit):
                r2_sync.prune(r2, dist, "")
            self.assertEqual(r2.deletes, [])


if __name__ == "__main__":
    unittest.main()
