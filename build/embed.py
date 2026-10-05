"""Section-level embeddings for semantic search and the "similar entries" lists.

Reads the parser's entities.json, splits each entry into heading sections, and
embeds them through the Workers AI REST API:

    CLOUDFLARE_ACCOUNT_ID=... WORKERS_AI_API_TOKEN=... python build/embed.py --data data

Writes to <data>/semantic/:
    index.json    model, dims, and one row per chunk (entry id, section anchor, heading)
    vectors.bin   int8 vectors, row-major, chunks x dims
    scales.bin    float32 per-row dequantization scale
    similar.json  entry id -> nearest entries by meaning

Vectors are cached by chunk text hash, so a rebuild only embeds sections that
changed. Without credentials, or when the API fails, the previous output is
kept and the build goes on.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

# Chosen on build/search_eval.json: bge-m3 put the expected entry first for 72% of
# queries against 47% for qwen3-embedding-0.6b, and bge-reranker-base lowered both.
# Truncated to 512 dims (renormalized): within one query of full width, half the size.
MODEL = "@cf/baai/bge-m3"
DIMS = 512
# Prepended to search queries only; bge-m3 needs none.
QUERY_PREFIX = ""
# Search ranks an entry by its best section plus this times its opening section's
# score, so the entry about a subject outranks entries that mention it in passing.
LEAD_WEIGHT = 0.5
BATCH = 32
MAX_WORDS = 350
MIN_WORDS = 40
SIMILAR_K = 12
SKIP_TYPES = {"meta", "misc"}

_WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")
_MDLINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_FNREF = re.compile(r"\[\^[^\]]+\]")
_HEADING = re.compile(r"^(#{2,4})\s+(.+?)\s*#*\s*$")


def plain(md: str) -> str:
    """Link markup down to its visible text; footnote markers dropped."""
    md = _WIKILINK.sub(lambda m: m.group(2) or m.group(1), md)
    md = _MDLINK.sub(r"\1", md)
    return _FNREF.sub("", md)


def _split_long(text: str) -> list[str]:
    """Paragraph-packed pieces of at most MAX_WORDS (a single huge paragraph stays whole)."""
    out, cur, n = [], [], 0
    for para in re.split(r"\n\s*\n", text):
        w = len(para.split())
        if cur and n + w > MAX_WORDS:
            out.append("\n\n".join(cur))
            cur, n = [], 0
        cur.append(para)
        n += w
    if cur:
        out.append("\n\n".join(cur))
    return out


def chunk_entity(e: dict[str, Any]) -> list[dict[str, Any]]:
    """Heading sections of one entry, each prefixed with the entry title and heading.

    Anchors come from the parser's toc so they match the rendered heading ids.
    Sections under MIN_WORDS fold into the one before them.
    """
    anchors = {t["text"]: t["id"] for t in e.get("toc") or []}
    sections: list[tuple[str, str, list[str]]] = [("", "", [])]
    for line in (e.get("body_md") or "").splitlines():
        m = _HEADING.match(line)
        if m:
            heading = plain(m.group(2)).strip()
            sections.append((heading, anchors.get(m.group(2).strip(), anchors.get(heading, "")), []))
        else:
            sections[-1][2].append(line)

    merged: list[list[Any]] = []
    for heading, anchor, lines in sections:
        text = plain("\n".join(lines)).strip()
        if merged and len(text.split()) < MIN_WORDS:
            merged[-1][2] = f"{merged[-1][2]}\n\n{heading}\n{text}".strip()
            continue
        merged.append([heading, anchor, text])

    title = e["title"]
    aliases = e.get("frontmatter", {}).get("aliases") or e.get("frontmatter", {}).get("alias") or []
    if not isinstance(aliases, list):
        aliases = [aliases]
    lead = title + (f" (also {', '.join(map(str, aliases))})" if aliases else "")
    chunks = []
    for i, (heading, anchor, text) in enumerate(merged):
        if i == 0 and e.get("summary") and e["summary"] not in text:
            text = f"{e['summary']}\n\n{text}".strip()
        if not text:
            continue
        for part in _split_long(text):
            head = f"{lead}\n" if i == 0 else f"{title}: {heading}\n"
            chunks.append({"id": e["id"], "anchor": anchor, "heading": heading, "text": head + part})
    if not chunks and e.get("summary"):
        chunks.append({"id": e["id"], "anchor": "", "heading": "", "text": f"{lead}\n{e['summary']}"})
    return chunks


def normalize(m: np.ndarray, dims: int) -> np.ndarray:
    m = np.asarray(m, dtype=np.float32)[:, :dims]
    return m / np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-12)


class Embedder:
    def __init__(self, account: str, token: str, model: str):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
        self.token = token

    def _post(self, texts: list[str]) -> list[list[float]]:
        body = json.dumps({"text": texts}).encode()
        for attempt in range(5):
            req = urllib.request.Request(self.url, body, {
                "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)["result"]["data"]
            except (urllib.error.URLError, TimeoutError, KeyError) as err:
                if attempt == 4 or (isinstance(err, urllib.error.HTTPError) and err.code in (400, 401, 403)):
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    def embed(self, texts: list[str], workers: int = 6) -> np.ndarray:
        batches = [texts[i:i + BATCH] for i in range(0, len(texts), BATCH)]
        with ThreadPoolExecutor(workers) as pool:
            rows = [v for out in pool.map(self._post, batches) for v in out]
        return np.asarray(rows, dtype=np.float32)


def text_key(model: str, text: str) -> str:
    return hashlib.sha1(f"{model}\0{text}".encode()).hexdigest()


def load_cache(path: Path) -> dict[str, np.ndarray]:
    if not path.exists():
        return {}
    z = np.load(path)
    return dict(zip(z["keys"].tolist(), z["vecs"]))


def save_cache(path: Path, cache: dict[str, np.ndarray]) -> None:
    keys = list(cache)
    tmp = path.with_suffix(".tmp.npz")
    np.savez(tmp, keys=np.array(keys), vecs=np.stack([cache[k] for k in keys]).astype(np.float16))
    tmp.replace(path)


def quantize(m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scale = np.maximum(np.abs(m).max(axis=1), 1e-12) / 127
    return np.round(m / scale[:, None]).astype(np.int8), scale.astype(np.float32)


def similar(ids: list[str], chunk_ids: list[str], vecs: np.ndarray, k: int = SIMILAR_K) -> dict[str, list[dict[str, Any]]]:
    """Nearest entries by the normalized mean of each entry's chunk vectors."""
    k = min(k, len(ids) - 1)
    if k < 1:
        return {}
    index = {eid: i for i, eid in enumerate(ids)}
    sums = np.zeros((len(ids), vecs.shape[1]), dtype=np.float32)
    for row, eid in enumerate(chunk_ids):
        sums[index[eid]] += vecs[row]
    keep = np.linalg.norm(sums, axis=1) > 0
    ent = normalize(sums, vecs.shape[1])
    out: dict[str, list[dict[str, Any]]] = {}
    # ponytail: dense blocks of 1024 rows; fine to ~100k entries, use an ANN index past that.
    for start in range(0, len(ids), 1024):
        sims = ent[start:start + 1024] @ ent.T
        sims[:, ~keep] = -1
        for r, row in enumerate(sims):
            i = start + r
            if not keep[i]:
                continue
            row[i] = -1
            top = np.argpartition(-row, k)[:k]
            top = top[np.argsort(-row[top])]
            out[ids[i]] = [{"id": ids[j], "score": round(float(row[j]), 3)} for j in top if row[j] > 0]
    return out


