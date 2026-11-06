// Captures everything the live hub sends during a session, for checking the
// library against real data afterwards. Start it about an hour before the
// session (F1's archive starts about an hour before the session too) and
// leave it running; it stops on its own after the session ends.
//
//   npm run build
//   F1_AUTH_TOKEN=<subscriptionToken> node scripts/capture-live.ts [--out dir]
//
// Writes into the output folder (default captures/<start time>):
//   wire.jsonl    every Subscribe result and hub invocation, untouched, with
//                 the local receive time
//   recording/    one folder per session (<key>-<name>) through Recorder
//                 (raw: true), for loadRecording
//   events.log    connections, status changes, snapshots, session status,
//                 stalls and archive polls (also printed)
//   signalr.log   the SignalR client's debug log
//   summary.json  counts, connections and the archive session path

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  ArchiveClient,
  type HubConnectionLike,
  LIVE_URL,
  LiveClient,
  type LiveSession,
  type LiveStatus,
  type LiveTimingMessage,
  Recorder,
} from '@exhumer/f1-live-timing';
import { HubConnectionBuilder, type ILogger, LogLevel } from '@exhumer/signalr-client';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    // Minutes to keep recording after SessionStatus reaches 'Ends'.
    'after-end': { type: 'string', default: '30' },
    // Hard stop, in case the session never reports 'Ends'.
    'max-hours': { type: 'string', default: '8' },
    'no-auth': { type: 'boolean', default: false },
  },
});

const authToken = process.env['F1_AUTH_TOKEN'];
if (!authToken && !args['no-auth']) {
  console.error('Set F1_AUTH_TOKEN to the F1 subscription token, or pass --no-auth to capture without CarData/Position.');
  process.exit(1);
}

const startedAt = new Date();
const outDir = args.out ?? join('captures', startedAt.toISOString().replace(/[:.]/g, '-'));
const afterEndMs = Number(args['after-end']) * 60_000;
const maxMs = Number(args['max-hours']) * 3_600_000;
const STALL_MS = 120_000;
const ARCHIVE_POLL_MS = 5 * 60_000;

await mkdir(outDir, { recursive: true });
const wireFile = createWriteStream(join(outDir, 'wire.jsonl'), { flags: 'a' });
const eventsFile = createWriteStream(join(outDir, 'events.log'), { flags: 'a' });
const signalrFile = createWriteStream(join(outDir, 'signalr.log'), { flags: 'a' });
const archive = new ArchiveClient(authToken ? { authToken } : {});

const redact = (text: string) => (authToken ? text.replaceAll(authToken, '<token>') : text);

