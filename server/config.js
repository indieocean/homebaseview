import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.HOMEBASEVIEW_DATA_DIR || path.join(os.homedir(), '.homebaseview')

export const config = {
  root,
  dataDir,
  webDir: path.join(root, 'web'),
  host: '127.0.0.1',
  port: Number(process.env.HOMEBASEVIEW_PORT || 18700),

  /** Ring refresh token (rotated by Ring on every use). Mode 0600. */
  ringTokenPath: path.join(dataDir, 'ring-token'),
  /** Shared secret between this server and its clients (web UI, menu bar app). Mode 0600. */
  sessionTokenPath: path.join(dataDir, 'session-token'),
  logPath: path.join(dataDir, 'server.log'),
  eventsPath: path.join(dataDir, 'events.json'),
  /** Live HLS segments. Wiped on startup and shutdown. */
  hlsDir: path.join(dataDir, 'hls'),

  /** Name shown under Ring app > Control Center > Authorized Client Devices. */
  clientName: process.env.HOMEBASEVIEW_CLIENT_NAME || 'HomeBaseView',
  snapshotTtlMs: 10_000,
  /** How often to poll Ring event history (backup for push notifications). */
  eventPollMs: Math.max(2000, Number(process.env.HOMEBASEVIEW_POLL_MS || 5000)),
  cameraStatusPollingSeconds: 20,
  eventRetentionHours: 24,
  /** Stop a live stream when no client has fetched its playlist for this long. */
  streamIdleMs: 30_000,
  verbose: process.env.HOMEBASEVIEW_VERBOSE === '1',
}
