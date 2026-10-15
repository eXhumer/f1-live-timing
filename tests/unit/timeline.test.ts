import { describe, expect, it, vi } from 'vitest';

import type { LiveTimingMessage } from '../../src/decode.js';
import { Timeline } from '../../src/timeline.js';

const msg = (utc: number, topic: string, data: unknown): LiveTimingMessage => ({ topic, utc, data });
const lap = (utc: number, n: number) => msg(utc, 'LapCount', { CurrentLap: n });

describe('Timeline', () => {
  it('starts empty', () => {
    const timeline = new Timeline();
    expect(timeline.start).toBeUndefined();
    expect(timeline.first).toBeUndefined();
    expect(timeline.last).toBeUndefined();
    expect(timeline.size).toBe(0);
    expect(timeline.topics()).toEqual([]);
    expect(timeline.latest()).toEqual({});
    timeline.insert([]);
    expect(timeline.size).toBe(0);
  });

  it('orders inserts and rebuilds the state at any time', () => {
    const timeline = new Timeline({ checkpointInterval: 10 });
    timeline.insert([lap(30, 3), lap(10, 1)]);
    timeline.insert([lap(20, 2), msg(20, 'TrackStatus', { Status: '1' })]);
    timeline.insert([lap(40, 4)]);
    timeline.insert([lap(5, 0), lap(50, 5)]);
    expect(timeline.messages().map((m) => m.utc)).toEqual([5, 10, 20, 20, 30, 40, 50]);
    expect(timeline.start).toBe(5);
    expect(new Timeline({ start: 1 }).start).toBe(1);
    expect(timeline.first).toBe(5);
    expect(timeline.last).toBe(50);
    expect(timeline.topics().sort()).toEqual(['LapCount', 'TrackStatus']);
    expect(timeline.latest()['LapCount']).toEqual({ CurrentLap: 5 });
    for (const [time, expected] of [[4, undefined], [5, 0], [25, 2], [35, 3], [99, 5]] as const) {
      expect((timeline.stateAt(time)['LapCount'] as { CurrentLap: number } | undefined)?.CurrentLap).toBe(expected);
    }
  });

  it('keeps arrival order for equal times', () => {
    const timeline = new Timeline();
    timeline.insert([lap(10, 1)]);
    timeline.insert([lap(10, 2)]);
    expect(timeline.latest()['LapCount']).toEqual({ CurrentLap: 2 });
  });

  it('notifies listeners and follows a live source', () => {
    let push: (message: LiveTimingMessage) => void = () => undefined;
    const unsubscribe = vi.fn();
    const timeline = Timeline.fromLive({
      subscribeMessages: (listener) => {
        push = listener;
        return unsubscribe;
      },
    });
    const listener = vi.fn();
    const off = timeline.subscribe(listener);
    push(lap(1, 1));
    expect(listener).toHaveBeenCalledWith(timeline);
    off();
    push(lap(2, 2));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(timeline.size).toBe(2);
    timeline[Symbol.dispose]();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('feeds the telemetry store', () => {
    const timeline = new Timeline();
    timeline.insert([
      msg(0, 'CarData', { Entries: [{ Utc: '2026-01-01T00:00:00Z', Cars: { '1': { Channels: { 2: 300 } } } }] }),
    ]);
    expect(timeline.telemetry.drivers()).toEqual(['1']);
  });
});

describe('Cursor', () => {
  function setup() {
    const timeline = new Timeline({ checkpointInterval: 10 });
    timeline.insert([lap(10, 1), lap(20, 2), msg(20, 'TrackStatus', { Status: '1' }), lap(30, 3)]);
    return { timeline, cursor: timeline.cursor() };
  }

  it('advances and reports updates per topic', () => {
    const { cursor } = setup();
    expect(cursor.time).toBe(-Infinity);
    const laps = vi.fn();
    const many = vi.fn();
    cursor.subscribe('LapCount', laps);
    cursor.subscribe(['LapCount', 'TrackStatus', 'WeatherData'], many);
    cursor.advanceTo(15);
    expect(laps).toHaveBeenLastCalledWith({ CurrentLap: 1 }, { updates: [lap(10, 1)], reset: false });
    expect(many).toHaveBeenLastCalledWith(['LapCount'], false);
    cursor.advanceTo(25);
    expect(laps.mock.lastCall?.[1].updates).toHaveLength(1);
    expect(many).toHaveBeenLastCalledWith(['LapCount', 'TrackStatus'], false);
    expect(cursor.get('TrackStatus')).toEqual({ Status: '1' });
    expect(cursor.time).toBe(25);
    expect(cursor.state['LapCount']).toEqual({ CurrentLap: 2 });
    cursor.advanceTo(26);
    expect(laps).toHaveBeenCalledTimes(2);
  });

  it('only calls single-topic subscribers for their topic', () => {
    const { cursor } = setup();
    const status = vi.fn();
    cursor.subscribe('TrackStatus', status);
    cursor.advanceTo(15);
    expect(status).not.toHaveBeenCalled();
  });

  it('seeks backwards with a reset', () => {
    const { cursor } = setup();
    const laps = vi.fn();
    const many = vi.fn();
    cursor.subscribe('LapCount', laps);
    cursor.subscribe(['WeatherData'], many);
    cursor.advanceTo(35);
    cursor.advanceTo(12);
    expect(laps).toHaveBeenLastCalledWith({ CurrentLap: 1 }, { updates: [], reset: true });
    expect(many).toHaveBeenLastCalledWith(['WeatherData'], true);
    const off = cursor.subscribe(['LapCount'], vi.fn());
    off();
  });

  it('seeks after an insert behind it', () => {
    const { timeline, cursor } = setup();
    cursor.advanceTo(25);
    timeline.insert([lap(40, 4)]);
    const laps = vi.fn();
    cursor.subscribe('LapCount', laps);
    cursor.advanceTo(45);
    expect(laps.mock.lastCall?.[1].reset).toBe(false);
    timeline.insert([lap(15, 9)]);
    cursor.advanceTo(46);
    expect(laps.mock.lastCall?.[1].reset).toBe(true);
    expect(cursor.get('LapCount')).toEqual({ CurrentLap: 4 });
    cursor.seek(16);
    expect(cursor.get('LapCount')).toEqual({ CurrentLap: 9 });
  });

  it('rethrows subscriber errors after notifying everyone', () => {
    const { cursor } = setup();
    const after = vi.fn();
    const offA = cursor.subscribe('LapCount', () => {
      throw new Error('a');
    });
    cursor.subscribe(['LapCount'], after);
    expect(() => cursor.advanceTo(10)).toThrow('a');
    expect(after).toHaveBeenCalled();
    cursor.subscribe('LapCount', () => {
      throw new Error('b');
    });
    expect(() => cursor.advanceTo(20)).toThrow(AggregateError);
    offA();
  });

  it('stops after dispose', () => {
    const { timeline, cursor } = setup();
    cursor.dispose();
    expect(() => cursor.advanceTo(1)).toThrow('Cursor is disposed.');
    const other = timeline.cursor();
    other[Symbol.dispose]();
    expect(() => other.seek(1)).toThrow();
    timeline.insert([lap(1, 0)]);
  });

  it('follows the end of the timeline', () => {
    const { timeline, cursor } = setup();
    const laps = vi.fn();
    cursor.subscribe('LapCount', laps);
    cursor.follow();
    expect(cursor.following).toBe(true);
    expect(cursor.time).toBe(30);
    expect(laps).toHaveBeenLastCalledWith({ CurrentLap: 3 }, { updates: [lap(10, 1), lap(20, 2), lap(30, 3)], reset: false });

    timeline.insert([lap(40, 4)]);
    expect(cursor.time).toBe(40);
    expect(laps).toHaveBeenLastCalledWith({ CurrentLap: 4 }, { updates: [lap(40, 4)], reset: false });

    timeline.insert([lap(25, 9)]);
    expect(laps.mock.lastCall?.[1].reset).toBe(true);
    expect(cursor.get('LapCount')).toEqual({ CurrentLap: 4 });

    cursor.seek(15);
    expect(cursor.following).toBe(false);
    timeline.insert([lap(50, 5)]);
    expect(cursor.time).toBe(15);

    cursor.follow();
    cursor.advanceTo(55);
    expect(cursor.following).toBe(false);
    timeline.insert([lap(60, 6)]);
    expect(cursor.get('LapCount')).toEqual({ CurrentLap: 5 });
  });

  it('follows an empty timeline until data arrives', () => {
    const timeline = new Timeline();
    const cursor = timeline.cursor();
    cursor.follow();
    expect(cursor.time).toBe(-Infinity);
    const listener = vi.fn(() => expect(cursor.get('LapCount')).toEqual({ CurrentLap: 1 }));
    timeline.subscribe(listener);
    timeline.insert([lap(1, 1)]);
    expect(listener).toHaveBeenCalled();
    cursor.dispose();
    expect(cursor.following).toBe(false);
    expect(() => cursor.follow()).toThrow('Cursor is disposed.');
  });

  it('keeps inserting when a following subscriber throws', () => {
    const timeline = new Timeline();
    const a = timeline.cursor();
    const b = timeline.cursor();
    const c = timeline.cursor();
    const ok = vi.fn();
    a.subscribe('LapCount', () => {
      throw new Error('a');
    });
    c.subscribe('LapCount', ok);
    a.follow();
    c.follow();
    expect(() => timeline.insert([lap(1, 1)])).toThrow('a');
    expect(ok).toHaveBeenCalled();
    expect(timeline.size).toBe(1);
    b.follow();
    b.subscribe('LapCount', () => {
      throw new Error('b');
    });
    expect(() => timeline.insert([lap(2, 2)])).toThrow(AggregateError);
  });
});
