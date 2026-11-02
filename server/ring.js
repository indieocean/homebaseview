import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { RingApi } from 'ring-client-api'
import { RingRestClient } from 'ring-client-api/rest-client'
import ffmpegPath from 'ffmpeg-for-homebridge'
import { config } from './config.js'
import { readTextFile, removeFile, writePrivateFile } from './fsutil.js'

/**
 * Emits:
 *   'event'   (event)        a new motion / doorbell event
 *   'camera'  (cameraInfo)   a camera's status changed
 *   'auth'    ({ authenticated, authExpired })
 */
export const bus = new EventEmitter()
bus.setMaxListeners(50)

let api = null
let cameras = []
let authExpired = false
let connected = false // true once the camera list has loaded, not merely when a token exists
let subscriptions = []
let pollTimer = null
let pollInFlight = null
const lastSeenEventAt = new Map() // cameraId -> ISO time of newest history event processed
const motionActiveUntil = new Map() // cameraId -> epoch ms

// ---------------------------------------------------------------------------
// Event log (persisted so the activity list survives restarts)
// ---------------------------------------------------------------------------

let events = loadEvents()
let eventSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
let saveTimer = null

function loadEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.eventsPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { writePrivateFile(config.eventsPath, JSON.stringify(events)) } catch (e) { console.error('[events] save failed:', e.message) }
  }, 1000)
}

function pruneEvents() {
  const cutoff = Date.now() - config.eventRetentionHours * 3600_000
  events = events.filter((e) => Date.parse(e.timestamp) >= cutoff).slice(0, 500)
}

/**
 * Record an event. Push notifications and history polling report the same
 * event, so anything of the same kind on the same camera within 90 s merges.
 */
function recordEvent({ camera, kind, timestamp, dingId, detection, hasRecording = false }, { notify }) {
  const t = Date.parse(timestamp)
  const existing = events.find(
    (e) => e.cameraId === camera.id && e.kind === kind &&
      ((dingId && e.dingId === dingId) || Math.abs(Date.parse(e.timestamp) - t) < 90_000),
  )
  if (existing) {
    if (dingId && !existing.dingId) existing.dingId = dingId
    if (hasRecording) existing.hasRecording = true
    if (detection && !existing.detection) existing.detection = detection
    scheduleSave()
    return null
  }
  const event = {
    seq: ++eventSeq,
    id: dingId || crypto.randomUUID(),
    dingId: dingId || null,
    cameraId: camera.id,
    cameraName: camera.name,
    kind, // 'motion' | 'ding'
    detection: detection || null, // e.g. 'human', 'package_delivery'
    timestamp: new Date(t).toISOString(),
    hasRecording,
  }
  events.unshift(event)
  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
  pruneEvents()
  scheduleSave()

  if (notify) {
    if (kind === 'motion') {
      motionActiveUntil.set(camera.id, Date.now() + 15_000)
      setTimeout(() => bus.emit('camera', cameraInfo(camera)), 15_100)
    }
    console.log(`[events] ${kind}${detection ? ` (${detection})` : ''} on camera ${camera.id}`)
    bus.emit('event', event)
    bus.emit('camera', cameraInfo(camera))
  }
  return event
}

export function getEvents({ after = 0 } = {}) {
  pruneEvents()
  return events.filter((e) => e.seq > after)
}

export function getEvent(id) {
  return events.find((e) => e.id === id)
}

// ---------------------------------------------------------------------------
// Ring connection
// ---------------------------------------------------------------------------

function looksLikeAuthError(message = '') {
  const m = message.toLowerCase()
  return ['invalid_grant', 'unauthorized', '401', 'refresh token', 'token is expired', 'authentication failed']
    .some((s) => m.includes(s))
}

function markAuthExpired() {
  if (authExpired) return
  authExpired = true
  console.error('[ring] Ring rejected the saved session. Sign in again.')
  bus.emit('auth', authStatus())
}

export function authStatus() {
  return {
    authenticated: api !== null && connected && !authExpired,
    connecting: api !== null && !connected && !authExpired,
    authExpired,
    hasToken: !!readTextFile(config.ringTokenPath),
  }
}

function saveRingToken(token) {
  writePrivateFile(config.ringTokenPath, token)
  console.log('[ring] Refresh token saved')
}

