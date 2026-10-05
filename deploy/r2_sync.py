"""Mirror the files the Worker serves from R2: OG images, markdown twins, and the semantic index.

    CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \\
      python deploy/r2_sync.py upload --bucket NAME --dist web/dist --semantic data/semantic
    python deploy/r2_sync.py prune --bucket NAME --dist web/dist --keep VERSION

`upload` sends only files whose MD5 differs from the object's ETag and prints the semantic
index version (a content hash, used as the R2 prefix semantic/<version>/). `prune` runs after
the Worker deploy: it deletes objects the site no longer has, keeping the current and the
previous semantic version, and refuses to delete more than a quarter of the bucket.
Stdlib only; the token needs R2 read and write on the bucket.

This goes through the Cloudflare REST API, which allows 1,200 requests per 5 minutes per
user (shared with wrangler), so requests are paced at REQUESTS_PER_SECOND. A rebuild touches
a few dozen files; the first upload of a whole site takes a while.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TYPES = {".png": "image/png", ".md": "text/markdown; charset=utf-8", ".json": "application/json",
         ".bin": "application/octet-stream"}
SEMANTIC_FILES = ("index.json", "vectors.bin", "scales.bin", "similar.json")
MAX_PRUNE_SHARE = 0.25
REQUESTS_PER_SECOND = 3


class R2:
    def __init__(self, account: str, token: str, bucket: str):
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects"
        self.token = token
        self._lock = threading.Lock()
        self._next = 0.0

    def _pace(self) -> None:
        with self._lock:
            now = time.monotonic()
            wait, self._next = self._next - now, max(now, self._next) + 1 / REQUESTS_PER_SECOND
        if wait > 0:
            time.sleep(wait)

    def _req(self, method: str, url: str, body: bytes | None = None, ctype: str | None = None) -> dict:
        headers = {"Authorization": f"Bearer {self.token}"}
        if ctype:
            headers["Content-Type"] = ctype
        for attempt in range(6):
            self._pace()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, body, headers, method=method), timeout=120) as r:
                    return json.load(r)
            except urllib.error.HTTPError as err:
                if attempt == 5 or (err.code < 500 and err.code != 429):
                    raise
                time.sleep(int(err.headers.get("Retry-After") or 60) if err.code == 429 else 2 ** attempt)
            except Exception:  # noqa: BLE001 -- dropped connections are retried
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    def list(self) -> dict[str, dict]:
        out, cursor = {}, ""
        while True:
            q = urllib.parse.urlencode({"per_page": 1000, **({"cursor": cursor} if cursor else {})})
            page = self._req("GET", f"{self.base}?{q}")
            for o in page["result"]:
                out[o["key"]] = o
            cursor = (page.get("result_info") or {}).get("cursor") or ""
            if not cursor or not (page.get("result_info") or {}).get("is_truncated", True):
                return out

    def put(self, key: str, path: Path) -> None:
        self._req("PUT", f"{self.base}/{urllib.parse.quote(key)}", path.read_bytes(),
                  TYPES.get(path.suffix, "application/octet-stream"))

    def delete(self, key: str) -> None:
        self._req("DELETE", f"{self.base}/{urllib.parse.quote(key)}")


def site_files(dist: Path) -> dict[str, Path]:
    """OG images and the <type>/<slug>.md twins, keyed by their URL path."""
    files = {p.relative_to(dist).as_posix(): p for p in (dist / "og").rglob("*.png")}
    files.update({p.relative_to(dist).as_posix(): p for p in dist.glob("*/*.md")})
    return files


def semantic_version(semantic: Path) -> str | None:
    if not all((semantic / f).is_file() for f in SEMANTIC_FILES):
        return None
    h = hashlib.sha1()
    for f in SEMANTIC_FILES:
        h.update((semantic / f).read_bytes())
    return h.hexdigest()[:12]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def upload(r2: R2, dist: Path, semantic: Path) -> str:
    files = site_files(dist)
    version = semantic_version(semantic)
    if version:
        files.update({f"semantic/{version}/{f}": semantic / f for f in SEMANTIC_FILES})
    remote = r2.list()
    todo = [(k, p) for k, p in files.items() if remote.get(k, {}).get("etag") != md5(p)]
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda kp: r2.put(*kp), todo))
    print(f"[r2] {len(todo)} of {len(files)} files uploaded", file=sys.stderr)
    return version or ""


def prune(r2: R2, dist: Path, keep: str, force: bool = False) -> None:
    files = site_files(dist)
    remote = r2.list()
    versions = {}
    for k, o in remote.items():
        if k.startswith("semantic/"):
            v = k.split("/")[1]
            versions[v] = max(versions.get(v, ""), o.get("last_modified", ""))
    previous = sorted((v for v in versions if v != keep), key=lambda v: versions[v])[-1:]
    kept = {keep, *previous}
    stale = [k for k in remote if (k.split("/")[1] not in kept if k.startswith("semantic/") else k not in files)]
    if stale and len(stale) > MAX_PRUNE_SHARE * len(remote) and not force:
        raise SystemExit(f"[r2] refusing to delete {len(stale)} of {len(remote)} objects; rerun prune with --force if intended")
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(r2.delete, stale))
    print(f"[r2] pruned {len(stale)} objects", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description="Mirror OG images, markdown twins and the semantic index to R2.")
    ap.add_argument("action", choices=["upload", "prune"])
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--dist", type=Path, required=True)
    ap.add_argument("--semantic", type=Path, default=Path("data/semantic"))
    ap.add_argument("--keep", default="", help="prune: the semantic version the deployed Worker reads")
    ap.add_argument("--force", action="store_true", help="prune: allow deleting more than a quarter of the bucket")
    args = ap.parse_args()
    r2 = R2(os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_API_TOKEN"], args.bucket)
    if args.action == "upload":
        print(upload(r2, args.dist, args.semantic))
    else:
        prune(r2, args.dist, args.keep, args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
