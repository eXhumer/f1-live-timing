import type { LiveTimingMessage } from './decode.js';
import { applyMessage, EMPTY_STATE, type SessionState } from './state.js';
import { TelemetryStore, upperBound } from './telemetry.js';
import type { Topic, TopicState } from './topics.js';

/** Anything that pushes messages to a listener, such as a `LiveClient`. */
export interface MessageSource {
  subscribeMessages(listener: (message: LiveTimingMessage) => void): () => void;
}

export interface TimelineOptions {
  /** UTC instant the session stream started (archive offset zero), if known. */
  readonly start?: number;
  /** Keep a state checkpoint every this many milliseconds of session time. Default 30 000. */
  readonly checkpointInterval?: number;
}

interface Checkpoint {
  /** Number of messages applied to reach `state`. */
  readonly index: number;
  readonly utc: number;
  readonly state: SessionState;
}

const DEFAULT_CHECKPOINT_INTERVAL = 30_000;

/**
 * Every message of a session, ordered by UTC time, with state checkpoints so a
 * {@link Cursor} can rebuild the state at any instant quickly.
 *
 * Live and replay sessions use the same timeline: a replay inserts all of its
 * messages up front, a live session keeps appending.
 */
export class Timeline {
  /** Car telemetry and position series of this session. */
  readonly telemetry = new TelemetryStore();

  readonly #messages: LiveTimingMessage[] = [];
  readonly #checkpoints: Checkpoint[] = [{ index: 0, utc: -Infinity, state: EMPTY_STATE }];
  readonly #interval: number;
  readonly #cursors = new Set<Cursor>();
  readonly #listeners = new Set<(timeline: Timeline) => void>();
  #head: { index: number; state: SessionState } = { index: 0, state: EMPTY_STATE };
  #start: number | undefined;

  constructor(options: TimelineOptions = {}) {
    this.#start = options.start;
    this.#interval = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
  }

  /** Build a timeline that keeps appending messages from a live source. */
  static fromLive(source: MessageSource, options: TimelineOptions = {}): Timeline & Disposable {
    const timeline = new Timeline(options);
    const unsubscribe = source.subscribeMessages((message) => timeline.insert([message]));
    return Object.assign(timeline, { [Symbol.dispose]: unsubscribe });
  }

  /** UTC instant the session stream started, or the first message's time. */
  get start(): number | undefined {
    return this.#start ?? this.#messages[0]?.utc;
  }

  /** UTC time of the first message, or `undefined` while empty. */
  get first(): number | undefined {
    return this.#messages[0]?.utc;
  }

  /** UTC time of the latest message, or `undefined` while empty. */
  get last(): number | undefined {
    return this.#messages[this.#messages.length - 1]?.utc;
  }

  /** Number of messages. */
  get size(): number {
    return this.#messages.length;
  }

  /** Every message, ordered by time. */
  messages(): readonly LiveTimingMessage[] {
    return this.#messages;
  }

