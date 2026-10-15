import type { LiveTimingMessage } from './decode.js';
import { applyUpdate } from './merge.js';
import type { Topic, TopicState } from './topics.js';

/**
 * Merged state of every topic at one instant. Immutable: applying a message
 * returns a new object, and topics the message does not touch keep their
 * identity.
 */
export type SessionState = Readonly<Record<string, unknown>>;

export const EMPTY_STATE: SessionState = Object.freeze({});

/** Apply one message to a session state and return the new state. */
export function applyMessage(state: SessionState, message: LiveTimingMessage): SessionState {
  return { ...state, [message.topic]: applyUpdate(state[message.topic], message.data) };
}

/** Typed read of one topic from a session state. */
export function getTopic<T extends Topic>(state: SessionState, topic: T): TopicState<T> | undefined {
  return state[topic] as TopicState<T> | undefined;
}
