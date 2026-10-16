import { HubConnectionBuilder, type ILogger, LogLevel, NullLogger } from '@exhumer/signalr-client';
import type { Dispatcher } from 'undici';

import { decodeTopicData, type LiveTimingMessage } from './decode.js';
import { isPlainObject } from './merge.js';
import { parseUtc } from './time.js';
import { AUTH_TOPICS, fromWireTopic, isCompressedTopic, LIVE_TOPICS, toWireTopic, type Topic } from './topics.js';

/** F1 live timing SignalR Core hub. */
export const LIVE_URL = 'https://livetiming.formula1.com/signalrcore';

/** The parts of a SignalR `HubConnection` the live client uses. */
export interface HubConnectionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T = void>(methodName: string, ...args: unknown[]): Promise<T>;
  on(methodName: string, handler: (...args: never[]) => unknown): void;
  onclose(callback: (error?: Error) => void): void;
  onreconnecting(callback: (error?: Error) => void): void;
  onreconnected(callback: (connectionId: string | null) => void): void;
}

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface LiveClientOptions {
  /**
   * F1 subscription token (the ascendon / `subscriptionToken`). Without it the
   * hub does not send `CarData` or `Position`, so those topics are left out.
   */
  readonly authToken?: string;
  /** Topics to subscribe to. Default {@link LIVE_TOPICS}. */
  readonly topics?: readonly Topic[];
  /** Default {@link LIVE_URL}. */
  readonly url?: string;
  /** undici dispatcher for the connection. Default: a cookie-aware agent. */
  readonly dispatcher?: Dispatcher;
  /** SignalR log level or logger. Default: no logging. */
  readonly logger?: LogLevel | ILogger;
  /** Keep the original base64 string of compressed topics in `raw` (for recording). */
  readonly raw?: boolean;
  /** Replace the SignalR connection, for tests or a custom transport. */
  readonly connectionFactory?: (url: string) => HubConnectionLike;
}

type MessageListener = (message: LiveTimingMessage) => void;
type StatusListener = (status: LiveStatus, error?: Error) => void;

/**
 * Live F1 timing over SignalR Core.
 *
 * {@link LiveClient.connect} resolves once the subscription snapshot has
 * arrived. The snapshot is delivered as one keyframe message per topic, then
 * each `feed` update as a message. Listeners added after `connect` resolves
 * miss that first snapshot; read it from {@link LiveClient.snapshot}. After a
 * reconnect the client subscribes again and delivers a fresh snapshot.
 */
export class LiveClient {
  /** Topics actually subscribed to. */
  readonly topics: readonly Topic[];
  /** Requested topics left out because they need an `authToken`. */
  readonly skippedTopics: readonly Topic[];

  readonly #connection: HubConnectionLike;
  readonly #raw: boolean;
  readonly #messageListeners = new Set<MessageListener>();
  readonly #statusListeners = new Set<StatusListener>();
  readonly #queues = new Set<MessageQueue>();
  #snapshot: readonly LiveTimingMessage[] | undefined;
  #status: LiveStatus = 'connecting';
  #closing = false;

  private constructor(connection: HubConnectionLike, topics: readonly Topic[], skipped: readonly Topic[], raw: boolean) {
    this.#connection = connection;
    this.topics = topics;
    this.skippedTopics = skipped;
    this.#raw = raw;
  }

  /** Connect, subscribe and wait for the first snapshot. */
  static async connect(options: LiveClientOptions = {}): Promise<LiveClient> {
    const requested = (options.topics ?? LIVE_TOPICS).map(fromWireTopic);
    const needsAuth = (topic: Topic) => (AUTH_TOPICS as readonly string[]).includes(topic);
    const topics = options.authToken ? requested : requested.filter((topic) => !needsAuth(topic));
    const skipped = options.authToken ? [] : requested.filter(needsAuth);

    const url = new URL(options.url ?? LIVE_URL);
    if (options.authToken) url.searchParams.set('authToken', options.authToken);
    const connection = (options.connectionFactory ?? createConnection(options))(url.toString());

    const client = new LiveClient(connection, topics, skipped, options.raw ?? false);
    await client.#start();
    return client;
  }

  /**
   * The snapshot received while connecting: one keyframe message per topic, all
   * stamped with the same time. {@link LiveClient.connect} delivers it to
   * listeners before it resolves, so a listener added afterwards never sees
   * it; insert it into a timeline or recording from here. Snapshots after a
   * reconnect are delivered to listeners as usual and do not replace this one.
   * Empty when the hub sent nothing.
   */
  get snapshot(): readonly LiveTimingMessage[] {
    return this.#snapshot ?? [];
  }

  /** Current connection status. */
  get status(): LiveStatus {
    return this.#status;
  }

