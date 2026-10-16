import { HubConnectionBuilder } from '@exhumer/signalr-client';
import { MockAgent } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { type HubConnectionLike, LIVE_URL, LiveClient, LogLevel, snapshotTime } from '../../src/live.js';
import { Timeline } from '../../src/timeline.js';
import { LIVE_TOPICS } from '../../src/topics.js';
import { liveFeed } from '../helpers/fixtures.js';

class FakeHub implements HubConnectionLike {
  readonly invocations: [string, unknown[]][] = [];
  readonly handlers = new Map<string, (...args: never[]) => unknown>();
  close?: (error?: Error) => void;
  reconnecting?: (error?: Error) => void;
  reconnected?: (id: string | null) => void;
  snapshot: unknown = liveFeed().snapshot;
  failUnsubscribe = false;
  failSubscribe = false;

  start = vi.fn(() => Promise.resolve());
  stop = vi.fn(() => {
    this.close?.();
    return Promise.resolve();
  });

  invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    this.invocations.push([method, args]);
    if (method === 'Unsubscribe' && this.failUnsubscribe) return Promise.reject(new Error('gone'));
    if (method === 'Subscribe' && this.failSubscribe) return Promise.reject('nope');
    return Promise.resolve((method === 'Subscribe' ? this.snapshot : undefined) as T);
  }

  on(method: string, handler: (...args: never[]) => unknown): void {
    this.handlers.set(method, handler);
  }
  onclose(callback: (error?: Error) => void): void {
    this.close = callback;
  }
  onreconnecting(callback: (error?: Error) => void): void {
    this.reconnecting = callback;
  }
  onreconnected(callback: (id: string | null) => void): void {
    this.reconnected = callback;
  }

  feed(topic: string, data: unknown, timestamp?: string): void {
    (this.handlers.get('feed') as (...args: unknown[]) => void)(topic, data, timestamp);
  }
}

async function connect(options: Parameters<typeof LiveClient.connect>[0] = {}) {
  const hub = new FakeHub();
  let url = '';
  const client = await LiveClient.connect({
    ...options,
    connectionFactory: (u) => {
      url = u;
      return hub;
    },
  });
  return { hub, client, url };
}

