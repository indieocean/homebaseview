'use strict'

const $ = (sel) => document.querySelector(sel)
// Present when running inside the HomeBaseView menu bar app (WKWebView).
const native = window.webkit?.messageHandlers?.homebaseview ?? null
const nativeCall = async (msg) => {
  if (!native) return null
  try { return await native.postMessage(msg) } catch { return null }
}

// ---------------------------------------------------------------------------
// Preferences (per browser; mirrored to the menu bar app for notifications)
// ---------------------------------------------------------------------------
const prefs = (() => {
  const defaults = { notify: true, notifyMotion: true, refresh: 30, lastSeenSeq: 0, layout: 'grid' }
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('homebaseview-prefs') || '{}') } } catch { return defaults }
})()
function savePrefs() {
  try { localStorage.setItem('homebaseview-prefs', JSON.stringify(prefs)) } catch { /* private mode */ }
  nativeCall({ type: 'prefs', notify: prefs.notify, notifyMotion: prefs.notifyMotion })
}

const state = {
  cameras: new Map(),
  events: [],
  tab: 'cameras',
  snapshotAt: new Map(),
  player: null, // { mode: 'live' | 'clip', cameraId, hls, event }
  source: null,
  snapTimer: null,
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
class Unauthorized extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) { show('locked'); throw new Unauthorized() }
  const data = await res.json().catch(() => ({}))
  if (!res.ok && !('success' in data) && !('ok' in data)) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status })
  return data
}

function show(view) {
  for (const v of ['locked', 'login', 'main']) $(`#view-${v}`).hidden = v !== view
  if (view !== 'main') closePlayer()
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let health
  try { health = await api('/health') } catch (e) { if (!(e instanceof Unauthorized)) setTimeout(boot, 2000); return }
  savePrefs()
  if (health.authenticated) return enterMain()
  showLogin(health.authExpired ? 'Your Ring session expired. Sign in again.' : null)
}

function showLogin(note) {
  show('login')
  $('#login-form').hidden = false
  $('#code-form').hidden = true
  if (note) { $('#login-error').textContent = note; $('#login-error').hidden = false }
  $('#login-form [name=email]').focus()
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const form = ev.currentTarget
  const btn = form.querySelector('button')
  $('#login-error').hidden = true
  btn.disabled = true
  btn.textContent = 'Signing in…'
  try {
    const r = await api('/auth/start', { method: 'POST', body: { email: form.email.value, password: form.password.value } })
    if (r.success) { form.password.value = ''; return enterMain() }
    if (r.requiresTwoFactor) {
      form.password.value = ''
      $('#login-form').hidden = true
      $('#code-form').hidden = false
      $('#code-form').dataset.session = r.sessionId
      $('#code-prompt').textContent = r.prompt
      $('#code-form [name=code]').focus()
      return
    }
    $('#login-error').textContent = r.error || 'Sign-in failed.'
    $('#login-error').hidden = false
  } catch (e) {
    if (!(e instanceof Unauthorized)) { $('#login-error').textContent = e.message; $('#login-error').hidden = false }
  } finally {
    btn.disabled = false
    btn.textContent = 'Sign in'
  }
})

$('#code-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const form = ev.currentTarget
  const btn = form.querySelector('button.primary')
  $('#code-error').hidden = true
  btn.disabled = true
  try {
    const r = await api('/auth/verify', { method: 'POST', body: { sessionId: form.dataset.session, code: form.code.value } })
    if (r.success) { form.code.value = ''; return enterMain() }
    $('#code-error').textContent = r.error
    $('#code-error').hidden = false
    if (/start again/i.test(r.error)) setTimeout(() => showLogin(), 1500)
  } catch (e) {
    if (!(e instanceof Unauthorized)) { $('#code-error').textContent = e.message; $('#code-error').hidden = false }
  } finally {
    btn.disabled = false
  }
})
$('#code-back').addEventListener('click', () => showLogin())

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
async function enterMain() {
  show('main')
  $('#banner').hidden = true
  await Promise.all([loadCameras(), loadEvents()])
  connectStream()
  restartSnapshotTimer()
}

async function loadCameras() {
  const list = await api('/cameras')
  state.cameras = new Map(list.map((c) => [c.id, c]))
  renderGrid()
  renderCameraFilter()
}

