// HLS playlist helpers: detect, parse the quality ladder, and rewrite URIs so
// every request the player makes goes back through our local proxy.

export function isPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

export function isMaster(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

export function isLive(text) {
  return !/^#EXT-X-ENDLIST/m.test(text);
}

// Parses an attribute list such as `BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2"`.
export function parseAttributes(list) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(list))) {
    const value = m[2];
    attrs[m[1]] = value.startsWith('"') ? value.slice(1, -1) : value;
  }
  return attrs;
}

function resolve(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
}

// Returns the variants of a master playlist, best quality first.
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    // The URI is the next line that is neither blank nor a tag.
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (next.startsWith('#')) {
        if (next.startsWith('#EXT-X-STREAM-INF:')) break;
        continue;
      }
      uri = next;
      i = j;
      break;
    }
    if (!uri) continue;
    const url = resolve(uri, baseUrl);
    if (!url) continue;
    const [width, height] = (attrs.RESOLUTION || '').split('x').map(Number);
    const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH) || 0;
    variants.push({
      url,
      bandwidth,
      width: width || null,
      height: height || null,
      frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : null,
      codecs: attrs.CODECS || null,
      name: attrs.NAME || null,
    });
  }
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  return variants;
}

export function variantLabel(v) {
  if (v.height) {
    const fps = v.frameRate && v.frameRate > 30 ? Math.round(v.frameRate) : '';
    return `${v.height}p${fps}`;
  }
  if (v.name) return v.name;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kb/s`;
  return 'Qualité inconnue';
}

// Rewrites every URI in a playlist (segments, variant playlists, keys, init
// segments, alternate renditions) with `mapUrl(absoluteUrl)`.
export function rewritePlaylist(text, baseUrl, mapUrl) {
  const mapOne = (uri) => {
    const abs = resolve(uri, baseUrl);
    // Leave non-HTTP schemes alone (data:, skd:, ...): the player handles them.
    if (!abs || !/^https?:/i.test(abs)) return uri;
    return mapUrl(abs);
  };
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith('#')) {
        if (!line.includes('URI="')) return raw;
        return raw.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${mapOne(uri)}"`);
      }
      return mapOne(line);
    })
    .join('\n');
}

// Every playlist a master points to (variants and alternate renditions).
export function childUrls(text, baseUrl) {
  const urls = new Set(parseMaster(text, baseUrl).map((v) => v.url));
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') && !line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) continue;
    const uri = parseAttributes(line.slice(line.indexOf(':') + 1)).URI;
    const abs = uri && resolve(uri, baseUrl);
    if (abs) urls.add(abs);
  }
  return [...urls];
}
