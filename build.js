#!/usr/bin/env node
'use strict';
/*
 * Stage 2 of 2: NewsGPT edition builder.
 *
 *   data/raw/*.json  (drops)  ->  data/editions/<date>.json  +  web/editions.js
 *
 * Drops normally come from merge.js, which consolidates the day's Hermes chunks.
 * A hand-written single-file drop works too.
 *
 * Editions are rebuilt from scratch on every run, so re-running is always safe.
 * Validation failures abort the build rather than emitting a half-empty page.
 */

const fs = require('fs');
const path = require('path');

const { dedupe, tokenize } = require('./lib/story');

const ROOT = __dirname;
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const EDITIONS_DIR = path.join(ROOT, 'data', 'editions');
const WEB_BUNDLE = path.join(ROOT, 'web', 'editions.js');
const OFFLINE_DIR = path.join(ROOT, 'editions');  // Self-contained dated folders

// --- Tunables -------------------------------------------------------------

// A ticker earns its own column once this many stories name it as lead ticker.
const PROMOTE_TICKER_AT = 3;
// Importance at or below this renders as a compact brief.
const BRIEF_MAX_IMPORTANCE = 2;
// A story must be at least this important to take the page-wide lead slot.
const LEAD_MIN_IMPORTANCE = 4;

const DEFAULT_SECTOR = 'Markets';

// Story identity, deduping and field-merging live in lib/story.js, shared with
// merge.js so the two stages agree on what "the same story" means.

// --- Failure collection ---------------------------------------------------

const errors = [];
function fail(where, msg) {
  errors.push(`${where}: ${msg}`);
}

// --- Helpers --------------------------------------------------------------

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Short stable hash, so a story keeps its id across rebuilds.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function firstSentence(md) {
  if (!md) return null;
  const plain = String(md).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  const m = plain.match(/^(.{20,240}?[.!?])(\s|$)/);
  return m ? m[1] : plain.slice(0, 200) || null;
}

function dateOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// --- Read + validate drops ------------------------------------------------

function readDrops() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`No raw drop folder at ${RAW_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.error(`No *.json drops in ${RAW_DIR}. Point Hermes at it (see HERMES_CONTRACT.md).`);
    process.exit(1);
  }
  return files.map((file) => {
    const full = path.join(RAW_DIR, file);
    try {
      return { file, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
    } catch (e) {
      fail(file, `not valid JSON — ${e.message}`);
      return { file, data: null };
    }
  }).filter((d) => d.data);
}

function normalizeSource(src, where) {
  if (!src || typeof src !== 'object') {
    fail(where, 'source is not an object');
    return null;
  }
  const url = typeof src.url === 'string' ? src.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) {
    fail(where, `source.url must start with http(s):// (got ${JSON.stringify(src.url)})`);
    return null;
  }
  return {
    title: src.title ? String(src.title).trim() : null,
    url,
    publisher: src.publisher ? String(src.publisher).trim() : null,
    published_at: src.published_at ? String(src.published_at) : null,
  };
}

function normalizeStory(raw, where) {
  if (!raw || typeof raw !== 'object') {
    fail(where, 'story is not an object');
    return null;
  }

  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : '';
  if (!headline) {
    fail(where, 'headline is required and must be a non-empty string');
    return null;
  }

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    fail(where, `"${headline.slice(0, 48)}" has no sources (at least one required)`);
    return null;
  }
  const sources = raw.sources.map((s, i) => normalizeSource(s, `${where} sources[${i}]`))
                             .filter(Boolean);
  if (!sources.length) return null;

  let importance = Number.isFinite(raw.importance) ? Math.round(raw.importance) : 3;
  importance = clamp(importance, 1, 5);

  const sentiment = Number.isFinite(raw.sentiment) ? clamp(raw.sentiment, -1, 1) : null;

  const tickers = Array.isArray(raw.tickers)
    ? raw.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : [];

  const body_md = raw.body_md ? String(raw.body_md).trim() : null;
  const dek = raw.dek ? String(raw.dek).trim() : firstSentence(body_md);

  return {
    id: `${slugify(headline)}-${hash(headline)}`,
    event_key: raw.event_key ? String(raw.event_key).trim().toLowerCase() : null,
    headline,
    dek: dek || null,
    body_md,
    tickers,
    sector: raw.sector ? String(raw.sector).trim() : DEFAULT_SECTOR,
    importance,
    sentiment,
    merged_count: 1,
    sources,
    _tokens: tokenize(headline),
  };
}

// --- Grouping: "let the data decide" -------------------------------------

/*
 * Default grouping is by sector. A ticker that dominates its own news flow
 * (>= PROMOTE_TICKER_AT stories naming it as lead ticker) is pulled out into a
 * dedicated column — that's the adaptive part. Stories with no tickers at all
 * group into a 'macro' section.
 */
