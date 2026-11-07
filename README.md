# NewspaperAI 📰

An AI-powered financial news digest system that aggregates, analyzes, and presents market intelligence in a newspaper format.

## Overview

NewspaperAI transforms raw financial data feeds into structured, browsable news editions. Built on the NewsGPT architecture, it processes market data, news sources, and trading signals into coherent daily editions with visual web presentation.

## Features

- **Structured JSON Schema**: Standardized story format with tickers, sentiment, importance scoring
- **Visual Web Interface**: Browse editions like a traditional newspaper with sections and stories
- **Story Deduplication**: Intelligent merging of similar stories across sources using token-based similarity
- **Offline Editions**: Self-contained HTML/CSS/JS packages for archival and offline viewing
- **Modular Architecture**: Separate build pipeline for flexible data source integration

## Architecture

```
data/
  editions/          # Published edition JSON files
editions/
  YYYY-MM-DD/       # Self-contained HTML newspapers (offline browsable)
    index.html
    app.js
    style.css
web/                # Live web app (reads all editions)
  index.html
  app.js
  style.css
  editions.js       # Auto-generated index
lib/                # Story processing utilities
  story.js          # Deduplication & tokenization
  salvage.js        # Partial data recovery
schema/             # JSON schema definitions
```

## Data Flow

1. **Source Jobs** (upstream) → `data/inbox/*.json` (raw stories)
2. **Build Pipeline** → `node build.js` → merges, deduplicates, generates `data/editions/YYYY-MM-DD.json`
3. **Web Generator** → creates self-contained edition in `editions/YYYY-MM-DD/`
4. **Index Update** → regenerates `web/editions.js` for live site

## Story Schema

Each story includes:
- `headline`, `dek` (subheadline), `body_md` (markdown body)
- `tickers[]` (stock symbols)
- `sector`, `importance` (1-5), `sentiment` (-1 to +1)
- `sources[]` (title, url, publisher, published_at)
- `merged_count` (how many source stories were merged)

## Usage

### Build an Edition

```bash
node build.js YYYY-MM-DD
```

Reads `data/inbox/*.json`, outputs `data/editions/YYYY-MM-DD.json` and `editions/YYYY-MM-DD/`

### Preview an Edition

```bash
./scripts/preview.sh YYYY-MM-DD
```

Opens the offline edition in your browser.

### Browse All Editions

Open `web/index.html` in a browser to see the live aggregated view.

## Configuration

- **Deduplication threshold**: `lib/story.js` → `DEDUPE_SIMILARITY` (default 0.45 Jaccard similarity)
- **Schema validation**: `schema/edition.schema.json`

## Key Contracts

- **Chunked Output Safe**: If source jobs exceed token limits mid-array, build.js can merge partial files
- **Event Key Merging**: Stories with same `event_key` are merged (authoritative signal)
- **Headline Token Overlap**: Stories with ≥45% token overlap are merged automatically

See [HERMES_CONTRACT.md](HERMES_CONTRACT.md) for detailed upstream integration requirements.

## Visual Design

See [UI_GUIDE.md](UI_GUIDE.md) and [VISUAL_DEMO.md](VISUAL_DEMO.md) for design system and UI patterns.

## Offline Editions

See [OFFLINE_EDITIONS.md](OFFLINE_EDITIONS.md) for the self-contained edition export system.

## Requirements

- Node.js 16+
- Dependencies: see `package.json`

## License

MIT

## Notes

- This is the public, browsable version of the NewsGPT pipeline
- Source data (inbox/, raw/) is excluded from this repo
- Published editions in `data/editions/` contain only public market data
