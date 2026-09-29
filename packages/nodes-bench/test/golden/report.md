# Endpoint latency

**3 targets: 1 regression.**

- Environment: https://dev.example.com
- A regression is a median more than 20% and at least 5 ms over its baseline, confirmed by measuring once more. Baselines are kept per environment and advance by `onPass`, rising at most 10% per run.
- ≈ marks a change too small to mean anything: inside the tolerance, or under the noise floor (a few milliseconds, or a few hundred bytes).
- Connections are kept alive between runs, where `curl` opens a fresh one each time, so these times leave out connection setup.
- Sizes are the decoded body. This client asks for gzip and counts what it unpacks to; `curl` without `--compressed` asks for uncompressed bodies. Old and new are measured the same way, so comparisons stay like-for-like.

| Endpoint | Variant | Median (ms) | Baseline (ms) | Change | p95 / max (ms) | Size | Verdict |
|---|---|---:|---:|---:|---:|---:|---|
| buyers | list | 120.0 | — | — | p95 129.0 | 20.0 KB | baseline created |
| projects | new | 38.1 | 30.0 | +27.0% | max 44.0 | 1.9 KB | **REGRESSION** (re-measured) |
| projects | old | 212.4 | 205.0 | +3.6% | max 260.0 | 47.1 KB | ok |

## Variants compared

| Endpoint | Pair | Median (ms) | Time saved | Size | Size saved | Verdict |
|---|---|---:|---:|---:|---:|---|
| projects | old → new | 212.4 → 38.1 | +82.1% | 47.1 KB → 1.9 KB | +96.1% | faster · smaller |
