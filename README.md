# HomeView

A personal Ring camera viewer for macOS. It lives in the menu bar and gives you:

- Live view of any camera, with sound
- Two-way talk through the camera speaker using your Mac's microphone
- A grid of camera stills that refreshes on its own
- Floodlight, siren and motion-detection toggles
- Native notifications for doorbell presses and motion, with a snapshot attached
- A 24-hour activity log with person, package and vehicle labels, and recorded clip playback (needs Ring Protect)
- Battery, charging, offline and low-battery status

It talks to Ring's cloud the same way the Ring app does, using the open-source
[`ring-client-api`](https://github.com/dgreif/ring) library. This is unofficial and
for personal use only.

## How it works

```
HomeView.app (Swift menu bar shell)
 ├─ starts ─▶ Node server on 127.0.0.1:18700 (server/)
 │             ├─ ring-client-api ─▶ Ring cloud (OAuth, REST, push notifications)
 │             ├─ WebRTC live view ─▶ FFmpeg ─▶ HLS segments in ~/.homeview/hls
 │             └─ FFmpeg mic capture ─▶ WebRTC return audio (two-way talk)
 ├─ shows ──▶ web UI (web/) in a popover
 └─ polls ──▶ /api/events for native notifications
```

All files live in `~/.homeview`, readable only by you:

| File | Purpose |
| --- | --- |
| `ring-token` | Ring refresh token. Ring rotates it on every use. |
| `session-token` | Shared secret that the UI and menu bar app send to the local server. |
| `events.json` | Activity log for the last 24 hours. |
| `server.log` | Server log, rotated at 1 MB. |
| `hls/` | Live-view segments. Deleted when a stream stops and on every start. |

The server only listens on `127.0.0.1`, rejects requests for any other host name,
and requires the session token on every API call.

## Build and run the menu bar app

Requires Node 20 or newer and Xcode command line tools.

```sh
npm install
npm run app            # builds macos/build/HomeView.app
open macos/build/HomeView.app

# or build and copy to /Applications in one step
bash macos/build-app.sh --install
```

Click the doorbell icon in the menu bar and sign in with your Ring email and password.
Ring then asks for a verification code. Right-click the icon for Launch at Login,
Open in Browser, the server log, and Restart Server. Drag the popover away from the
menu bar to keep it open as a floating window.

The first time you press Talk, macOS asks for microphone permission for HomeView.

## Run without the menu bar app

```sh
npm install
npm start -- --open    # opens the UI in your browser
```

The terminal prints a link with the session token. Opening it once stores a cookie,
so later visits to `http://127.0.0.1:18700` just work. Browser mode uses web
notifications, which you can turn on in Settings.

## Settings via environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOMEVIEW_PORT` | `18700` | Local server port |
| `HOMEVIEW_POLL_MS` | `5000` | How often to poll Ring event history as a backup for push |
| `HOMEVIEW_CLIENT_NAME` | `HomeView` | Name shown in Ring app > Control Center > Authorized Client Devices |
| `HOMEVIEW_DATA_DIR` | `~/.homeview` | Where tokens, logs and segments are stored |
| `HOMEVIEW_VERBOSE` | unset | Set to `1` for ring-client-api debug logging |

Run `npm start -- --new-token` to rotate the session token. Signing out in Settings
deletes the Ring token. You can also revoke HomeView from the Ring app's Control Center.

## Notes

- Motion and doorbell events arrive by push when Ring delivers it. History polling
  catches anything push misses, with Ring's usual delay of 20 to 60 seconds.
- Live streams stop when you close the viewer, when the popover closes, or after
  30 seconds with no viewer, so battery cameras are not kept awake.
- Snapshots on battery cameras are limited by Ring and may be a few minutes old.
