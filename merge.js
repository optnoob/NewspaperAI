#!/usr/bin/env node
'use strict';
/*
 * Stage 1 of 2: consolidate Hermes chunks into one clean drop per day.
 *
 *   data/inbox/*.json  (chunks, possibly truncated/overlapping)
 *        ->  data/raw/<edition-date>.json  (one tidy drop, what build.js eats)
 *
 * Exists because an agent's max output tokens force a day's scrape into several
 * files, and the last one is usually cut off mid-JSON. This stage salvages the
 * complete stories out of it, orders the chunks, folds away the overlap between
 * them, and hands build.js a single well-formed drop.
 *
 * The inbox is never modified, so a bad merge is always re-runnable.
 */

const fs = require('fs');
const path = require('path');

const { parseDrop } = require('./lib/salvage');
const { dedupe, stripInternal } = require('./lib/story');

const ROOT = __dirname;
const INBOX_DIR = path.join(ROOT, 'data', 'inbox');
const RAW_DIR = path.join(ROOT, 'data', 'raw');

const warnings = [];
function warn(msg) {
  warnings.push(msg);
}

function dateOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// --- Read the inbox -------------------------------------------------------

function readChunks() {
  if (!fs.existsSync(INBOX_DIR)) {
    console.error(`No inbox at ${INBOX_DIR}. Point Hermes at it (see HERMES_CONTRACT.md).`);
    process.exit(1);
  }

  const files = fs.readdirSync(INBOX_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.error(`No *.json chunks in ${INBOX_DIR}.`);
    process.exit(1);
  }

  const chunks = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(INBOX_DIR, file), 'utf8');
    const result = parseDrop(text);

    if (!result.data) {
      warn(`${file}: UNREADABLE — ${result.note}. Skipped.`);
      continue;
    }
    if (result.truncated) {
      warn(`${file}: truncated (${result.note}) — salvaged ${result.recovered} ` +
           `complete stor${result.recovered === 1 ? 'y' : 'ies'}, ` +
           `discarded ${result.discarded} incomplete.`);
    }

    chunks.push({ file, ...result });
  }
  return chunks;
}

// --- Group chunks into days ----------------------------------------------

function groupByDate(chunks) {
  const byDate = new Map();

  for (const chunk of chunks) {
    const { file, data } = chunk;
    const date = data.edition_date || dateOf(data.scraped_at);

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      warn(`${file}: no usable edition date (edition_date / scraped_at missing ` +
           `or unparseable). Skipped.`);
      continue;
    }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(chunk);
  }
  return byDate;
}

/*
 * Chunk order decides which value wins for single-valued fields, so make it
 * deterministic: declared part number first, then scrape time, then filename.
 */
function orderChunks(chunks) {
  return [...chunks].sort((a, b) => {
    const pa = Number.isFinite(a.data.part) ? a.data.part : Infinity;
    const pb = Number.isFinite(b.data.part) ? b.data.part : Infinity;
    if (pa !== pb) return pa - pb;

    const ta = a.data.scraped_at || '';
    const tb = b.data.scraped_at || '';
    if (ta !== tb) return ta < tb ? -1 : 1;

    return a.file.localeCompare(b.file);
  });
}

/*
 * A silently missing chunk is the dangerous failure here: the paper still
 * builds, just thinner, with no sign anything is absent. So check the declared
 * part numbers and say so loudly.
 */