async function loadEvents() {
  state.events = await api('/events')
  renderActivity()
}

function connectStream() {
  if (state.source) state.source.close()
  const es = new EventSource('/api/events/stream')
  state.source = es
  es.addEventListener('camera', (m) => {
    const cam = JSON.parse(m.data)
    state.cameras.set(cam.id, cam)
    renderTile(cam)
    if (state.player?.mode === 'live' && state.player.cameraId === cam.id) renderLiveControls()
  })
  es.addEventListener('ring-event', (m) => {
    const e = JSON.parse(m.data)
    if (state.events.some((x) => x.seq === e.seq)) return
    state.events.unshift(e)
    renderActivity()
    if (state.player?.cameraId === e.cameraId) renderRecent()
    notify(e)
    refreshSnapshot(e.cameraId)
  })
  es.addEventListener('auth', (m) => {
    const a = JSON.parse(m.data)
    if (a.authExpired) showBanner('Ring signed this Mac out. Sign in again to keep watching.', 'Sign in', () => showLogin())
    else if (!a.authenticated) showLogin()
    else if ($('#view-main').hidden) enterMain()
  })
  es.onerror = () => {
    // EventSource reconnects by itself; check whether we lost auth or the server.
    api('/health').then((h) => { if (!h.authenticated && !h.authExpired) showLogin() }).catch(() => {})
  }
}

function showBanner(text, action, onAction) {
  const b = $('#banner')
  b.textContent = text
  if (action) {
    const btn = document.createElement('button')
    btn.className = 'link'
    btn.textContent = action
    btn.onclick = onAction
    b.append(btn)
  }
  b.hidden = false
}

// Tabs
for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => setTab(btn.dataset.tab))
}
function setTab(tab) {
  state.tab = tab
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  $('#tab-cameras').hidden = tab !== 'cameras'
  $('#tab-activity').hidden = tab !== 'activity'
  if (tab === 'activity') markEventsSeen()
}

// ---------------------------------------------------------------------------
// Camera grid
// ---------------------------------------------------------------------------
const ICONS = {
  motion: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4"/></svg>',
  ding: '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  battery: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  package: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M5 17h14v-5l-2-5H7l-2 5v5ZM5 12h14"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
}

function renderGrid() {
  const grid = $('#camera-grid')
  grid.replaceChildren()
  for (const cam of state.cameras.values()) {
    const tile = document.createElement('button')
    tile.className = 'tile'
    tile.dataset.id = cam.id
    tile.innerHTML = `
      <img class="thumb" alt="">
      <div class="chips"></div>
      <span class="battery" hidden></span>
      <span class="play"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg></span>
      <div class="caption"><span class="name"></span><span class="age"></span></div>`
    tile.addEventListener('click', () => openLive(cam.id))
    grid.append(tile)
    renderTile(cam)
    refreshSnapshot(cam.id)
  }
  $('#no-cameras').hidden = state.cameras.size > 0
}

function renderTile(cam) {
  const tile = document.querySelector(`.tile[data-id="${cam.id}"]`)
  if (!tile) return
  tile.querySelector('.name').textContent = cam.name
  const chips = []
  tile.classList.toggle('offline', !!cam.isOffline)
  if (cam.motionActive) chips.push('<span class="chip motion">Motion</span>')
  if (cam.streaming) chips.push('<span class="chip live">Live</span>')
  if (cam.isOffline) chips.push('<span class="chip">Offline</span>')
  if (!cam.motionDetectionEnabled) chips.push('<span class="chip">Motion off</span>')
  if (cam.lightOn) chips.push('<span class="chip light">Light on</span>')
  if (cam.sirenOn) chips.push('<span class="chip motion">Siren</span>')
  tile.querySelector('.chips').innerHTML = chips.join('')
  const battery = tile.querySelector('.battery')
  battery.hidden = !(cam.hasBattery && cam.batteryLevel != null)
  battery.classList.toggle('low', !!cam.hasLowBattery)
  battery.innerHTML = battery.hidden ? '' : `${cam.isCharging ? ICONS.bolt : ICONS.battery}${cam.batteryLevel}%`
  updateAge(cam.id)
}

function snapshotUrl(id, fresh = false) {
  return `/api/cameras/${id}/snapshot?t=${Date.now()}${fresh ? '&fresh=1' : ''}`
}

