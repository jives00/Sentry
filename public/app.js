'use strict';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtClock = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const h12 = h % 12 || 12;
  return `${h12}:${pad(m)}:${pad(s)} ${h < 12 ? 'AM' : 'PM'}`;
};
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const state = {
  cameras: [],
  slug: null,
  date: isoDay(new Date()),
  day: { snapshots: [], events: [] },
  pos: -1,
  playing: null,
  clip: null,
};

/* ---------- snapshots ---------- */

/** Index of the snapshot nearest to t (seconds since midnight). */
function nearest(t) {
  const s = state.day.snapshots;
  if (!s.length) return -1;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && t - s[lo - 1].t < s[lo].t - t ? lo - 1 : lo;
}

const preloaded = new Set();
function preload(from) {
  for (let i = from + 1; i < from + 6 && i < state.day.snapshots.length; i++) {
    const src = `/footage/${state.day.snapshots[i].file}`;
    if (preloaded.has(src)) continue;
    preloaded.add(src);
    new Image().src = src;
  }
}

function setCursor(t) {
  $('cursor').style.left = `${(t / 86400) * 100}%`;
}

function showSnapshot(pos) {
  const snaps = state.day.snapshots;
  if (!snaps.length) return renderEmpty();
  closeClip();
  state.pos = Math.max(0, Math.min(snaps.length - 1, pos));
  const snap = snaps[state.pos];
  $('frame').hidden = false;
  $('empty').hidden = true;
  $('frame').src = `/footage/${snap.file}`;
  $('when').textContent = `${fmtClock(snap.t)} · ${state.pos + 1} of ${snaps.length}`;
  setCursor(snap.t);
  preload(state.pos);
}

function renderEmpty() {
  $('frame').hidden = true;
  $('empty').hidden = false;
  $('when').textContent = '';
  if (!state.cameras.length) {
    $('empty').textContent = 'No cameras yet. Sentry is waiting for ring-mqtt to report the doorbell.';
  } else if (state.day.events.length) {
    $('empty').textContent = 'No snapshots this day. Pick an event below.';
  } else {
    $('empty').textContent = 'Nothing recorded on this day.';
  }
}

/* ---------- clips ---------- */

function playClip(ev) {
  stop();
  state.clip = ev;
  const v = $('clip');
  $('frame').hidden = true;
  $('empty').hidden = true;
  v.hidden = false;
  v.src = `/footage/${ev.file}`;
  v.play().catch(() => {});
  $('backToSnaps').hidden = false;
  $('when').textContent = `${fmtClock(ev.t)} · ${ev.kind === 'ding' ? 'Doorbell' : 'Motion'}`;
  setCursor(ev.t);
  renderEventList();
}

function closeClip() {
  if (!state.clip) return;
  state.clip = null;
  const v = $('clip');
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.hidden = true;
  $('backToSnaps').hidden = true;
  renderEventList();
}

$('clip').addEventListener('timeupdate', () => {
  if (state.clip) setCursor(state.clip.t + $('clip').currentTime);
});

$('backToSnaps').addEventListener('click', () => {
  const t = state.clip ? state.clip.t + $('clip').currentTime : 0;
  closeClip();
  showSnapshot(nearest(t));
});

/* ---------- playback ---------- */

function play() {
  if (!state.day.snapshots.length) return;
  closeClip();
  if (state.pos >= state.day.snapshots.length - 1) showSnapshot(0);
  const fps = Number($('speed').value);
  state.playing = setInterval(() => {
    if (state.pos >= state.day.snapshots.length - 1) return stop();
    showSnapshot(state.pos + 1);
  }, 1000 / fps);
  $('play').textContent = '❚❚';
}

function stop() {
  clearInterval(state.playing);
  state.playing = null;
  $('play').textContent = '▶';
}

$('play').addEventListener('click', () => (state.playing ? stop() : play()));
$('speed').addEventListener('change', () => {
  if (state.playing) { stop(); play(); }
  store.set('sentry-speed', $('speed').value);
});

/* ---------- timeline ---------- */

