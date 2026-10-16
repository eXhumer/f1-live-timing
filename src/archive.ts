import { request, type Dispatcher } from 'undici';

import {
  decodeTopicData,
  type LiveTimingMessage,
  parseJson,
  parseStreamLine,
  splitLines,
  streamLineToMessage,
  type StreamLine,
} from './decode.js';
import { isPlainObject } from './merge.js';
import { parseUtc } from './time.js';
import { type ArchiveStatus, type SessionInfo, toWireTopic, type Topic } from './topics.js';

/** Base URL of the live timing static archive. */
export const STATIC_BASE_URL = 'https://livetiming.formula1.com/static/';

/** `/static/Index.json`. */
export interface StaticIndex {
  Years: { Year: number; Path: string }[];
}

export interface SeasonSession {
  Key: number;
  Type: string;
  Number?: number;
  Name: string;
  /** Local time at the circuit. */
  StartDate: string;
  EndDate: string;
  GmtOffset: string;
  /**
   * Archive path. Older year indexes sometimes leave it out; {@link ArchiveClient.season}
   * fills it in with {@link buildSessionPath}.
   */
  Path: string;
}

export interface SeasonMeeting {
  Key: number;
  Code: string;
  Number: number;
  Location: string;
  OfficialName: string;
  Name: string;
  Country: { Key: number; Code: string; Name: string };
  Circuit: { Key: number; ShortName: string };
  Path?: string;
  Sessions: SeasonSession[];
}

/** `/static/{year}/Index.json`. */
export interface SeasonIndex {
  Year: number;
  Meetings: SeasonMeeting[];
}

export interface FeedInfo {
  KeyFramePath: string;
  StreamPath: string;
}

/** `/static/{path}Index.json`: the topics recorded for a session, by wire name. */
export interface SessionFeeds {
  Feeds: Record<string, FeedInfo>;
}

export type StreamingStatus = 'Available' | 'Offline' | (string & {});

export interface ArchiveClientOptions {
  /** Default {@link STATIC_BASE_URL}. */
  readonly baseUrl?: string;
  /** undici dispatcher for every request (proxy, mock, shared pool). */
  readonly dispatcher?: Dispatcher;
  /**
   * F1 subscription token (the `subscriptionToken` of the F1 login, the same
   * value as {@link LiveClientOptions.authToken}), sent as
   * `Authorization: Bearer <token>`. The archive rejects requests without a
   * valid one with HTTP 401 ({@link ArchiveAuthError}). A leading `Bearer ` is
   * accepted and ignored.
   */
  readonly authToken?: string;
  /** Extra headers for every request. They win over {@link ArchiveClientOptions.authToken}. */
  readonly headers?: Record<string, string>;
}

export interface StreamOptions {
  /** UTC instant of offset zero. Default: {@link ArchiveClient.streamStart}. */
  readonly start?: number;
  /** Keep the original base64 string of compressed topics in `raw`. */
  readonly raw?: boolean;
}

/** An archive file that does not exist (HTTP 403 or 404 from S3). */
export class ArchiveNotFoundError extends Error {
  override readonly name = 'ArchiveNotFoundError';
  constructor(readonly url: string, readonly statusCode: number) {
    super(`Archive file not found (HTTP ${statusCode}): ${url}`);
  }
}

/** Any other unexpected HTTP status from the archive. */
export class ArchiveHttpError extends Error {
  override readonly name: string = 'ArchiveHttpError';
  constructor(readonly url: string, readonly statusCode: number) {
    super(`Archive request failed (HTTP ${statusCode}): ${url}`);
  }
}

/**
 * The archive refused the request (HTTP 401): it needs a valid F1 subscription
 * token ({@link ArchiveClientOptions.authToken}). Extends {@link ArchiveHttpError},
 * so code that catches that keeps working.
 */
export class ArchiveAuthError extends ArchiveHttpError {
  override readonly name: string = 'ArchiveAuthError';
  /** Whether the client sent a token, i.e. the token was rejected (expired or invalid), not missing. */
  constructor(url: string, statusCode: number, readonly hadToken: boolean) {
    super(url, statusCode);
    this.message = hadToken
      ? `Archive rejected the authToken (HTTP ${statusCode}); it may have expired: ${url}`
      : `Archive needs an authToken (HTTP ${statusCode}): ${url}`;
  }
}

