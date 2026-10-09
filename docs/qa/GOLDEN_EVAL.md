# Golden-set eval — AI refined-transcript quality (D4a)

The heart of the product is the AI analysis. Its quality is measured, not
assumed: after ANY change to prompts or models in
`apps/web/workflows/generate-ai.ts`, run the eval and compare against the
baselines below BEFORE shipping.

## How to run

```bash
cd apps/web
DATABASE_URL=<mysql public-proxy url> \
CAP_AWS_ENDPOINT=<r2 endpoint> CAP_AWS_ACCESS_KEY=... CAP_AWS_SECRET_KEY=... \
node scripts/eval-refined.mjs
```

(Values live in Railway: `railway variables --service @cap/web` / MySQL
service proxy host+port.) To eval after a pipeline change, first re-run
analysis on a golden video ("AI qayta tahlil" or POST /generate with
reprocess), then run the script.

## Metrics and thresholds

- **ratio** (refined chars / raw chars): target band **0.35–0.65**.
  Below ~0.30 = the model is summarizing, not rewriting (data loss risk).
  Note the raw baseline includes `<v Speaker>` tags (~15% overhead), so an
  on-screen 0.41 is an effective ~0.48.
- **missing numeric tokens**: investigate EVERY missing token by hand —
  reordered ("95-90"→"90-95") and reformatted ("1000/100"→"10 barobar")
  hits are false positives; a genuinely absent business number is a FAIL.
- **speaker labels left**: must be 0.
- **chapters**: at least duration/6min (prompt enforces 3–6 min density).

## Golden set + baselines (recorded 2026-07-07, post sub-slicing fix)

| video | dur | ratio | chapters | tasks | missing numeric |
|---|---|---|---|---|---|
| `4htfajtyrv30cv3` (biznes suhbat) | 28 min | 0.41 | 5 | 6 | 2/19 — both from one background stat (200/800 tadbirkor, prior-employer context); all business-critical figures preserved |
| `patefma8qhn5rqe` (platforma demo) | 10 min | (stale: old 2.5-flash pipeline, ratio 1.00 verbatim) — re-baseline after next re-analysis | 4 | 5 | n/a |

History: before the sub-slicing fix (29e8d90) the 28-min video scored
ratio 0.19 with 7/19 tokens flagged — the fix doubled retention.

Owner to add 1-2 number-heavy videos of his own to GOLDEN_SET in
`apps/web/scripts/eval-refined.mjs` when available.