  /** Call `listener` with every message. Returns an unsubscribe function. */
  subscribeMessages(listener: MessageListener): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  /** Call `listener` on every status change. Returns an unsubscribe function. */
  subscribeStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * Every message from now on as an async iterator. It ends when the client
   * closes; breaking out of the loop stops buffering.
   */
  messages(): AsyncIterableIterator<LiveTimingMessage> {
    const queue = new MessageQueue(() => this.#queues.delete(queue));
    if (this.#status === 'closed') queue.end();
    else this.#queues.add(queue);
    return queue;
  }

  /** Unsubscribe and close the connection. */
  async close(): Promise<void> {
    if (this.#status === 'closed') return;
    this.#closing = true;
    try {
      await this.#connection.invoke('Unsubscribe', this.topics.map(toWireTopic));
    } catch {
      // The connection may already be gone; stopping is what matters.
    }
    await this.#connection.stop();
    this.#setStatus('closed');
  }

  async #start(): Promise<void> {
    this.#connection.on('feed', (topic: string, data: unknown, timestamp?: string) => {
      this.#onFeed(topic, data, timestamp);
    });
    this.#connection.onreconnecting((error) => this.#setStatus('reconnecting', error));
    this.#connection.onreconnected(() => {
      this.#subscribe()
        .then(() => this.#setStatus('connected'))
        .catch((error: unknown) => this.#setStatus('reconnecting', toError(error)));
    });
    this.#connection.onclose((error) => {
      if (!this.#closing) this.#setStatus('closed', error);
    });
    await this.#connection.start();
    await this.#subscribe();
    this.#setStatus('connected');
  }

  async #subscribe(): Promise<void> {
    const snapshot = await this.#connection.invoke<Record<string, unknown> | null>(
      'Subscribe',
      this.topics.map(toWireTopic),
    );
    const messages: LiveTimingMessage[] = [];
    if (isPlainObject(snapshot)) {
      const decoded = Object.entries(snapshot).map(([wire, value]) => [wire, value, decodeTopicData(wire, value)] as const);
      const utc = snapshotTime(new Map(decoded.map(([wire, , data]) => [fromWireTopic(wire), data])));
      for (const [wire, value, data] of decoded) {
        if (!isPlainObject(data)) continue;
        messages.push(this.#message(wire, { ...data, _kf: true }, utc, value));
      }
    }
    this.#snapshot ??= messages;
    for (const message of messages) this.#emit(message);
  }

  #onFeed(wire: string, data: unknown, timestamp: string | undefined): void {
    const utc = typeof timestamp === 'string' ? parseUtc(timestamp) : Date.now();
    this.#emit(this.#message(wire, decodeTopicData(wire, data), utc, data));
  }

  #message(wire: string, data: unknown, utc: number, original: unknown): LiveTimingMessage {
    const message = { topic: fromWireTopic(wire), utc, data };
    return this.#raw && isCompressedTopic(wire) && typeof original === 'string' ? { ...message, raw: original } : message;
  }

  #emit(message: LiveTimingMessage): void {
    for (const queue of this.#queues) queue.push(message);
    for (const listener of [...this.#messageListeners]) listener(message);
  }

  #setStatus(status: LiveStatus, error?: Error): void {
    this.#status = status;
    if (status === 'closed') {
      for (const queue of this.#queues) queue.end();
      this.#queues.clear();
    }
    for (const listener of [...this.#statusListeners]) listener(status, error);
  }
}

function createConnection(options: LiveClientOptions): (url: string) => HubConnectionLike {
  return (url) => {
    const builder = new HubConnectionBuilder()
      .withUrl(url)
      .withAutomaticReconnect()
      .configureLogging(options.logger ?? new NullLogger());
    return (options.dispatcher ? builder.withDispatcher(options.dispatcher) : builder.withCookies()).build();
  };
}

/** How far `Heartbeat.Utc` runs ahead of feed timestamps (measured: about 2 s). */
const HEARTBEAT_LEAD = 2_000;

/**
 * The time to stamp a subscription snapshot with. It must not be later than
 * the feed updates that follow it, or the snapshot would overwrite them on the
 * timeline. The newest sample time inside the snapshot is a safe choice, since
 * CarData's last sample time equals its feed timestamp. `Heartbeat` runs about
 * 2 s ahead of feed timestamps, so it is only a fallback.
 */
export function snapshotTime(topics: ReadonlyMap<Topic, unknown>, now = Date.now()): number {
  const times: number[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') times.push(parseUtc(value));
  };
  const lastOf = (value: unknown, key: string): unknown => {
    const list = isPlainObject(value) ? value[key] : undefined;
    return Array.isArray(list) ? (list[list.length - 1] as unknown) : undefined;
  };
  const car = lastOf(topics.get('CarData'), 'Entries');
  if (isPlainObject(car)) add(car['Utc']);
  const position = lastOf(topics.get('Position'), 'Position');
  if (isPlainObject(position)) add(position['Timestamp']);
  const clock = topics.get('ExtrapolatedClock');
  if (isPlainObject(clock)) add(clock['Utc']);
  if (times.length > 0) return Math.max(...times);
  const heartbeat = topics.get('Heartbeat');
  if (isPlainObject(heartbeat) && typeof heartbeat['Utc'] === 'string') {
    return parseUtc(heartbeat['Utc']) - HEARTBEAT_LEAD;
  }
  return now;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Unbounded async queue behind {@link LiveClient.messages}. */
class MessageQueue implements AsyncIterableIterator<LiveTimingMessage> {
  readonly #buffer: LiveTimingMessage[] = [];
  readonly #waiting: ((result: IteratorResult<LiveTimingMessage>) => void)[] = [];
  readonly #onDone: () => void;
  #done = false;

  constructor(onDone: () => void) {
    this.#onDone = onDone;
  }

  push(message: LiveTimingMessage): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#buffer.push(message);
  }

  end(): void {
    this.#done = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<LiveTimingMessage>> {
    const message = this.#buffer.shift();
    if (message) return Promise.resolve({ value: message, done: false });
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  return(): Promise<IteratorResult<LiveTimingMessage>> {
    this.#buffer.length = 0;
    this.end();
    this.#onDone();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LiveTimingMessage> {
    return this;
  }
}

export { LogLevel };
