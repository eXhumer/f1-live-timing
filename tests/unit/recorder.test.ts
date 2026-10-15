import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseStreamLine, streamLineToMessage } from '../../src/decode.js';
import { Recorder, RECORDING_FILE } from '../../src/recorder.js';
import { loadRecording } from '../../src/replay.js';
import { SESSION_START, sessionFile } from '../helpers/fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'f1lt-rec-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixtureMessages(wire: string, raw: boolean) {
  return sessionFile(`${wire}.jsonStream`)
    .split('\n')
    .map(parseStreamLine)
    .filter((line) => line !== null)
    .map((line) => streamLineToMessage(wire, line, SESSION_START, raw));
}

describe('Recorder', () => {
  it('writes the archive format byte for byte from raw messages', async () => {
    const recorder = await Recorder.create(join(dir, 'session'), { start: SESSION_START });
    expect(recorder.start).toBe(SESSION_START);
    for (const wire of ['LapCount', 'CarData.z', 'TrackStatus']) {
      for (const message of fixtureMessages(wire, true)) recorder.write(message);
    }
    await recorder.close();
    await recorder.close();
    expect(() => recorder.write({ topic: 'LapCount', utc: 0, data: {} })).toThrow('Recorder is closed.');

    const out = (name: string) => readFile(join(dir, 'session', name), 'utf8');
    for (const wire of ['LapCount', 'TrackStatus']) {
      expect(await out(`${wire}.jsonStream`)).toBe(sessionFile(`${wire}.jsonStream`).replace(/\r\n$/, '') + '\r\n');
      expect(JSON.parse((await out(`${wire}.json`)).slice(1))).toEqual(JSON.parse(sessionFile(`${wire}.json`).slice(1)));
    }
    expect(await out('CarData.z.jsonStream')).toBe(sessionFile('CarData.z.jsonStream').replace(/\r\n$/, '') + '\r\n');
    expect(JSON.parse((await out('Index.json')).slice(1))).toEqual({
      Feeds: {
        LapCount: { KeyFramePath: 'LapCount.json', StreamPath: 'LapCount.jsonStream' },
        'CarData.z': { KeyFramePath: 'CarData.z.json', StreamPath: 'CarData.z.jsonStream' },
        TrackStatus: { KeyFramePath: 'TrackStatus.json', StreamPath: 'TrackStatus.jsonStream' },
      },
    });
    expect(JSON.parse(await out(RECORDING_FILE))).toEqual({ Start: new Date(SESSION_START).toISOString() });
  });

  it('round-trips decoded messages through loadRecording', async () => {
    const messages = [...fixtureMessages('Position.z', false), ...fixtureMessages('WeatherData', false)];
    {
      await using recorder = await Recorder.create(dir);
      for (const message of messages) recorder.write(message);
      expect(recorder.start).toBe(messages[0]!.utc);
    }
    const timeline = await loadRecording(dir);
    expect(timeline.messages().map(({ topic, utc, data }) => ({ topic, utc, data }))).toEqual(
      [...messages].sort((a, b) => a.utc - b.utc),
    );
  });

  it('writes nothing but Index.json when empty', async () => {
    const recorder = await Recorder.create(dir);
    await recorder.close();
    expect(JSON.parse((await readFile(join(dir, 'Index.json'), 'utf8')).slice(1))).toEqual({ Feeds: {} });
    await expect(readFile(join(dir, RECORDING_FILE))).rejects.toThrow('ENOENT');
  });

  it('reports stream errors on close', async () => {
    const recorder = await Recorder.create(join(dir, 'gone'));
    await rm(join(dir, 'gone'), { recursive: true });
    recorder.write({ topic: 'LapCount', utc: 0, data: {} });
    await expect(recorder.close()).rejects.toThrow('ENOENT');
  });
});
