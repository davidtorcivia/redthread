"""Recall of semantic search on the hand-labelled queries in search_eval.json.

    CLOUDFLARE_ACCOUNT_ID=... WORKERS_AI_API_TOKEN=... python build/eval_search.py --index data/semantic

Prints recall@1/5/10 for name matching alone, dense alone, and both fused, at
several truncation widths. Needs the index embed.py wrote (and its vector cache).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import embed  # noqa: E402

RRF_K = 60


def name_rank(names: list[tuple[str, list[str]]], q: str) -> list[str]:
    """Port of the site search's quickRank: exact, prefix, word prefix, substring."""
    q = q.strip().lower()

    def rank(keys: list[str]) -> int:
        return min((0 if k == q else 1 if k.startswith(q) else 2 if f" {q}" in k else 3 if q in k else 9) for k in keys)

    scored = [(rank(keys), len(keys[0]), eid) for eid, keys in names]
    return [eid for r, _, eid in sorted(scored) if r < 9]


def dense_rank(qv: np.ndarray, vecs: np.ndarray, chunk_ids: list[str]) -> list[str]:
    """Entries by best section score plus LEAD_WEIGHT times their opening section's score."""
    ids = list(dict.fromkeys(chunk_ids))
    pos = {eid: i for i, eid in enumerate(ids)}
    rows = np.array([pos[c] for c in chunk_ids])
    lead = np.r_[True, rows[1:] != rows[:-1]]
    s = vecs @ qv
    best = np.full(len(ids), -np.inf)
    np.maximum.at(best, rows, s)
    best[rows[lead]] += embed.LEAD_WEIGHT * s[lead]
    return [ids[i] for i in np.argsort(-best)[:50]]


def rrf(*lists: list[str]) -> list[str]:
    score: dict[str, float] = {}
    for lst in lists:
        for i, eid in enumerate(lst[:50]):
            score[eid] = score.get(eid, 0) + 1 / (RRF_K + i + 1)
    return sorted(score, key=lambda e: -score[e])


def recall(ranked: list[list[str]], expect: list[list[str]], k: int) -> float:
    return sum(bool(set(r[:k]) & set(e)) for r, e in zip(ranked, expect)) / len(expect)


def main() -> int:
    ap = argparse.ArgumentParser(description="Recall of semantic search on labelled queries.")
    ap.add_argument("--index", type=Path, required=True)
    ap.add_argument("--data", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    ap.add_argument("--model", default=embed.MODEL)
    ap.add_argument("--prefix", default=embed.QUERY_PREFIX)
    ap.add_argument("--show-misses", action="store_true")
    args = ap.parse_args()

    cases = json.loads((Path(__file__).with_name("search_eval.json")).read_text())
    entities = [e for e in json.loads((args.data / "entities.json").read_text()) if e["type"] not in embed.SKIP_TYPES]
    chunks = [c for e in entities for c in embed.chunk_entity(e)]
    cache = embed.load_cache(next(args.index.glob("cache-*.npz")))
    full = np.stack([cache[embed.text_key(args.model, c["text"])] for c in chunks]).astype(np.float32)
    chunk_ids = [c["id"] for c in chunks]
    names = [(e["id"], [e["title"].lower(), *(str(a).lower() for a in embed_aliases(e))]) for e in entities]

    emb = embed.Embedder(os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["WORKERS_AI_API_TOKEN"], args.model)
    qfull = emb.embed([args.prefix + c["q"] for c in cases])
    expect = [c["expect"] for c in cases]
    by_name = [name_rank(names, c["q"]) for c in cases]

    print(f"{'':>14} {'@1':>5} {'@5':>5} {'@10':>5}")
    print(f"{'names':>14} " + " ".join(f"{recall(by_name, expect, k):5.2f}" for k in (1, 5, 10)))
    for dims in sorted({128, 256, 512, full.shape[1]}):
        vecs, qv = embed.normalize(full, dims), embed.normalize(qfull, dims)
        dense = [dense_rank(q, vecs, chunk_ids) for q in qv]
        fused = [rrf(n, d) for n, d in zip(by_name, dense)]
        for label, ranked in ((f"dense {dims}", dense), (f"fused {dims}", fused)):
            print(f"{label:>14} " + " ".join(f"{recall(ranked, expect, k):5.2f}" for k in (1, 5, 10)))
        if args.show_misses and dims == embed.DIMS:
            for c, r in zip(cases, fused):
                if not set(r[:5]) & set(c["expect"]):
                    print(f"  miss: {c['q']!r} -> {r[:5]}")
    return 0


def embed_aliases(e: dict) -> list:
    fm = e.get("frontmatter", {})
    a = fm.get("aliases") or fm.get("alias") or []
    return a if isinstance(a, list) else [a]


if __name__ == "__main__":
    sys.exit(main())