function log(event: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} ${event}${detail === undefined ? '' : ` ${redact(JSON.stringify(detail))}`}`;
  console.log(line);
  eventsFile.write(`${line}\n`);
}

function wire(entry: Record<string, unknown>): void {
  lastWireAt = Date.now();
  wireFile.write(`${JSON.stringify({ received: new Date(lastWireAt).toISOString(), ...entry })}\n`);
}

const signalrLogger: ILogger = {
  log(level, message) {
    const name = Object.keys(LogLevel).find((key) => LogLevel[key as keyof typeof LogLevel] === level) ?? level;
    const line = `${new Date().toISOString()} [${name}] ${redact(message)}`;
    signalrFile.write(`${line}\n`);
    if (level >= LogLevel.Warning) log('signalr', line);
  },
};

// Keep retrying inside one connection so LiveClient's own reconnect path runs.
// The timeout and delays match LiveClient's defaults.
const SERVER_TIMEOUT = 60_000;
const RETRY_DELAYS = [0, 1_000, 2_000, 5_000, 10_000];
const retryForever = {
  nextRetryDelayInMilliseconds: ({ previousRetryCount }: { previousRetryCount: number }) =>
    stopping ? null : (RETRY_DELAYS[previousRetryCount] ?? 30_000),
};

/** The real hub connection, with everything it receives copied to wire.jsonl. */
function tappedConnection(url: string, conn: number): HubConnectionLike {
  const hub = new HubConnectionBuilder()
    .withUrl(url, { serverTimeoutInMilliseconds: SERVER_TIMEOUT })
    .withAutomaticReconnect(retryForever)
    .configureLogging(signalrLogger)
    .withCookies()
    .build();
  return {
    start: () => hub.start(),
    stop: () => hub.stop(),
    async invoke<T>(method: string, ...params: unknown[]): Promise<T> {
      const result = await hub.invoke<T>(method, ...params);
      if (method === 'Subscribe') wire({ conn, type: 'subscribe', topics: params[0], snapshot: result });
      return result;
    },
    on(method, handler) {
      hub.on(method, (...params: unknown[]) => {
        wire({ conn, type: method, args: params });
        return handler(...(params as never[]));
      });
    },
    onclose: (callback) => {
      hub.onclose((error) => {
        wire({ conn, type: 'closed', error: error?.message });
        callback(error);
      });
    },
    onreconnecting: (callback) => {
      hub.onreconnecting((error) => {
        wire({ conn, type: 'reconnecting', error: error?.message });
        callback(error);
      });
    },
    onreconnected: (callback) => {
      hub.onreconnected((connectionId) => {
        wire({ conn, type: 'reconnected' });
        callback(connectionId);
      });
    },
  };
}

// ─── Recording ────────────────────────────────────────────────────────────────

const counts: Record<string, number> = {};
const connections: { conn: number; connectedAt: string; closedAt?: string; error?: string }[] = [];
let sessionStatus: string | undefined;
let endedAt: number | undefined;
let sawStart = false;
let lastWireAt = Date.now();
let stalled = false;
let recorder: Recorder | undefined;
let recorderKey: number | undefined;
const recorderCloses: Promise<void>[] = [];

/** Record into the session's own folder, starting a new one when the session changes. */
function useRecorderFor(session: LiveSession | undefined): void {
  if (recorder && session?.key === recorderKey) return;
  if (recorder) recorderCloses.push(recorder.close().catch((error: unknown) => log('recorder-error', String(error))));
  recorderKey = session?.key;
  const name = session ? `${session.key}-${(session.name ?? '').replace(/\W+/g, '_')}` : 'unknown';
  recorder = Recorder.createSync(join(outDir, 'recording', name));
  log('recording', { dir: join(outDir, 'recording', name) });
}

function record(message: LiveTimingMessage): void {
  counts[message.topic] = (counts[message.topic] ?? 0) + 1;
  recorder!.write(message);
  const data = message.data as Record<string, unknown> | null;
  if (message.topic === 'SessionStatus' && typeof data?.['Status'] === 'string' && data['Status'] !== sessionStatus) {
    sessionStatus = data['Status'];
    log('session-status', { status: sessionStatus, utc: new Date(message.utc).toISOString() });
    // Between sessions the hub keeps serving the previous one as 'Ends', so
    // only an end that follows a start counts.
    if (sessionStatus === 'Started') sawStart = true;
    if (sessionStatus === 'Ends' && sawStart) endedAt ??= Date.now();
  }
  if (message.topic === 'SessionInfo' && data?.['_kf']) {
    log('session-info', { meeting: (data['Meeting'] as { Name?: string } | undefined)?.Name, name: data['Name'], path: data['Path'] });
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let stopping = false;
let current: LiveClient | undefined;
const stopController = new AbortController();

async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('stopping', { reason });
  stopController.abort();
  await current?.close().catch((error: unknown) => log('close-error', String(error)));
}

process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  void stop('SIGINT (press Ctrl+C again to exit without saving)');
});
process.on('SIGTERM', () => void stop('SIGTERM'));

const watchdog = setInterval(() => {
  const now = Date.now();
  if (endedAt !== undefined && now - endedAt >= afterEndMs) void stop(`session ended ${args['after-end']} min ago`);
  if (now - startedAt.getTime() >= maxMs) void stop(`reached --max-hours ${args['max-hours']}`);
  const silent = current?.status === 'connected' && now - lastWireAt >= STALL_MS;
  if (silent && !stalled) log('stall', { silentFor: `${Math.round((now - lastWireAt) / 1000)}s` });
  if (!silent && stalled) log('stall-over');
  stalled = silent;
}, 10_000);

async function pollArchive(): Promise<void> {
  let last = '';
  while (!stopping) {
    try {
      const [streaming, session] = await Promise.all([archive.streamingStatus(), archive.latestSession()]);
      const state = JSON.stringify({ streaming, session: { name: session.Name, path: session.Path, start: session.StartDate } });
      if (state !== last) log('archive', JSON.parse(state));
      last = state;
      latestSession = session;
    } catch (error) {
      log('archive-error', String(error));
    }
    await sleep(ARCHIVE_POLL_MS, undefined, { signal: stopController.signal }).catch(() => undefined);
  }
}
let latestSession: unknown;

async function captureLoop(): Promise<void> {
  let conn = 0;
  let failures = 0;
  while (!stopping) {
    conn += 1;
    const id = conn;
    log('connecting', { conn: id });
    try {
      const live = await LiveClient.connect({
        ...(authToken ? { authToken } : {}),
        raw: true,
        connectionFactory: (url) => tappedConnection(url, id),
      });
      current = live;
      failures = 0;
      const entry: (typeof connections)[number] = { conn: id, connectedAt: new Date().toISOString() };
      connections.push(entry);
      log('connected', {
        conn: id,
        topics: live.topics.length,
        skipped: live.skippedTopics,
        snapshotTopics: live.snapshot.map((m) => m.topic),
        snapshotUtc: live.snapshot[0] && new Date(live.snapshot[0].utc).toISOString(),
      });
      useRecorderFor(live.session);
      for (const message of live.snapshot) record(message);
      live.subscribeSession((session) => {
        log('session-change', { key: session.key, name: session.name, utc: new Date(session.utc).toISOString() });
        useRecorderFor(session);
      });
      live.subscribeMessages(record);
      await new Promise<void>((resolve) => {
        live.subscribeStatus((status: LiveStatus, error) => {
          log('status', { conn: id, status, error: error?.message });
          if (status === 'closed') {
            entry.closedAt = new Date().toISOString();
            if (error) entry.error = error.message;
            resolve();
          }
        });
        if (stopping) resolve();
      });
      // stop() may have run while connect() was still in flight.
      if (stopping) await live.close();
      current = undefined;
    } catch (error) {
      log('connect-error', { conn: id, error: String(error) });
      failures += 1;
    }
    if (stopping) break;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4));
    log('retrying', { inSeconds: delay / 1000 });
    await sleep(delay, undefined, { signal: stopController.signal }).catch(() => undefined);
  }
}

log('start', { outDir, url: LIVE_URL, auth: Boolean(authToken), afterEndMin: args['after-end'], maxHours: args['max-hours'] });
const archivePolling = pollArchive();
await captureLoop();
await archivePolling;
clearInterval(watchdog);

await recorder?.close();
await Promise.all(recorderCloses);
const summary = {
  startedAt: startedAt.toISOString(),
  stoppedAt: new Date().toISOString(),
  lastSessionStatus: sessionStatus,
  latestSession,
  connections,
  messages: counts,
};
await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
log('done', { outDir, messages: Object.values(counts).reduce((a, b) => a + b, 0) });
await Promise.all([wireFile, eventsFile, signalrFile].map((s) => new Promise((resolve) => s.end(resolve))));