const snapLoading = new Set()
function refreshSnapshot(id) {
  if (snapLoading.has(id)) return
  snapLoading.add(id)
  // Load off-screen first so the tile never flashes blank.
  const img = new Image()
  img.onload = () => {
    snapLoading.delete(id)
    const tile = document.querySelector(`.tile[data-id="${id}"]`)
    if (tile) { tile.querySelector('.thumb').src = img.src; tile.classList.add('loaded') }
    state.snapshotAt.set(id, Date.now())
    updateAge(id)
  }
  img.onerror = () => {
    snapLoading.delete(id)
    document.querySelector(`.tile[data-id="${id}"]`)?.classList.add('loaded') // stop the shimmer
  }
  img.src = snapshotUrl(id)
}

function updateAge(id) {
  const el = document.querySelector(`.tile[data-id="${id}"] .age`)
  const t = state.snapshotAt.get(id)
  const cam = state.cameras.get(id)
  if (el) el.textContent = cam?.isOffline ? 'Camera offline' : t ? `Updated ${relTime(t)}` : 'Loading…'
}

function restartSnapshotTimer() {
  clearInterval(state.snapTimer)
  state.snapTimer = null
  if (!prefs.refresh) return
  state.snapTimer = setInterval(() => {
    if (document.hidden || state.player) return
    for (const id of state.cameras.keys()) refreshSnapshot(id)
  }, prefs.refresh * 1000)
}
setInterval(() => { for (const id of state.cameras.keys()) updateAge(id) }, 15_000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#view-main').hidden && !state.player) {
    for (const [id, t] of state.snapshotAt) if (Date.now() - t > 10_000) refreshSnapshot(id)
  }
})

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
function renderCameraFilter() {
  const sel = $('#filter-camera')
  const current = sel.value
  sel.replaceChildren(new Option('All cameras', ''))
  for (const c of state.cameras.values()) sel.append(new Option(c.name, c.id))
  sel.value = current
}
$('#filter-camera').addEventListener('change', renderActivity)
$('#filter-kind').addEventListener('change', renderActivity)

function eventLabel(e) {
  if (e.kind === 'ding') return 'Doorbell pressed'
  const d = (e.detection || '').replace(/_/g, ' ')
  if (/human|person/.test(d)) return 'Person detected'
  if (/package/.test(d)) return 'Package activity'
  if (/vehicle/.test(d)) return 'Vehicle detected'
  if (/animal/.test(d)) return 'Animal detected'
  return 'Motion'
}

function renderActivity() {
  const camFilter = $('#filter-camera').value
  const kindFilter = $('#filter-kind').value
  const list = state.events.filter((e) => (!camFilter || String(e.cameraId) === camFilter) && (!kindFilter || e.kind === kindFilter))
  const ul = $('#activity-list')
  ul.replaceChildren()
  let lastDay = ''
  for (const e of list) {
    const day = dayLabel(e.timestamp)
    if (day !== lastDay) {
      const li = document.createElement('li')
      li.className = 'day'
      li.textContent = day
      ul.append(li)
      lastDay = day
    }
    ul.append(eventItem(e))
  }
  $('#no-activity').hidden = list.length > 0
  if (state.tab === 'activity' && !document.hidden) markEventsSeen()
  updateBadge()
}

function eventIcon(e) {
  if (e.kind === 'ding') return ['ding', ICONS.ding]
  const d = e.detection || ''
  if (/human|person/.test(d)) return ['person', ICONS.person]
  if (/package/.test(d)) return ['', ICONS.package]
  if (/vehicle/.test(d)) return ['', ICONS.car]
  return ['', ICONS.motion]
}

