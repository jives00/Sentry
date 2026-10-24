import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SLUG_RE } from './paths';

export const CameraSchema = z.object({
  /** display name; editable */
  name: z.string().trim().min(1).max(60),
  /** folder name under the storage root; fixed once the camera is first seen */
  slug: z.string().regex(SLUG_RE),
  /** Ring location id, needed to address its MQTT command topics */
  location: z.string(),
  enabled: z.boolean().default(true),
});

export const SettingsSchema = z.object({
  snapshotDays: z.number().int().min(1).max(365),
  eventDays: z.number().int().min(1).max(730),
  /** seconds between Ring interval snapshots; Ring may not honor very short values */
  snapshotInterval: z.number().int().min(10).max(600),
  /** keep recording this long after motion stops (or after a ding) */
  postRoll: z.number().int().min(5).max(120),
  /** keyed by Ring device id */
  cameras: z.record(CameraSchema),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Camera = z.infer<typeof CameraSchema>;

export const DEFAULTS: Settings = {
  snapshotDays: 30,
  eventDays: 90,
  snapshotInterval: 30,
  postRoll: 20,
  cameras: {},
};

export class SettingsStore {
  private current: Settings;

  constructor(private file: string, private log: { warn: (msg: string) => void } = console) {
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /** Replaces the settings. Camera slugs and locations can't be changed from outside. */
  set(next: unknown): Settings {
    const parsed = SettingsSchema.parse(next);
    for (const [id, cam] of Object.entries(parsed.cameras)) {
      const known = this.current.cameras[id];
      if (!known) delete parsed.cameras[id];
      else parsed.cameras[id] = { ...cam, slug: known.slug, location: known.location };
    }
    return this.write(parsed);
  }

  /** Records a newly seen camera, picking a slug no other camera uses. */
  addCamera(id: string, cam: Omit<Camera, 'enabled'>): Camera {
    const taken = new Set(Object.values(this.current.cameras).map((c) => c.slug));
    let slug = cam.slug;
    for (let n = 2; taken.has(slug); n++) slug = `${cam.slug.slice(0, 36)}-${n}`;
    const added: Camera = { ...cam, slug, enabled: true };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [id]: added } });
    return added;
  }

  /** Internal updates (a discovered name, say); unlike set(), this may change the slug. */
  updateCamera(id: string, patch: Partial<Camera>): Camera | null {
    const cam = this.current.cameras[id];
    if (!cam) return null;
    const next = { ...cam, ...patch };
    this.write({ ...this.current, cameras: { ...this.current.cameras, [id]: next } });
    return next;
  }

  private write(settings: Settings): Settings {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, this.file);
    this.current = settings;
    return settings;
  }

  private load(): Settings {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Could not read ${this.file}, using defaults: ${(err as Error).message}`);
      }
      return structuredClone(DEFAULTS);
    }
    // Merge over defaults so settings saved by an older version pick up new fields.
    const result = SettingsSchema.safeParse({ ...structuredClone(DEFAULTS), ...(raw as object) });
    if (result.success) return result.data;
    this.log.warn(`${this.file} failed validation, using defaults: ${result.error.message}`);
    return structuredClone(DEFAULTS);
  }
}
