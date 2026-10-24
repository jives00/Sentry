import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipRecorder, MAX_CLIP_MS } from '../src/recorder';

/** A stand-in for ffmpeg: writes some bytes to its output path and exits 0 on 'q'. */
function fakeFfmpeg(bytes = 64 * 1024) {
  const spawned: string[][] = [];
  const spawn = (_cmd: string, args: string[]) => {
    spawned.push(args);
    const proc = new EventEmitter() as any;
    proc.exitCode = null;
    proc.stdin = new PassThrough();
    proc.stderr = new PassThrough();
    const out = args.at(-1)!;
    fs.writeFileSync(out, Buffer.alloc(bytes));
    proc.stdin.on('data', (d: Buffer) => {
      if (d.toString() === 'q') {
        proc.exitCode = 0;
        proc.emit('close', 0);
      }
    });
    proc.kill = () => {
      proc.exitCode = 137;
      proc.emit('close', null);
    };
    return proc;
  };
  return { spawn, spawned };
}

const log = { info: () => {}, warn: () => {} };

describe('ClipRecorder', () => {
  let root: string;
  let clock: number;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-rec-'));
    clock = new Date(2026, 9, 24, 14, 3, 12).getTime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const events = () => fs.readdirSync(path.join(root, 'front-door/2026/10/24/events'));
  const make = (ff = fakeFfmpeg()) =>
    new ClipRecorder({
      root,
      slug: () => 'front-door',
      rtspUrl: 'rtsp://ring/abc_live',
      postRoll: () => 20,
      log,
      spawn: ff.spawn as any,
      now: () => new Date(clock),
    });
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('records from motion on until post-roll after motion off', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    rec.motion(true);
    expect(rec.recording).toBe(true);
    expect(ff.spawned[0]).toContain('rtsp://ring/abc_live');

    await advance(10_000);
    rec.motion(false);
    await advance(19_000);
    expect(rec.recording).toBe(true);
    await advance(1_000);
    expect(rec.recording).toBe(false);
    expect(events()).toEqual(['14-03-12_motion_30s.mp4']);
  });

  it('keeps one clip when motion restarts during post-roll, and a ding relabels it', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    rec.motion(true);
    rec.motion(false);
    await advance(15_000);
    rec.motion(true);
    rec.ding(true);
    rec.motion(false);
    await advance(20_000);
    expect(ff.spawned).toHaveLength(1);
    expect(events()).toEqual(['14-03-12_ding_35s.mp4']);
  });

  it('records a ding with no motion for the post-roll', async () => {
    const rec = make();
    rec.ding(true);
    rec.ding(false);
    await advance(20_000);
    expect(events()).toEqual(['14-03-12_ding_20s.mp4']);
  });

  it('splits long events', async () => {
    const ff = fakeFfmpeg();
    const rec = make(ff);
    rec.motion(true);
    await advance(MAX_CLIP_MS);
    expect(ff.spawned).toHaveLength(2);
    expect(rec.recording).toBe(true);
    await rec.shutdown();
    expect(events()).toHaveLength(2);
  });

  it('drops a clip that never got data', async () => {
    const rec = make(fakeFfmpeg(100));
    rec.motion(true);
    rec.motion(false);
    await advance(20_000);
    expect(events()).toEqual([]);
  });
});
