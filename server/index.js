import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config } from './config.js'
import { setupLogging } from './log.js'
import { emptyDir, ensurePrivateDir, readTextFile, writePrivateFile } from './fsutil.js'
import { createApp } from './routes.js'
import { authStatus, initRing, shutdownRing } from './ring.js'
import { stopAllStreams } from './streams.js'

process.umask(0o077) // everything we (and FFmpeg) write is owner-only

// One-time move of data saved under the app's previous name (HomeView).
const legacyDir = path.join(os.homedir(), '.homeview')
if (!process.env.HOMEBASEVIEW_DATA_DIR && !fs.existsSync(config.dataDir) && fs.existsSync(legacyDir)) {
  fs.renameSync(legacyDir, config.dataDir)
}
setupLogging()
ensurePrivateDir(config.dataDir)
ensurePrivateDir(config.hlsDir)
emptyDir(config.hlsDir) // leftover footage from a crash

// A stable shared secret: the web UI keeps it in a cookie, the menu bar app reads this file.
let sessionToken = readTextFile(config.sessionTokenPath)
if (!sessionToken || process.argv.includes('--new-token')) {
  sessionToken = crypto.randomBytes(32).toString('hex')
  writePrivateFile(config.sessionTokenPath, sessionToken)
}

const app = createApp(sessionToken)
const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?token=${sessionToken}`
  console.log(`[server] HomeBaseView running. Open: ${url}`)
  fs.writeFileSync(`${config.dataDir}/server.pid`, String(process.pid), { mode: 0o600 })
  if (process.argv.includes('--open')) execFile('open', [url])
})
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `[server] Port ${config.port} is already in use. Is HomeBaseView already running?`
    : `[server] Failed to start: ${err.message}`)
  process.exit(1)
})

// Retry if Ring can't be reached at launch (e.g. no network yet after login), unless the session was rejected.
async function connectRing(attempt = 1) {
  try {
    await initRing()
  } catch (err) {
    console.error(`[ring] init failed (attempt ${attempt}):`, err.message)
    if (!authStatus().authExpired) setTimeout(() => connectRing(attempt + 1), Math.min(60_000, 5000 * attempt)).unref()
  }
}
connectRing()

// If launched by the menu bar app, exit when it does (even if it was force-quit).
const parentPid = Number(process.env.HOMEBASEVIEW_PARENT_PID)
if (parentPid) {
  setInterval(() => {
    try { process.kill(parentPid, 0) } catch { shutdown('parent exited') }
  }, 5000).unref()
}

let stopping = false
function shutdown(reason) {
  if (stopping) return
  stopping = true
  console.log(`[server] shutting down (${reason})`)
  setTimeout(() => process.exit(1), 3000).unref()
  try { stopAllStreams() } catch { /* ignore */ }
  try { shutdownRing() } catch { /* ignore */ }
  try { fs.unlinkSync(`${config.dataDir}/server.pid`) } catch { /* ignore */ }
  server.close(() => process.exit(0))
  server.closeAllConnections?.()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => { console.error('[server] uncaught:', err); shutdown('crash') })
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err))