function renderTimeline() {
  $('hours').innerHTML = Array.from({ length: 24 }, (_, h) => `<span>${h % 12 || 12}${h < 12 ? 'a' : 'p'}</span>`).join('');

  // Coverage strip: one block per 10-minute bucket that has snapshots.
  const buckets = new Set(state.day.snapshots.map((s) => Math.floor(s.t / 600)));
  $('density').innerHTML = [...buckets]
    .map((b) => `<i style="left:${(b / 144) * 100}%;width:${100 / 144}%"></i>`)
    .join('');

  $('marks').innerHTML = state.day.events
    .map((e, i) => `<b class="${e.kind}" data-i="${i}" title="${fmtClock(e.t)} ${e.kind}" style="left:${(e.t / 86400) * 100}%;width:${(e.duration / 86400) * 100}%"></b>`)
    .join('');
}

function timeAt(clientX) {
  const r = $('timeline').getBoundingClientRect();
  return Math.max(0, Math.min(86399, ((clientX - r.left) / r.width) * 86400));
}

let dragging = false;
$('timeline').addEventListener('pointerdown', (e) => {
  const mark = e.target.closest('b[data-i]');
  if (mark) return playClip(state.day.events[+mark.dataset.i]);
  dragging = true;
  $('timeline').setPointerCapture(e.pointerId);
  stop();
  showSnapshot(nearest(timeAt(e.clientX)));
});
$('timeline').addEventListener('pointermove', (e) => {
  if (dragging) showSnapshot(nearest(timeAt(e.clientX)));
});
$('timeline').addEventListener('pointerup', () => (dragging = false));

/* ---------- events list ---------- */

function renderEventList() {
  const evs = state.day.events;
  $('eventCount').textContent = evs.length ? `(${evs.length})` : '';
  $('eventList').innerHTML = evs.length
    ? evs
        .map((e, i) => `<li class="${e.kind}"><button data-i="${i}" class="${state.clip && state.clip.file === e.file ? 'active' : ''}">
          <span class="dot"></span>${fmtClock(e.t)}<span class="dur">${fmtDur(e.duration)}</span></button></li>`)
        .join('')
    : '<li class="meta">No events.</li>';
}

$('eventList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) playClip(state.day.events[+b.dataset.i]);
});

/* ---------- loading ---------- */

async function loadDay({ keepPlace = false } = {}) {
  if (!state.slug) {
    state.day = { snapshots: [], events: [] };
  } else {
    try {
      state.day = await api(`/api/cameras/${state.slug}/days/${state.date}`);
    } catch {
      state.day = { snapshots: [], events: [] };
    }
  }
  renderTimeline();
  renderEventList();
  if (state.clip) return;
  const atEnd = state.pos >= state.day.snapshots.length - 2;
  if (keepPlace && !atEnd) return;
  // Today opens on the latest frame (and follows it); past days open at the first one.
  showSnapshot(state.date === isoDay(new Date()) ? state.day.snapshots.length - 1 : 0);
}

function setDate(iso) {
  const today = isoDay(new Date());
  state.date = iso > today ? today : iso;
  $('date').value = state.date;
  $('date').max = today;
  stop();
  closeClip();
  state.pos = -1;
  loadDay();
}

function shiftDay(n) {
  const [y, m, d] = state.date.split('-').map(Number);
  setDate(isoDay(new Date(y, m - 1, d + n)));
}

$('date').addEventListener('change', () => $('date').value && setDate($('date').value));
$('prevDay').addEventListener('click', () => shiftDay(-1));
$('nextDay').addEventListener('click', () => shiftDay(1));
$('camera').addEventListener('change', () => {
  state.slug = $('camera').value;
  store.set('sentry-camera', state.slug);
  setDate(state.date);
});

