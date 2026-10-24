# Sentry

Records the NAS's security cameras and serves a playback site at `http://synology:3014`. The
first camera is a Ring doorbell, reached through [ring-mqtt](https://github.com/tsightler/ring-mqtt)
without a Ring Protect subscription.

- **Event clips:** when Ring reports motion or a doorbell press, Sentry opens the live stream
  and records until motion has been quiet for the post-roll (20 s by default). The first few
  seconds of each event are missed while the stream starts.
- **Snapshots:** Ring's interval snapshots (30 s by default), saved as they arrive.
- **Viewer:** pick a day, drag along the 24-hour timeline to scrub snapshots, play them back as
  a timelapse, or click an event to play its clip. Keys: ←/→ (Shift for ×10), space, `[`/`]`
  for days, Esc to leave a clip.
- **Retention:** snapshots 30 days, clips 90 days, changeable in settings (⚙).

Footage goes to `/volume2/SecurityCameras/Sentry/<camera>/YYYY/MM/DD/{events,snapshots}/`.

## Setup on the NAS

1. Create `/volume2/docker/sentry/` with `data/`, `mosquitto/` and `ring-mqtt/` inside, plus
   `/volume2/SecurityCameras/Sentry/`.
2. Copy `docker-compose.yml` into `/volume2/docker/sentry/`, `nas/mosquitto/mosquitto.conf`
   into `mosquitto/`, and `nas/ring-mqtt/config.json` into `ring-mqtt/`.
3. `docker compose up -d`.
4. Open `http://synology:55123` and sign in to Ring (email, password, 2FA code). ring-mqtt
   saves a refresh token to `ring-mqtt/ring-state.json` and renews it from then on. That file
   grants full access to the Ring account.
5. Within a minute the doorbell shows up in Sentry. In the Ring app, check that end-to-end
   encryption is **off**; with it on, ring-mqtt can't stream.

## Development

```
pnpm install
pnpm dev        # PORT, DATA_DIR, FOOTAGE_ROOT, MQTT_URL, RTSP_BASE from the environment
pnpm test
```