function eventItem(e, { showCamera = true } = {}) {
  const li = document.createElement('li')
  const btn = document.createElement('button')
  const [cls, icon] = eventIcon(e)
  btn.innerHTML = `
    <span class="kind ${cls}">${icon}</span>
    <span class="what"><b></b><small></small></span>
    <span class="when"><b></b><span></span></span>
    ${e.seq > prefs.lastSeenSeq ? '<span class="new"></span>' : ICONS.chev}`
  btn.querySelector('.what b').textContent = eventLabel(e)
  btn.querySelector('.what small').textContent = showCamera ? e.cameraName : 'Tap to play recording'
  btn.querySelector('.when b').textContent = new Date(e.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  btn.querySelector('.when span').textContent = relTime(Date.parse(e.timestamp))
  btn.addEventListener('click', () => openClip(e))
  li.append(btn)
  return li
}

function renderRecent() {
  const p = state.player
  if (!p) return
  const list = state.events.filter((e) => e.cameraId === p.cameraId && e.id !== p.event?.id).slice(0, 8)
  $('#recent-list').replaceChildren(...list.map((e) => eventItem(e, { showCamera: false })))
  $('#recent-empty').hidden = list.length > 0
}

function markEventsSeen() {
  const max = state.events.reduce((m, e) => Math.max(m, e.seq), 0)
  if (max > prefs.lastSeenSeq) { prefs.lastSeenSeq = max; savePrefs() }
  updateBadge()
}

function updateBadge() {
  const n = state.events.filter((e) => e.seq > prefs.lastSeenSeq).length
  $('#activity-badge').hidden = n === 0
  $('#activity-badge').textContent = n > 99 ? '99+' : n
}

// ---------------------------------------------------------------------------
// Notifications (browser only; the menu bar app posts native notifications)
// ---------------------------------------------------------------------------
function notify(e) {
  if (native || !prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return
  if (e.kind === 'motion' && !prefs.notifyMotion) return
  const n = new Notification(`${e.cameraName}`, { body: eventLabel(e), icon: snapshotUrl(e.cameraId), tag: e.id })
  n.onclick = () => { window.focus(); openLive(e.cameraId); n.close() }
}

// ---------------------------------------------------------------------------
// Player: live view and recorded clips
// ---------------------------------------------------------------------------
const video = $('#video')

function setStatus(text, { spinner = true } = {}) {
  const el = $('#video-status')
  el.querySelector('.text').textContent = text || ''
  el.classList.toggle('show', !!text)
  el.classList.toggle('idle', !spinner)
}
function setPlayerError(text) { $('#player-error').textContent = text || ''; $('#player-error').hidden = !text }

async function openLive(cameraId) {
  const cam = state.cameras.get(cameraId)
  if (!cam) return
  closePlayer()
  state.player = { mode: 'live', cameraId, hls: null, token: Symbol('live') }
  const token = state.player.token
  $('#player').hidden = false
  $('#player-name').textContent = cam.name
  $('#player-sub').textContent = 'Live view'
  $('#live-dot').hidden = true
  $('#live-controls').hidden = false
  video.controls = false
  video.muted = true
  video.poster = document.querySelector(`.tile[data-id="${cameraId}"] .thumb`)?.src || ''
  setPlayerError('')
  renderLiveControls()
  renderRecent()
  setStatus(cam.isOffline ? 'Camera reports offline. Trying anyway…' : 'Connecting to camera…')

  try {
    await api(`/cameras/${cameraId}/live/start`, { method: 'POST' })
    const playlist = `/api/cameras/${cameraId}/live/stream.m3u8`
    // FFmpeg needs a couple of seconds to write the first segments.
    for (let i = 0; i < 60; i++) {
      if (state.player?.token !== token) return
      const r = await fetch(playlist, { credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 200) break
      if (r.status === 404) throw new Error('The camera ended the session.')
      await sleep(500)
    }
    if (state.player?.token !== token) return
    attachHls(playlist, token)
  } catch (e) {
    if (state.player?.token !== token) return
    setStatus('')
    setPlayerError(`Live view failed. ${e.message || ''}`)
    addRetry()
  }
}

function attachHls(src, token) {
  if (window.Hls?.isSupported()) {
    const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 4, maxBufferLength: 6, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6 })
    state.player.hls = hls
    hls.on(Hls.Events.ERROR, (_ev, data) => {
      if (!data.fatal || state.player?.token !== token) return
      setStatus('')
      setPlayerError('Live view ended.')
      $('#live-dot').hidden = true
      addRetry()
      hls.destroy()
    })
    hls.loadSource(src)
    hls.attachMedia(video)
  } else {
    video.src = src // Safari plays HLS natively
  }
  video.play().catch(() => {})
}

video.addEventListener('playing', () => {
  setStatus('')
  if (state.player?.mode === 'live') $('#live-dot').hidden = false
})
video.addEventListener('waiting', () => { if (state.player?.mode === 'live') setStatus('Buffering…') })

function addRetry() {
  const p = $('#player-error')
  const btn = document.createElement('button')
  btn.className = 'link'
  btn.textContent = 'Try again'
  btn.onclick = () => openLive(state.player.cameraId)
  p.append(' ', btn)
  p.hidden = false
}

async function openClip(event) {
  closePlayer()
  state.player = { mode: 'clip', cameraId: event.cameraId, event, token: Symbol('clip') }
  const token = state.player.token
  $('#player').hidden = false
  $('#player-name').textContent = `${event.cameraName} · ${eventLabel(event)}`
  $('#player-sub').textContent = new Date(event.timestamp).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' })
  $('#live-dot').hidden = true
  $('#live-controls').hidden = true
  setPlayerError('')
  renderRecent()
  setStatus('Loading recording…')
  video.poster = ''
  try {
    const { url, error } = await fetch(`/api/events/${encodeURIComponent(event.id)}/recording`, { credentials: 'same-origin' }).then((r) => r.json())
    if (state.player?.token !== token) return
    if (!url) throw new Error(error || 'No recording available.')
    video.controls = true
    video.muted = false
    video.src = url
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}) })
  } catch (e) {
    if (state.player?.token !== token) return
    setStatus('')
    setPlayerError(e.message)
  }
}

