import { describe, expect, it } from 'vitest';

import { decodeTopicData, parseJson, parseStreamLine } from '../../src/decode.js';
import { applyPatch, applyUpdate, isKeyframe, stripKeyframeMarkers } from '../../src/merge.js';
import { applyMessage, EMPTY_STATE, getTopic } from '../../src/state.js';
import { FULL_TOPICS, sessionFile } from '../helpers/fixtures.js';

describe('applyPatch', () => {
  it('merges objects recursively without mutating', () => {
    const target = { a: { b: 1, c: 2 }, d: { e: 3 } };
    const result = applyPatch(target, { a: { b: 9 } }) as typeof target;
    expect(result).toEqual({ a: { b: 9, c: 2 }, d: { e: 3 } });
    expect(target.a.b).toBe(1);
    expect(result.d).toBe(target.d);
  });

  it('replaces with arrays and scalars', () => {
    expect(applyPatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(applyPatch({ a: { b: 1 } }, { a: 'x' })).toEqual({ a: 'x' });
    expect(applyPatch({ a: 1 }, null)).toBeNull();
  });

  it('updates array items by index and appends one past the end', () => {
    const target = { Lines: [{ v: 1 }, { v: 2 }] };
    expect(applyPatch(target, { Lines: { '1': { v: 3 }, '2': { v: 4 } } })).toEqual({
      Lines: [{ v: 1 }, { v: 3 }, { v: 4 }],
    });
  });

  it('turns non-object targets into objects', () => {
    expect(applyPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(applyPatch(5, { a: 1 })).toEqual({ a: 1 });
  });

  it('removes _deleted keys and drops _kf', () => {
    const target = { PitTimes: { '44': { Duration: '20.1' }, '11': { Duration: '21.0' } } };
    expect(applyPatch(target, { PitTimes: { _deleted: ['44'] }, _kf: true })).toEqual({
      PitTimes: { '11': { Duration: '21.0' } },
    });
    expect(applyPatch({ Value: 'x', Position: 2 }, { Value: '', _deleted: ['Position'] })).toEqual({ Value: '' });
  });

  it('ignores _kf and _deleted inside array patches', () => {
    expect(applyPatch([1, 2], { _kf: true, _deleted: ['0'], '0': 5 })).toEqual([5, 2]);
  });

  it('rejects malformed _deleted and array keys', () => {
    expect(() => applyPatch({}, { _deleted: 'a' })).toThrow('_deleted is not an array.');
    expect(() => applyPatch({}, { _deleted: [1] })).toThrow('_deleted expected a string key.');
    expect(() => applyPatch([1], { x: 1 })).toThrow('non-index key');
  });
});

describe('applyUpdate / keyframes', () => {
  it('replaces state with a keyframe', () => {
    expect(isKeyframe({ _kf: true })).toBe(true);
    expect(isKeyframe({ _kf: false })).toBe(false);
    expect(isKeyframe([1])).toBe(false);
    expect(applyUpdate({ old: 1 }, { Utc: 'x', _kf: true })).toEqual({ Utc: 'x' });
    expect(applyUpdate({ old: 1 }, { Utc: 'x' })).toEqual({ old: 1, Utc: 'x' });
  });

  it('strips nested markers', () => {
    expect(stripKeyframeMarkers({ _kf: true, a: [{ _kf: true, b: 1 }], c: 2 })).toEqual({ a: [{ b: 1 }], c: 2 });
  });
});

/**
 * F1 publishes each topic's final state as a keyframe next to its stream.
 * Replaying the whole stream must reproduce it. ArchiveStatus, SessionInfo and
 * ExtrapolatedClock keyframes were updated after the stream ended, so they
 * are compared with that known difference.
 */
describe('merge reproduces F1 keyframes (Singapore 2026 race)', () => {
  const updatedAfterStream: Record<string, (state: Record<string, unknown>) => Record<string, unknown>> = {
    ArchiveStatus: (state) => ({ ...state, Status: 'Complete' }),
    SessionInfo: (state) => ({ ...state, ArchiveStatus: { Status: 'Complete' } }),
  };

  it.each(FULL_TOPICS.filter((topic) => topic !== 'ExtrapolatedClock'))('%s', (topic) => {
    let state: unknown;
    for (const text of sessionFile(`${topic}.jsonStream`).split('\n')) {
      const line = parseStreamLine(text);
      if (line) state = applyUpdate(state, decodeTopicData(topic, line.data));
    }
    const keyframe = stripKeyframeMarkers(parseJson(sessionFile(`${topic}.json`)));
    const adjust = updatedAfterStream[topic];
    expect(adjust ? adjust(state as Record<string, unknown>) : state).toEqual(keyframe);
  });

  it('ExtrapolatedClock keyframe is newer than its stream', () => {
    let state: unknown;
    for (const text of sessionFile('ExtrapolatedClock.jsonStream').split('\n')) {
      const line = parseStreamLine(text);
      if (line) state = applyUpdate(state, line.data);
    }
    expect(state).toMatchObject({ Remaining: '01:59:57', Extrapolating: true });
    expect(parseJson(sessionFile('ExtrapolatedClock.json'))).toMatchObject({ Remaining: '00:15:45' });
  });
});

describe('session state', () => {
  it('applies messages and reads topics', () => {
    const state = applyMessage(EMPTY_STATE, { topic: 'LapCount', utc: 0, data: { CurrentLap: 1 } });
    expect(getTopic(state, 'LapCount')).toEqual({ CurrentLap: 1 });
    expect(getTopic(EMPTY_STATE, 'LapCount')).toBeUndefined();
  });
});
