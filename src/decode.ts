import { inflateRawSync } from 'node:zlib';

import { parseOffset } from './time.js';
import { fromWireTopic, isCompressedTopic, type Topic } from './topics.js';

/** A topic update from either source, with compressed data already inflated. */
export interface LiveTimingMessage {
  /** Library topic name (`CarData`, not `CarData.z`). */
  readonly topic: Topic;
  /** When F1 stamped the update, as UTC epoch milliseconds. */
  readonly utc: number;
  /** The update: a delta to merge, or a full state when `_kf` is `true`. */
  readonly data: unknown;
  /** Original base64 string of a compressed topic, when requested. */
  readonly raw?: string;
}

/** Strip a leading UTF-8 byte order mark. Every archive file starts with one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse JSON that may start with a UTF-8 byte order mark. */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(stripBom(text)) as T;
}

/**
 * Inflate a compressed topic payload (base64 of raw DEFLATE, no zlib header)
 * and parse the JSON inside.
 */
export function inflate(payload: string): unknown {
  return JSON.parse(inflateRawSync(Buffer.from(payload, 'base64')).toString('utf8'));
}

/**
 * Turn wire data into library data: compressed topics are inflated, everything
 * else is returned unchanged.
 */
export function decodeTopicData(wireTopic: string, data: unknown): unknown {
  return isCompressedTopic(wireTopic) && typeof data === 'string' ? inflate(data) : data;
}

/** One line of an archive `.jsonStream` file. */
export interface StreamLine {
  /** Milliseconds since the session stream started. */
  readonly offset: number;
  /** Parsed JSON: a string for compressed topics, an object otherwise. */
  readonly data: unknown;
}

/** Width of the `HH:MM:SS.mmm` offset at the start of each stream line. */
const OFFSET_WIDTH = 12;

/**
 * Parse one `.jsonStream` line: a 12-character `HH:MM:SS.mmm` offset followed
 * directly by JSON. Returns `null` for blank lines.
 */
export function parseStreamLine(line: string): StreamLine | null {
  const text = stripBom(line).trimEnd();
  if (!text) return null;
  return {
    offset: parseOffset(text.slice(0, OFFSET_WIDTH)),
    data: JSON.parse(text.slice(OFFSET_WIDTH)),
  };
}

/**
 * Convert a parsed stream line into a message, given the UTC instant at which
 * the session stream started.
 */
export function streamLineToMessage(
  wireTopic: string,
  line: StreamLine,
  start: number,
  raw = false,
): LiveTimingMessage {
  const message = {
    topic: fromWireTopic(wireTopic),
    utc: start + line.offset,
    data: decodeTopicData(wireTopic, line.data),
  };
  return raw && typeof line.data === 'string' ? { ...message, raw: line.data } : message;
}

/**
 * Split an async stream of text chunks into lines. A final line without a
 * trailing newline is still yielded.
 */
export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of chunks) {
    rest += chunk;
    let index: number;
    while ((index = rest.indexOf('\n')) !== -1) {
      yield rest.slice(0, index);
      rest = rest.slice(index + 1);
    }
  }
  if (rest) yield rest;
}
