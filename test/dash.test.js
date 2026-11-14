import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashProxyPath, isManifest, parseManifest, rewriteManifest } from '../src/dash.js';
import { findPlaylistUrls } from '../src/scanner.js';

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT2S">
  <Location>https://origin.example/live/manifest.mpd?t=1&amp;u=2</Location>
  <BaseURL>https://cdn.example/live/</BaseURL>
  <Period>
    <BaseURL>video/</BaseURL>
    <AdaptationSet mimeType="video/mp4" frameRate="60000/1001">
      <SegmentTemplate initialization="init-$RepresentationID$.mp4" media="/abs/$RepresentationID$/$Number%05d$.m4s"/>
      <Representation id="hi" bandwidth="6000000" width="1920" height="1080"/>
      <Representation id="lo" bandwidth="1500000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio">
      <Representation id="aud" bandwidth="128000" mimeType="audio/mp4"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const map = (abs) => dashProxyPath('feed1', abs);

test('recognises manifests', () => {
  assert.equal(isManifest(MPD), true);
  assert.equal(isManifest('#EXTM3U'), false);
});

test('reads live state, protection and video qualities', () => {
  const info = parseManifest(MPD);
  assert.equal(info.live, true);
  assert.equal(info.drm, false);
  assert.deepEqual(info.qualities.map((q) => q.label), ['1080p60', '720p60']);
  assert.equal(parseManifest(MPD.replace('type="dynamic"', 'type="static"')).live, false);
  assert.equal(parseManifest(MPD.replace('<Representation id="hi"', '<ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Representation id="hi"')).drm, true);
});

test('mirrors a URL as a proxy path', () => {
  assert.equal(map('https://cdn.example:8443/a/b.mpd?x=1&y=2'), '/dproxy/feed1/https/cdn.example:8443/a/b.mpd?x=1&y=2');
});

test('rewrites only the URLs that would leave the proxy', () => {
  const out = rewriteManifest(MPD, 'https://origin.example/live/manifest.mpd', map);
  // Absolute base and the refresh address come back to the proxy.
  assert.ok(out.includes('<BaseURL>/dproxy/feed1/https/cdn.example/live/</BaseURL>'));
  assert.ok(out.includes('<Location>/dproxy/feed1/https/origin.example/live/manifest.mpd?t=1&amp;u=2</Location>'));
  // Root-relative template: resolved against the manifest host, variables intact.
  assert.ok(out.includes('media="/dproxy/feed1/https/origin.example/abs/$RepresentationID$/$Number%05d$.m4s"'));
  // Relative URLs already resolve inside the mirrored path.
  assert.ok(out.includes('<BaseURL>video/</BaseURL>'));
  assert.ok(out.includes('initialization="init-$RepresentationID$.mp4"'));
});

test('finds manifest URLs of both kinds in page text', () => {
  assert.deepEqual(findPlaylistUrls('a="https://x.example/v/manifest.mpd?k=1" b="https://x.example/v/a.m3u8" c="https://x.example/p.mpdx"'), [
    'https://x.example/v/manifest.mpd?k=1',
    'https://x.example/v/a.m3u8',
  ]);
});
