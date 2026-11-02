import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { RtpSplitter } from '@homebridge/camera-utils'
import { RtpPacket } from 'werift'
import ffmpegPath from 'ffmpeg-for-homebridge'
import { config } from './config.js'
import { emptyDir, ensurePrivateDir } from './fsutil.js'

/**
 * Live view: ring-client-api opens a WebRTC session with the camera through
 * Ring's signalling server and pipes the RTP into FFmpeg, which writes a short
 * rolling HLS playlist the UI plays. Two-way talk sends the Mac's microphone
 * back over the same WebRTC session.
 */

const active = new Map() // cameraId -> { session, startedAt, lastAccess, talkback? }
const starting = new Map() // cameraId -> Promise (coalesces concurrent starts)
const cleanupTimers = new Map()

function hlsDir(cameraId) {
  return path.join(config.hlsDir, String(cameraId))
}

export function isStreaming(cameraId) {
  return active.has(Number(cameraId))
}

export function activeStreamCount() {
  return active.size
}

export async function startStream(camera) {
  if (active.has(camera.id)) {
    active.get(camera.id).lastAccess = Date.now()
    return
  }
  if (starting.has(camera.id)) return starting.get(camera.id)
  const p = doStart(camera).finally(() => starting.delete(camera.id))
  starting.set(camera.id, p)
  return p
}

async function doStart(camera) {
  clearTimeout(cleanupTimers.get(camera.id))
  cleanupTimers.delete(camera.id)
  const dir = hlsDir(camera.id)
  ensurePrivateDir(dir)
  emptyDir(dir)

  console.log(`[stream] starting camera ${camera.id}`)
  const session = await camera.streamVideo({
    video: ['-vcodec', 'copy'],
    audio: ['-acodec', 'aac', '-ac', '1', '-ar', '16000', '-b:a', '32k'],
    output: [
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+append_list+omit_endlist',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
      path.join(dir, 'stream.m3u8'),
    ],
  })
  session.requestKeyFrame()

  const stream = { session, startedAt: Date.now(), lastAccess: Date.now(), talkback: null }
  active.set(camera.id, stream)

  session.onCallEnded.subscribe(() => {
    console.log(`[stream] camera ${camera.id} ended after ${((Date.now() - stream.startedAt) / 1000).toFixed(0)}s`)
    stopTalkbackFor(stream)
    if (active.get(camera.id) === stream) {
      active.delete(camera.id)
      scheduleCleanup(camera.id)
    }
  })
}

function scheduleCleanup(cameraId) {
  clearTimeout(cleanupTimers.get(cameraId))
  // Give the player a moment to finish buffered segments before deleting them.
  cleanupTimers.set(cameraId, setTimeout(() => {
    emptyDir(hlsDir(cameraId))
    cleanupTimers.delete(cameraId)
  }, 5000))
}

export function stopStream(cameraId) {
  cameraId = Number(cameraId)
  const stream = active.get(cameraId)
  if (!stream) return
  console.log(`[stream] stopping camera ${cameraId}`)
  stopTalkbackFor(stream)
  active.delete(cameraId)
  try { stream.session.stop() } catch { /* already ended */ }
  scheduleCleanup(cameraId)
}

/** Returns the path of a playlist or segment, or null if it isn't there (yet). */
export function streamFile(cameraId, name) {
  cameraId = Number(cameraId)
  const stream = active.get(cameraId)
  if (!stream && !cleanupTimers.has(cameraId)) return null
  if (name !== 'stream.m3u8' && !/^seg_\d{1,8}\.ts$/.test(name)) return null
  if (stream) stream.lastAccess = Date.now()
  const file = path.join(hlsDir(cameraId), name)
  return fs.existsSync(file) ? file : null
}

// Stop streams nobody is watching (e.g. the popover closed without saying so).
setInterval(() => {
  for (const [id, s] of active) {
    if (Date.now() - s.lastAccess > config.streamIdleMs) {
      console.log(`[stream] camera ${id} idle, stopping`)
      stopStream(id)
    }
  }
}, 5000).unref()

// ---------------------------------------------------------------------------
// Two-way talk
// ---------------------------------------------------------------------------

export function isTalking(cameraId) {
  return !!active.get(Number(cameraId))?.talkback
}

export async function startTalkback(cameraId) {
  const stream = active.get(Number(cameraId))
  if (!stream) return { ok: false, error: 'Start live view first.' }
  if (stream.talkback) return { ok: true }

  const { session } = stream
  let gotPacket = false
  const splitter = new RtpSplitter(({ message }) => {
    try {
      session.sendAudioPacket(RtpPacket.deSerialize(message))
      gotPacket = true
    } catch { /* drop malformed packet */ }
    return null
  })
  const port = await splitter.portPromise
  const opus = await session.isUsingOpus
  const codec = opus
    ? ['-acodec', 'libopus', '-ac', '2', '-ar', '48k']
    : ['-acodec', 'pcm_mulaw', '-ac', '1', '-ar', '8k']

  // Capture the default macOS input device. macOS asks for microphone
  // permission on behalf of whichever app launched this server.
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', ':default',
    ...codec,
    '-flags', '+global_header',
    '-f', 'rtp', `rtp://127.0.0.1:${port}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let lastError = ''
  ff.stderr.on('data', (d) => { lastError = d.toString().trim().slice(0, 300) })
  session.activateCameraSpeaker()

  // Only report success once audio is actually flowing.
  const ok = await new Promise((resolve) => {
    const onExit = () => resolve(false)
    ff.once('exit', onExit)
    setTimeout(() => { ff.removeListener('exit', onExit); resolve(gotPacket) }, 1500)
  })
  if (!ok) {
    try { ff.kill('SIGKILL') } catch { /* gone */ }
    splitter.close()
    const denied = /denied|not authorized|permission/i.test(lastError)
    console.error(`[talk] mic failed for camera ${cameraId}: ${lastError || 'no audio captured'}`)
    return {
      ok: false,
      error: denied
        ? 'Microphone access is blocked. Allow it in System Settings > Privacy & Security > Microphone.'
        : 'Could not capture the microphone. Is another app using it?',
    }
  }

  stream.talkback = { ff, splitter }
  ff.on('exit', () => {
    if (stream.talkback?.ff === ff) stopTalkbackFor(stream)
  })
  console.log(`[talk] talking to camera ${cameraId} (${opus ? 'opus' : 'pcmu'})`)
  return { ok: true }
}

export function stopTalkback(cameraId) {
  const stream = active.get(Number(cameraId))
  if (stream) stopTalkbackFor(stream)
}

function stopTalkbackFor(stream) {
  const tb = stream.talkback
  if (!tb) return
  stream.talkback = null
  try { tb.ff.kill('SIGTERM') } catch { /* gone */ }
  // avfoundation can hold the mic briefly after SIGTERM; make sure it's released.
  setTimeout(() => { try { if (tb.ff.exitCode === null) tb.ff.kill('SIGKILL') } catch { /* gone */ } }, 400)
  try { tb.splitter.close() } catch { /* closed */ }
}

export function stopAllStreams() {
  for (const [id, stream] of active) {
    stopTalkbackFor(stream)
    try { stream.session.stop() } catch { /* ignore */ }
    active.delete(id)
  }
  for (const t of cleanupTimers.values()) clearTimeout(t)
  cleanupTimers.clear()
  emptyDir(config.hlsDir)
}
