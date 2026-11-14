// Fetches a stream URL the way the original page did: same Referer, Origin,
// User-Agent and cookies. Most stream hosts refuse requests without them.

const REPLAYED_HEADERS = ['user-agent', 'referer', 'origin', 'cookie', 'authorization', 'accept-language'];

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Keeps only the request headers worth replaying.
export function pickHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (REPLAYED_HEADERS.includes(key) && value) out[key] = value;
  }
  return out;
}

function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.split('.').slice(-2).join('.');
    const hb = new URL(b).hostname.split('.').slice(-2).join('.');
    return ha === hb;
  } catch {
    return false;
  }
}

export async function fetchUpstream(url, feed, { range, signal, timeoutMs = 20000, redirect = 'follow' } = {}) {
  const headers = { accept: '*/*', 'user-agent': DEFAULT_UA, ...(feed?.headers || {}) };
  // Cookies and credentials were captured for the playlist host; do not leak
  // them to an unrelated host (segments are often served from a CDN).
  if (feed?.url && !sameSite(url, feed.url)) {
    delete headers.cookie;
    delete headers.authorization;
  }
  if (range) headers.range = range;

  // The timeout only covers the wait for response headers; the body of a
  // live segment or a long file may legitimately stream for much longer.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Délai dépassé')), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      redirect,
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response as text, refusing bodies larger than `maxBytes`.
export async function readText(res, maxBytes = 4 * 1024 * 1024) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Réponse trop volumineuse');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
