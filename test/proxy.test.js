// End-to-end through the real server: scan the fixture's DASH page, then
// fetch the feed the way the player does.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFixture } from './fixture/server.js';

const hasMedia = existsSync(new URL('./fixture/media/dash/manifest.mpd', import.meta.url));
const skip = hasMedia ? false : 'média de test absent (lance test/fixture/make-media.sh)';

let fixture;
let app;
before(async () => {
  if (!hasMedia) return;
  process.env.DATA_FILE = join(mkdtempSync(join(tmpdir(), 'feedswitch-')), 'sources.json');
  const { startServer } = await import('../src/server.js');
  fixture = await startFixture();
  app = await startServer({ port: 0 });
});
after(async () => {
  await app?.close();
  await fixture?.close();
});

async function scan(url) {
  const res = await fetch(`${app.url}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const { id } = await res.json();
  for (;;) {
    const { sources } = await (await fetch(`${app.url}/api/sources`)).json();
    const source = sources.find((s) => s.id === id);
    if (source.status === 'done' || source.status === 'error') return source;
    await new Promise((r) => setTimeout(r, 300));
  }
}

test('relays a DASH feed: redirect, manifest and segments', { skip, timeout: 90000 }, async () => {
  const source = await scan(`${fixture.pageUrl}?link=4`);
  assert.equal(source.status, 'done');
  assert.equal(source.feeds.length, 1);
  const [feed] = source.feeds;
  assert.equal(feed.kind, 'dash');
  assert.ok(feed.playUrl.startsWith(`/dproxy/${feed.id}/http/`));

  const manifest = await fetch(app.url + feed.playUrl);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /dash\+xml/);
  assert.match(await manifest.text(), /<MPD/);

  // Segment addresses are relative: they resolve next to the manifest.
  const init = await fetch(new URL('init-stream0.m4s', manifest.url));
  assert.equal(init.status, 200);
  assert.ok((await init.arrayBuffer()).byteLength > 100);

  const range = await fetch(new URL('chunk-stream2-00001.m4s', manifest.url), { headers: { range: 'bytes=0-99' } });
  assert.ok([200, 206].includes(range.status));
  await range.body.cancel();
});

test('a redirecting manifest address is passed on as a redirect', { skip, timeout: 90000 }, async () => {
  const source = await scan(`${fixture.pageUrl}?link=4`);
  const feed = source.feeds[0];
  const moved = `/dproxy/${feed.id}/http/${new URL(fixture.cdnOrigin).host}/moved/manifest.mpd`;
  const res = await fetch(app.url + moved, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/dproxy/${feed.id}/http/${new URL(fixture.cdnOrigin).host}/dash/manifest.mpd`);
});