function checkCompleteness(date, chunks) {
  const parts = chunks
    .map((c) => c.data.part)
    .filter((p) => Number.isFinite(p))
    .sort((a, b) => a - b);

  if (!parts.length) {
    if (chunks.length > 1) {
      warn(`${date}: ${chunks.length} chunks, none declaring "part" — cannot ` +
           `verify any are missing. Have Hermes set part/parts.`);
    }
    return;
  }

  const declaredTotal = chunks
    .map((c) => c.data.parts)
    .filter((p) => Number.isFinite(p))
    .sort((a, b) => b - a)[0] || null;

  const expected = declaredTotal || parts[parts.length - 1];
  const missing = [];
  for (let i = 1; i <= expected; i++) {
    if (parts.indexOf(i) === -1) missing.push(i);
  }

  if (missing.length) {
    warn(`${date}: MISSING chunk${missing.length === 1 ? '' : 's'} ` +
         `${missing.join(', ')} of ${expected} — this edition is incomplete.`);
  }
  if (new Set(parts).size !== parts.length) {
    warn(`${date}: duplicate part numbers (${parts.join(', ')}) — ` +
         `overlapping stories will be deduped, but check Hermes is numbering correctly.`);
  }
  if (declaredTotal && parts[parts.length - 1] > declaredTotal) {
    warn(`${date}: saw part ${parts[parts.length - 1]} but "parts" says ${declaredTotal}.`);
  }
}

// --- Merge one day --------------------------------------------------------

function mergeDate(date, rawChunks) {
  const chunks = orderChunks(rawChunks);
  checkCompleteness(date, chunks);

  const sectorLedes = {};
  const runIds = [];
  const provenance = [];
  const incoming = [];
  let sample = false;

  for (const chunk of chunks) {
    const { data } = chunk;

    if (data._sample === true) sample = true;
    if (data.run_id && runIds.indexOf(String(data.run_id)) === -1) {
      runIds.push(String(data.run_id));
    }
    // Later chunks win on conflict; in practice they fill gaps.
    Object.assign(sectorLedes, data.sector_ledes || {});

    for (const story of data.stories) incoming.push(story);

    provenance.push({
      file: chunk.file,
      part: Number.isFinite(data.part) ? data.part : null,
      stories: data.stories.length,
      truncated: chunk.truncated || false,
      discarded: chunk.discarded || 0,
    });
  }

  // The real work: fold away overlap between chunks, and reunite a story whose
  // body landed in one chunk and whose dek landed in another.
  const stories = dedupe(incoming).map(stripInternal).map((s) => {
    delete s.merged_count; // build.js recomputes this; raw drops don't carry it.
    return s;
  });

  const scrapedTimes = chunks.map((c) => c.data.scraped_at).filter(Boolean).sort();

  return {
    drop: {
      _generated_by: 'merge.js — consolidated from data/inbox/, do not hand-edit',
      ...(sample ? { _sample: true } : {}),
      run_id: runIds.length === 1 ? runIds[0] : `${date}-merged`,
      run_ids: runIds,
      scraped_at: scrapedTimes[0] || `${date}T00:00:00Z`,
      edition_date: date,
      source_chunks: provenance,
      ...(Object.keys(sectorLedes).length ? { sector_ledes: sectorLedes } : {}),
      stories,
    },
    collapsed: incoming.length - stories.length,
    incoming: incoming.length,
  };
}

// --- Main -----------------------------------------------------------------

function main() {
  const chunks = readChunks();
  const byDate = groupByDate(chunks);

  if (!byDate.size) {
    console.error('\nNothing could be merged:\n');
    for (const w of warnings) console.error('  * ' + w);
    process.exit(1);
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const dates = [...byDate.keys()].sort();
  const results = [];

  for (const date of dates) {
    const result = mergeDate(date, byDate.get(date));
    fs.writeFileSync(path.join(RAW_DIR, `${date}.json`),
                     JSON.stringify(result.drop, null, 2));
    results.push({ date, ...result });
  }

  console.log(`Merged ${chunks.length} chunk(s) into ${results.length} drop(s):`);
  for (const r of results) {
    const chunkList = r.drop.source_chunks
      .map((c) => `${c.file}${c.truncated ? ' (salvaged)' : ''}`)
      .join(', ');
    console.log(`  ${r.date}  ${r.incoming} scraped -> ${r.drop.stories.length} unique` +
                `${r.collapsed ? ` (${r.collapsed} overlapping collapsed)` : ''}`);
    console.log(`    from ${chunkList}`);
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log('  ! ' + w);
  }

  console.log(`\n  -> ${path.relative(ROOT, RAW_DIR)}${path.sep}*.json`);
  console.log('\nNow run: node build.js');
}

main();
