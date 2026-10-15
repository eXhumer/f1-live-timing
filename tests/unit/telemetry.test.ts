import { describe, expect, it } from 'vitest';

import { lowerBound, TelemetryStore, upperBound } from '../../src/telemetry.js';

const car = (utc: string, cars: Record<string, Record<string, number>>) => ({
  topic: 'CarData',
  utc: Date.parse(utc),
  data: { Entries: [{ Utc: utc, Cars: Object.fromEntries(Object.entries(cars).map(([n, c]) => [n, { Channels: c }])) }] },
});

describe('TelemetryStore', () => {
  it('collects car samples and interpolates', () => {
    const store = new TelemetryStore();
    store.add(car('2026-01-01T00:00:01.000Z', { '1': { 0: 10000, 2: 200, 3: 6, 4: 100, 5: 0 } }));
    store.add(car('2026-01-01T00:00:00.000Z', { '1': { 0: 9000, 2: 100, 3: 5, 4: 0, 5: 100, 45: 8 } }));
    store.add({ topic: 'CarData', utc: 0, data: { Entries: [null, { Utc: 'x' }, { Utc: '2026-01-01T00:00:00Z', Cars: { '2': 1 } }] } });
    store.add({ topic: 'CarData', utc: 0, data: null });
    store.add({ topic: 'WeatherData', utc: 0, data: {} });
    expect(store.drivers()).toEqual(['1']);
    expect(store.car('1').map((s) => s.speed)).toEqual([100, 200]);
    expect(store.car('9')).toEqual([]);
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    expect(store.carAt('1', t0 - 1)).toBeUndefined();
    expect(store.carAt('1', t0 + 500)).toEqual({ utc: t0 + 500, rpm: 9500, speed: 150, gear: 5, throttle: 50, brake: 50, drs: 8 });
    expect(store.carAt('1', t0 + 2000)?.speed).toBe(200);
    expect(store.carAt('1', t0 + 1000)).not.toHaveProperty('drs');
    expect(store.carAt('1', t0 + 999.5)?.gear).toBe(5);
    expect(store.carRange('1', t0, t0)).toHaveLength(1);
  });

  it('fills missing channels with zero', () => {
    const store = new TelemetryStore();
    store.add(car('2026-01-01T00:00:00.000Z', { '4': {} }));
    store.add(car('2026-01-01T00:00:01.000Z', { '4': { 2: 10 } }));
    expect(store.carAt('4', Date.parse('2026-01-01T00:00:00.500Z'))).not.toHaveProperty('drs');
    expect(store.car('4')[0]).toEqual({ utc: Date.parse('2026-01-01T00:00:00Z'), rpm: 0, speed: 0, gear: 0, throttle: 0, brake: 0 });
  });

  it('collects positions and interpolates', () => {
    const store = new TelemetryStore();
    const pos = (ts: string, x: number) => ({
      topic: 'Position',
      utc: Date.parse(ts),
      data: { Position: [{ Timestamp: ts, Entries: { '16': { Status: 'OnTrack', X: x, Y: x * 2, Z: 1 }, '44': 'bad' } }] },
    });
    store.add(pos('2026-01-01T00:00:00.000Z', 0));
    store.add(pos('2026-01-01T00:00:02.000Z', 100));
    store.add({ topic: 'Position', utc: 0, data: { Position: [{ Timestamp: '2026-01-01T00:00:03Z', Entries: { '16': {} } }, 5] } });
    store.add({ topic: 'Position', utc: 0, data: {} });
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    expect(store.positionDrivers()).toEqual(['16']);
    expect(store.positionAt('16', t0 - 1)).toBeUndefined();
    expect(store.positionAt('16', t0 + 1000)).toEqual({ utc: t0 + 1000, status: 'OnTrack', x: 50, y: 100, z: 1 });
    expect(store.positionAt('16', t0 + 5000)).toEqual({ utc: t0 + 3000, status: '', x: 0, y: 0, z: 0 });
    expect(store.position('16')).toHaveLength(3);
    expect(store.positionRange('16', t0 + 1, t0 + 2000)).toHaveLength(1);
    store.clear();
    expect(store.drivers()).toEqual([]);
    expect(store.positionDrivers()).toEqual([]);
  });

  it('finds bounds', () => {
    const list = [1, 2, 2, 3].map((utc) => ({ utc }));
    expect(lowerBound(list, 2)).toBe(1);
    expect(upperBound(list, 2)).toBe(3);
    expect(lowerBound(list, 9)).toBe(4);
    expect(upperBound([], 0)).toBe(0);
  });
});