async function refreshStatus() {
  const dot = $('status');
  try {
    const s = await api('/api/status');
    state.cameras = s.cameras.filter((c) => c.enabled);
    const cam = state.cameras.find((c) => c.slug === state.slug);
    const issues = [];
    if (!s.mqtt) issues.push('Not connected to MQTT');
    if (cam && cam.online === false) issues.push(`${cam.name} is offline`);
    if (cam && cam.error) issues.push(cam.error);
    dot.className = `status ${cam && cam.recording ? 'rec' : issues.length ? 'bad' : 'ok'}`;
    dot.textContent = cam && cam.recording ? '● Recording' : issues.length ? '● Problem' : '●';
    const lastSnap = cam && cam.lastSnapshot ? `Last snapshot ${new Date(cam.lastSnapshot).toLocaleTimeString()}` : 'No snapshots yet';
    dot.title = [...issues, lastSnap].join('\n');
    return s;
  } catch {
    dot.className = 'status bad';
    dot.textContent = '● Offline';
    dot.title = "Can't reach the Sentry server";
    return null;
  }
}

function renderCameraPicker() {
  const sel = $('camera');
  sel.innerHTML = state.cameras.map((c) => `<option value="${c.slug}">${escapeHtml(c.name)}</option>`).join('');
  sel.hidden = state.cameras.length < 2;
  if (!state.cameras.some((c) => c.slug === state.slug)) state.slug = state.cameras[0] ? state.cameras[0].slug : null;
  sel.value = state.slug || '';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- settings ---------- */

let settingsCache = null;
$('openSettings').addEventListener('click', async () => {
  settingsCache = await api('/api/settings');
  const f = $('settingsForm');
  for (const k of ['snapshotDays', 'eventDays', 'snapshotInterval', 'postRoll']) f.elements[k].value = settingsCache[k];
  const rows = Object.entries(settingsCache.cameras);
  $('cameraRows').innerHTML = rows.length
    ? rows
        .map(([id, c]) => `<div class="camrow"><input type="checkbox" data-id="${id}" data-f="enabled" ${c.enabled ? 'checked' : ''} title="Record this camera">
          <input type="text" data-id="${id}" data-f="name" value="${escapeHtml(c.name)}" maxlength="60" required><code>${c.slug}/</code></div>`)
        .join('')
    : '<p class="meta">None yet.</p>';
  $('settingsError').hidden = true;
  $('settings').showModal();
});

$('settingsForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'save') return;
  e.preventDefault();
  const f = $('settingsForm');
  const next = structuredClone(settingsCache);
  for (const k of ['snapshotDays', 'eventDays', 'snapshotInterval', 'postRoll']) next[k] = Number(f.elements[k].value);
  for (const el of $('cameraRows').querySelectorAll('[data-id]')) {
    next.cameras[el.dataset.id][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  try {
    await api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
    $('settings').close();
    await refreshStatus();
    renderCameraPicker();
    loadDay({ keepPlace: true });
  } catch (err) {
    $('settingsError').textContent = err.message;
    $('settingsError').hidden = false;
  }
});

/* ---------- keys ---------- */

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || $('settings').open) return;
  if (e.key === 'ArrowRight') { stop(); showSnapshot(state.pos + (e.shiftKey ? 10 : 1)); }
  else if (e.key === 'ArrowLeft') { stop(); showSnapshot(state.pos - (e.shiftKey ? 10 : 1)); }
  else if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); }
  else if (e.key === '[') shiftDay(-1);
  else if (e.key === ']') shiftDay(1);
  else if (e.key === 'Escape' && state.clip) $('backToSnaps').click();
  else return;
});

/* ---------- start ---------- */

(async function start() {
  const speed = store.get('sentry-speed');
  if (speed) $('speed').value = speed;
  state.slug = store.get('sentry-camera');
  await refreshStatus();
  renderCameraPicker();
  setDate(state.date);

  setInterval(async () => {
    const before = state.cameras.map((c) => c.slug).join();
    await refreshStatus();
    if (state.cameras.map((c) => c.slug).join() !== before) {
      renderCameraPicker();
      loadDay();
    }
  }, 15_000);
  // Today keeps growing; pick up new snapshots and events without losing your place.
  setInterval(() => {
    if (state.date === isoDay(new Date()) && !state.playing) loadDay({ keepPlace: true });
  }, 30_000);
})();