export async function initRing() {
  const refreshToken = readTextFile(config.ringTokenPath)
  if (!refreshToken) {
    console.log('[ring] Not signed in yet. Waiting for sign-in from the UI.')
    return
  }
  teardownRing()

  api = new RingApi({
    refreshToken,
    controlCenterDisplayName: config.clientName,
    cameraStatusPollingSeconds: config.cameraStatusPollingSeconds,
    ffmpegPath,
    debug: config.verbose,
  })
  subscriptions.push(api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveRingToken(newRefreshToken)))

  try {
    cameras = await api.getCameras()
  } catch (err) {
    if (looksLikeAuthError(err?.message)) markAuthExpired()
    throw err
  }
  authExpired = false
  connected = true
  console.log(`[ring] Connected. ${cameras.length} camera(s).`)

  for (const cam of cameras) {
    // Status changes (battery, light, siren, settings) from Ring's polling.
    subscriptions.push(cam.onData.subscribe(() => bus.emit('camera', cameraInfo(cam))))

    // Real-time push (FCM). Fast when it works; history polling below is the backup.
    subscriptions.push(cam.onNewNotification.subscribe((n) => {
      const category = n?.android_config?.category ?? ''
      const kind = category.includes('ding') ? 'ding' : category.includes('motion') ? 'motion' : null
      if (!kind) return
      const ding = n?.data?.event?.ding
      recordEvent({
        camera: cam,
        kind,
        timestamp: ding?.created_at || new Date().toISOString(),
        dingId: ding?.id ? String(ding.id) : undefined,
        detection: ding?.detection_type || (ding?.subtype && ding.subtype !== kind ? ding.subtype : undefined),
      }, { notify: true })
    }))
  }

  await backfillHistory()
  pollTimer = setInterval(() => {
    if (!pollInFlight) pollInFlight = pollHistory().finally(() => { pollInFlight = null })
  }, config.eventPollMs)

  bus.emit('auth', authStatus())
}

function teardownRing() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  for (const s of subscriptions) { try { s.unsubscribe() } catch { /* ignore */ } }
  subscriptions = []
  if (api) { try { api.disconnect() } catch { /* ignore */ } }
  api = null
  connected = false
  cameras = []
  lastSeenEventAt.clear()
}

function historyKind(e) {
  if (e.kind === 'ding') return 'ding'
  if (e.kind === 'motion') return 'motion'
  return null // on_demand (someone opened live view), alarm, etc.
}

/** Load the last 24 h from Ring so the activity log is populated on launch. */
async function backfillHistory() {
  for (const cam of cameras) {
    try {
      const { events: list } = await cam.getEvents({ limit: 50 })
      for (const e of list) {
        const kind = historyKind(e)
        if (!kind) continue
        recordEvent({
          camera: cam, kind, timestamp: e.created_at, dingId: e.ding_id_str,
          hasRecording: e.recording_status === 'ready' || e.recording_status === 'audio_ready',
        }, { notify: false })
      }
      lastSeenEventAt.set(cam.id, list[0]?.created_at ?? new Date().toISOString())
    } catch (err) {
      console.error(`[events] history load failed for camera ${cam.id}:`, err.message)
      if (looksLikeAuthError(err?.message)) markAuthExpired()
    }
  }
}

async function pollHistory() {
  for (const cam of cameras) {
    try {
      const { events: list } = await cam.getEvents({ limit: 10 })
      const since = lastSeenEventAt.get(cam.id) ?? new Date().toISOString()
      for (const e of [...list].reverse()) {
        const kind = historyKind(e)
        if (!kind) continue
        const isNew = e.created_at > since
        recordEvent({
          camera: cam, kind, timestamp: e.created_at, dingId: e.ding_id_str,
          hasRecording: e.recording_status === 'ready' || e.recording_status === 'audio_ready',
        }, { notify: isNew })
      }
      if (list[0]?.created_at && list[0].created_at > since) lastSeenEventAt.set(cam.id, list[0].created_at)
    } catch (err) {
      if (config.verbose) console.error(`[events] poll failed for camera ${cam.id}:`, err.message)
      if (looksLikeAuthError(err?.message)) markAuthExpired()
    }
  }
}

// ---------------------------------------------------------------------------
// Sign-in (email + password, then optional 2FA code)
// ---------------------------------------------------------------------------

const pendingAuth = new Map() // sessionId -> { client, attempts, createdAt }
const AUTH_TTL_MS = 10 * 60_000
const MAX_2FA_ATTEMPTS = 5

function friendlyAuthError(message = '') {
  const m = message.toLowerCase()
  if (/invalid|credentials|unauthorized|401|access_denied|verify that your email/.test(m)) return 'Incorrect email or password.'
  if (/rate|limit|too many/.test(m)) return 'Too many attempts. Wait a few minutes and try again.'
  if (/locked|blocked/.test(m)) return 'Your Ring account is temporarily locked. Try again later.'
  if (/timeout|timed out/.test(m)) return 'Ring took too long to respond.'
  if (/network|enotfound|econnrefused|fetch failed/.test(m)) return 'Could not reach Ring. Check your internet connection.'
  return 'Sign-in failed. Please try again.'
}

