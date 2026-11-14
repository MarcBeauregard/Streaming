// Opens a page in a headless Chrome, nudges the player into starting, and
// records every stream URL the page requests (HLS, DASH, direct video files)
// together with the request headers needed to replay them.

import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { pickHeaders } from './upstream.js';

const HEADLESS = process.env.HEADLESS !== '0';

const FALLBACK_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/pw-browsers/chromium',
];

const LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
];

let browserPromise = null;
let userAgent = null;

async function launch() {
  const attempts = [];
  if (process.env.CHROME_PATH) attempts.push({ executablePath: process.env.CHROME_PATH });
  attempts.push({ channel: 'chrome' }, { channel: 'msedge' });
  for (const path of FALLBACK_PATHS) if (existsSync(path)) attempts.push({ executablePath: path });

  let lastError;
  for (const target of attempts) {
    try {
      const browser = await chromium.launch({ headless: HEADLESS, args: LAUNCH_ARGS, ...target });
      // Headless Chrome announces itself in its user agent; sites then serve a
      // different page. Use the same string a regular window would send.
      const page = await browser.newPage();
      userAgent = (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
      await page.close();
      browser.on('disconnected', () => {
        browserPromise = null;
      });
      return browser;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    "Impossible de lancer Chrome. Installe Google Chrome, ou indique le chemin de l'exécutable " +
      `avec la variable CHROME_PATH. (${String(lastError?.message || lastError).split('\n')[0]})`,
  );
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) await pending.then((b) => b.close()).catch(() => {});
}

// ---------------------------------------------------------------- detection

const SEGMENT_EXT = /\.(ts|m4s|m4a|aac|vtt|key|jpg|jpeg|png|gif|webp|css|js)$/i;

function kindFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (/\.m3u8?$/i.test(path)) return 'hls';
  if (/\.mpd$/i.test(path)) return 'dash';
  if (/\.(mp4|webm|m4v|mov)$/i.test(path)) return 'file';
  return null;
}

function kindFromContentType(type, url) {
  if (!type) return null;
  if (/mpegurl/i.test(type)) return 'hls';
  if (/dash\+xml/i.test(type)) return 'dash';
  if (/^video\/(mp4|webm|quicktime)/i.test(type)) {
    try {
      if (SEGMENT_EXT.test(new URL(url).pathname)) return null;
    } catch {
      return null;
    }
    return 'file';
  }
  return null;
}

// Total size of the resource behind a response, when the server tells us.
function totalSize(headers) {
  const range = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
  if (range) return Number(range[1]);
  const length = Number(headers['content-length']);
  return Number.isFinite(length) && length > 0 ? length : null;
}

const TEXT_TYPES = /(html|json|javascript|text\/plain|xml)/i;
const MAX_TEXT_BODY = 2 * 1024 * 1024;

// Finds playlist URLs written in page source, scripts and API responses.
export function findPlaylistUrls(text) {
  const clean = text
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&');
  const found = new Set();
  const re = /https?:\/\/[^\s"'<>\\)]+?\.m3u8(?:\?[^\s"'<>\\)]*)?/gi;
  let m;
  while ((m = re.exec(clean))) found.add(m[0]);
  return [...found];
}

// ------------------------------------------------------------ player nudging

// Runs inside every frame: starts any <video> and presses the usual play buttons.
function startPlayersInFrame() {
  for (const video of document.querySelectorAll('video')) {
    try {
      video.muted = true;
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  const selectors = [
    '.jw-icon-display',
    '.jw-display-icon-container',
    '.vjs-big-play-button',
    '.plyr__control--overlaid',
    '.fp-play',
    '.bmpui-ui-hugeplaybacktogglebutton',
    '[aria-label="Play" i]',
    '[aria-label="Lecture" i]',
    '[title="Play" i]',
    '.play-button',
    '.play-btn',
    '.btn-play',
    '#play',
    '#player .play',
  ];
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) el.click();
    } catch {}
  }
  try {
    if (typeof window.jwplayer === 'function') window.jwplayer().play();
  } catch {}
}

// Runs in the main frame: centre of the biggest visible player-like element.
function findClickTarget() {
  let best = null;
  for (const el of document.querySelectorAll('video, iframe, embed, object')) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w < 120 || h < 90) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (!best || w * h > best.area) {
      best = { area: w * h, x: Math.max(r.left, 0) + w / 2, y: Math.max(r.top, 0) + h / 2 };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// Runs in the main frame: links that look like alternate streams of the same event.
function collectLinks() {
  const hint = /(stream|link|lien|server|serveur|source|feed|channel|cha[iî]ne|watch|live|embed|player|\bhd\b|\bsd\b|\b\d{3,4}p\b)/i;
  const seen = new Set();
  const here = location.href.split('#')[0];
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let url;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const href = url.href.split('#')[0];
    if (href === here || seen.has(href)) continue;
    const text = (a.innerText || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!hint.test(text) && !hint.test(url.pathname + url.search)) continue;
    seen.add(href);
    out.push({ url: href, text: text || url.hostname + url.pathname });
    if (out.length >= 40) break;
  }
  return out;
}

