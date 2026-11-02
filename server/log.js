import fs from 'node:fs'
import { config } from './config.js'
import { ensurePrivateDir } from './fsutil.js'

const MAX_BYTES = 1_000_000

/** Mirror console output to ~/.homebaseview/server.log (rotated, owner-only). */
export function setupLogging() {
  ensurePrivateDir(config.dataDir)
  try {
    if (fs.existsSync(config.logPath) && fs.statSync(config.logPath).size > MAX_BYTES) {
      fs.renameSync(config.logPath, `${config.logPath}.old`)
      fs.chmodSync(`${config.logPath}.old`, 0o600)
    }
  } catch { /* non-fatal */ }

  const stream = fs.createWriteStream(config.logPath, { flags: 'a', mode: 0o600 })
  try { fs.chmodSync(config.logPath, 0o600) } catch { /* non-fatal */ }

  // When the parent app dies, stdout becomes a broken pipe. Never let that crash us.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      try { orig(...args) } catch { /* EPIPE */ }
      const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      try { stream.write(`${new Date().toISOString()} [${level.toUpperCase()}] ${text}\n`) } catch { /* closed */ }
    }
  }
}