function buildSections(stories, sectorLedes) {
  const leadCounts = new Map();
  for (const s of stories) {
    const lead = s.tickers[0];
    if (lead) leadCounts.set(lead, (leadCounts.get(lead) || 0) + 1);
  }
  const promoted = new Set(
    [...leadCounts.entries()].filter(([, n]) => n >= PROMOTE_TICKER_AT).map(([t]) => t)
  );

  const byKey = new Map();
  function bucket(key, meta) {
    if (!byKey.has(key)) byKey.set(key, { ...meta, stories: [] });
    return byKey.get(key);
  }

  for (const story of stories) {
    const lead = story.tickers[0];

    if (lead && promoted.has(lead)) {
      bucket(`ticker:${lead}`, { kind: 'ticker', title: lead, tickers: [lead] })
        .stories.push(story);
    } else if (!story.tickers.length) {
      bucket('macro:' + story.sector, { kind: 'macro', title: story.sector, tickers: [] })
        .stories.push(story);
    } else {
      bucket(`sector:${story.sector}`, { kind: 'sector', title: story.sector, tickers: [] })
        .stories.push(story);
    }
  }

  const sections = [...byKey.entries()].map(([key, sec]) => {
    sec.stories.sort((a, b) => b.importance - a.importance ||
                               a.headline.localeCompare(b.headline));

    // Sector columns advertise the tickers they actually cover.
    if (sec.kind !== 'ticker') {
      const seen = [];
      for (const s of sec.stories) {
        for (const t of s.tickers) if (!seen.includes(t)) seen.push(t);
      }
      sec.tickers = seen.slice(0, 8);
    }

    // Importance-weighted sentiment; unscored stories simply don't vote.
    let num = 0, den = 0;
    for (const s of sec.stories) {
      if (s.sentiment !== null) { num += s.sentiment * s.importance; den += s.importance; }
    }

    const top = sec.stories[0];
    return {
      id: slugify(key),
      kind: sec.kind,
      title: sec.title,
      tickers: sec.tickers,
      lede: sectorLedes[sec.title] || (top ? top.dek : null) || null,
      sentiment: den ? Number((num / den).toFixed(3)) : null,
      stories: sec.stories,
    };
  });

  // Strongest column first: peak importance, then depth of coverage.
  sections.sort((a, b) =>
    b.stories[0].importance - a.stories[0].importance ||
    b.stories.length - a.stories.length ||
    a.title.localeCompare(b.title));

  return sections;
}

// --- Assemble -------------------------------------------------------------

function buildEdition(editionDate, drops) {
  const sectorLedes = {};
  const runIds = [];
  let sample = false;
  const raw = [];

  for (const { file, data } of drops) {
    if (data._sample === true) sample = true;
    // merge.js emits run_ids[] (one per contributing chunk); a hand-written
    // drop just has run_id.
    for (const id of data.run_ids || (data.run_id ? [data.run_id] : [])) {
      if (runIds.indexOf(String(id)) === -1) runIds.push(String(id));
    }
    Object.assign(sectorLedes, data.sector_ledes || {});

    data.stories.forEach((s, i) => {
      const story = normalizeStory(s, `${file} stories[${i}]`);
      if (story) raw.push(story);
    });
  }

  const stories = dedupe(raw);
  const sections = buildSections(stories, sectorLedes);

  // Front-page lead: single most important story, if anything clears the bar.
  const candidates = stories
    .filter((s) => s.importance >= LEAD_MIN_IMPORTANCE)
    .sort((a, b) => b.importance - a.importance ||
                    b.merged_count - a.merged_count ||
                    (b.body_md || '').length - (a.body_md || '').length);
  const lead = candidates[0] || null;

  // Strip internal fields before freezing.
  for (const sec of sections) {
    sec.stories = sec.stories.map(({ _tokens, ...keep }) => keep);
  }

  return {
    edition_date: editionDate,
    generated_at: new Date().toISOString(),
    ...(sample ? { sample: true } : {}),
    run_ids: runIds,
    lead_story_id: lead ? lead.id : null,
    story_count: stories.length,
    sections,
  };
}

// --- Offline HTML generation ------------------------------------------------

function generateStandaloneHTML(edition) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NewsGPT — ${edition.edition_date}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>

<a class="skip" href="#edition">Skip to the edition</a>

<header class="masthead">
  <div class="masthead-rule" aria-hidden="true"></div>

  <div class="masthead-top">
    <span class="masthead-side" id="meta-left"></span>
    <h1 class="nameplate">NewsGPT</h1>
    <span class="masthead-side masthead-side--right" id="meta-right"></span>
  </div>

  <div class="masthead-bar">
    <span id="dateline" class="dateline"></span>
    <span class="masthead-dot" aria-hidden="true">&bull;</span>
    <span id="summary" class="masthead-note"></span>
  </div>

  <div class="masthead-rule masthead-rule--double" aria-hidden="true"></div>
</header>

<main id="edition">
  <div id="banner" class="banner" hidden></div>
  <section id="lead" class="lead" hidden></section>
  <div id="columns" class="columns"></div>
</main>

