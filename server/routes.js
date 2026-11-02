import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import express from 'express'
import { config } from './config.js'
import * as ring from './ring.js'
import * as streams from './streams.js'
import { getSnapshot } from './snapshots.js'

const COOKIE = 'hbv_session'

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function createApp(sessionToken) {
  const app = express()
  app.disable('x-powered-by')

  // Block DNS-rebinding: only accept requests addressed to this machine.
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`])
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host)) return res.status(421).send('Misdirected request')
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })

  // Opening /?token=... once stores the token in a cookie and drops it from the URL.
  app.get('/', (req, res, next) => {
    if (typeof req.query.token !== 'string') return next()
    if (!safeEqual(req.query.token, sessionToken)) return res.status(401).send('Invalid token')
    res.cookie(COOKIE, sessionToken, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 365 * 24 * 3600_000 })
    res.redirect(302, '/')
  })

  // The UI itself contains nothing sensitive; every /api route below is authenticated.
  app.use(express.static(config.webDir, { index: 'index.html' }))
  app.get('/vendor/hls.min.js', (_req, res) =>
    res.sendFile(path.join(config.root, 'node_modules', 'hls.js', 'dist', 'hls.min.js')))

  const api = express.Router()
  api.use((req, res, next) => {
    const token = req.headers['x-homebaseview-token'] || readCookie(req, COOKIE)
    if (!token || !safeEqual(token, sessionToken)) return res.status(401).json({ error: 'unauthorized' })
    next()
  })
  api.use(express.json({ limit: '10kb' }))

  const withCamera = (handler) => async (req, res) => {
    const cam = ring.getCamera(req.params.id)
    if (!cam) return res.status(404).json({ error: 'Camera not found' })
    try {
      await handler(cam, req, res)
    } catch (err) {
      console.error(`[api] ${req.method} ${req.path} failed:`, err.message)
      if (!res.headersSent) res.status(500).json({ error: 'Ring request failed' })
    }
  }

  // --- status & auth ---------------------------------------------------------
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', ...ring.authStatus(), cameras: ring.getCameras().length, activeStreams: streams.activeStreamCount() })
  })

  const attempts = new Map()
  function rateLimited(key, limit) {
    const now = Date.now()
    const a = attempts.get(key)
    if (!a || a.reset < now) { attempts.set(key, { n: 1, reset: now + 60_000 }); return false }
    return ++a.n > limit
  }

  api.post('/auth/start', async (req, res) => {
    if (rateLimited('start', 8)) return res.status(429).json({ success: false, error: 'Too many attempts. Wait a minute.' })
    const { email, password } = req.body ?? {}
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== 'string' || !password || password.length > 256) {
      return res.status(400).json({ success: false, error: 'Enter your Ring email and password.' })
    }
    res.json(await ring.startAuth(email.trim(), password))
  })

  api.post('/auth/verify', async (req, res) => {
    if (rateLimited('verify', 20)) return res.status(429).json({ success: false, error: 'Too many attempts. Wait a minute.' })
    const { sessionId, code } = req.body ?? {}
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId) || typeof code !== 'string' || !/^[A-Za-z0-9-]{4,16}$/.test(code.trim())) {
      return res.status(400).json({ success: false, error: 'Enter the code from Ring.' })
    }
    res.json(await ring.verifyAuth(sessionId, code.trim()))
  })

  api.post('/auth/signout', async (_req, res) => {
    streams.stopAllStreams()
    await ring.signOut()
    res.json({ success: true })
  })

  // --- cameras ---------------------------------------------------------------
  api.get('/cameras', (_req, res) => {
    res.json(ring.getCameras().map((c) => ({ ...ring.cameraInfo(c), streaming: streams.isStreaming(c.id), talking: streams.isTalking(c.id) })))
  })

  api.get('/cameras/:id/snapshot', withCamera(async (cam, req, res) => {
    const snap = await getSnapshot(cam, { fresh: req.query.fresh === '1' })
    if (req.headers['if-none-match'] === snap.etag) return res.status(304).end()
    res.set({ 'Content-Type': 'image/jpeg', ETag: snap.etag, 'Cache-Control': 'no-cache', 'X-Snapshot-Time': new Date(snap.takenAt).toISOString() })
    res.send(snap.buffer)
  }))

  api.post('/cameras/:id/light', withCamera(async (cam, req, res) => {
    await cam.setLight(!!req.body?.on)
    res.json({ success: true })
  }))

  api.post('/cameras/:id/siren', withCamera(async (cam, req, res) => {
    await cam.setSiren(!!req.body?.on)
    res.json({ success: true })
  }))

  api.post('/cameras/:id/motion-detection', withCamera(async (cam, req, res) => {
    await cam.setSettings({ motion_detection_enabled: !!req.body?.enabled })
    cam.requestUpdate()
    res.json({ success: true })
  }))

  // --- live view -------------------------------------------------------------
  api.post('/cameras/:id/live/start', withCamera(async (cam, _req, res) => {
    await streams.startStream(cam)
    res.json({ streaming: true })
  }))

  api.post('/cameras/:id/live/stop', (req, res) => {
    streams.stopStream(req.params.id)
    res.json({ streaming: false })
  })

  api.get('/cameras/:id/live/:file', (req, res) => {
    const file = streams.streamFile(req.params.id, req.params.file)
    if (!file) {
      if (req.params.file === 'stream.m3u8' && streams.isStreaming(req.params.id)) return res.status(202).json({ status: 'buffering' })
      return res.status(404).end()
    }
    const isPlaylist = file.endsWith('.m3u8')
    res.set({ 'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Cache-Control': 'no-cache' })
    res.sendFile(file)
  })

  api.post('/cameras/:id/talk/start', async (req, res) => {
    const result = await streams.startTalkback(req.params.id)
    res.status(result.ok ? 200 : 409).json(result)
  })

  api.post('/cameras/:id/talk/stop', (req, res) => {
    streams.stopTalkback(req.params.id)
    res.json({ ok: true })
  })

  // --- events ----------------------------------------------------------------
  api.get('/events', (req, res) => {
    res.json(ring.getEvents({ after: Number(req.query.after) || 0 }))
  })

  // Server-sent events: pushes new motion/doorbell events and camera status changes.
  api.get('/events/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    const onEvent = (e) => send('ring-event', e)
    const onCamera = (c) => send('camera', { ...c, streaming: streams.isStreaming(c.id), talking: streams.isTalking(c.id) })
    const onAuth = (a) => send('auth', a)
    ring.bus.on('event', onEvent)
    ring.bus.on('camera', onCamera)
    ring.bus.on('auth', onAuth)
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(ping)
      ring.bus.off('event', onEvent)
      ring.bus.off('camera', onCamera)
      ring.bus.off('auth', onAuth)
    })
  })

  // Ring's signed download URLs expire after 15 minutes; reuse one for a while so seeking stays fast.
  const recordingUrls = new Map() // eventId -> { url, expires }
  async function recordingUrl(event) {
    const cached = recordingUrls.get(event.id)
    if (cached && cached.expires > Date.now()) return cached.url
    const url = await ring.getRecordingUrl(event)
    if (url) recordingUrls.set(event.id, { url, expires: Date.now() + 10 * 60_000 })
    for (const [id, c] of recordingUrls) if (c.expires <= Date.now()) recordingUrls.delete(id)
    return url
  }

  api.get('/events/:eventId/recording', async (req, res) => {
    const event = ring.getEvent(req.params.eventId)
    if (!event) return res.status(404).json({ error: 'Event not found' })
    try {
      const url = await recordingUrl(event)
      if (!url) return res.status(404).json({ error: 'No recording for this event yet. Recordings need a Ring Protect plan.' })
      // Played through the proxy below, not Ring's URL directly (see there).
      res.json({ url: `/api/events/${encodeURIComponent(event.id)}/recording.mp4` })
    } catch (err) {
      console.error('[api] recording lookup failed:', err.message)
      res.status(404).json({ error: 'Recording not available yet. Try again in a minute.' })
    }
  })

  /**
   * Byte-range proxy for a recording. Ring's download host redirects each request to a URL with
   * the requested Range baked into its query string, so a player that reuses the redirected URL
   * (WebKit does) gets the same first two bytes forever and never loads. Here every range request
   * goes to the original signed URL and follows the redirect fresh.
   */
  api.get('/events/:eventId/recording.mp4', async (req, res) => {
    const event = ring.getEvent(req.params.eventId)
    if (!event) return res.status(404).end()
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    try {
      const url = await recordingUrl(event)
      if (!url) return res.status(404).end()
      const headers = {}
      if (typeof req.headers.range === 'string') headers.Range = req.headers.range
      const upstream = await fetch(url, { headers, signal: abort.signal, redirect: 'follow' })
      if (upstream.status === 403) recordingUrls.delete(event.id) // expired signature; next request re-resolves
      if (!upstream.ok) return res.status(upstream.status === 416 ? 416 : 502).end()
      res.status(upstream.status)
      res.set('Content-Type', 'video/mp4')
      res.set('Accept-Ranges', 'bytes')
      res.set('Cache-Control', 'no-store')
      if (req.query.download === '1') {
        const t = new Date(event.timestamp)
        const pad = (n) => String(n).padStart(2, '0')
        const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}.${pad(t.getMinutes())}.${pad(t.getSeconds())}`
        const name = `${event.cameraName} ${stamp}.mp4`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      }
      for (const h of ['content-length', 'content-range']) {
        const v = upstream.headers.get(h)
        if (v) res.set(h, v)
      }
      if (!upstream.body) return res.end()
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
    } catch (err) {
      if (abort.signal.aborted) return
      console.error('[api] recording proxy failed:', err.message)
      if (!res.headersSent) res.status(502).end()
      else res.destroy()
    }
  })

  app.use('/api', api)

  app.use((err, _req, res, _next) => {
    const bad = err?.type === 'entity.parse.failed' || err?.status === 400
    if (!bad) console.error('[api] unhandled:', err?.message ?? err)
    res.status(bad ? 400 : 500).json({ error: bad ? 'Bad request' : 'Internal error' })
  })

  return app
}