  /** Topics that have at least one message. */
  topics(): Topic[] {
    return Object.keys(this.#head.state);
  }

  /** State after every message so far (the live edge). */
  latest(): SessionState {
    return this.#head.state;
  }

  /** State at a UTC instant: every message with `utc <= time` applied. */
  stateAt(utc: number): SessionState {
    const end = upperBound(this.#messages, utc);
    const checkpoint = this.#checkpointBefore(end);
    return this.#replay(checkpoint.state, checkpoint.index, end);
  }

  /** Create a cursor positioned before the first message. */
  cursor(): Cursor {
    const cursor = new Cursor(this);
    this.#cursors.add(cursor);
    return cursor;
  }

  /** Call `listener` after each insert. Returns an unsubscribe function. */
  subscribe(listener: (timeline: Timeline) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Add messages. They may arrive in any order; equal timestamps keep their
   * arrival order. Cursors that already passed an inserted message rebuild
   * their state on their next move.
   */
  insert(batch: readonly LiveTimingMessage[]): void {
    if (batch.length === 0) return;
    const sorted = isSorted(batch) ? batch : [...batch].sort((a, b) => a.utc - b.utc);
    const firstIndex = this.#merge(sorted);
    for (const message of sorted) this.telemetry.add(message);
    this.#invalidate(firstIndex);
    this.#advanceHead();
    for (const cursor of this.#cursors) cursor._inserted(firstIndex);
    const errors: unknown[] = [];
    for (const cursor of [...this.#cursors]) {
      try {
        cursor._follow();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const listener of [...this.#listeners]) listener(this);
    throwAll(errors, 'Following cursor subscribers threw.');
  }

  /** @internal */
  _detach(cursor: Cursor): void {
    this.#cursors.delete(cursor);
  }

  /** @internal Index just past the last message with `utc <= time`. */
  _end(utc: number): number {
    return upperBound(this.#messages, utc);
  }

  /** @internal */
  _at(index: number): LiveTimingMessage {
    return this.#messages[index]!;
  }

  /** @internal */
  _checkpointBefore(end: number): { readonly index: number; readonly state: SessionState } {
    return this.#checkpointBefore(end);
  }

  /** Merge a sorted batch into the message list; returns the first changed index. */
  #merge(batch: readonly LiveTimingMessage[]): number {
    const messages = this.#messages;
    const firstIndex = upperBound(messages, batch[0]!.utc);
    if (firstIndex === messages.length) {
      for (const message of batch) messages.push(message);
      return firstIndex;
    }
    const tail = messages.splice(firstIndex);
    let i = 0;
    let j = 0;
    while (i < tail.length && j < batch.length) {
      messages.push(tail[i]!.utc <= batch[j]!.utc ? tail[i++]! : batch[j++]!);
    }
    while (i < tail.length) messages.push(tail[i++]!);
    while (j < batch.length) messages.push(batch[j++]!);
    return firstIndex;
  }

  /** Drop checkpoints that include messages at or after `index`. */
  #invalidate(index: number): void {
    while (this.#checkpoints.length > 1 && this.#checkpoints[this.#checkpoints.length - 1]!.index > index) {
      this.#checkpoints.pop();
    }
    if (this.#head.index > index) {
      const checkpoint = this.#checkpoints[this.#checkpoints.length - 1]!;
      this.#head = { index: checkpoint.index, state: checkpoint.state };
    }
  }

  /** Apply messages to the head state, storing checkpoints along the way. */
  #advanceHead(): void {
    let { index, state } = this.#head;
    let lastCheckpoint = this.#checkpoints[this.#checkpoints.length - 1]!;
    while (index < this.#messages.length) {
      const message = this.#messages[index]!;
      if (message.utc - lastCheckpoint.utc >= this.#interval && index > lastCheckpoint.index) {
        lastCheckpoint = { index, utc: message.utc, state };
        this.#checkpoints.push(lastCheckpoint);
      }
      state = applyMessage(state, message);
      index += 1;
    }
    this.#head = { index, state };
  }

  #checkpointBefore(end: number): Checkpoint {
    const checkpoints = this.#checkpoints;
    let lo = 0;
    let hi = checkpoints.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (checkpoints[mid]!.index <= end) lo = mid;
      else hi = mid - 1;
    }
    return checkpoints[lo]!;
  }

  #replay(state: SessionState, from: number, to: number): SessionState {
    for (let index = from; index < to; index += 1) state = applyMessage(state, this.#messages[index]!);
    return state;
  }
}

/** What a topic subscriber receives with each change. */
export interface TopicChange {
  /** Messages applied for this topic since the last call, oldest first. Empty on reset. */
  readonly updates: readonly LiveTimingMessage[];
  /** `true` when the cursor seeked: redraw from `state` rather than patching. */
  readonly reset: boolean;
}

export type TopicListener<T extends Topic> = (state: TopicState<T> | undefined, change: TopicChange) => void;
export type TopicsListener = (changed: readonly Topic[], reset: boolean) => void;

interface Subscription {
  readonly topics: ReadonlySet<string>;
  readonly single: boolean;
  readonly listener: (...args: never[]) => void;
}

/**
 * A position on a {@link Timeline} with the merged state at that instant.
 *
 * Move it with {@link advanceTo} as the video plays (it applies only the new
 * messages) or {@link seek} to jump. Subscribers are called once per topic per
 * move, after every message up to the new time has been applied.
 */
export class Cursor implements Disposable {
  readonly #timeline: Timeline;
  readonly #subscriptions = new Set<Subscription>();
  #index = 0;
  #time = -Infinity;
  #state: SessionState = EMPTY_STATE;
  #stale = false;
  #following = false;
  #disposed = false;

  /** @internal Use {@link Timeline.cursor}. */
  constructor(timeline: Timeline) {
    this.#timeline = timeline;
  }

  /** UTC time of the cursor (`-Infinity` before the first move). */
  get time(): number {
    return this.#time;
  }

  /** Merged state of every topic at the cursor. */
  get state(): SessionState {
    return this.#state;
  }

  /** Merged state of one topic at the cursor. */
  get<T extends Topic>(topic: T): TopicState<T> | undefined {
    return this.#state[topic] as TopicState<T> | undefined;
  }

  /** `true` while the cursor follows the end of the timeline (see {@link follow}). */
  get following(): boolean {
    return this.#following;
  }

  /**
   * Move to the latest message and stay there: after every insert the cursor
   * advances to the timeline's last message, calling subscribers as
   * {@link advanceTo} does. {@link advanceTo} or {@link seek} stops following.
   */
  follow(): void {
    this.#assertOpen();
    this.#following = true;
    this.#advance(this.#timeline.last ?? -Infinity);
  }

  /**
   * Move forward to `utc`, applying only messages after the current time.
   * Moving backwards, or after messages were inserted behind the cursor,
   * behaves like {@link seek}. Stops {@link follow}ing.
   */
  advanceTo(utc: number): void {
    this.#assertOpen();
    this.#following = false;
    this.#advance(utc);
  }

  /** Jump to `utc` and rebuild the state from the nearest checkpoint. Stops {@link follow}ing. */
  seek(utc: number): void {
    this.#assertOpen();
    this.#following = false;
    this.#seek(utc);
  }

  #advance(utc: number): void {
    if (utc < this.#time || this.#stale) {
      this.#seek(utc);
      return;
    }
    const end = this.#timeline._end(utc);
    const updates = new Map<Topic, LiveTimingMessage[]>();
    let state = this.#state;
    for (let index = this.#index; index < end; index += 1) {
      const message = this.#timeline._at(index);
      state = applyMessage(state, message);
      let list = updates.get(message.topic);
      if (!list) updates.set(message.topic, (list = []));
      list.push(message);
    }
    this.#index = end;
    this.#time = utc;
    this.#state = state;
    if (updates.size > 0) this.#notify(updates, false);
  }

  #seek(utc: number): void {
    const end = this.#timeline._end(utc);
    const checkpoint = this.#timeline._checkpointBefore(end);
    let state = checkpoint.state;
    for (let index = checkpoint.index; index < end; index += 1) {
      state = applyMessage(state, this.#timeline._at(index));
    }
    this.#index = end;
    this.#time = utc;
    this.#state = state;
    this.#stale = false;
    this.#notify(null, true);
  }

  /** Subscribe to one topic. Returns an unsubscribe function. */
  subscribe<T extends Topic>(topic: T, listener: TopicListener<T>): () => void;
  /** Subscribe to several topics with one callback. Returns an unsubscribe function. */
  subscribe(topics: readonly Topic[], listener: TopicsListener): () => void;
  subscribe(topic: Topic | readonly Topic[], listener: (...args: never[]) => void): () => void {
    const single = typeof topic === 'string';
    const subscription: Subscription = {
      topics: new Set(single ? [topic] : topic),
      single,
      listener,
    };
    this.#subscriptions.add(subscription);
    return () => this.#subscriptions.delete(subscription);
  }

  /** Stop receiving inserts from the timeline and drop every subscriber. */
  dispose(): void {
    this.#disposed = true;
    this.#following = false;
    this.#subscriptions.clear();
    this.#timeline._detach(this);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /** @internal Called by the timeline after every insert. */
  _follow(): void {
    if (this.#following) this.#advance(this.#timeline.last!);
  }

  /** @internal Called by the timeline after an insert at `index`. */
  _inserted(index: number): void {
    if (index < this.#index) this.#stale = true;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Cursor is disposed.');
  }

  /** `updates === null` means a reset: every subscriber is called. */
  #notify(updates: Map<Topic, LiveTimingMessage[]> | null, reset: boolean): void {
    const errors: unknown[] = [];
    for (const subscription of [...this.#subscriptions]) {
      try {
        if (subscription.single) {
          const [topic] = subscription.topics as Set<Topic>;
          const list = updates?.get(topic!);
          if (updates && !list) continue;
          (subscription.listener as TopicListener<Topic>)(this.#state[topic!], { updates: list ?? [], reset });
        } else {
          const changed = updates
            ? [...subscription.topics].filter((topic) => updates.has(topic))
            : [...subscription.topics];
          if (changed.length === 0) continue;
          (subscription.listener as TopicsListener)(changed, reset);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    throwAll(errors, 'Cursor subscribers threw.');
  }
}

function throwAll(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function isSorted(batch: readonly LiveTimingMessage[]): boolean {
  for (let i = 1; i < batch.length; i += 1) if (batch[i]!.utc < batch[i - 1]!.utc) return false;
  return true;
}
