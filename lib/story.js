'use strict';
/*
 * Shared story identity and merge logic.
 *
 * Used by BOTH merge.js (consolidating Hermes chunks into a daily drop) and
 * build.js (compiling editions). Deliberately one implementation: two stages
 * that disagree about what counts as "the same story" would merge a duplicate
 * in one place and let it through in the other.
 *
 * Works on raw contract-shaped stories and on build.js's normalized ones, so
 * every field access here is defensive about missing values.
 */

// Dropped before comparing headlines, so "Nvidia beats on Q3" and
// "Nvidia beats in the Q3 report" collapse together.
const STOPWORDS = new Set((
  'a an the and or but of in on at to for with from by as is are was were be been ' +
  'has have had will would could should may might do does did its it this that these ' +
  'those after before amid over under up down new says said report reports'
).split(' '));

// Headline token overlap above which two stories are *guessed* to be the same
// event. Only a fallback — `event_key` is the reliable signal. Kept fairly loose
// because a missed merge is more visible on the page than a rare bad one.
const DEDUPE_SIMILARITY = 0.45;

const DEFAULT_IMPORTANCE = 3;

function tokenize(s) {
  return new Set(
    String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// Cached on the story; stripped again by stripInternal() before serialising.
function tokensOf(story) {
  if (!story._tokens) story._tokens = tokenize(story.headline);
  return story._tokens;
}

function keyOf(story) {
  return story.event_key ? String(story.event_key).trim().toLowerCase() : null;
}

function urlsOf(story) {
  return (story.sources || []).map((s) => s && s.url).filter(Boolean);
}

/*
 * Do these two stories cover the same event? Strongest signal first.
 *
 * Lexical similarity alone is not enough: "Nvidia lifts data-center outlook"
 * and "Nvidia guidance raised as order book extends" are the same event but
 * share almost no tokens. So `event_key` is authoritative, and a disagreeing
 * pair of keys vetoes the lexical guess entirely — that keeps merging
 * predictable and gives Hermes a way to force two stories apart.
 */
function sameEvent(a, b) {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (ka && kb) return ka === kb;

  const ua = urlsOf(a);
  const ub = urlsOf(b);
  if (ua.some((u) => ub.indexOf(u) !== -1)) return true;

  return jaccard(tokensOf(a), tokensOf(b)) >= DEDUPE_SIMILARITY;
}

// Prose cut off by a token limit rarely ends on terminal punctuation.
function looksComplete(md) {
  if (!md) return false;
  return /[.!?"’”)\]]\s*$/.test(String(md).trim());
}

/*
 * Pick the better of two bodies for the same story. Completeness beats length:
 * a chunk boundary can leave one copy truncated mid-sentence, and the longer
 * string is not necessarily the intact one.
 */
function betterBody(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ca = looksComplete(a);
  const cb = looksComplete(b);
  if (ca !== cb) return ca ? a : b;
  return b.length > a.length ? b : a;
}

const importanceOf = (s) =>
  Number.isFinite(s.importance) ? s.importance : DEFAULT_IMPORTANCE;

/* Fold `src` into `target`, keeping the richest version of every field. */
function mergeInto(target, src) {
  target.merged_count = (target.merged_count || 1) + (src.merged_count || 1);

  target.tickers = target.tickers || [];
  for (const t of src.tickers || []) {
    if (target.tickers.indexOf(t) === -1) target.tickers.push(t);
  }

  target.sources = target.sources || [];
  for (const s of src.sources || []) {
    if (s && s.url && !target.sources.some((e) => e.url === s.url)) {
      target.sources.push(s);
    }
  }

  target.body_md = betterBody(target.body_md, src.body_md);
  if (!target.dek && src.dek) target.dek = src.dek;
  if (!target.event_key && src.event_key) target.event_key = src.event_key;
  if (target.sentiment == null && src.sentiment != null) target.sentiment = src.sentiment;
  if (importanceOf(src) > importanceOf(target)) target.importance = src.importance;

  return target;
}

/*
 * Collapse duplicate coverage. The most important copy survives and absorbs
 * the rest, so tickers and sources pool onto the version readers actually see.
 */
function dedupe(stories) {
  const kept = [];
  const ordered = [...stories].sort((a, b) => importanceOf(b) - importanceOf(a));

  for (const story of ordered) {
    const twin = kept.find((k) => sameEvent(k, story));
    if (twin) mergeInto(twin, story);
    else kept.push(story);
  }
  return kept;
}

function stripInternal(story) {
  const copy = { ...story };
  delete copy._tokens;
  return copy;
}

module.exports = {
  STOPWORDS,
  DEDUPE_SIMILARITY,
  DEFAULT_IMPORTANCE,
  tokenize,
  jaccard,
  sameEvent,
  looksComplete,
  betterBody,
  mergeInto,
  dedupe,
  stripInternal,
};
