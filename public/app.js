/* global Hls, dashjs */
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const overlayTitle = $('overlay-title');
  const overlayText = $('overlay-text');
  const overlayAction = $('overlay-action');
  const nowState = $('now-state');
  const nowTitle = $('now-title');
  const nowSub = $('now-sub');
  const qualitySelect = $('quality');
  const reloadBtn = $('reload');
  const pipBtn = $('pip');
  const sourcesEl = $('sources');
  const addForm = $('add-form');
  const addUrl = $('add-url');

  const state = {
    sources: [],
    snapshot: '',
    current: null, // { feedId, key, sourceId }
    openLinks: new Set(), // sources whose "other links" list is expanded
    pollTimer: null,
    autoplay: false, // start the next feed found, if nothing is playing
  };
  let hls = null;
  let dash = null;
  let dashLoading = null;
  let recoveries = 0;

  // ------------------------------------------------------------ helpers

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'disabled' || key === 'hidden' || key === 'open') el[key] = Boolean(value);
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function icon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }
  const ICON_RESCAN = 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7';
  const ICON_REMOVE = 'M6 6l12 12M18 6L6 18';

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  const isBusy = (source) => source.status === 'queued' || source.status === 'scanning';
  const isPlayable = (feed) => feed.playable && feed.status === 'ok';

  function allFeeds() {
    return state.sources.flatMap((source) => source.feeds.map((feed) => ({ feed, source })));
  }
  function playableFeeds() {
    return allFeeds().filter(({ feed }) => isPlayable(feed));
  }

  function feedMeta(feed) {
    if (feed.status === 'error') return `Trouvé, mais illisible : ${feed.error}`;
    if (feed.kind === 'file') {
      return feed.size ? `Fichier vidéo · ${Math.round(feed.size / 1048576)} Mo` : 'Fichier vidéo';
    }
    if (feed.qualities.length) return feed.qualities.map((q) => q.label).join(' · ');
    return 'Qualité unique';
  }

  // ------------------------------------------------------------- player

  function setOverlay(mode, title = '', text = '', action = null) {
    overlay.hidden = mode === 'none';
    overlay.classList.toggle('is-loading', mode === 'loading');
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlayAction.hidden = !action;
    overlayAction.onclick = action;
  }

  function setNow(status, title, sub = '') {
    nowState.className = `dot ${status}`;
    nowTitle.textContent = title;
    nowSub.textContent = sub;
  }

  function resetQuality() {
    qualitySelect.replaceChildren(h('option', { value: '-1' }, 'Auto'));
    qualitySelect.disabled = true;
  }

  function levelLabel(level) {
    if (level.height) {
      const fps = level.frameRate > 30 ? Math.round(level.frameRate) : '';
      return `${level.height}p${fps}`;
    }
    if (level.name) return level.name;
    return level.bitrate ? `${Math.round(level.bitrate / 1000)} kb/s` : 'Inconnue';
  }

  function fillQuality() {
    const levels = hls.levels.map((level, index) => ({ level, index }));
    levels.sort((a, b) => (b.level.height || 0) - (a.level.height || 0) || b.level.bitrate - a.level.bitrate);
    qualitySelect.replaceChildren(
      h('option', { value: '-1' }, 'Auto'),
      ...levels.map(({ level, index }) => h('option', { value: String(index) }, levelLabel(level))),
    );
    qualitySelect.disabled = hls.levels.length < 2;
  }

  // The DASH player is large and rarely needed: fetch it on first use.
  function loadDashLibrary() {
    if (window.dashjs) return Promise.resolve();
    if (!dashLoading) {
      dashLoading = new Promise((resolve, reject) => {
        const script = h('script', { src: '/vendor/dash.min.js' });
        script.onload = resolve;
        script.onerror = () => {
          dashLoading = null;
          reject(new Error('Lecteur DASH introuvable'));
        };
        document.head.append(script);
      });
    }
    return dashLoading;
  }

  function dashLevels() {
    const levels = dash.getRepresentationsByType('video') || [];
    return [...levels].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  }

  function dashLevelLabel(level) {
    return levelLabel({ height: level.height, frameRate: level.frameRate, bitrate: level.bandwidth });
  }

  function fillDashQuality() {
    const levels = dashLevels();
    qualitySelect.replaceChildren(
      h('option', { value: '-1' }, 'Auto'),
      ...levels.map((level) => h('option', { value: level.id }, dashLevelLabel(level))),
    );
    qualitySelect.disabled = levels.length < 2;
  }

  // dash.js error codes after which the stream cannot continue: manifest or
  // segment unreachable or unreadable, no playable track, unsupported codec.
  const DASH_FATAL_CODES = [10, 11, 23, 25, 27, 28, 31, 32, 34, 35];

  // Shows which quality "Auto" is currently on, as the HLS player does.
  function showDashAutoLevel(level) {
    const auto = qualitySelect.options[0];
    const manual = qualitySelect.value !== '-1';
    auto.textContent = !manual && level && qualitySelect.options.length > 2 ? `Auto (${dashLevelLabel(level)})` : 'Auto';
  }

  function playDash(feed) {
    const events = dashjs.MediaPlayer.events;
    dash = dashjs.MediaPlayer().create();
    dash.updateSettings({ streaming: { buffer: { fastSwitchEnabled: true } } });
    dash.on(events.STREAM_INITIALIZED, fillDashQuality);
    dash.on(events.QUALITY_CHANGE_RENDERED, (event) => {
      if (event.mediaType === 'video') showDashAutoLevel(event.newRepresentation);
    });
    dash.on(events.ERROR, (event) => {
      const code = event.error && event.error.code;
      // Other codes (subtitles, clock sync, buffer trimming) do not stop playback.
      const fatal = DASH_FATAL_CODES.includes(code) || (code >= 100 && code < 200);
      if (!fatal) return;
      stopPlayer();
      fail(code >= 100 ? 'Ce flux est protégé.' : 'Lecture impossible.');
    });
    dash.on(events.PLAYBACK_NOT_ALLOWED, () => {
      // Autoplay with sound was refused: start muted rather than not at all.
      video.muted = true;
      dash.play();
    });
    dash.on(events.PLAYBACK_ERROR, () => {
      stopPlayer();
      fail('Lecture impossible.');
    });
    dash.initialize(video, feed.playUrl, true);
  }

  function stopPlayer() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (dash) {
      dash.destroy();
      dash = null;
    }
    video.removeAttribute('src');
    video.load();
    resetQuality();
  }

  function fail(message) {
    const current = currentEntry();
    setNow('error', current ? current.feed.host : 'Erreur', message);
    setOverlay('error', 'Le flux ne répond plus', message + ' Recharge-le, ou choisis un autre flux dans la liste.', () => {
      if (current) play(current.feed, current.source);
    });
  }

  function currentEntry() {
    if (!state.current) return null;
    return allFeeds().find(({ feed }) => feed.id === state.current.feedId) || null;
  }

  function play(feed, source) {
    stopPlayer();
    recoveries = 0;
    state.current = { feedId: feed.id, key: feed.key, sourceId: source.id };
    const sub = source.title || hostOf(source.url);
    setNow('loading', feed.host, sub);
    setOverlay('loading', 'Chargement du flux…');
    reloadBtn.disabled = false;
    renderSources();

    const start = () => {
      const attempt = video.play();
      if (attempt) {
        attempt.catch(() => {
          // Autoplay with sound was refused: start muted rather than not at all.
          video.muted = true;
          video.play().catch(() => {});
        });
      }
    };

    if (feed.kind === 'hls' && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 30 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        fillQuality();
        start();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const auto = qualitySelect.options[0];
        const level = hls.levels[data.level];
        auto.textContent = hls.autoLevelEnabled && level && hls.levels.length > 1 ? `Auto (${levelLabel(level)})` : 'Auto';
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (recoveries < 3 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          recoveries++;
          hls.recoverMediaError();
        } else if (recoveries < 3 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          recoveries++;
          setTimeout(() => hls && hls.startLoad(), 1000);
        } else {
          const code = data.response && data.response.code ? ` (HTTP ${data.response.code})` : '';
          stopPlayer();
          fail(`Lecture impossible${code}.`);
        }
      });
      hls.loadSource(feed.playUrl);
      hls.attachMedia(video);
    } else if (feed.kind === 'dash') {
      loadDashLibrary().then(
        () => {
          // The user may have switched feed while the player was loading.
          if (state.current && state.current.feedId === feed.id && !dash) playDash(feed);
        },
        (err) => fail(err.message + '.'),
      );
    } else {
      // Direct files, and HLS on browsers that play it natively (Safari).
      video.src = feed.playUrl;
      start();
    }
  }

  video.addEventListener('playing', () => {
    const current = currentEntry();
    if (!current) return;
    recoveries = 0;
    setOverlay('none');
    setNow('playing', current.feed.host, current.source.title || hostOf(current.source.url));
  });
  video.addEventListener('waiting', () => {
    if (state.current && overlay.hidden) nowState.className = 'dot loading';
  });
  video.addEventListener('error', () => {
    if (!hls && !dash && state.current && video.error) fail('Lecture impossible.');
  });

  qualitySelect.addEventListener('change', () => {
    if (hls) {
      hls.currentLevel = Number(qualitySelect.value);
    } else if (dash) {
      const auto = qualitySelect.value === '-1';
      dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: auto } } } });
      if (!auto) dash.setRepresentationForTypeById('video', qualitySelect.value, true);
      showDashAutoLevel(dash.getCurrentRepresentationForType('video'));
    }
  });

  reloadBtn.addEventListener('click', () => {
    const current = currentEntry();
    if (current) play(current.feed, current.source);
  });

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.readyState > 0) await video.requestPictureInPicture();
    } catch {
      // The browser refused (no video frame yet, or PiP disabled): nothing to do.
    }
  }
  pipBtn.addEventListener('click', togglePip);
  const pipSupported = Boolean(document.pictureInPictureEnabled);
  if (!pipSupported) pipBtn.title = 'Ton navigateur ne propose pas l’image dans l’image';
  video.addEventListener('loadedmetadata', () => {
    pipBtn.disabled = !pipSupported;
  });
  video.addEventListener('emptied', () => {
    pipBtn.disabled = true;
  });
  video.addEventListener('enterpictureinpicture', () => (pipBtn.textContent = 'Quitter l’image dans l’image'));
  video.addEventListener('leavepictureinpicture', () => (pipBtn.textContent = 'Image dans l’image'));

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, select, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[1-9]$/.test(event.key)) {
      const entry = playableFeeds()[Number(event.key) - 1];
      if (entry) play(entry.feed, entry.source);
    } else if (event.key.toLowerCase() === 'p') {
      togglePip();
    } else if (event.key.toLowerCase() === 'r') {
      reloadBtn.click();
    }
  });

  // -------------------------------------------------------------- rail

  function renderSource(source, numbers) {
    const title = source.title || hostOf(source.url);
    const busy = isBusy(source);

    const head = h('div', { class: 'source-head' },
      h('div', { class: 'source-info' },
        h('div', { class: 'source-title', title }, title),
        h('div', { class: 'source-url', title: source.url }, source.url),
      ),
      h('button', {
        class: 'icon-btn', type: 'button', disabled: busy,
        title: 'Analyser la page à nouveau', 'aria-label': `Analyser à nouveau ${title}`,
        onclick: () => act(`/api/sources/${source.id}/scan`, 'POST'),
      }, icon(ICON_RESCAN)),
      h('button', {
        class: 'icon-btn', type: 'button',
        title: 'Retirer cette page', 'aria-label': `Retirer ${title}`,
        onclick: () => act(`/api/sources/${source.id}`, 'DELETE'),
      }, icon(ICON_REMOVE)),
    );

    const parts = [head];
    if (busy) {
      parts.push(h('div', { class: 'source-status' }, h('span', { class: 'spinner' }), source.step || 'Analyse…'));
    } else if (source.status === 'error') {
      parts.push(h('div', { class: 'source-status error' }, `Analyse impossible : ${source.error}`));
    } else if (source.status === 'idle') {
      parts.push(h('div', { class: 'source-status' }, 'Pas encore analysée cette fois-ci. Clique sur la flèche pour retrouver ses flux.'));
    } else if (!source.feeds.length) {
      parts.push(h('div', { class: 'source-status' },
        source.links.length
          ? 'Aucun flux sur cette page. Elle mène peut-être à d’autres pages : essaie les liens ci-dessous.'
          : 'Aucun flux trouvé sur cette page.'));
    }

    if (source.feeds.length) {
      parts.push(h('ul', { class: 'feeds' }, source.feeds.map((feed) => {
        const number = numbers.get(feed.id);
        const active = state.current && state.current.feedId === feed.id;
        return h('li', {},
          h('button', {
            class: `feed${active ? ' active' : ''}`, type: 'button',
            disabled: !isPlayable(feed),
            'aria-pressed': isPlayable(feed) ? String(Boolean(active)) : null,
            title: feed.url,
            onclick: () => play(feed, source),
          },
            h('span', { class: 'feed-key' }, number && number <= 9 ? number : '·'),
            h('span', { class: 'feed-body' },
              h('div', { class: 'feed-host' }, feed.host),
              h('div', { class: `feed-meta${feed.status === 'error' ? ' error' : ''}` }, feedMeta(feed)),
            ),
            feed.live ? h('span', { class: 'badge live' }, 'DIRECT') : null,
            h('span', { class: 'badge' }, feed.kind === 'file' ? 'MP4' : feed.kind.toUpperCase()),
          ),
        );
      })));
    }

    if (source.links.length && !busy) {
      parts.push(h('details', {
        class: 'links', open: state.openLinks.has(source.id),
        ontoggle: (event) => {
          if (event.target.open) state.openLinks.add(source.id);
          else state.openLinks.delete(source.id);
        },
      },
        h('summary', {}, `Autres liens sur cette page (${source.links.length})`),
        h('ul', {}, source.links.map((link) => h('li', { class: 'link' },
          h('div', { class: 'link-text' },
            h('div', { title: link.text }, link.text),
            h('div', { title: link.url }, hostOf(link.url)),
          ),
          h('button', { type: 'button', onclick: () => addSource(link.url).catch((err) => alert(err.message)) }, 'Analyser'),
        ))),
      ));
    }

    return h('section', { class: 'source' }, parts);
  }

  function renderSources() {
    if (!state.sources.length) {
      sourcesEl.replaceChildren(h('p', { class: 'empty' }, 'Les pages que tu ajoutes apparaissent ici, avec les flux trouvés sur chacune.'));
      return;
    }
    const numbers = new Map(playableFeeds().map(({ feed }, index) => [feed.id, index + 1]));
    const scroll = sourcesEl.scrollTop;
    sourcesEl.replaceChildren(...state.sources.map((source) => renderSource(source, numbers)));
    sourcesEl.scrollTop = scroll;
  }

  // -------------------------------------------------------------- sync

  // After a rescan the feed being watched gets a new id (and a fresh token):
  // follow it, so a rescan is also the way to revive an expired stream.
  function reconcile() {
    if (state.current) {
      if (currentEntry()) return;
      const source = state.sources.find((s) => s.id === state.current.sourceId);
      if (source && isBusy(source)) return;
      const candidates = source ? source.feeds.filter(isPlayable) : [];
      const next = candidates.find((f) => f.key === state.current.key) || candidates[0];
      if (next) return play(next, source);
      stopPlayer();
      state.current = null;
      reloadBtn.disabled = true;
      setNow('', 'Rien en lecture');
      setOverlay('idle', 'Le flux n’est plus disponible', 'Choisis un autre flux dans la liste, ou analyse la page à nouveau.');
      return;
    }
    // Nothing playing yet: start the first feed that turns up.
    const first = playableFeeds()[0];
    if (first && state.autoplay) {
      state.autoplay = false;
      play(first.feed, first.source);
    }
  }

  function apply(sources) {
    const snapshot = JSON.stringify(sources);
    const changed = snapshot !== state.snapshot;
    state.sources = sources;
    state.snapshot = snapshot;
    if (changed) {
      reconcile();
      renderSources();
    }
    clearTimeout(state.pollTimer);
    if (sources.some(isBusy)) state.pollTimer = setTimeout(refresh, 1000);
  }

  async function refresh() {
    try {
      apply((await api('/api/sources')).sources);
    } catch {
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(refresh, 3000);
    }
  }

  async function act(path, method) {
    try {
      apply((await api(path, { method })).sources);
    } catch (err) {
      alert(err.message);
    }
  }

  async function addSource(url) {
    const data = await api('/api/sources', { method: 'POST', body: JSON.stringify({ url }) });
    if (!state.current) state.autoplay = true;
    apply(data.sources);
  }

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = addUrl.value.trim();
    if (!url) return;
    try {
      await addSource(url);
      addUrl.value = '';
      addUrl.setCustomValidity('');
    } catch (err) {
      addUrl.setCustomValidity(err.message);
      addUrl.reportValidity();
    }
  });
  addUrl.addEventListener('input', () => addUrl.setCustomValidity(''));

  refresh();
})();