describe('LiveClient', () => {
  it('skips auth topics without a token', async () => {
    const { client, url, hub } = await connect();
    expect(url).toBe(LIVE_URL);
    expect([...client.skippedTopics].sort()).toEqual(['CarData', 'Position']);
    expect(client.topics).not.toContain('CarData');
    expect(hub.invocations[0]![1][0]).not.toContain('CarData.z');
    expect(client.status).toBe('connected');
  });

  it('subscribes to compressed topics with a token', async () => {
    const { client, url, hub } = await connect({ authToken: 'abc', topics: ['CarData.z', 'LapCount'] });
    expect(new URL(url).searchParams.get('authToken')).toBe('abc');
    expect(client.topics).toEqual(['CarData', 'LapCount']);
    expect(client.skippedTopics).toEqual([]);
    expect(hub.invocations[0]).toEqual(['Subscribe', [['CarData.z', 'LapCount']]]);
  });

  it('turns feed updates into messages', async () => {
    const { feeds } = liveFeed();
    const { client, hub } = await connect({ authToken: 't', raw: true });
    const timeline = Timeline.fromLive(client);
    for (const [topic, data, ts] of feeds) hub.feed(topic, data, ts);
    timeline[Symbol.dispose]();
    expect(timeline.size).toBe(feeds.length);
    expect(timeline.messages().some((m) => m.topic === 'CarData' && typeof m.raw === 'string')).toBe(true);
    expect(timeline.messages().find((m) => m.topic === 'TimingData')?.raw).toBeUndefined();
    expect(timeline.telemetry.drivers().length).toBeGreaterThan(0);
  });

  it('keeps the connect-time snapshot for listeners that attach later', async () => {
    const { snapshot } = liveFeed();
    const { client, hub } = await connect({ authToken: 't', raw: true });
    expect(client.snapshot.map((m) => m.topic).sort()).toEqual(
      Object.keys(snapshot).map((w) => w.replace(/\.z$/, '')).sort(),
    );
    expect(client.snapshot.every((m) => (m.data as { _kf?: boolean })._kf === true)).toBe(true);
    expect(new Set(client.snapshot.map((m) => m.utc)).size).toBe(1);
    expect(client.snapshot.some((m) => m.topic === 'CarData' && typeof m.raw === 'string')).toBe(true);

    // Inserting it into a timeline that was created after connect gives the full state.
    const timeline = Timeline.fromLive(client);
    timeline.insert(client.snapshot);
    for (const [topic, data, ts] of liveFeed().feeds) hub.feed(topic, data, ts);
    timeline[Symbol.dispose]();
    expect(timeline.size).toBe(client.snapshot.length + liveFeed().feeds.length);
  });

  it('does not replace the snapshot after a reconnect, and is empty when the hub sent nothing', async () => {
    const { client, hub } = await connect({ authToken: 't' });
    const first = client.snapshot;
    hub.reconnected?.('id');
    await vi.waitFor(() => expect(hub.invocations.filter(([method]) => method === 'Subscribe')).toHaveLength(2));
    expect(client.snapshot).toBe(first);

    const empty = new FakeHub();
    empty.snapshot = null;
    expect((await LiveClient.connect({ connectionFactory: () => empty })).snapshot).toEqual([]);
  });

  it('delivers a fresh snapshot as keyframes after a reconnect', async () => {
    const { snapshot } = liveFeed();
    const { client, hub } = await connect({ authToken: 't' });
    const messages: { topic: string; utc: number; data: unknown }[] = [];
    const statuses: string[] = [];
    client.subscribeMessages((m) => messages.push(m));
    client.subscribeStatus((s) => statuses.push(s));
    hub.reconnecting?.(new Error('drop'));
    expect(client.status).toBe('reconnecting');
    hub.reconnected?.('id');
    await vi.waitFor(() => expect(statuses).toEqual(['reconnecting', 'connected']));
    expect(hub.invocations.filter(([method]) => method === 'Subscribe')).toHaveLength(2);
    expect(messages.map((m) => m.topic).sort()).toEqual(Object.keys(snapshot).map((w) => w.replace(/\.z$/, '')).sort());
    const expected = snapshotTime(new Map(messages.map((m) => [m.topic, m.data])));
    expect(messages.every((m) => m.utc === expected)).toBe(true);
    expect(messages.every((m) => (m.data as { _kf?: boolean })._kf === true)).toBe(true);
  });

  it('reports a failed resubscribe as still reconnecting', async () => {
    const { client, hub } = await connect();
    const statuses: [string, Error | undefined][] = [];
    client.subscribeStatus((s, e) => statuses.push([s, e]));
    hub.failSubscribe = true;
    hub.reconnected?.(null);
    await vi.waitFor(() => expect(statuses[0]?.[0]).toBe('reconnecting'));
    expect(statuses[0]?.[1]?.message).toBe('nope');
  });

  it('ignores an empty snapshot and non-object topics', async () => {
    const hub = new FakeHub();
    hub.snapshot = null;
    const client = await LiveClient.connect({ connectionFactory: () => hub });
    const seen = vi.fn();
    client.subscribeMessages(seen);
    hub.snapshot = { LapCount: 5 };
    hub.reconnected?.(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).not.toHaveBeenCalled();
  });

  it('stamps feed updates without a timestamp with the current time', async () => {
    const { client, hub } = await connect();
    const seen = vi.fn();
    client.subscribeMessages(seen);
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    hub.feed('LapCount', { CurrentLap: 2 });
    vi.restoreAllMocks();
    expect(seen).toHaveBeenCalledWith({ topic: 'LapCount', utc: 1234, data: { CurrentLap: 2 } });
  });

  it('iterates messages until closed', async () => {
    const { client, hub } = await connect();
    const iterator = client.messages();
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    hub.feed('LapCount', { CurrentLap: 1 }, '2026-01-01T00:00:00Z');
    expect((await iterator.next()).value?.data).toEqual({ CurrentLap: 1 });
    const waiting = iterator.next();
    hub.feed('LapCount', { CurrentLap: 2 }, '2026-01-01T00:00:01Z');
    expect((await waiting).value?.data).toEqual({ CurrentLap: 2 });
    const last = iterator.next();
    const statuses = vi.fn();
    client.subscribeStatus(statuses);
    hub.failUnsubscribe = true;
    await client.close();
    expect(await last).toEqual({ value: undefined, done: true });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(statuses).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenCalledWith('closed', undefined);
    expect(hub.invocations.at(-1)?.[0]).toBe('Unsubscribe');
    await client.close();
    expect(hub.stop).toHaveBeenCalledTimes(1);
    expect(await client.messages().next()).toEqual({ value: undefined, done: true });
  });

  it('stops buffering when the loop breaks', async () => {
    const { client, hub } = await connect();
    const received: unknown[] = [];
    const loop = (async () => {
      for await (const message of client.messages()) {
        received.push(message.data);
        break;
      }
    })();
    hub.feed('LapCount', { CurrentLap: 1 }, '2026-01-01T00:00:00Z');
    await loop;
    hub.feed('LapCount', { CurrentLap: 2 }, '2026-01-01T00:00:01Z');
    expect(received).toEqual([{ CurrentLap: 1 }]);
  });

  it('reports a server-side close', async () => {
    const { client, hub } = await connect();
    const statuses = vi.fn();
    const off = client.subscribeStatus(statuses);
    hub.close?.(new Error('bye'));
    expect(client.status).toBe('closed');
    expect(statuses).toHaveBeenCalledWith('closed', new Error('bye'));
    off();
  });

  it('builds a real SignalR connection by default', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://livetiming.formula1.com')
      .intercept({ path: () => true, method: () => true })
      .reply(503, 'down')
      .persist();
    await expect(LiveClient.connect({ dispatcher: agent, logger: LogLevel.None, topics: ['LapCount'] })).rejects.toThrow();
    await agent.close();
  });

  it('builds a cookie-aware connection by default', async () => {
    const hub = new FakeHub();
    const build = vi.spyOn(HubConnectionBuilder.prototype, 'build').mockReturnValue(hub as never);
    try {
      const client = await LiveClient.connect();
      expect(client.topics).toEqual(LIVE_TOPICS.filter((topic) => topic !== 'CarData' && topic !== 'Position'));
      expect(build).toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it('wraps an Error from a failed resubscribe as is', async () => {
    const { client, hub } = await connect();
    const statuses: (Error | undefined)[] = [];
    client.subscribeStatus((_, e) => statuses.push(e));
    const error = new Error('denied');
    hub.invoke = () => Promise.reject(error);
    hub.reconnected?.(null);
    await vi.waitFor(() => expect(statuses).toEqual([error]));
  });
});

describe('snapshotTime', () => {
  it('uses the newest sample time', () => {
    expect(
      snapshotTime(
        new Map<string, unknown>([
          ['CarData', { Entries: [{ Utc: '2026-01-01T00:00:01Z' }] }],
          ['Position', { Position: [{ Timestamp: '2026-01-01T00:00:02Z' }] }],
          ['ExtrapolatedClock', { Utc: '2026-01-01T00:00:00Z' }],
        ]),
      ),
    ).toBe(Date.parse('2026-01-01T00:00:02Z'));
  });

  it('falls back to Heartbeat minus its lead, then now', () => {
    expect(snapshotTime(new Map([['Heartbeat', { Utc: '2026-01-01T00:00:10Z' }]]))).toBe(
      Date.parse('2026-01-01T00:00:08Z'),
    );
    expect(snapshotTime(new Map<string, unknown>([['CarData', { Entries: [] }], ['Heartbeat', {}]]), 7)).toBe(7);
    expect(snapshotTime(new Map<string, unknown>([['CarData', { Entries: [{}] }], ['ExtrapolatedClock', 1]]), 8)).toBe(8);
  });
});