function closePlayer() {
  const p = state.player
  if (!p) return
  state.player = null
  if (p.hls) p.hls.destroy()
  video.pause()
  video.removeAttribute('src')
  video.load()
  if (p.mode === 'live') {
    if (p.talking) fetch(`/api/cameras/${p.cameraId}/talk/stop`, { method: 'POST', credentials: 'same-origin' })
    fetch(`/api/cameras/${p.cameraId}/live/stop`, { method: 'POST', credentials: 'same-origin', keepalive: true })
    setTimeout(() => refreshSnapshot(p.cameraId), 1500)
  }
  $('#player').hidden = true
}
$('#player-close').addEventListener('click', closePlayer)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.player && !$('#settings').open) closePlayer() })
window.addEventListener('pagehide', closePlayer)

function renderLiveControls() {
  const p = state.player
  if (p?.mode !== 'live') return
  const cam = state.cameras.get(p.cameraId)
  $('#ctl-audio').classList.toggle('active', !video.muted)
  $('#ctl-talk').classList.toggle('active', !!p.talking)
  $('#ctl-light').hidden = !cam.hasLight
  $('#ctl-light').classList.toggle('active', cam.lightOn)
  $('#ctl-siren').hidden = !cam.hasSiren
  $('#ctl-siren').classList.toggle('active', cam.sirenOn)
  $('#ctl-motion').classList.toggle('active', cam.motionDetectionEnabled)
}

$('#ctl-audio').addEventListener('click', () => {
  video.muted = !video.muted
  renderLiveControls()
})

$('#ctl-talk').addEventListener('click', async () => {
  const p = state.player
  if (p?.mode !== 'live') return
  const btn = $('#ctl-talk')
  btn.classList.add('busy')
  setPlayerError('')
  try {
    if (p.talking) {
      await api(`/cameras/${p.cameraId}/talk/stop`, { method: 'POST' })
      p.talking = false
    } else {
      if (native) {
        const granted = await nativeCall({ type: 'requestMic' })
        if (granted === false) throw new Error('Microphone access is blocked. Allow HomeBaseView in System Settings > Privacy & Security > Microphone.')
      }
      const r = await api(`/cameras/${p.cameraId}/talk/start`, { method: 'POST' })
      if (!r.ok) throw new Error(r.error)
      p.talking = true
      // Hearing yourself through the camera causes echo, so lower the volume while talking.
      video.volume = 0.3
    }
  } catch (e) {
    if (!(e instanceof Unauthorized)) setPlayerError(e.message)
  } finally {
    if (!p.talking) video.volume = 1
    btn.classList.remove('busy')
    renderLiveControls()
  }
})

async function cameraAction(btn, path, body, apply) {
  const p = state.player
  if (!p) return
  btn.classList.add('busy')
  setPlayerError('')
  try {
    const r = await api(`/cameras/${p.cameraId}/${path}`, { method: 'POST', body })
    if (r.success === false || r.error) throw new Error(r.error || 'Request failed')
    const cam = state.cameras.get(p.cameraId)
    apply(cam)
    renderTile(cam)
  } catch (e) {
    if (!(e instanceof Unauthorized)) setPlayerError(e.message === 'Ring request failed' ? 'Ring did not accept that change.' : e.message)
  } finally {
    btn.classList.remove('busy')
    renderLiveControls()
  }
}