async function nudge(page) {
  await Promise.all(
    page.frames().map((frame) => frame.evaluate(startPlayersInFrame).catch(() => {})),
  );
  const target = await page.evaluate(findClickTarget).catch(() => null);
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const point = target || { x: viewport.width / 2, y: viewport.height / 2 };
  await page.mouse.click(point.x, point.y).catch(() => {});
}

// ------------------------------------------------------------------- scan

/**
 * @returns {Promise<{title: string, finalUrl: string, candidates: Array, links: Array}>}
 */
export async function scanPage(url, { timeoutMs = 30000, settleMs = 4000, onProgress = () => {} } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const candidates = new Map(); // url -> candidate
  let firstStreamAt = null;

  const add = (candidate) => {
    const existing = candidates.get(candidate.url);
    // A request seen on the network carries the real headers; prefer it over
    // a URL that was only found in page text.
    if (existing && (existing.via === 'network' || candidate.via === 'text')) return;
    candidates.set(candidate.url, candidate);
    if (candidate.kind !== 'file' && !firstStreamAt) {
      firstStreamAt = Date.now();
      onProgress('Flux détecté, recherche d’autres flux…');
    }
  };

  const frameUrlOf = (request) => {
    try {
      return request.frame().url();
    } catch {
      return null;
    }
  };

  const onRequest = async (request) => {
    const kind = kindFromUrl(request.url());
    if (!kind || kind === 'file') return; // files are confirmed from the response
    const headers = await request.allHeaders().catch(() => request.headers());
    add({ url: request.url(), kind, via: 'network', headers: pickHeaders(headers), frameUrl: frameUrlOf(request) });
  };

  const onResponse = async (response) => {
    const request = response.request();
    const resUrl = response.url();
    if (!/^https?:/i.test(resUrl)) return;
    const headers = response.headers();
    const type = headers['content-type'] || '';
    const kind = kindFromContentType(type, resUrl) || (kindFromUrl(resUrl) === 'file' && response.ok() ? 'file' : null);

    if (kind) {
      if (kind === 'file') {
        const size = totalSize(headers);
        // Small video responses are segments or ad stingers, not feeds.
        if (size !== null && size < 3 * 1024 * 1024) return;
      }
      const reqHeaders = await request.allHeaders().catch(() => request.headers());
      delete reqHeaders.range;
      add({
        url: resUrl,
        kind,
        via: 'network',
        headers: pickHeaders(reqHeaders),
        frameUrl: frameUrlOf(request),
        size: kind === 'file' ? totalSize(headers) : null,
      });
      return;
    }

    // Otherwise look for playlist URLs mentioned in text responses.
    if (!['document', 'script', 'xhr', 'fetch'].includes(request.resourceType())) return;
    if (!TEXT_TYPES.test(type)) return;
    const length = Number(headers['content-length']);
    if (Number.isFinite(length) && length > MAX_TEXT_BODY) return;
    const body = await response.text().catch(() => null);
    if (!body || body.length > MAX_TEXT_BODY) return;
    const frameUrl = frameUrlOf(request) || resUrl;
    for (const found of findPlaylistUrls(body)) {
      let origin = null;
      try {
        origin = new URL(frameUrl).origin;
      } catch {}
      add({
        url: found,
        kind: 'hls',
        via: 'text',
        headers: pickHeaders({ 'user-agent': userAgent, referer: frameUrl, origin }),
        frameUrl,
      });
    }
  };

  try {
    const page = await context.newPage();
    context.on('request', (r) => void onRequest(r).catch(() => {}));
    context.on('response', (r) => void onResponse(r).catch(() => {}));
    // Ad pop-ups: close anything that is not our page.
    context.on('page', (popup) => {
      if (popup !== page) popup.close().catch(() => {});
    });
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

    // Once the page is loaded, a click must not be able to send it to an ad.
    let locked = false;
    await page.route('**/*', (route) => {
      const request = route.request();
      if (locked && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // Answering "204 No Content" makes Chrome drop the navigation and keep
        // the current page; aborting would replace it with an error page.
        return route.fulfill({ status: 204, body: '' }).catch(() => {});
      }
      return route.continue().catch(() => {});
    });

    onProgress('Ouverture de la page…');
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    locked = true;

    onProgress('Démarrage du lecteur…');
    const deadline = started + timeoutMs;
    let nextNudge = 0;
    for (;;) {
      const now = Date.now();
      if (now > deadline) break;
      if (firstStreamAt && now - firstStreamAt > settleMs) break;
      if (!firstStreamAt && now >= nextNudge) {
        await nudge(page);
        nextNudge = Date.now() + 1500;
      }
      await page.waitForTimeout(300);
    }

    const title = await page.title().catch(() => '');
    const links = await page.evaluate(collectLinks).catch(() => []);
    return { title, finalUrl: page.url(), candidates: [...candidates.values()], links };
  } finally {
    await context.close().catch(() => {});
  }
}
