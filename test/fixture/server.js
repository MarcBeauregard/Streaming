// A stand-in for a typical streaming page, used to test the scanner end to end:
//   site  - the page the user pastes: an ad overlay that opens a pop-up and
//           tries to redirect the tab, an iframe player, and "other links"
//   embed - the player page inside the iframe (a different origin)
//   cdn   - the stream host, which answers only when the Referer is the embed
//
// Run `node test/fixture/server.js` to browse it by hand.

import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(HERE, 'media');
const HLS_JS = join(HERE, '..', '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');

function listen(handler, port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8">${body}`);
};

export async function startFixture({ sitePort = 0, embedPort = 0, cdnPort = 0 } = {}) {
  if (!existsSync(join(MEDIA, 'master.m3u8'))) {
    throw new Error('Média de test absent : lance test/fixture/make-media.sh');
  }
  const stats = { cdnAllowed: 0, cdnRefused: 0, popups: 0 };
  let embedOrigin = '';
  let cdnOrigin = '';

  const cdn = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const referer = req.headers.referer || '';
    const match = /^\/(live|live2)\/(.+)$/.exec(url.pathname);
    const tokenOk = match?.[1] !== 'live2' || !url.pathname.endsWith('master.m3u8') || url.searchParams.get('token') === 'abc';
    if (!match || !referer.startsWith(embedOrigin) || !tokenOk) {
      stats.cdnRefused++;
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    const file = normalize(join(MEDIA, match[2]));
    if (!file.startsWith(MEDIA) || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    stats.cdnAllowed++;
    res.writeHead(200, {
      // Deliberately unhelpful content type, as seen in the wild.
      'content-type': extname(file) === '.m3u8' ? 'text/plain' : 'video/mp2t',
      'access-control-allow-origin': embedOrigin,
    });
    createReadStream(file).pipe(res);
  }, cdnPort);
  cdnOrigin = `http://127.0.0.1:${cdn.address().port}`;

  const embed = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/hls.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return createReadStream(HLS_JS).pipe(res);
    }
    if (url.pathname === '/embed/1') {
      // The stream URL is assembled at click time, so it is nowhere in the page text.
      const encoded = Buffer.from(`${cdnOrigin}/live/master.m3u8`).toString('base64');
      return html(res, `
        <style>html,body{margin:0;height:100%;background:#111}video{width:100%;height:100%}
        #go{position:absolute;inset:0;margin:auto;width:120px;height:120px;border-radius:50%;font-size:40px}</style>
        <video id="v" muted></video><button id="go">▶</button>
        <script src="/hls.min.js"></script>
        <script>
          document.getElementById('go').addEventListener('click', function (event) {
            if (!event.isTrusted) return;            // ignores scripted clicks
            this.remove();
            var hls = new Hls();
            hls.loadSource(atob('${encoded}'));
            hls.attachMedia(document.getElementById('v'));
            hls.on(Hls.Events.MANIFEST_PARSED, function () { document.getElementById('v').play(); });
          });
        </script>`);
    }
    if (url.pathname === '/embed/2') {
      // A player that never starts: the URL only exists in an inline config.
      const escaped = `${cdnOrigin}/live2/master.m3u8?token=abc&amp;x=1`.replace(/\//g, '\\/');
      return html(res, `<body style="background:#111;color:#eee">Lecteur en pause
        <script>var playerConfig = {"file":"${escaped}","dead":"${cdnOrigin.replace(/\//g, '\\/')}\\/gone\\/x.m3u8"};</script>`);
    }
    res.writeHead(404);
    res.end();
  }, embedPort);
  embedOrigin = `http://127.0.0.1:${embed.address().port}`;

  const site = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ad') {
      stats.popups++;
      return html(res, '<title>Pub</title><h1>PUB</h1>');
    }
    if (url.pathname === '/match') {
      const link = url.searchParams.get('link') || '1';
      const player = link === '3'
        ? '<p>Ce lien est hors ligne.</p>'
        : `<div style="position:relative;width:960px;height:540px">
             <iframe src="${embedOrigin}/embed/${link}" width="960" height="540" allow="autoplay" style="border:0"></iframe>
             <div id="ad" style="position:absolute;inset:0;z-index:9"
                  onclick="window.open('/ad'); this.remove(); setTimeout(function(){ location.href='/ad'; }, 50);"></div>
           </div>`;
      return html(res, `<title>Match test, lien ${link}</title>
        <body style="background:#222;color:#eee;font-family:sans-serif">
        <h1>Match test</h1>${player}
        <p><a href="/match?link=2">Lien 2 HD</a> · <a href="/match?link=3">Server 3</a> · <a href="/a-propos">À propos</a></p>`);
    }
    res.writeHead(404);
    res.end();
  }, sitePort);
  const siteOrigin = `http://127.0.0.1:${site.address().port}`;

  return {
    siteOrigin,
    embedOrigin,
    cdnOrigin,
    stats,
    pageUrl: `${siteOrigin}/match`,
    close: () => Promise.all([site, embed, cdn].map((s) => new Promise((r) => {
      s.closeAllConnections();
      s.close(r);
    }))),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixture({ sitePort: 5001, embedPort: 5002, cdnPort: 5003 });
  console.log(`Page de test : ${fixture.pageUrl}`);
}
