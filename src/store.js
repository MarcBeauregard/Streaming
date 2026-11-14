// In-memory state: the pages the user added ("sources") and the feeds found
// on each. Only the list of page URLs is saved to disk; stream URLs carry
// short-lived tokens, so feeds are rediscovered by rescanning.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashProxyPath, isManifest, parseManifest } from './dash.js';
import { childUrls, isLive, isMaster, isPlaylist, parseMaster, variantLabel } from './hls.js';
import { scanPage } from './scanner.js';
import { DEFAULT_UA, fetchUpstream, readText } from './upstream.js';

const DATA_FILE =
  process.env.DATA_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sources.json');

const sources = new Map(); // id -> source
const feeds = new Map(); // id -> feed (with private headers)

const newId = () => randomBytes(6).toString('hex');

function streamKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ------------------------------------------------------------- persistence

export async function load() {
  try {
    const saved = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    for (const s of saved) {
      if (!s?.id || !s?.url) continue;
      sources.set(s.id, { ...blankSource(s.url), id: s.id, title: s.title || '' });
    }
  } catch {
    // First run, or unreadable file: start empty.
  }
}

async function save() {
  const list = [...sources.values()].map(({ id, url, title }) => ({ id, url, title }));
  try {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('Sauvegarde impossible :', err.message);
  }
}

// ------------------------------------------------------------------ feeds

async function inspectHls(candidate) {
  const res = await fetchUpstream(candidate.url, candidate);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await readText(res);
  if (!isPlaylist(text)) throw new Error('La réponse n’est pas une playlist HLS');
  const base = res.url || candidate.url;
  if (isMaster(text)) {
    const variants = parseMaster(text, base);
    // Live or replay is only written in the variant playlists.
    let live = null;
    if (variants[0]) {
      try {
        const sub = await fetchUpstream(variants[0].url, candidate);
        const subText = sub.ok ? await readText(sub) : (await sub.body?.cancel().catch(() => {}), '');
        if (isPlaylist(subText)) live = isLive(subText);
      } catch {
        // Unknown: the feed is still listed, just without the badge.
      }
    }
    return {
      key: streamKey(base),
      master: true,
      children: childUrls(text, base),
      live,
      qualities: variants.map((v) => ({ label: variantLabel(v), height: v.height, bandwidth: v.bandwidth })),
    };
  }
  return { key: streamKey(base), master: false, children: [], live: isLive(text), qualities: [] };
}

async function inspectDash(candidate) {
  const res = await fetchUpstream(candidate.url, candidate);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await readText(res);
  if (!isManifest(text)) throw new Error('La réponse n’est pas un manifeste DASH');
  const { live, drm, qualities } = parseManifest(text);
  if (drm) throw new Error('flux protégé par DRM');
  // Two addresses that redirect to the same manifest are the same feed.
  return { key: streamKey(res.url || candidate.url), live, qualities };
}

async function inspectFile(candidate) {
  const res = await fetchUpstream(candidate.url, candidate, { range: 'bytes=0-0' });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {};
}

async function toFeed(candidate) {
  const feed = {
    id: newId(),
    kind: candidate.kind,
    url: candidate.url,
    headers: candidate.headers || {},
    key: streamKey(candidate.url),
    host: hostOf(candidate.url),
    via: candidate.via,
    master: false,
    children: [],
    qualities: [],
    live: null,
    size: candidate.size || null,
    playable: true,
    status: 'ok',
    error: null,
  };
  try {
    if (candidate.kind === 'hls') Object.assign(feed, await inspectHls(feed));
    else if (candidate.kind === 'dash') Object.assign(feed, await inspectDash(feed));
    else Object.assign(feed, await inspectFile(feed));
  } catch (err) {
    feed.status = 'error';
    feed.playable = false;
    feed.error = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Délai dépassé' : err.message;
  }
  return feed;
}

function rank(feed) {
  if (feed.status !== 'ok' || !feed.playable) return 9;
  if (feed.kind === 'hls') return feed.master ? 0 : 1;
  if (feed.kind === 'dash') return 0;
  return 2;
}

