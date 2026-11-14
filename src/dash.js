// DASH manifest helpers: detect, read the quality ladder, and rewrite the
// URLs that would otherwise make the player leave our local proxy.
//
// The proxy serves DASH under a path that mirrors the original URL
// (/dproxy/<feed>/<scheme>/<host>/<path>), so relative URLs and segment
// templates in the manifest resolve to the proxy on their own. Only absolute
// and root-relative URLs need rewriting.

// The proxied address of a DASH URL: the original URL, mirrored as a path.
export function dashProxyPath(feedId, absoluteUrl) {
  const url = new URL(absoluteUrl);
  return `/dproxy/${feedId}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}`;
}

export function isManifest(text) {
  return typeof text === 'string' && /<MPD[\s>]/.test(text.slice(0, 2048));
}

const decodeXml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const encodeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attributes(tag) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = decodeXml(m[2]);
  return attrs;
}

function frameRate(value) {
  if (!value) return null;
  const [num, den] = String(value).split('/').map(Number);
  const rate = den ? num / den : num;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Reads what the feed list needs from a manifest: live or not, protected or
 * not, and the video qualities (best first).
 */
export function parseManifest(text) {
  const root = /<MPD\b[^>]*>/.exec(text)?.[0] || '';
  const live = attributes(root).type === 'dynamic';
  const drm = /<ContentProtection\b/.test(text);

  const qualities = [];
  const seen = new Set();
  const sets = text.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || [];
  for (const set of sets) {
    const setAttrs = attributes(/<AdaptationSet\b[^>]*>/.exec(set)[0]);
    for (const tag of set.match(/<Representation\b[^>]*>/g) || []) {
      const attrs = { ...setAttrs, ...attributes(tag) };
      const height = Number(attrs.height) || null;
      const isVideo = /video/.test(attrs.mimeType || attrs.contentType || '') || Boolean(height);
      if (!isVideo) continue;
      const bandwidth = Number(attrs.bandwidth) || 0;
      const rate = frameRate(attrs.frameRate);
      const label = height
        ? `${height}p${rate && rate > 30 ? Math.round(rate) : ''}`
        : bandwidth
          ? `${Math.round(bandwidth / 1000)} kb/s`
          : 'Qualité inconnue';
      if (seen.has(label)) continue;
      seen.add(label);
      qualities.push({ label, height, bandwidth });
    }
  }
  qualities.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  return { live, drm, qualities };
}

const LEAVES_PROXY = /^(https?:)?\/\//i; // absolute or protocol-relative
const URL_ATTRIBUTES = ['media', 'initialization', 'index', 'sourceURL', 'xlink:href'];

/**
 * Rewrites the URLs of a manifest that point outside the proxied path.
 * `mapUrl(absoluteUrl)` returns the proxied address.
 */
export function rewriteManifest(text, baseUrl, mapUrl) {
  const map = (raw, always) => {
    const value = decodeXml(raw.trim());
    if (!value || /^(data|urn):/i.test(value)) return raw;
    if (!always && !LEAVES_PROXY.test(value) && !value.startsWith('/')) return raw;
    let abs;
    try {
      abs = new URL(value, baseUrl);
    } catch {
      return raw;
    }
    if (!/^https?:$/.test(abs.protocol)) return raw;
    // `$Number$`-style template variables must survive untouched.
    return encodeXml(mapUrl(abs.href).replace(/%24/g, '$'));
  };

  let out = text.replace(/(<BaseURL\b[^>]*>)([^<]*)(<\/BaseURL>)/g, (_, open, value, close) => open + map(value, false) + close);
  // The manifest's own refresh address always has to come back to the proxy.
  out = out.replace(/(<Location\b[^>]*>)([^<]*)(<\/Location>)/g, (_, open, value, close) => open + map(value, true) + close);
  for (const name of URL_ATTRIBUTES) {
    const re = new RegExp(`(\\s${name}=")([^"]*)(")`, 'g');
    out = out.replace(re, (_, open, value, close) => open + map(value, false) + close);
  }
  return out;
}
