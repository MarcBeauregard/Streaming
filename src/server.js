// Local web server: the UI, a small JSON API, and the stream proxy.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isPlaylist, rewritePlaylist } from './hls.js';
import { closeBrowser } from './scanner.js';
import * as store from './store.js';
import { fetchUpstream } from './upstream.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
let loopbackOnly = true;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const STATIC_ALIASES = {
  '/': join(PUBLIC_DIR, 'index.html'),
  '/vendor/hls.min.js': join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js'),
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Requête trop volumineuse');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// While the server listens on loopback only, refuse requests that arrive under
// another host name (DNS rebinding) or that another website makes the browser
// send (cross-site requests).
function isTrusted(req) {
  if (!loopbackOnly) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function serveStatic(pathname, res) {
  let file = STATIC_ALIASES[pathname];
  if (!file) {
    file = normalize(join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + '/')) return false;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- proxy

const PASSTHROUGH = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

async function handleProxy(req, res, feedId, target) {
  const feed = store.getFeed(feedId);
  if (!feed) return sendJson(res, 404, { error: 'Flux inconnu (re-scanne la page)' });
  let url;
  try {
    url = new URL(target);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return sendJson(res, 400, { error: 'Adresse invalide' });
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetchUpstream(url.href, feed, { range: req.headers.range, signal: abort.signal });
  } catch (err) {
    if (abort.signal.aborted) return;
    return sendJson(res, 502, { error: `Source injoignable : ${err.cause?.code || err.message}` });
  }

  const headers = { 'cache-control': 'no-store' };
  for (const name of PASSTHROUGH) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  // fetch() already decoded any compression, so the upstream length only
  // still applies when the body was sent as-is.
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) headers['content-length'] = length;

  if (!upstream.body) {
    res.writeHead(upstream.status, headers);
    return res.end();
  }

  // Peek at the first chunk: playlists are recognised by content, because
  // servers label them with every content type imaginable.
  const reader = upstream.body.getReader();
  let first;
  try {
    first = await reader.read();
  } catch {
    if (abort.signal.aborted) return;
    return sendJson(res, 502, { error: 'Source interrompue' });
  }
  const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);

  if (upstream.ok && isPlaylist(head.subarray(0, 64).toString('utf8'))) {
    const chunks = [head];
    let size = head.length;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Playlist trop volumineuse');
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      if (abort.signal.aborted) return;
      return sendJson(res, 502, { error: err.message });
    }
    const base = upstream.url || url.href;
    const body = rewritePlaylist(
      Buffer.concat(chunks).toString('utf8'),
      base,
      (abs) => `/proxy/${feed.id}?u=${encodeURIComponent(abs)}`,
    );
    const data = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    return res.end(data);
  }

  res.writeHead(upstream.status, headers);
  if (first.done) return res.end();
  res.write(head);
  const rest = Readable.fromWeb(new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  }));
  rest.on('error', () => res.destroy());
  rest.pipe(res);
}

// ----------------------------------------------------------------- api

async function handleApi(req, res, pathname) {
  if (pathname === '/api/sources' && req.method === 'GET') {
    return sendJson(res, 200, { sources: store.listSources() });
  }
  if (pathname === '/api/sources' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'Requête invalide' });
    }
    try {
      const id = store.addSource(body.url);
      return sendJson(res, 200, { id, sources: store.listSources() });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  const match = /^\/api\/sources\/([a-f0-9]+)(\/scan)?$/.exec(pathname);
  if (match) {
    const [, id, scan] = match;
    if (scan && req.method === 'POST') {
      if (!store.rescanSource(id)) return sendJson(res, 404, { error: 'Source inconnue' });
      return sendJson(res, 200, { sources: store.listSources() });
    }
    if (!scan && req.method === 'DELETE') {
      if (!store.removeSource(id)) return sendJson(res, 404, { error: 'Source inconnue' });
      return sendJson(res, 200, { sources: store.listSources() });
    }
  }
  return sendJson(res, 404, { error: 'Introuvable' });
}

// -------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrusted(req)) return sendJson(res, 403, { error: 'Accès refusé' });
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);

    const proxy = /^\/proxy\/([a-f0-9]+)$/.exec(pathname);
    if (proxy) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Méthode refusée' });
      return await handleProxy(req, res, proxy[1], url.searchParams.get('u') || '');
    }

    if (req.method === 'GET' && (await serveStatic(pathname, res))) return;
    return sendJson(res, 404, { error: 'Introuvable' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erreur interne' });
    else res.destroy();
  }
});

/**
 * Starts the app server. `port: 0` picks any free port.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer({ port = 4173, host = '127.0.0.1' } = {}) {
  loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
  await store.load();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return {
    port: actualPort,
    url: `http://${shown}:${actualPort}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await closeBrowser();
    },
  };
}
