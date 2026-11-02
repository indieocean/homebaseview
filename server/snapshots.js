import { config } from './config.js'

const cache = new Map() // cameraId -> { buffer, takenAt, etag }
const inFlight = new Map()

async function capture(camera) {
  try {
    return await camera.getSnapshot()
  } catch (err) {
    // Ring's cached "offline" flag is often stale. Try a forced capture before giving up.
    if (/offline/i.test(err?.message ?? '')) return camera.getNextSnapshot({ force: true })
    throw err
  }
}

/** Latest still image for a camera, cached briefly so many viewers share one fetch. */
export async function getSnapshot(camera, { fresh = false } = {}) {
  const cached = cache.get(camera.id)
  if (!fresh && cached && Date.now() - cached.takenAt < config.snapshotTtlMs) return cached
  if (inFlight.has(camera.id)) return inFlight.get(camera.id)

  const p = capture(camera)
    .then((buffer) => {
      const snap = { buffer, takenAt: Date.now(), etag: `"${camera.id}-${Date.now().toString(36)}"` }
      cache.set(camera.id, snap)
      return snap
    })
    .finally(() => inFlight.delete(camera.id))
  inFlight.set(camera.id, p)
  return p
}