def build(data: Path, embedder: Embedder | None, model: str = MODEL, dims: int = DIMS,
          out: Path | None = None) -> bool:
    entities = [e for e in json.loads((data / "entities.json").read_text()) if e["type"] not in SKIP_TYPES]
    chunks = [c for e in entities for c in chunk_entity(e)]
    out = out or data / "semantic"
    out.mkdir(exist_ok=True)
    # Full-width vectors, so changing DIMS needs no re-embedding.
    cache_path = out / f"cache-{re.sub(r'[^a-z0-9.-]+', '-', model.lower()).strip('-')}.npz"
    cache = load_cache(cache_path)
    keys = [text_key(model, c["text"]) for c in chunks]
    missing = sorted({k: c["text"] for k, c in zip(keys, chunks) if k not in cache}.items())
    if missing:
        if embedder is None:
            print(f"[embed] {len(missing)} sections need embedding but no credentials are set; keeping the previous index", file=sys.stderr)
            return False
        print(f"[embed] embedding {len(missing)} of {len(chunks)} sections")
        # Saved per slice so an API failure partway keeps what was already paid for.
        for i in range(0, len(missing), 1024):
            part = missing[i:i + 1024]
            cache.update(zip([k for k, _ in part], embedder.embed([t for _, t in part])))
            save_cache(cache_path, cache)
    live = set(keys)
    cache = {k: v for k, v in cache.items() if k in live}
    save_cache(cache_path, cache)

    vecs = normalize(np.stack([cache[k] for k in keys]).astype(np.float32), dims)
    q, scales = quantize(vecs)
    (out / "vectors.bin").write_bytes(q.tobytes())
    (out / "scales.bin").write_bytes(scales.tobytes())
    (out / "index.json").write_text(json.dumps({
        "model": model, "dims": dims, "query_prefix": QUERY_PREFIX, "lead_weight": LEAD_WEIGHT,
        "chunks": [[c["id"], c["anchor"], c["heading"]] for c in chunks],
    }, separators=(",", ":")))
    sim = similar([e["id"] for e in entities], [c["id"] for c in chunks], vecs)
    (out / "similar.json").write_text(json.dumps(sim, separators=(",", ":")))
    print(f"[embed] {len(chunks)} sections, {len(entities)} entries -> {out}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Embed entry sections for semantic search.")
    ap.add_argument("--data", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--dims", type=int, default=DIMS)
    ap.add_argument("--out", type=Path, help="Output directory (default: <data>/semantic)")
    args = ap.parse_args()
    account, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("WORKERS_AI_API_TOKEN")
    embedder = Embedder(account, token, args.model) if account and token else None
    try:
        build(args.data, embedder, args.model, args.dims, args.out)
    except Exception as err:  # noqa: BLE001 -- a failed embed must not fail the site build
        print(f"[embed] failed, keeping the previous index: {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
