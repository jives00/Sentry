import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { dayIndex, listDays, sweep } from './library';
import { LiveView } from './live';
import { DAY_RE, slugify } from './paths';
import { ClipRecorder } from './recorder';
import { RingBridge } from './ring';
import { SettingsStore } from './settings';
import { SnapshotWriter } from './snapshots';

const PORT = Number(process.env.PORT ?? 3014);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const FOOTAGE_ROOT = path.resolve(process.env.FOOTAGE_ROOT ?? 'footage');
const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const RTSP_BASE = (process.env.RTSP_BASE ?? 'rtsp://localhost:8554').replace(/\/$/, '');

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const log = {
  info: (m: string) => app.log.info(m),
  warn: (m: string) => app.log.warn(m),
};

fs.mkdirSync(FOOTAGE_ROOT, { recursive: true });
const settings = new SettingsStore(path.join(DATA_DIR, 'settings.json'), log);
const ring = new RingBridge(MQTT_URL, log);
const snapshots = new SnapshotWriter(FOOTAGE_ROOT);
const liveView = new LiveView(path.join(DATA_DIR, 'live'), log);

interface Live {
  recorder: ClipRecorder;
  online: boolean | null;
  snapshotConfig: { mode?: string; interval?: number };
}
const live = new Map<string, Live>();

const fallbackName = (id: string) => `Ring camera ${id.slice(-4)}`;

function liveFor(id: string): Live {
  let entry = live.get(id);
  if (!entry) {
    entry = {
      online: null,
      snapshotConfig: {},
      recorder: new ClipRecorder({
        root: FOOTAGE_ROOT,
        slug: () => settings.get().cameras[id]?.slug ?? id,
        rtspUrl: `${RTSP_BASE}/${id}_live`,
        clipLength: () => settings.get().clipLength,
        log,
      }),
    };
    live.set(id, entry);
  }
  return entry;
}

const enabled = (id: string) => settings.get().cameras[id]?.enabled ?? false;

ring.on('camera', (id, location, name) => {
  const known = settings.get().cameras[id];
  if (!known) {
    const label = name ?? fallbackName(id);
    const cam = settings.addCamera(id, { name: label, slug: slugify(label), location });
    log.info(`New camera ${cam.name} (${id}) → ${cam.slug}/`);
  } else if (name && known.name === fallbackName(id)) {
    // Seen by its state topics first; take the real name, and the slug too if nothing's on disk yet.
    const patch = listDays(FOOTAGE_ROOT, known.slug).length ? { name } : { name, slug: slugify(name) };
    settings.updateCamera(id, patch);
  }
  liveFor(id);
  ring.setSnapshots(id, location, settings.get().snapshotInterval);
});

ring.on('motion', (id, on) => enabled(id) && liveFor(id).recorder.motion(on));
ring.on('ding', (id, on) => enabled(id) && liveFor(id).recorder.ding(on));
ring.on('online', (id, online) => (liveFor(id).online = online));
ring.on('snapshotConfig', (id, c) => Object.assign(liveFor(id).snapshotConfig, c));
ring.on('snapshot', (id, jpeg) => {
  const cam = settings.get().cameras[id];
  if (!cam?.enabled) return;
  try {
    snapshots.save(cam.slug, jpeg);
  } catch (err) {
    log.warn(`${cam.slug}: couldn't save snapshot: ${(err as Error).message}`);
  }
});

function runRetention() {
  const s = settings.get();
  for (const cam of Object.values(s.cameras)) {
    try {
      const n = sweep(FOOTAGE_ROOT, cam.slug, s);
      if (n) log.info(`${cam.slug}: retention removed ${n} folder(s)`);
    } catch (err) {
      log.warn(`${cam.slug}: retention failed: ${(err as Error).message}`);
    }
  }
}

app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/' });
// Finished footage never changes (in-progress files are .part and aren't linked anywhere).
app.register(fastifyStatic, {
  root: FOOTAGE_ROOT,
  prefix: '/footage/',
  decorateReply: false,
  maxAge: '7d',
  immutable: true,
});
// The live playlist rewrites every couple of seconds, so it must never be cached.
app.register(fastifyStatic, {
  root: liveView.dir,
  prefix: '/live/',
  decorateReply: false,
  cacheControl: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
});

app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return reply.status(400).send({ error: `${first.path.join('.') || 'settings'}: ${first.message}` });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.status(status).send({ error: err.message });
});

app.get('/health', async () => ({ ok: true, mqtt: ring.connected }));

app.get('/api/status', async () => ({
  mqtt: ring.connected,
  cameras: Object.entries(settings.get().cameras).map(([id, cam]) => {
    const l = live.get(id);
    return {
      id,
      ...cam,
      online: l?.online ?? null,
      ringSnapshots: l?.snapshotConfig ?? {},
      recording: l?.recorder.recording ?? false,
      live: liveView.isLive(cam.slug),
      lastEvent: l?.recorder.lastEvent ?? null,
      lastSnapshot: snapshots.lastAt.get(cam.slug) ?? null,
      error: l?.recorder.lastError ?? null,
    };
  }),
}));

app.get('/api/settings', async () => settings.get());
app.put('/api/settings', async (req) => {
  const before = settings.get().snapshotInterval;
  const next = settings.set(req.body);
  if (next.snapshotInterval !== before) {
    for (const [id, cam] of Object.entries(next.cameras)) ring.setSnapshots(id, cam.location, next.snapshotInterval);
  }
  runRetention();
  return next;
});

const camBySlug = (slug: string) => Object.values(settings.get().cameras).find((c) => c.slug === slug);

app.get<{ Params: { slug: string } }>('/api/cameras/:slug/days', async (req, reply) => {
  if (!camBySlug(req.params.slug)) return reply.status(404).send({ error: 'No such camera' });
  return { days: listDays(FOOTAGE_ROOT, req.params.slug) };
});

app.get<{ Params: { slug: string; date: string } }>('/api/cameras/:slug/days/:date', async (req, reply) => {
  if (!camBySlug(req.params.slug)) return reply.status(404).send({ error: 'No such camera' });
  if (!DAY_RE.test(req.params.date)) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
  return dayIndex(FOOTAGE_ROOT, req.params.slug, req.params.date);
});

const idBySlug = (slug: string) => Object.entries(settings.get().cameras).find(([, c]) => c.slug === slug)?.[0];

// Live view: the page POSTs every few seconds while it's open, and DELETEs when it closes.
app.post<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req, reply) => {
  const id = idBySlug(req.params.slug);
  if (!id) return reply.status(404).send({ error: 'No such camera' });
  const s = liveView.ping(req.params.slug, `${RTSP_BASE}/${id}_live`);
  return { ...s, playlist: `/live/${s.playlist}` };
});
app.delete<{ Params: { slug: string } }>('/api/cameras/:slug/live', async (req) => {
  liveView.stop(req.params.slug);
  return { ok: true };
});

async function main() {
  ring.start();
  runRetention();
  setInterval(runRetention, 3600_000).unref();
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

async function shutdown() {
  ring.stop();
  liveView.stopAll();
  await Promise.all([...live.values()].map((l) => l.recorder.shutdown()));
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
