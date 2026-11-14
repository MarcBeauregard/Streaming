// End-to-end: scans the fixture streaming page with a real browser.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { closeBrowser, scanPage } from '../src/scanner.js';
import { buildFeeds } from '../src/store.js';
import { fetchUpstream } from '../src/upstream.js';
import { startFixture } from './fixture/server.js';

const hasMedia = existsSync(new URL('./fixture/media/master.m3u8', import.meta.url));
const skip = hasMedia ? false : 'média de test absent (lance test/fixture/make-media.sh)';

let fixture;
before(async () => {
  if (hasMedia) fixture = await startFixture();
});
after(async () => {
  await closeBrowser();
  await fixture?.close();
});

test('finds the stream behind an ad overlay, a pop-up and an iframe', { skip, timeout: 90000 }, async () => {
  const result = await scanPage(fixture.pageUrl);
  assert.equal(result.title, 'Match test, lien 1');
  assert.equal(result.finalUrl, fixture.pageUrl, 'the ad redirect must not move the page');
  assert.ok(fixture.stats.popups >= 1, 'the fixture did open its pop-up');
  assert.deepEqual(result.links.map((l) => l.text), ['Lien 2 HD', 'Server 3', 'Lien 4 DASH']);

  const feeds = await buildFeeds(result.candidates);
  assert.equal(feeds.length, 1, 'variant playlists are folded into their master');
  const [feed] = feeds;
  assert.equal(feed.url, `${fixture.cdnOrigin}/live/master.m3u8`);
  assert.equal(feed.status, 'ok');
  assert.deepEqual(feed.qualities.map((q) => q.label), ['720p', '480p', '240p']);
  assert.equal(feed.live, false);
  assert.ok(feed.headers.referer.startsWith(fixture.embedOrigin), 'the embed page is replayed as Referer');

  // The stream host refuses a bare request and accepts the replayed one.
  const bare = await fetch(feed.url);
  assert.equal(bare.status, 403);
  const replayed = await fetchUpstream(feed.url, feed);
  assert.equal(replayed.status, 200);
  await replayed.body.cancel();
});

test('finds a stream that is only mentioned in the page source', { skip, timeout: 90000 }, async () => {
  const result = await scanPage(`${fixture.pageUrl}?link=2`, { timeoutMs: 8000 });
  const feeds = await buildFeeds(result.candidates);
  assert.deepEqual(feeds.map((f) => f.url), [`${fixture.cdnOrigin}/live2/master.m3u8?token=abc&x=1`]);
  assert.equal(feeds[0].status, 'ok');
});

test('reports nothing for a page without a stream', { skip, timeout: 90000 }, async () => {
  const result = await scanPage(`${fixture.pageUrl}?link=3`, { timeoutMs: 5000 });
  assert.deepEqual(await buildFeeds(result.candidates), []);
});

test('finds a DASH stream and keeps the address it redirects to', { skip, timeout: 90000 }, async () => {
  const result = await scanPage(`${fixture.pageUrl}?link=4`);
  const feeds = await buildFeeds(result.candidates);
  assert.equal(feeds.length, 1, 'segments and the redirecting address are not feeds');
  const [feed] = feeds;
  assert.equal(feed.kind, 'dash');
  assert.equal(feed.url, `${fixture.cdnOrigin}/dash/manifest.mpd`);
  assert.equal(feed.status, 'ok');
  assert.equal(feed.playable, true);
  assert.equal(feed.live, false);
  assert.deepEqual(feed.qualities.map((q) => q.label), ['720p', '480p', '240p']);
});
