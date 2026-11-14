import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childUrls, isLive, isMaster, isPlaylist, parseMaster, rewritePlaylist, variantLabel } from '../src/hls.js';
import { findPlaylistUrls } from '../src/scanner.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="fr",URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=59.940
https://cdn.example/hi/index.m3u8?t=1
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720

mid/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg1.ts?x=1&y=2
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license"
#EXTINF:4.0,
/abs/seg2.ts
`;

test('recognises playlists', () => {
  assert.equal(isPlaylist('\n#EXTM3U\n'), true);
  assert.equal(isPlaylist('<html>'), false);
  assert.equal(isMaster(MASTER), true);
  assert.equal(isMaster(MEDIA), false);
  assert.equal(isLive(MEDIA), true);
  assert.equal(isLive(MEDIA + '#EXT-X-ENDLIST\n'), false);
});

test('parses the quality ladder, best first', () => {
  const variants = parseMaster(MASTER, 'https://host.example/live/master.m3u8');
  assert.deepEqual(variants.map(variantLabel), ['1080p60', '720p', '360p']);
  assert.deepEqual(variants.map((v) => v.url), [
    'https://cdn.example/hi/index.m3u8?t=1',
    'https://host.example/live/mid/index.m3u8',
    'https://host.example/live/low/index.m3u8',
  ]);
});

test('lists every child playlist of a master', () => {
  const children = childUrls(MASTER, 'https://host.example/live/master.m3u8');
  assert.equal(children.length, 4);
  assert.ok(children.includes('https://host.example/live/audio/fr.m3u8'));
});

test('rewrites segments, keys and init segments through the proxy', () => {
  const out = rewritePlaylist(MEDIA, 'https://host.example/live/720/index.m3u8', (u) => `/p?u=${encodeURIComponent(u)}`);
  const lines = out.split('\n');
  assert.ok(lines.includes(`#EXT-X-KEY:METHOD=AES-128,URI="/p?u=${encodeURIComponent('https://host.example/live/720/key.bin')}",IV=0x1`));
  assert.ok(lines.includes(`#EXT-X-MAP:URI="/p?u=${encodeURIComponent('https://host.example/live/720/init.mp4')}"`));
  assert.ok(lines.includes(`/p?u=${encodeURIComponent('https://host.example/live/720/seg1.ts?x=1&y=2')}`));
  assert.ok(lines.includes(`/p?u=${encodeURIComponent('https://host.example/abs/seg2.ts')}`));
  // Non-HTTP key URIs belong to the player, not the proxy.
  assert.ok(lines.includes('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license"'));
  assert.ok(lines.includes('#EXTINF:4.0,'));
});

test('finds playlist URLs hidden in page text', () => {
  const text = `var c = {"file":"https:\\/\\/a.example\\/x\\/master.m3u8?token=1&amp;e=2","img":"https://a.example/p.jpg"};
    <source src='http://b.example/live.m3u8'>`;
  assert.deepEqual(findPlaylistUrls(text), [
    'https://a.example/x/master.m3u8?token=1&e=2',
    'http://b.example/live.m3u8',
  ]);
});
