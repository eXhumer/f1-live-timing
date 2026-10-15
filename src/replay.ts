import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type ArchiveClient, ArchiveNotFoundError, type SessionFeeds } from './archive.js';
import {
  decodeTopicData,
  type LiveTimingMessage,
  parseJson,
  parseStreamLine,
  type StreamLine,
  streamLineToMessage,
} from './decode.js';
import { isPlainObject } from './merge.js';
import { RECORDING_FILE } from './recorder.js';
import { parseUtc } from './time.js';
import { Timeline, type TimelineOptions } from './timeline.js';
import { fromWireTopic, toWireTopic, type Topic } from './topics.js';

export interface ReplayOptions extends Pick<TimelineOptions, 'checkpointInterval'> {
  /** Topics to load. Default: every topic in the session's `Index.json`. */
  readonly topics?: readonly Topic[];
  /** Keep the original base64 string of compressed topics in `raw`. */
  readonly raw?: boolean;
  /** UTC instant of offset zero. Default: {@link ArchiveClient.streamStart}. */
  readonly start?: number;
  /** Called as each topic finishes loading. */
  readonly onTopicLoaded?: (topic: Topic, messages: number) => void;
}

export interface Replay {
  readonly timeline: Timeline;
  /** Topics that were requested but are not in the archive. */
  readonly missing: readonly Topic[];
}

/**
 * Load an archived session into a {@link Timeline}. Topics load in parallel,
 * and each one is inserted as soon as it arrives, so small topics are usable
 * before `CarData` and `Position` finish.
 *
 * The final keyframes are not applied: F1 updates some of them after the
 * stream ends, so the stream alone is the session as it happened.
 */
export async function loadReplay(
  archive: ArchiveClient,
  path: string,
  options: ReplayOptions = {},
): Promise<Replay> {
  const feeds = await archive.sessionFeeds(path);
  const available = Object.keys(feeds.Feeds).map(fromWireTopic);
  const wanted = options.topics?.map(fromWireTopic) ?? available;
  const topics = wanted.filter((topic) => available.includes(topic));
  const missing = wanted.filter((topic) => !available.includes(topic));

  const start = options.start ?? (await archive.streamStart(path));
  const timeline = new Timeline({
    start,
    ...(options.checkpointInterval === undefined ? {} : { checkpointInterval: options.checkpointInterval }),
  });

  await Promise.all(
    topics.map(async (topic) => {
      const messages: LiveTimingMessage[] = [];
      try {
        for await (const message of archive.stream(path, topic, { start, raw: options.raw ?? false })) {
          messages.push(message);
        }
      } catch (error) {
        if (!(error instanceof ArchiveNotFoundError)) throw error;
        missing.push(topic);
        return;
      }
      timeline.insert(messages);
      options.onTopicLoaded?.(topic, messages.length);
    }),
  );

  return { timeline, missing };
}

export interface RecordingOptions extends Pick<ReplayOptions, 'checkpointInterval' | 'raw' | 'start'> {
  /** Topics to load. Default: every topic in the recording's `Index.json`. */
  readonly topics?: readonly Topic[];
}

/**
 * Load a folder in the archive format (written by {@link Recorder}, or a
 * downloaded copy of an F1 session) into a {@link Timeline}. Topics listed in
 * `Index.json` whose stream file is missing are skipped.
 *
 * The start instant comes from `options.start`, then `Recording.json`, then
 * the first `CarData.z` line.
 */
export async function loadRecording(dir: string, options: RecordingOptions = {}): Promise<Timeline> {
  const feeds = parseJson<SessionFeeds>(await readFile(join(dir, 'Index.json'), 'utf8'));
  const available = Object.keys(feeds.Feeds).map(fromWireTopic);
  const topics = (options.topics?.map(fromWireTopic) ?? available).filter((topic) => available.includes(topic));
  const lines = new Map<Topic, StreamLine[]>();
  for (const topic of topics) {
    const text = await readOptional(join(dir, feeds.Feeds[toWireTopic(topic)]!.StreamPath));
    if (text !== undefined) lines.set(topic, text.split('\n').map(parseStreamLine).filter((line) => line !== null));
  }
  const start = options.start ?? (await recordingStart(dir, lines));
  const timeline = new Timeline({
    start,
    ...(options.checkpointInterval === undefined ? {} : { checkpointInterval: options.checkpointInterval }),
  });
  for (const [topic, topicLines] of lines) {
    const wire = toWireTopic(topic);
    timeline.insert(topicLines.map((line) => streamLineToMessage(wire, line, start, options.raw ?? false)));
  }
  return timeline;
}

/** A file's text, or `undefined` when it does not exist. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function recordingStart(dir: string, lines: ReadonlyMap<Topic, StreamLine[]>): Promise<number> {
  const recording = await readOptional(join(dir, RECORDING_FILE));
  if (recording !== undefined) return parseUtc(parseJson<{ Start: string }>(recording).Start);
  let first = lines.get('CarData')?.[0];
  if (!first) {
    const text = (await readOptional(join(dir, 'CarData.z.jsonStream'))) ?? '';
    first = parseStreamLine(text.split('\n', 1)[0]!) ?? undefined;
  }
  const data = first ? decodeTopicData('CarData.z', first.data) : undefined;
  const entries = isPlainObject(data) ? data['Entries'] : undefined;
  const last = Array.isArray(entries) ? (entries[entries.length - 1] as unknown) : undefined;
  if (first && isPlainObject(last) && typeof last['Utc'] === 'string') return parseUtc(last['Utc']) - first.offset;
  throw new Error(`Cannot find the start instant of the recording in ${dir}; pass options.start.`);
}
