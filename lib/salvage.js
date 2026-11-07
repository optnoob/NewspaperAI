'use strict';
/*
 * Recovery for Hermes chunks cut off by a max-output-token limit.
 *
 * When an agent hits its ceiling mid-emission the file is syntactically invalid
 * JSON — usually a story object with no closing brace and no closing `]`/`}`.
 * JSON.parse rejects the whole file, so without this every complete story in
 * that chunk would be thrown away (or, worse, abort the build).
 *
 * Strategy: brace-scan the `"stories"` array and keep every *balanced* object,
 * discarding the trailing incomplete one. Envelope scalars are recovered by
 * pattern, since any key the agent had not yet written is simply gone.
 */

/*
 * Walk forward from the opening `[` of the stories array, collecting top-level
 * objects. String-aware so braces inside headlines don't corrupt the depth
 * count, and escape-aware so a `\"` inside a string doesn't end it early.
 */
function scanObjects(text, from) {
  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  let arrayClosed = false;

  for (let i = from; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { inString = true; continue; }

    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) {
      arrayClosed = true;
      break;
    }
  }

  return { objects, arrayClosed, danglingObject: depth > 0 || objStart !== -1 };
}

function extractString(text, key) {
  // Non-greedy, escape-tolerant scalar string match.
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = re.exec(text);
  if (!m) return null;
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch (e) {
    return m[1];
  }
}

function extractNumber(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)').exec(text);
  return m ? Number(m[1]) : null;
}

function extractBool(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*(true|false)').exec(text);
  return m ? m[1] === 'true' : null;
}

/* Balanced-brace extraction of a nested object value, e.g. sector_ledes. */
function extractObject(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*\\{').exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const scan = scanObjects(text, open);
  if (!scan.objects.length) return null;
  try {
    return JSON.parse(scan.objects[0]);
  } catch (e) {
    return null;
  }
}

/*
 * Parse a drop file, falling back to salvage when it is truncated.
 *
 * Returns { data, truncated, recovered, discarded, note }.
 * `data` is null only when not even one story could be read.
 */
function parseDrop(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.stories)) {
      return { data: null, truncated: false, recovered: 0, discarded: 0,
               note: 'valid JSON but no "stories" array' };
    }
    return { data, truncated: false, recovered: data.stories.length, discarded: 0, note: null };
  } catch (parseError) {
    // Fall through to salvage.
  }

  const arrayMatch = /"stories"\s*:\s*\[/.exec(text);
  if (!arrayMatch) {
    return { data: null, truncated: true, recovered: 0, discarded: 0,
             note: 'invalid JSON and no "stories" array to salvage from' };
  }

  const open = arrayMatch.index + arrayMatch[0].length - 1;
  const scan = scanObjects(text, open);

  const stories = [];
  let discarded = 0;
  for (const raw of scan.objects) {
    try {
      stories.push(JSON.parse(raw));
    } catch (e) {
      discarded++; // Balanced braces but still malformed — rare, skip it.
    }
  }
  if (scan.danglingObject) discarded++;

  if (!stories.length) {
    return { data: null, truncated: true, recovered: 0, discarded,
             note: 'invalid JSON and no complete story objects found' };
  }

  // Envelope fields that survived. Anything the agent had not yet written —
  // often sector_ledes, if it emits them after the stories — is unrecoverable.
  const data = { stories };
  const runId = extractString(text, 'run_id');
  const scrapedAt = extractString(text, 'scraped_at');
  const editionDate = extractString(text, 'edition_date');
  const ledes = extractObject(text, 'sector_ledes');
  const part = extractNumber(text, 'part');
  const parts = extractNumber(text, 'parts');
  const sample = extractBool(text, '_sample');

  if (runId) data.run_id = runId;
  if (scrapedAt) data.scraped_at = scrapedAt;
  if (editionDate) data.edition_date = editionDate;
  if (ledes) data.sector_ledes = ledes;
  if (part !== null) data.part = part;
  if (parts !== null) data.parts = parts;
  if (sample !== null) data._sample = sample;

  return {
    data,
    truncated: true,
    recovered: stories.length,
    discarded,
    note: scan.arrayClosed
      ? 'malformed tail after the stories array'
      : 'output cut off mid-array (token limit?)',
  };
}

module.exports = { parseDrop, scanObjects };
