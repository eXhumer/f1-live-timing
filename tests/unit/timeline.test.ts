import { describe, expect, it, vi } from 'vitest';

import type { LiveTimingMessage } from '../../src/decode.js';
import { type HubConnectionLike, LiveClient } from '../../src/live.js';
import { Timeline } from '../../src/timeline.js';
import { liveSessionSwitch } from '../helpers/fixtures.js';

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

  it('clears everything to start a new session', () => {
    const timeline = new Timeline({ start: 1 });
    const car = msg(10, 'CarData', { Entries: [{ Utc: '1970-01-01T00:00:00.010Z', Cars: { '1': { Channels: { 2: 100 } } } }] });
    timeline.insert([lap(5, 1), car, lap(20, 2)]);
    const following = timeline.cursor();
    const parked = timeline.cursor();
    const unmoved = timeline.cursor();
    following.follow();
    parked.seek(15);
    const followingCalls: [unknown, boolean][] = [];
    following.subscribe('LapCount', (state, { reset }) => followingCalls.push([state, reset]));
    const parkedCalls: boolean[] = [];
    parked.subscribe('LapCount', (_, { reset }) => parkedCalls.push(reset));
    const listener = vi.fn();
    timeline.subscribe(listener);

    timeline.clear();
    expect(timeline.size).toBe(0);
    expect(timeline.start).toBeUndefined();
    expect(timeline.latest()).toEqual({});
    expect(timeline.telemetry.drivers()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(followingCalls).toEqual([[undefined, true]]);
    expect(following.state).toEqual({});
    expect(parkedCalls).toEqual([]);

    timeline.insert([lap(30, 1)]);
    expect(following.get('LapCount')).toEqual({ CurrentLap: 1 });
    parked.advanceTo(40);
    expect(parkedCalls).toEqual([true]);
    expect(parked.get('LapCount')).toEqual({ CurrentLap: 1 });
    unmoved.advanceTo(40);
    expect(unmoved.get('LapCount')).toEqual({ CurrentLap: 1 });
    expect(timeline.stateAt(35)['LapCount']).toEqual({ CurrentLap: 1 });
  });

  it('rethrows following subscriber errors after clearing', () => {
    const timeline = new Timeline();
    timeline.insert([lap(1, 1)]);
    const cursor = timeline.cursor();
    cursor.follow();
    cursor.subscribe('LapCount', () => {
      throw new Error('boom');
    });
    expect(() => timeline.clear()).toThrow('boom');
    expect(timeline.size).toBe(0);
  });

  it('clears a live timeline when the hub moves on to the next session', async () => {
    const { snapshot, feeds } = liveSessionSwitch();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const hub: HubConnectionLike = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      invoke: <T>() => Promise.resolve(snapshot as T),
      on: (method, handler) => handlers.set(method, handler),
      onclose: () => undefined,
      onreconnecting: () => undefined,
      onreconnected: () => undefined,
    };
    const feed = handlers.get.bind(handlers, 'feed') as () => (...args: unknown[]) => void;
    const live = await LiveClient.connect({ connectionFactory: () => hub });

    const timeline = Timeline.fromLive(live);
    const kept = Timeline.fromLive(live, { clearOnSessionChange: false });
    for (const t of [timeline, kept]) t.insert(live.snapshot);
    const cursor = timeline.cursor();
    cursor.follow();
    expect(cursor.get('TeamRadio')?.Captures).toHaveLength(8);
    expect(timeline.telemetry.drivers().length).toBeGreaterThan(0);

    for (const [topic, data, ts] of feeds) feed()(topic, data, ts);
    timeline[Symbol.dispose]();
    kept[Symbol.dispose]();

    expect(timeline.first).toBe(live.session!.utc);
    expect(timeline.size).toBe(feeds.length);
    expect(timeline.telemetry.drivers()).toEqual([]);
    expect(cursor.get('SessionInfo')?.Name).toBe('Practice 2');
    // Practice 1's radio is gone; F1 only resets it with Practice 2's first clip.
    expect(cursor.get('TeamRadio')).toBeUndefined();
    expect(cursor.get('TrackStatus')).toEqual({ Status: '1', Message: 'AllClear' });
    expect(kept.size).toBe(live.snapshot.length + feeds.length);
    expect((kept.latest()['TeamRadio'] as { Captures: unknown[] }).Captures).toHaveLength(8);
  });

  it('applies a late message of another topic in place instead of rebuilding', () => {
    const timeline = new Timeline({ checkpointInterval: 1 });
    timeline.insert([lap(10, 1), msg(20, 'TrackStatus', { Status: '1' })]);
    const following = timeline.cursor();
    const parked = timeline.cursor();
    const stale = timeline.cursor();
    following.follow();
    parked.seek(25);
    stale.seek(25);
    const calls: [number[], boolean][] = [];
    following.subscribe('LapCount', (_, { updates, reset }) => calls.push([updates.map((m) => m.utc), reset]));
    const parkedCalls: [number[], boolean][] = [];
    parked.subscribe(['LapCount', 'TrackStatus'], (changed, reset) => parkedCalls.push([changed.length, reset] as never));

    // Same topic out of order: a rebuild.
    timeline.insert([lap(5, 0)]);
    expect(calls).toEqual([[[], true]]);
    // Another topic out of order: applied in place.
    timeline.insert([lap(15, 2)]);
    timeline.insert([msg(12, 'WeatherData', { AirTemp: '30' })]);
    expect(calls).toEqual([[[], true], [[15], false]]);
    expect(following.get('LapCount')).toEqual({ CurrentLap: 2 });
    expect(timeline.stateAt(14)['LapCount']).toEqual({ CurrentLap: 1 });
    expect(timeline.stateAt(14)['WeatherData']).toEqual({ AirTemp: '30' });

    parked.advanceTo(30);
    expect(parkedCalls).toEqual([[2, true]]);
    stale.advanceTo(30);
    expect(stale.state).toEqual(timeline.latest());
    expect(parked.state).toEqual(timeline.latest());

    // A cursor already due for a rebuild takes late messages in with it.
    stale.seek(30);
    timeline.insert([lap(1, -1)]);
    timeline.insert([msg(0, 'SessionStatus', { Status: 'Started' })]);
    stale.advanceTo(30);
    expect(stale.state).toEqual(timeline.latest());
  });

  it('matches a timeline built in order, whatever the arrival order', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const topics = ['A', 'B', 'C'];
    const arrivals: LiveTimingMessage[] = [];
    for (let i = 0; i < 400; i += 1) {
      const topic = topics[Math.floor(random() * topics.length)]!;
      arrivals.push(msg(Math.floor(random() * 1_000), topic, { [String(i % 7)]: i, Last: i }));
    }
    const timeline = new Timeline({ checkpointInterval: 50 });
    const following = timeline.cursor();
    following.follow();
    const parked = timeline.cursor();
    parked.seek(0);
    for (const [i, message] of arrivals.entries()) {
      timeline.insert([message]);
      if (i % 37 === 0) {
        parked.advanceTo(parked.time + Math.floor(random() * 200));
        expect(parked.state).toEqual(timeline.stateAt(parked.time));
      }
      expect(following.state).toEqual(timeline.latest());
    }
    const ordered = new Timeline();
    ordered.insert(arrivals);
    expect(timeline.messages()).toEqual(ordered.messages());
    for (const time of [0, 100, 333, 500, 999]) expect(timeline.stateAt(time)).toEqual(ordered.stateAt(time));
    expect(timeline.latest()).toEqual(ordered.latest());
    expect(following.state).toEqual(ordered.latest());
    parked.advanceTo(2_000);
    expect(parked.state).toEqual(ordered.latest());
  });
});
