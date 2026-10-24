import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventKind, dayPath, eventName } from './paths';

/**
 * Records one camera's event clips. Ring stops sending motion while a live stream is open, so the
 * stream is opened only on an event and closed once motion has been off for `postRoll` seconds.
 * The first few seconds of each event are lost while the stream starts; that's the trade for
 * leaving the Ring app's own alerts working.
 *
 * Clips are fragmented MP4 so a killed ffmpeg still leaves a playable file. They're written as
 * `.part` and renamed when finished, once the length is known.
 */

/** Ring ends live streams around 10 minutes; split well before that. */
export const MAX_CLIP_MS = 5 * 60_000;
/** Shorter than this is a stream that never really started. */
const MIN_BYTES = 32 * 1024;

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

interface Clip {
  proc: ChildProcess;
  start: Date;
  kind: EventKind;
  dir: string;
  tmp: string;
  maxTimer: NodeJS.Timeout;
  done: Promise<void>;
}

export class ClipRecorder {
  private clip: Clip | null = null;
  private motionOn = false;
  private stopTimer?: NodeJS.Timeout;
  lastEvent: { at: number; kind: EventKind } | null = null;
  lastError: string | null = null;

  constructor(
    private opts: {
      root: string;
      slug: () => string;
      rtspUrl: string;
      postRoll: () => number;
      log: { info: (msg: string) => void; warn: (msg: string) => void };
      spawn?: Spawn;
      now?: () => Date;
    },
  ) {}

  get recording() {
    return this.clip !== null;
  }

  motion(on: boolean) {
    this.motionOn = on;
    if (on) {
      clearTimeout(this.stopTimer);
      this.trigger('motion');
    } else {
      this.scheduleStop();
    }
  }

  /** A ding records like motion, but labels the clip and always runs at least the post-roll. */
  ding(on: boolean) {
    if (!on) return;
    this.trigger('ding');
    if (!this.motionOn) this.scheduleStop();
  }

  async shutdown() {
    clearTimeout(this.stopTimer);
    await this.finish();
  }

  private trigger(kind: EventKind) {
    const now = (this.opts.now ?? (() => new Date()))();
    this.lastEvent = { at: now.getTime(), kind };
    if (this.clip) {
      if (kind === 'ding') this.clip.kind = 'ding';
      return;
    }
    this.begin(kind, now);
  }

  private scheduleStop() {
    clearTimeout(this.stopTimer);
    if (!this.clip) return;
    this.stopTimer = setTimeout(() => void this.finish(), this.opts.postRoll() * 1000);
  }

  private begin(kind: EventKind, start: Date) {
    const dir = path.join(this.opts.root, dayPath(this.opts.slug(), start), 'events');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${eventName(start, kind, 0)}.part`);
    const args = [
      '-hide_banner', '-v', 'error', '-y',
      '-rtsp_transport', 'tcp', '-i', this.opts.rtspUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      // ring-mqtt's "Compatible" video mode is H.264, which browsers play as-is.
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', tmp,
    ];
    const proc = (this.opts.spawn ?? spawn)('ffmpeg', args);
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
    const done = new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        if (code && this.clip?.proc === proc) {
          // ffmpeg quit on its own: the stream failed or Ring ended it.
          this.lastError = `ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`;
          this.opts.log.warn(`${this.opts.slug()}: ${this.lastError}`);
          void this.finish();
        }
        resolve();
      });
      proc.on('error', (err) => {
        this.lastError = `Couldn't start ffmpeg: ${err.message}`;
        this.opts.log.warn(this.lastError);
        resolve();
      });
    });

    const maxTimer = setTimeout(() => void this.rollover(), MAX_CLIP_MS);
    this.clip = { proc, start, kind, dir, tmp, maxTimer, done };
    this.opts.log.info(`${this.opts.slug()}: recording ${kind}`);
  }

  /** Long events are split so no clip runs into Ring's stream limit. */
  private async rollover() {
    const kind = this.clip?.kind ?? 'motion';
    await this.finish();
    if (this.motionOn) this.begin(kind, (this.opts.now ?? (() => new Date()))());
  }

  private async finish() {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    clearTimeout(clip.maxTimer);
    clearTimeout(this.stopTimer);

    if (clip.proc.exitCode === null) {
      // 'q' lets ffmpeg flush its last fragment; kill it if it doesn't go.
      clip.proc.stdin?.write('q');
      clip.proc.stdin?.end();
      const kill = setTimeout(() => clip.proc.kill('SIGKILL'), 5000);
      await clip.done;
      clearTimeout(kill);
    }

    const seconds = ((this.opts.now ?? (() => new Date()))().getTime() - clip.start.getTime()) / 1000;
    let size = 0;
    try {
      size = fs.statSync(clip.tmp).size;
    } catch {
      /* never written */
    }
    if (size < MIN_BYTES) {
      fs.rmSync(clip.tmp, { force: true });
      this.opts.log.warn(`${this.opts.slug()}: dropped an empty ${clip.kind} clip`);
      return;
    }
    const final = path.join(clip.dir, eventName(clip.start, clip.kind, seconds));
    fs.renameSync(clip.tmp, final);
    this.lastError = null;
    this.opts.log.info(`${this.opts.slug()}: saved ${path.basename(final)}`);
  }
}