async function completeSignIn(refreshToken) {
  saveRingToken(refreshToken)
  await initRing()
}

export async function startAuth(email, password) {
  const now = Date.now()
  for (const [id, s] of pendingAuth) if (now - s.createdAt > AUTH_TTL_MS) pendingAuth.delete(id)

  const client = new RingRestClient({ email, password, controlCenterDisplayName: config.clientName })
  try {
    const auth = await client.getAuth()
    await completeSignIn(auth.refresh_token)
    return { success: true }
  } catch (err) {
    if (client.using2fa) {
      const sessionId = crypto.randomBytes(16).toString('hex')
      pendingAuth.set(sessionId, { client, attempts: 0, createdAt: now })
      return {
        success: false,
        requiresTwoFactor: true,
        sessionId,
        prompt: client.promptFor2fa || 'Enter the verification code Ring sent you.',
      }
    }
    console.error('[auth] sign-in failed:', err.message)
    return { success: false, error: friendlyAuthError(err.message) }
  }
}

export async function verifyAuth(sessionId, code) {
  const session = pendingAuth.get(sessionId)
  if (!session || Date.now() - session.createdAt > AUTH_TTL_MS) {
    pendingAuth.delete(sessionId)
    return { success: false, error: 'Sign-in expired. Start again.' }
  }
  if (++session.attempts > MAX_2FA_ATTEMPTS) {
    pendingAuth.delete(sessionId)
    return { success: false, error: 'Too many attempts. Start again.' }
  }
  try {
    const auth = await session.client.getAuth(code)
    pendingAuth.delete(sessionId)
    await completeSignIn(auth.refresh_token)
    return { success: true }
  } catch (err) {
    console.error('[auth] 2FA failed:', err.message)
    const m = (err.message || '').toLowerCase()
    return { success: false, error: m.includes('expired') ? 'Code expired. Start again.' : 'Incorrect code. Try again.' }
  }
}

export async function signOut() {
  teardownRing()
  removeFile(config.ringTokenPath)
  events = []
  scheduleSave()
  authExpired = false
  console.log('[ring] Signed out')
  bus.emit('auth', authStatus())
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

export function getCameras() {
  return cameras
}

export function getCamera(id) {
  return cameras.find((c) => c.id === Number(id))
}

export function cameraInfo(cam) {
  const d = cam.data ?? {}
  return {
    id: cam.id,
    name: cam.name,
    model: cam.model,
    isDoorbell: !!cam.isDoorbot,
    isOffline: cam.isOffline,
    hasBattery: cam.hasBattery,
    batteryLevel: cam.hasBattery ? cam.batteryLevel : null,
    hasLowBattery: cam.hasLowBattery,
    isCharging: cam.isCharging,
    hasLight: cam.hasLight,
    hasSiren: cam.hasSiren,
    lightOn: String(d.led_status ?? '').toLowerCase() === 'on',
    sirenOn: (d.siren_status?.seconds_remaining ?? 0) > 0,
    motionDetectionEnabled: d.settings?.motion_detection_enabled !== false,
    motionActive: (motionActiveUntil.get(cam.id) ?? 0) > Date.now(),
  }
}

/** Resolve a playable MP4 URL for a recorded event (needs a Ring Protect plan). */
export async function getRecordingUrl(event) {
  const cam = getCamera(event.cameraId)
  if (!cam) return null
  let dingId = event.dingId
  if (!dingId) {
    const target = Date.parse(event.timestamp)
    const { events: list } = await cam.getEvents({ limit: 50 })
    const match = list
      .filter((e) => historyKind(e) === event.kind && Math.abs(Date.parse(e.created_at) - target) < 120_000)
      .sort((a, b) => Math.abs(Date.parse(a.created_at) - target) - Math.abs(Date.parse(b.created_at) - target))[0]
    if (!match) return null
    dingId = match.ding_id_str
    event.dingId = dingId
    scheduleSave()
  }
  // The raw recording is available first; the transcoded copy can lag by minutes.
  try {
    return await cam.getRecordingUrl(dingId, { transcoded: false })
  } catch {
    return await cam.getRecordingUrl(dingId, { transcoded: true })
  }
}

export function shutdownRing() {
  teardownRing()
  if (saveTimer) {
    clearTimeout(saveTimer)
    try { writePrivateFile(config.eventsPath, JSON.stringify(events)) } catch { /* ignore */ }
  }
}
