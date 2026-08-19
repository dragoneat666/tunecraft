// Shared retry-with-backoff wrapper around node-fetch, for the external APIs
// (MusicBrainz, ListenBrainz, Last.fm) that occasionally return a transient
// failure -- e.g. MusicBrainz returning a 503 while it recovers from a load
// spike. Centralized here rather than duplicated per service file because
// the retry behavior itself has nothing to do with any one API's data shape
// (unlike, say, candidateKey() in similarityRanking.js, which is
// intentionally duplicated from plex.js because it IS tied to Plex-specific
// name normalization).
//
// Design: short exponential-ish backoff, not a flat wait. A 503 is usually
// a momentary spike that clears in a couple of seconds, so the first retry
// fires almost immediately (1s); if that also fails, one more try after a
// longer wait (3s); then give up. A single blip costs a few seconds instead
// of a flat 30, while a real outage still gets a fair chance to pass.
const fetch = require('node-fetch');

const DEFAULT_RETRIES = 2; // retry attempts AFTER the first try (3 tries total)
const DEFAULT_DELAYS_MS = [1000, 3000]; // delay before retry #1, retry #2

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Only retry failures that are plausibly transient: 5xx (server-side
// trouble) and 429 (rate limited -- backing off is the correct response
// anyway). Never retry other 4xx statuses (400/401/403/404/etc) -- those
// mean the request itself was wrong, unauthorized, or the resource genuinely
// doesn't exist, and retrying won't change that.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Drop-in replacement for fetch(). Resolves to the same Response object a
// plain fetch() call would -- including a non-ok Response once retries are
// exhausted -- so every existing `if (!res.ok) throw ...` call site keeps
// working completely unchanged; this just gives transient failures a couple
// of extra chances before that check ever runs. Only throws itself if every
// attempt fails at the network level (DNS, connection refused, timeout,
// etc), which is exactly what a plain fetch() call would have done on its
// one and only attempt anyway.
async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries = retryOptions.retries ?? DEFAULT_RETRIES;
  const delays = retryOptions.delaysMs ?? DEFAULT_DELAYS_MS;
  const label = retryOptions.label || url;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || !isRetryableStatus(res.status) || attempt === retries) {
        return res;
      }
      const delay = delays[attempt] ?? delays[delays.length - 1];
      console.warn(`[HTTP retry] ${label} -> HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(delay);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      const delay = delays[attempt] ?? delays[delays.length - 1];
      console.warn(`[HTTP retry] ${label} -> ${err.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(delay);
    }
  }
  // Unreachable in practice (the loop always returns or throws above), but
  // keeps a defined result if retries/delays are ever misconfigured to a
  // value that skips the loop body entirely.
  if (lastErr) throw lastErr;
}

module.exports = { fetchWithRetry, isRetryableStatus };