<footer class="colophon">
  <p>
    Every story on this page is generated by an AI agent from scraped sources.
    Follow the numbered footnotes to the originals before acting on anything here.
    <strong>Not investment advice.</strong>
  </p>
  <p id="colophon-meta" class="colophon-meta"></p>
</footer>

<script>
// Embedded edition data — self-contained, works over file://
window.EDITION = ${JSON.stringify(edition)};
</script>
<script src="app.js"></script>
</body>
</html>`;
}

// --- Main -----------------------------------------------------------------

function main() {
  const drops = readDrops();

  // Group drops into editions by date; several runs a day merge into one paper.
  const byDate = new Map();
  for (const drop of drops) {
    const { file, data } = drop;
    if (!Array.isArray(data.stories)) {
      fail(file, 'missing required "stories" array');
      continue;
    }
    if (!data.scraped_at && !data.edition_date) {
      fail(file, 'needs "scraped_at" (or an explicit "edition_date")');
      continue;
    }
    const date = data.edition_date || dateOf(data.scraped_at);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      fail(file, `could not resolve an edition date from scraped_at=${JSON.stringify(data.scraped_at)}`);
      continue;
    }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(drop);
  }

  const editions = [...byDate.entries()]
    .map(([date, ds]) => buildEdition(date, ds))
    .sort((a, b) => b.edition_date.localeCompare(a.edition_date));

  // Loud failure: never render a partial paper.
  if (errors.length) {
    console.error(`\nBuild aborted — ${errors.length} problem(s) in the Hermes drops:\n`);
    for (const e of errors) console.error('  * ' + e);
    console.error('\nSee HERMES_CONTRACT.md for the expected shape.\n');
    process.exit(1);
  }

  // Optional belt-and-braces check of our own output. The drop validation above
  // is what catches Hermes mistakes; this catches builder regressions, and only
  // runs if ajv happens to be installed (`npm i -D ajv`).
  let schemaChecked = false;
  try {
    // ajv's default entry point is draft-07; the schema declares 2020-12.
    const Ajv = require('ajv/dist/2020');
    const schema = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'schema', 'edition.schema.json'), 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    for (const ed of editions) {
      if (!validate(ed)) {
        console.error(`\nBuilder bug: edition ${ed.edition_date} violates its own schema:\n`);
        for (const e of validate.errors) {
          console.error(`  * ${e.instancePath || '/'} ${e.message}`);
        }
        process.exit(1);
      }
    }
    schemaChecked = true;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  }

  fs.mkdirSync(EDITIONS_DIR, { recursive: true });
  for (const ed of editions) {
    fs.writeFileSync(path.join(EDITIONS_DIR, `${ed.edition_date}.json`),
                     JSON.stringify(ed, null, 2));
  }

  // Bundled as JS, not fetched as JSON, so web/index.html works over file://
  // (fetch() is blocked by CORS there) — no server needed to read the paper.
  fs.mkdirSync(path.dirname(WEB_BUNDLE), { recursive: true });
  fs.writeFileSync(WEB_BUNDLE,
    '/* Generated by build.js — do not edit. */\n' +
    'window.NEWSGPT_EDITIONS = ' + JSON.stringify(editions) + ';\n');

  // Generate self-contained offline folders for each edition
  fs.mkdirSync(OFFLINE_DIR, { recursive: true });
  for (const ed of editions) {
    const editionDir = path.join(OFFLINE_DIR, ed.edition_date);
    fs.mkdirSync(editionDir, { recursive: true });

    // Copy CSS and JS files
    fs.copyFileSync(path.join(ROOT, 'web', 'style.css'), path.join(editionDir, 'style.css'));
    fs.copyFileSync(path.join(ROOT, 'web', 'app.js'), path.join(editionDir, 'app.js'));

    // Generate standalone HTML with embedded edition data
    const html = generateStandaloneHTML(ed);
    fs.writeFileSync(path.join(editionDir, 'index.html'), html);
  }

  console.log(`Built ${editions.length} edition(s):`);
  for (const ed of editions) {
    const cols = ed.sections.map((s) => `${s.title}(${s.stories.length})`).join(', ');
    console.log(`  ${ed.edition_date}  ${ed.story_count} stories, ` +
                `${ed.sections.length} columns${ed.sample ? '  [SAMPLE]' : ''}`);
    console.log(`    ${cols}`);
  }
  if (!schemaChecked) {
    console.log('\n  (schema self-check skipped — `npm i -D ajv` to enable)');
  }
  console.log(`\n  -> ${path.relative(ROOT, EDITIONS_DIR)}${path.sep}*.json`);
  console.log(`  -> ${path.relative(ROOT, WEB_BUNDLE)}`);
  console.log(`\n  Offline editions:`);
  for (const ed of editions) {
    console.log(`  -> ${path.relative(ROOT, path.join(OFFLINE_DIR, ed.edition_date))}${path.sep}index.html`);
  }
  console.log(`\nOpen an offline edition directly in your browser (file://).`);
}

main();
