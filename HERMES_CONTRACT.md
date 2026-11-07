# Hermes → NewsGPT output contract

This is the **only** thing Hermes needs to know about NewsGPT. Hermes drops JSON files
into `data/inbox/`; NewsGPT does everything else (salvage, merge, dedupe, grouping,
layout).

    data/inbox/<anything>.json

Filename is free-form — every `*.json` in the folder is read. Use something sortable,
e.g. `2026-10-22-part1.json`.

**You may write as many files per day as you need.** If a day's output doesn't fit in
one response, split it across files and set `part` — see
[Chunked output](#chunked-output-when-you-run-out-of-tokens). It is also fine to be
cut off mid-file: the merger salvages every complete story from a truncated chunk.

Don't write to `data/raw/` or `data/editions/` — both are generated.

## Format

A flat array of stories. **Flat is deliberate** — don't group by sector or ticker in
Hermes. The builder decides column layout from the data, and it can only do that if it
sees every story individually.

```json
{
  "run_id": "2026-10-22T0600-premarket",
  "scraped_at": "2026-10-22T06:00:00Z",
  "edition_date": "2026-10-22",

  "sector_ledes": {
    "Semiconductors": "One AI-written sentence wrapping up the sector."
  },

  "stories": [
    {
      "event_key": "nvda-datacenter-guidance-2026-10-22",
      "headline": "Short, declarative, no trailing period",
      "dek": "One-sentence subhead expanding the headline.",
      "body_md": "Two or three short paragraphs.\n\nMarkdown: **bold**, *italic* only.",
      "tickers": ["NVDA", "AMD"],
      "sector": "Semiconductors",
      "importance": 4,
      "sentiment": -0.4,
      "sources": [
        {
          "title": "Original article title",
          "url": "https://example.com/article",
          "publisher": "Reuters",
          "published_at": "2026-10-22T04:12:00Z"
        }
      ]
    }
  ]
}
```

## Field rules

| Field | Req | Notes |
|---|---|---|
| `run_id` | yes | Unique per run. |
| `scraped_at` | yes | ISO 8601 UTC. |
| `edition_date` | no | `YYYY-MM-DD`. Defaults to the date of `scraped_at`. Every chunk sharing a date merges into one edition. |
| `part` | no* | 1-based chunk number. **Required if you write more than one file for a day** — it's the only way the merger can tell a chunk is missing. |
| `parts` | no | Total chunks for the day, if you know it up front. Enables a stronger completeness check. |
| `sector_ledes` | no | Sector name → one sentence. Omitted sectors fall back to the top story's dek. |
| `stories[].event_key` | no | **Highest-value optional field** — see below. |
| `stories[].headline` | **yes** | Non-empty. Fallback dedupe signal. |
| `stories[].dek` | no | Falls back to the first sentence of `body_md`. |
| `stories[].body_md` | no | Markdown-lite. Briefs (importance ≤ 2) may omit it. |
| `stories[].tickers` | no | Uppercase symbols. **Order matters — `tickers[0]` is the lead ticker** and decides which column the story can be promoted into. `[]` is fine for macro stories. |
| `stories[].sector` | no | Free-form, but **be consistent across runs** — the string is the grouping key. Defaults to `"Markets"`. |
| `stories[].importance` | no | Integer 1–5, default 3. See below. |
| `stories[].sentiment` | no | Float −1.0 … +1.0. Omit if unscored; omitted stories don't drag a sector's average. |
| `stories[].sources` | **yes** | At least one, each with a valid `http(s)` `url`. |

## Chunked output (when you run out of tokens)

A full day of news rarely fits in one response. Split it across files, keep the same
`run_id`, and number them:

```json
{ "run_id": "2026-10-22-premarket", "scraped_at": "...", "edition_date": "2026-10-22",
  "part": 2, "parts": 4,
  "stories": [ ... ] }
```

`node merge.js` consolidates all of a day's chunks into a single
`data/raw/<date>.json` before the builder ever sees them, so chunking is invisible
to the finished paper.

**Four rules for chunked output:**

1. **Emit whole story objects.** Never split one story across two files. The
   salvager recovers *complete* objects from a truncated chunk; a story split by
   hand across a file boundary is simply lost, because neither half parses.
2. **Always set `part`.** Without it a missing chunk is undetectable — the paper
   still builds, just quietly thinner. With it you get
   `MISSING chunk 3 of 4 — this edition is incomplete`.
3. **Repeat the envelope in every chunk** (`run_id`, `scraped_at`, `edition_date`).
   Each file is parsed independently.
4. **Put `sector_ledes` in the first chunk.** If a chunk is truncated, any key you
   had not yet written is unrecoverable — and ledes written after the stories array
   are exactly what gets lost.

**Getting cut off is safe.** If you hit the token ceiling mid-array, just stop. The
merger brace-scans the file, keeps every balanced story object, discards the
incomplete tail, and reports it:

```
! 2026-10-22-part2.json: truncated (output cut off mid-array (token limit?))
  — salvaged 6 complete stories, discarded 1 incomplete.
```

The story you were mid-way through **is lost**, so re-emit it in the next chunk.
Overlap is free: duplicates collapse on `event_key`, so when in doubt, repeat the
last story or two rather than risk dropping one.

## `event_key` controls deduplication

Give every story a slug naming **the underlying event**, not the article. Two
write-ups of the same earnings call get the *same* `event_key`; the builder merges
them into one story and unions their sources.

```
"event_key": "nvda-datacenter-guidance-2026-10-22"
```

Why this matters: NewsGPT's fallback is lexical headline similarity, and that
quietly fails on paraphrase. "Nvidia lifts data-center outlook" and "Nvidia guidance
raised as order book extends" are the same event but share almost no words — without
`event_key` they both reach the page and the column reads as sloppy.

The resolution order is:

1. **Both stories have an `event_key`** → merge only if the keys match. A
   deliberate mismatch is a veto: it stops the lexical fallback from merging two
   stories you want kept apart.
2. Neither/one has a key, but they **share a source URL** → merged.
3. Otherwise, **headline token overlap ≥ 0.45** → merged.

So keys are worth the tokens. Reuse the same key across chunks and runs on the same
day and re-emitted stories collapse cleanly instead of stacking up. This is what
makes overlapping chunks safe.

When two copies of the same story are merged, the **more complete body wins** — a
body that doesn't end on terminal punctuation is treated as cut off and loses to one
that does, regardless of length. So re-emitting a story in full in the next chunk
repairs a version that got clipped.

## `importance` drives the whole layout

This is the highest-leverage field Hermes sets. Spend real judgement on it.

| | Meaning | How it renders |
|---|---|---|
| **5** | Market-moving. Rare — most runs have none. | Candidate for the page-wide front-page lead |
| **4** | Lead story for its sector | Full headline, dek, body |
| **3** | Normal story | Full headline, dek, body |
| **2** | Minor / incremental | Compact one-line brief |
| **1** | Noise, logged for completeness | Compact one-line brief |

Don't inflate. If every story is a 4, the page flattens into a uniform grid and stops
reading like a newspaper.

## Rules that matter

1. **Never invent a source.** Every story must trace to a real scraped URL. The UI
   footnotes every story, so fabrications are visible on the page.
2. **One event = one story.** If an event hits several tickers, emit it *once* with
   multiple `tickers`, most-affected first. Don't emit per-ticker copies — the builder
   will merge them and you'll lose control of the ticker ordering.
   Where two outlets genuinely need separate entries, tie them with `event_key`.
3. **Don't pre-group or pre-rank.** No sector buckets, no sorting. Flat array.
4. **Write for print.** Declarative headlines, no "Here's what you need to know",
   no second person, no hedging preamble.
5. **Re-running is safe.** The inbox is append-only and never modified; editions are
   rebuilt from scratch every time. Duplicate stories across chunks and runs get
   deduped.

## Validating

```
node merge.js      # inbox chunks -> one drop per day (salvages truncation)
node build.js      # drops -> editions
```

`merge.js` is forgiving: it **warns** about truncation, missing chunks and duplicate
part numbers, but still produces the best drop it can.

`build.js` is strict: a malformed drop **aborts** the whole build rather than
rendering a half-empty page, printing the offending file, story index and field.
A story with no sources, an empty headline, or a non-`http(s)` URL is a hard failure.
