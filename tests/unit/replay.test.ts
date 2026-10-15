import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArchiveClient } from '../../src/archive.js';
import { loadRecording, loadReplay } from '../../src/replay.js';
import { archiveAgent, SESSION_DIR, SESSION_PATH, SESSION_START } from '../helpers/fixtures.js';

let agent: MockAgent;
let archive: ArchiveClient;

beforeEach(() => {
  agent = archiveAgent();
  archive = new ArchiveClient({ dispatcher: agent });
});

afterEach(async () => {
  await agent.close();
});

describe('loadReplay', () => {
  it('loads the requested topics and reports missing ones', async () => {
    const loaded = vi.fn();
    const { timeline, missing } = await loadReplay(archive, SESSION_PATH, {
      topics: ['LapCount', 'TimingData', 'CarData.z', 'NotATopic'],
      checkpointInterval: 60_000,
      onTopicLoaded: loaded,
    });
    expect([...missing].sort()).toEqual(['NotATopic', 'TimingData']);
    expect(loaded).toHaveBeenCalledWith('LapCount', expect.any(Number));
    expect(timeline.start).toBeCloseTo(SESSION_START, 0);
    expect(timeline.topics().sort()).toEqual(['CarData', 'LapCount']);
    expect(timeline.latest()['LapCount']).toEqual({ CurrentLap: 62, TotalLaps: 62 });
    expect(timeline.telemetry.drivers().length).toBeGreaterThan(0);
  });

  it('loads every available topic with a given start', async () => {
    const { timeline, missing } = await loadReplay(archive, SESSION_PATH, { start: 0, raw: true });
    expect(timeline.start).toBe(0);
    expect(missing).toContain('TimingData');
    expect(missing).not.toContain('LapCount');
    expect(timeline.topics().length).toBeGreaterThan(20);
    expect(timeline.messages().find((m) => m.topic === 'Position')?.raw).toEqual(expect.any(String));
  });

  it('loads everything by default', async () => {
    const { timeline } = await loadReplay(archive, SESSION_PATH);
    expect(timeline.start).toBeCloseTo(SESSION_START, 0);
  });

  it('rethrows other errors', async () => {
    const broken = new ArchiveClient({ dispatcher: agent });
    vi.spyOn(broken, 'stream').mockImplementation(async function* () {
      yield* [];
      throw new Error('boom');
    });
    await expect(loadReplay(broken, SESSION_PATH, { start: 0, topics: ['LapCount'] })).rejects.toThrow('boom');
  });
});

describe('loadRecording', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'f1lt-'));
    await cp(SESSION_DIR, dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a downloaded archive and finds the start from CarData', async () => {
    const timeline = await loadRecording(dir, { topics: ['LapCount', 'CarData'], checkpointInterval: 60_000 });
    expect(timeline.start).toBeCloseTo(SESSION_START, 0);
    expect(timeline.latest()['LapCount']).toEqual({ CurrentLap: 62, TotalLaps: 62 });
  });

  it('reads CarData for the start even when it is not loaded', async () => {
    const timeline = await loadRecording(dir, { topics: ['LapCount'], raw: true });
    expect(timeline.start).toBeCloseTo(SESSION_START, 0);
    expect(timeline.topics()).toEqual(['LapCount']);
  });

  it('prefers options.start, then Recording.json', async () => {
    expect((await loadRecording(dir, { topics: ['LapCount'], start: 5 })).start).toBe(5);
    await writeFile(join(dir, 'Recording.json'), '{"Start":"2026-01-01T00:00:00.000Z"}');
    expect((await loadRecording(dir, { topics: ['LapCount'] })).start).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('fails without any start', async () => {
    await writeFile(join(dir, 'CarData.z.jsonStream'), '');
    await expect(loadRecording(dir, { topics: ['LapCount'] })).rejects.toThrow('Cannot find the start instant');
    await rm(join(dir, 'CarData.z.jsonStream'));
    await expect(loadRecording(dir, { topics: ['LapCount'] })).rejects.toThrow('Cannot find the start instant');
    await writeFile(join(dir, 'CarData.z.jsonStream'), '00:00:00.000"q64FAA=="');
    await expect(loadRecording(dir, { topics: ['LapCount'] })).rejects.toThrow('Cannot find the start instant');
  });

  it('skips topics whose stream is missing', async () => {
    const timeline = await loadRecording(dir);
    expect(timeline.topics()).not.toContain('TimingData');
    expect(timeline.topics()).toContain('WeatherData');
  });

  it('rethrows other read errors', async () => {
    await writeFile(join(dir, 'Recording.json'), 'nope');
    await expect(loadRecording(dir, { topics: ['LapCount'] })).rejects.toThrow(SyntaxError);
    await rm(join(dir, 'Recording.json'));
    await cp(SESSION_DIR, join(dir, 'Recording.json'), { recursive: true });
    await expect(loadRecording(dir, { topics: ['LapCount'] })).rejects.toThrow('EISDIR');
  });
});