export async function buildFeeds(candidates) {
  const inspected = await Promise.all(candidates.map(toFeed));

  // Variant playlists requested by the page's own player are already
  // reachable through their master; listing them again would be noise.
  const children = new Set();
  for (const f of inspected) for (const c of f.children) children.add(c).add(streamKey(c));

  // Hosts that serve a working manifest: a video file seen on the same host
  // is one of its segments, not a feed of its own.
  const manifestHosts = new Set(
    inspected.filter((f) => f.kind !== 'file' && f.status === 'ok').map((f) => f.host),
  );

  const seen = new Set();
  const out = [];
  for (const f of inspected) {
    if (f.kind === 'file' && manifestHosts.has(f.host)) continue;
    // A URL that was only spotted in page text and does not answer is a false lead.
    if (f.via === 'text' && f.status === 'error') continue;
    if (!f.master && (children.has(f.url) || children.has(f.key))) continue;
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  out.sort((a, b) => rank(a) - rank(b) || (b.qualities[0]?.height || 0) - (a.qualities[0]?.height || 0));
  return out;
}

// ---------------------------------------------------------------- sources

function blankSource(url) {
  return {
    id: newId(),
    url,
    title: '',
    status: 'idle', // idle | queued | scanning | done | error
    step: '',
    error: null,
    feedIds: [],
    links: [],
    scannedAt: null,
  };
}

export function getFeed(id) {
  return feeds.get(id);
}

function publicFeed(feed) {
  const { headers, children, ...rest } = feed;
  const playUrl =
    feed.kind === 'dash' ? dashProxyPath(feed.id, feed.url) : `/proxy/${feed.id}?u=${encodeURIComponent(feed.url)}`;
  return { ...rest, playUrl };
}

export function listSources() {
  return [...sources.values()].map((s) => {
    const { feedIds, ...rest } = s;
    return { ...rest, feeds: feedIds.map((id) => feeds.get(id)).filter(Boolean).map(publicFeed) };
  });
}

export function normalizeUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Lien vide');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Lien invalide');
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error('Lien invalide');
  return url.href;
}

export function addSource(input) {
  const url = normalizeUrl(input);
  const existing = [...sources.values()].find((s) => s.url === url);
  if (existing) {
    if (existing.status !== 'scanning' && existing.status !== 'queued') enqueue(existing);
    return existing.id;
  }
  const source = blankSource(url);
  sources.set(source.id, source);
  void save();
  enqueue(source);
  return source.id;
}

export function rescanSource(id) {
  const source = sources.get(id);
  if (!source) return false;
  if (source.status !== 'scanning' && source.status !== 'queued') enqueue(source);
  return true;
}

export function removeSource(id) {
  const source = sources.get(id);
  if (!source) return false;
  for (const feedId of source.feedIds) feeds.delete(feedId);
  sources.delete(id);
  void save();
  return true;
}

// ------------------------------------------------------------------ queue

const MAX_PARALLEL_SCANS = 2;
const queue = [];
let running = 0;

function enqueue(source) {
  source.status = 'queued';
  source.step = 'En attente…';
  source.error = null;
  queue.push(source);
  pump();
}

function pump() {
  while (running < MAX_PARALLEL_SCANS && queue.length) {
    const source = queue.shift();
    if (!sources.has(source.id)) continue; // removed while waiting
    running++;
    scan(source).finally(() => {
      running--;
      pump();
    });
  }
}

// 'hls' or 'dash' when the address is itself a manifest, otherwise null.
function directStreamKind(url) {
  try {
    const path = new URL(url).pathname;
    if (/\.m3u8?$/i.test(path)) return 'hls';
    if (/\.mpd$/i.test(path)) return 'dash';
  } catch {
    // Not a URL: let the page scan report it.
  }
  return null;
}

// Turns a browser error into something a person can act on.
function describeError(err) {
  const message = String(err?.message || err).split('\n')[0];
  const net = /net::(ERR_[A-Z_]+)/.exec(message);
  if (net) {
    const reasons = {
      ERR_NAME_NOT_RESOLVED: 'ce site est introuvable (adresse erronée ou site fermé)',
      ERR_CONNECTION_REFUSED: 'le site refuse la connexion',
      ERR_CONNECTION_TIMED_OUT: 'le site ne répond pas',
      ERR_INTERNET_DISCONNECTED: 'pas de connexion internet',
    };
    return reasons[net[1]] || `la page n’a pas pu être ouverte (${net[1]})`;
  }
  if (/Timeout \d+ms exceeded/.test(message)) return 'la page met trop de temps à répondre';
  return message.replace(/^page\.\w+: /, '');
}

async function scan(source) {
  source.status = 'scanning';
  source.step = 'Préparation…';
  try {
    let result;
    const direct = directStreamKind(source.url);
    if (direct) {
      // The user pasted a manifest URL: nothing to discover.
      result = {
        title: '',
        links: [],
        candidates: [{ url: source.url, kind: direct, via: 'network', headers: { 'user-agent': DEFAULT_UA } }],
      };
    } else {
      result = await scanPage(source.url, { onProgress: (step) => (source.step = step) });
    }
    source.step = 'Vérification des flux…';
    const found = await buildFeeds(result.candidates);
    if (!sources.has(source.id)) return; // removed while scanning

    for (const feedId of source.feedIds) feeds.delete(feedId);
    for (const feed of found) feeds.set(feed.id, feed);
    source.feedIds = found.map((f) => f.id);
    source.links = result.links || [];
    if (result.title && result.title !== source.title) {
      source.title = result.title.slice(0, 140);
      void save();
    }
    source.status = 'done';
    source.scannedAt = Date.now();
  } catch (err) {
    source.status = 'error';
    source.error = describeError(err);
  } finally {
    source.step = '';
  }
}
