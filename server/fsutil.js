import fs from 'node:fs'
import path from 'node:path'

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* non-fatal */ }
}

/** Atomically write a file that only the current user can read. */
export function writePrivateFile(filePath, contents) {
  ensurePrivateDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.tmp`
  try { fs.unlinkSync(tmp) } catch { /* not there */ }
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, 0o600)
  try { fs.writeSync(fd, contents) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, filePath)
  fs.chmodSync(filePath, 0o600)
}

export function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim() || null } catch { return null }
}

export function removeFile(filePath) {
  try { fs.unlinkSync(filePath) } catch { /* already gone */ }
}

export function emptyDir(dir) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true })
}