$('#ctl-light').addEventListener('click', (ev) => {
  const cam = state.cameras.get(state.player.cameraId)
  cameraAction(ev.currentTarget, 'light', { on: !cam.lightOn }, (c) => { c.lightOn = !c.lightOn })
})
$('#ctl-siren').addEventListener('click', (ev) => {
  const cam = state.cameras.get(state.player.cameraId)
  if (!cam.sirenOn && !confirm(`Sound the siren on ${cam.name}?`)) return
  cameraAction(ev.currentTarget, 'siren', { on: !cam.sirenOn }, (c) => { c.sirenOn = !c.sirenOn })
})
$('#ctl-motion').addEventListener('click', (ev) => {
  const cam = state.cameras.get(state.player.cameraId)
  cameraAction(ev.currentTarget, 'motion-detection', { enabled: !cam.motionDetectionEnabled }, (c) => { c.motionDetectionEnabled = !c.motionDetectionEnabled })
})
$('#ctl-snap').addEventListener('click', () => {
  const p = state.player
  if (!p) return
  const cam = state.cameras.get(p.cameraId)
  // Grab the current video frame when live; fall back to Ring's still.
  if (video.videoWidth) {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    canvas.toBlob((blob) => download(URL.createObjectURL(blob), cam.name), 'image/jpeg', 0.92)
  } else {
    download(snapshotUrl(p.cameraId, true), cam.name)
  }
})

function download(href, name) {
  const a = document.createElement('a')
  a.href = href
  a.download = `${name} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg`
  a.click()
}

// ---------------------------------------------------------------------------
// Layout and window
// ---------------------------------------------------------------------------
function applyLayout() { document.body.classList.toggle('layout-large', prefs.layout === 'large') }
$('#layout-btn').addEventListener('click', () => {
  prefs.layout = prefs.layout === 'large' ? 'grid' : 'large'
  savePrefs()
  applyLayout()
})
applyLayout()
if (native) {
  $('#window-btn').hidden = false
  $('#window-btn').addEventListener('click', () => nativeCall({ type: 'openWindow' }))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
$('#settings-btn').addEventListener('click', () => {
  $('#set-notify').checked = prefs.notify
  $('#set-notify-motion').checked = prefs.notifyMotion
  $('#set-refresh').value = String(prefs.refresh)
  const n = state.cameras.size
  $('#account-line').textContent = `Connected to Ring · ${n} camera${n === 1 ? '' : 's'}`
  $('#settings').showModal()
})
$('#set-notify').addEventListener('change', async (e) => {
  prefs.notify = e.target.checked
  if (prefs.notify && !native && 'Notification' in window && Notification.permission === 'default') {
    prefs.notify = (await Notification.requestPermission()) === 'granted'
    e.target.checked = prefs.notify
  }
  savePrefs()
})
$('#set-notify-motion').addEventListener('change', (e) => { prefs.notifyMotion = e.target.checked; savePrefs() })
$('#set-refresh').addEventListener('change', (e) => { prefs.refresh = Number(e.target.value); savePrefs(); restartSnapshotTimer() })
$('#signout-btn').addEventListener('click', async () => {
  if (!confirm('Sign out of Ring on this Mac?')) return
  $('#settings').close()
  state.source?.close()
  await api('/auth/signout', { method: 'POST' }).catch(() => {})
  state.cameras.clear()
  state.events = []
  showLogin()
})

// ---------------------------------------------------------------------------
// Hooks for the menu bar app
// ---------------------------------------------------------------------------
window.homebaseview = {
  openCamera: (id) => { if (!$('#view-main').hidden) { setTab('cameras'); openLive(Number(id)) } },
  showActivity: () => { closePlayer(); setTab('activity') },
  /** Called when the popover closes: stop streaming so the camera (and battery) can rest. */
  hidden: () => closePlayer(),
  shown: () => { for (const id of state.cameras.keys()) refreshSnapshot(id) },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

if (native) $('#notify-row').querySelector('small').textContent = 'Shown by the menu bar app'
boot()
