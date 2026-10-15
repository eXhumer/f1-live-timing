import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { deflateRawSync } from 'node:zlib';

import type { LiveTimingMessage } from './decode.js';
import { applyUpdate, stripKeyframeMarkers } from './merge.js';
import { formatOffset, formatUtc } from './time.js';
import { isCompressedTopic, toWireTopic, type Topic } from './topics.js';

const BOM = '\uFEFF';

/** Extra file a recording writes next to the archive files. */
export const RECORDING_FILE = 'Recording.json';

export interface RecorderOptions {
  /**
   * UTC instant of offset zero. Default: the first recorded message's time.
   * Messages before it are written at offset zero.
   */
  readonly start?: number;
}

/**
 * Writes messages to a folder in the live timing archive format: `Index.json`,
 * one `{topic}.jsonStream` per topic and, on {@link close}, a `{topic}.json`
 * keyframe with the final state. `Recording.json` also stores the start
 * instant, since a recording without `CarData` has no other way to recover it.
 * {@link loadRecording} reads a recording back into a timeline.
 *
 * Compressed topics are written from the message's `raw` string when present
 * (byte-identical to F1's archive) and re-compressed otherwise.
 */
export class Recorder {
  readonly #dir: string;
  readonly #streams = new Map<Topic, WriteStream>();
  readonly #state = new Map<Topic, unknown>();
  #start: number | undefined;
  #closed = false;

  private constructor(dir: string, start: number | undefined) {
    this.#dir = dir;
    this.#start = start;
  }

  /** Create the folder (if needed) and a recorder writing into it. */
  static async create(dir: string, options: RecorderOptions = {}): Promise<Recorder> {
    await mkdir(dir, { recursive: true });
    return new Recorder(dir, options.start);
  }

  /** UTC instant of offset zero, once known. */
  get start(): number | undefined {
    return this.#start;
  }

  /** Append one message to its topic's stream. */
  write(message: LiveTimingMessage): void {
    if (this.#closed) throw new Error('Recorder is closed.');
    this.#start ??= message.utc;
    const wire = toWireTopic(message.topic);
    let stream = this.#streams.get(message.topic);
    if (!stream) {
      stream = createWriteStream(join(this.#dir, `${wire}.jsonStream`), { flags: 'a' });
      // Write errors surface from close(); without a listener they would crash the process.
      stream.on('error', () => undefined);
      stream.write(BOM);
      this.#streams.set(message.topic, stream);
    }
    const payload = isCompressedTopic(wire) ? JSON.stringify(message.raw ?? compress(message.data)) : JSON.stringify(message.data);
    stream.write(`${formatOffset(message.utc - this.#start)}${payload}\r\n`);
    this.#state.set(message.topic, applyUpdate(this.#state.get(message.topic), message.data));
  }

  /**
   * Finish every stream and write `Index.json` and the keyframes. Rejects with
   * the first write error, if any happened.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#streams.values()].map((stream) => {
        stream.end();
        return finished(stream);
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    const feeds: Record<string, { KeyFramePath: string; StreamPath: string }> = {};
    for (const [topic, state] of this.#state) {
      const wire = toWireTopic(topic);
      feeds[wire] = { KeyFramePath: `${wire}.json`, StreamPath: `${wire}.jsonStream` };
      const keyframe = isCompressedTopic(wire) ? compress(state) : stripKeyframeMarkers(state);
      await writeFile(join(this.#dir, `${wire}.json`), BOM + JSON.stringify(keyframe));
    }
    await writeFile(join(this.#dir, 'Index.json'), BOM + JSON.stringify({ Feeds: feeds }));
    if (this.#start !== undefined) {
      await writeFile(join(this.#dir, RECORDING_FILE), JSON.stringify({ Start: formatUtc(this.#start) }));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function compress(data: unknown): string {
  return deflateRawSync(Buffer.from(JSON.stringify(data), 'utf8')).toString('base64');
}