/** First bytes requested when only the first line of a stream is needed. */
const FIRST_LINE_BYTES = 16_384;
const FIRST_LINE_MAX_BYTES = 1_048_576;

/**
 * Client for the live timing static archive (`livetiming.formula1.com/static`).
 * F1 now answers it with HTTP 401 unless the request carries the subscription
 * token, so pass `authToken` (a request without one throws {@link ArchiveAuthError}).
 */
export class ArchiveClient {
  readonly #baseUrl: string;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #headers: Record<string, string>;
  readonly #hasToken: boolean;

  constructor(options: ArchiveClientOptions = {}) {
    const base = options.baseUrl ?? STATIC_BASE_URL;
    this.#baseUrl = base.endsWith('/') ? base : `${base}/`;
    this.#dispatcher = options.dispatcher;
    const token = options.authToken?.trim().replace(/^bearer\s+/i, '');
    this.#headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers };
    this.#hasToken = Object.keys(this.#headers).some((name) => name.toLowerCase() === 'authorization');
  }

  /** Absolute URL of an archive path, e.g. a team radio clip or commentary playlist. */
  url(path: string): string {
    return new URL(path.replace(/^\/+/, ''), this.#baseUrl).toString();
  }

  /** The current or most recent session (`/static/SessionInfo.json`). */
  latestSession(): Promise<SessionInfo> {
    return this.#json('SessionInfo.json');
  }

  /** Whether live timing is streaming (`/static/StreamingStatus.json`). */
  async streamingStatus(): Promise<StreamingStatus> {
    return (await this.#json<{ Status: StreamingStatus }>('StreamingStatus.json')).Status;
  }

  /** Years available in the archive. */
  index(): Promise<StaticIndex> {
    return this.#json('Index.json');
  }

  /** Meetings and sessions of a year. Missing session paths are rebuilt. */
  async season(year: number): Promise<SeasonIndex> {
    const index = await this.#json<SeasonIndex>(`${year}/Index.json`);
    for (const meeting of index.Meetings) {
      for (const session of meeting.Sessions) {
        if (!session.Path) session.Path = buildSessionPath(year, meeting, session);
      }
    }
    return index;
  }

  /** Topics recorded for a session, keyed by wire name (`CarData.z`). */
  sessionFeeds(path: string): Promise<SessionFeeds> {
    return this.#json(`${normalizePath(path)}Index.json`);
  }

  /** `Complete` once F1 has finished writing a session's archive. */
  archiveStatus(path: string): Promise<ArchiveStatus> {
    return this.#json(`${normalizePath(path)}ArchiveStatus.json`);
  }

  /**
   * A topic's final keyframe, decoded. Note that F1 can update keyframes after
   * the stream ends (ArchiveStatus, ExtrapolatedClock), so a replay should not
   * apply them at the end of the stream.
   */
  async keyframe(path: string, topic: Topic): Promise<unknown> {
    const wire = toWireTopic(topic);
    return decodeTopicData(wire, await this.#json(`${normalizePath(path)}${wire}.json`));
  }

  /** Raw lines of a topic's `.jsonStream`, read as the response streams in. */
  async *streamLines(path: string, topic: Topic): AsyncGenerator<StreamLine> {
    const body = await this.#open(`${normalizePath(path)}${toWireTopic(topic)}.jsonStream`);
    for await (const line of splitLines(decodeText(body))) {
      const parsed = parseStreamLine(line);
      if (parsed) yield parsed;
    }
  }

  /** A topic's updates as messages with UTC times. */
  async *stream(path: string, topic: Topic, options: StreamOptions = {}): AsyncGenerator<LiveTimingMessage> {
    const start = options.start ?? (await this.streamStart(path));
    const wire = toWireTopic(topic);
    for await (const line of this.streamLines(path, topic)) {
      yield streamLineToMessage(wire, line, start, options.raw ?? false);
    }
  }

  /**
   * The UTC instant of a session's stream offset zero.
   *
   * Every `CarData.z` line's last sample time minus its offset gives the same
   * instant to the millisecond, so the first line is enough. It is fetched
   * with a range request; `Position.z` is the fallback.
   */
  async streamStart(path: string): Promise<number> {
    let lastError: unknown;
    for (const [topic, field, time] of [
      ['CarData', 'Entries', 'Utc'],
      ['Position', 'Position', 'Timestamp'],
    ] as const) {
      try {
        const line = await this.#firstLine(`${normalizePath(path)}${toWireTopic(topic)}.jsonStream`);
        const data = decodeTopicData(toWireTopic(topic), line.data);
        const entries = isPlainObject(data) ? data[field] : undefined;
        const last = Array.isArray(entries) ? (entries[entries.length - 1] as unknown) : undefined;
        if (isPlainObject(last) && typeof last[time] === 'string') return parseUtc(last[time]) - line.offset;
        lastError = new Error(`${topic} first line has no ${time}.`);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Cannot find the stream start of ${path}.`, { cause: lastError });
  }

  async #firstLine(relative: string): Promise<StreamLine> {
    for (let bytes = FIRST_LINE_BYTES; ; bytes *= 4) {
      const body = await this.#open(relative, { range: `bytes=0-${bytes - 1}` });
      const { text, complete } = await readUpTo(body, bytes);
      const newline = text.indexOf('\n');
      if (newline !== -1 || complete || bytes >= FIRST_LINE_MAX_BYTES) {
        const line = parseStreamLine(newline === -1 ? text : text.slice(0, newline));
        if (!line) throw new Error(`${relative} is empty.`);
        return line;
      }
    }
  }

  async #json<T>(relative: string): Promise<T> {
    const body = await this.#open(relative);
    return parseJson<T>(await body.text());
  }

  async #open(relative: string, headers: Record<string, string> = {}): Promise<Dispatcher.ResponseData['body']> {
    const url = this.url(relative);
    const response = await request(url, {
      headers: { ...this.#headers, ...headers },
      ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
    });
    if (response.statusCode === 200 || response.statusCode === 206) return response.body;
    await response.body.dump();
    if (response.statusCode === 403 || response.statusCode === 404) {
      throw new ArchiveNotFoundError(url, response.statusCode);
    }
    if (response.statusCode === 401) throw new ArchiveAuthError(url, response.statusCode, this.#hasToken);
    throw new ArchiveHttpError(url, response.statusCode);
  }
}

/**
 * Rebuild a session's archive path the way F1 names them:
 * `{year}/{meeting date}_{meeting name}/{session date}_{session name}/`, where
 * the meeting date is the last session's date and spaces become underscores.
 */
export function buildSessionPath(
  year: number,
  meeting: Pick<SeasonMeeting, 'Name' | 'Sessions'>,
  session: Pick<SeasonSession, 'Name' | 'StartDate'>,
): string {
  const lastSession = meeting.Sessions[meeting.Sessions.length - 1] ?? session;
  const meetingDate = lastSession.StartDate.split('T')[0];
  const sessionDate = session.StartDate.split('T')[0];
  return `${year}/${meetingDate}_${meeting.Name}/${sessionDate}_${session.Name}/`.replaceAll(' ', '_');
}

/** UTC start of a session from its local `StartDate` and `GmtOffset` (`08:00:00` or `-04:00:00`). */
export function sessionStartUtc(session: Pick<SeasonSession, 'StartDate' | 'GmtOffset'>): number {
  const local = parseUtc(session.StartDate);
  const negative = session.GmtOffset.startsWith('-');
  const parts = session.GmtOffset.replace(/^[-+]/, '').split(':').map(Number);
  const offset = parts.reduce((total, part, index) => total + part * 60 ** (2 - index), 0) * 1000;
  return negative ? local + offset : local - offset;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

async function* decodeText(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  yield decoder.decode();
}

/** Read at most `limit` bytes; `complete` is true when the body ended first. */
async function readUpTo(
  body: Dispatcher.ResponseData['body'],
  limit: number,
): Promise<{ text: string; complete: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) {
      body.destroy();
      return { text: Buffer.concat(chunks).toString('utf8'), complete: false };
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), complete: true };
}
