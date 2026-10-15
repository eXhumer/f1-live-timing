# @exhumer/f1-live-timing

[![CI](https://github.com/eXhumer/f1-live-timing/actions/workflows/ci.yml/badge.svg)](https://github.com/eXhumer/f1-live-timing/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/eXhumer/f1-live-timing/branch/main/graph/badge.svg)](https://codecov.io/gh/eXhumer/f1-live-timing)
[![npm](https://img.shields.io/npm/v/@exhumer/f1-live-timing)](https://www.npmjs.com/package/@exhumer/f1-live-timing)

F1 live timing for Node.js: the live SignalR Core feed, archived sessions, and
local recordings, all as one timeline you can scrub in step with a video.

- Live data comes from `livetiming.formula1.com/signalrcore` through
  [`@exhumer/signalr-client`](https://github.com/eXhumer/signalr-client-ts).
- Archived sessions come from `livetiming.formula1.com/static` through
  [undici](https://github.com/nodejs/undici).
- `CarData` and `Position` arrive inflated. You never handle the `.z`
  base64/deflate payloads unless you ask for them.

## Requirements

- Node.js ≥ 22.19.0

## Installation

```sh
npm install @exhumer/f1-live-timing
```

## Quick start

### Replay an archived session

```ts
import { ArchiveClient, loadReplay } from '@exhumer/f1-live-timing';

const archive = new ArchiveClient();
const season = await archive.season(2026);
const race = season.Meetings.at(-1)!.Sessions.find((s) => s.Type === 'Race')!;

const { timeline, missing } = await loadReplay(archive, race.Path);

const cursor = timeline.cursor();
cursor.subscribe('LapCount', (lapCount, { reset }) => {
  console.log(`Lap ${lapCount?.CurrentLap}/${lapCount?.TotalLaps}`, reset ? '(seeked)' : '');
});

// Call on every video frame or timeupdate with the video's UTC time.
cursor.advanceTo(Date.parse('2026-10-11T12:30:00Z'));
console.log(timeline.telemetry.carAt('1', cursor.time));
```

### Follow a live session

```ts
import { LiveClient, Timeline } from '@exhumer/f1-live-timing';

const live = await LiveClient.connect({ authToken: subscriptionToken });
const timeline = Timeline.fromLive(live);

const cursor = timeline.cursor();
timeline.subscribe(() => cursor.advanceTo(timeline.last!));
cursor.subscribe(['TrackStatus', 'RaceControlMessages'], (changed) => {
  for (const topic of changed) console.log(topic, cursor.get(topic));
});

// Later
timeline[Symbol.dispose]();
await live.close();
```

`authToken` is the F1 subscription token (the `subscriptionToken` in the
`login-session` cookie). Without it the hub does not send `CarData` or
`Position`, so the client leaves them out and lists them in
`live.skippedTopics`.

### Record a live session and play it back

```ts
import { LiveClient, loadRecording, Recorder } from '@exhumer/f1-live-timing';

const live = await LiveClient.connect({ authToken, raw: true });
const recorder = await Recorder.create('./recordings/singapore-race');
live.subscribeMessages((message) => recorder.write(message));

// When the session ends
await live.close();
await recorder.close();

const timeline = await loadRecording('./recordings/singapore-race');
```

A recording uses the same layout as F1's archive (`Index.json`,
`{topic}.jsonStream`, `{topic}.json`). With `raw: true` the compressed topics
are written byte for byte as F1 sent them. `loadRecording` also reads a session
downloaded from the archive.

## Concepts

### Messages

Every source produces the same message shape:

```ts
interface LiveTimingMessage {
  topic: string; // 'TimingData', 'CarData', ... (no '.z')
  utc: number; // epoch milliseconds
  data: unknown; // the decoded update
  raw?: string; // the original base64 payload, only with { raw: true }
}
```

Live messages are stamped with the hub's feed timestamp. Archive lines carry
an offset from the start of the stream, which `ArchiveClient.streamStart`
converts to an exact UTC instant from the first `CarData.z` line.

### Merging

Updates are patches that F1 merges into the previous state:

- objects merge deeply;
- a JSON array replaces the old value;
- an object patching an array updates items by index, and an index one past
  the end appends;
- `_deleted: string[]` removes keys;
- a message with `_kf: true` is a keyframe that replaces the state.

These rules reproduce F1's own end-of-session keyframes on every topic in the
test fixtures. `applyUpdate` and `applyMessage` are exported if you want to
merge yourself.

### Timeline and cursors

A `Timeline` holds every message of a session in UTC order, with state
checkpoints (every 30 s of session time by default) so any instant can be
rebuilt quickly. Messages can be inserted in any order. A replay inserts them
up front; a live timeline keeps appending.

A `Cursor` is a position on the timeline:

| Method | Use |
| --- | --- |
| `advanceTo(utc)` | Playback. Applies only the messages since the last call. Moving backwards behaves like `seek`. |
| `seek(utc)` | Jumps, rebuilding the state from the nearest checkpoint. Subscribers get `reset: true`. |
| `state`, `get(topic)` | The merged state at the cursor. |
| `subscribe(topic, cb)` | `cb(state, { updates, reset })` once per move that touched the topic. |
| `subscribe(topics, cb)` | `cb(changedTopics, reset)` once per move that touched any of them. |

Each cursor is independent, so several video players can each have their own.

### Telemetry

`timeline.telemetry` keeps per-driver series of car data and positions:

```ts
timeline.telemetry.drivers(); // ['1', '4', ...]
timeline.telemetry.carAt('1', utc); // { rpm, speed, gear, throttle, brake, drs? }
timeline.telemetry.positionAt('1', utc); // { status, x, y, z }
timeline.telemetry.carRange('1', from, to); // raw samples for a chart
```

`carAt` and `positionAt` interpolate between samples, while gear and DRS hold
their previous value. The DRS channel is absent from 2026 onwards.

## API

### `ArchiveClient`

```ts
new ArchiveClient({ baseUrl?, dispatcher?, headers? })
```

| Method | Returns |
| --- | --- |
| `index()` | Years in the archive (`/static/Index.json`). |
| `season(year)` | Meetings and sessions of a year. Missing session paths are rebuilt. |
| `latestSession()` | The current or most recent session (`SessionInfo.json`). |
| `streamingStatus()` | `'Available'` while live timing is streaming, otherwise `'Offline'`. |
| `sessionFeeds(path)` | Topics recorded for a session. |
| `archiveStatus(path)` | `{ Status: 'Complete' }` once the archive is finished. |
| `keyframe(path, topic)` | A topic's final state, decoded. |
| `stream(path, topic, { start?, raw? })` | A topic's messages as an async generator. |
| `streamLines(path, topic)` | The raw `{ offset, data }` lines. |
| `streamStart(path)` | The UTC instant of stream offset zero. |
| `url(path)` | The absolute URL of any archive file (team radio clips, for example). |

Missing files throw `ArchiveNotFoundError` (S3 answers 403); other statuses
throw `ArchiveHttpError`.

### `loadReplay(archive, path, options?)`

Loads a session into a `Timeline` and returns `{ timeline, missing }`.
Options: `topics` (default: every topic in the session), `start`, `raw`,
`checkpointInterval`, and `onTopicLoaded(topic, count)`. Topics load in
parallel and each is usable as soon as it lands.

### `LiveClient.connect(options?)`

Options: `authToken`, `topics` (default `LIVE_TOPICS`), `url`, `dispatcher`,
`logger`, `raw`, and `connectionFactory` (for tests or a custom transport).

Resolves after the subscription snapshot arrives. The snapshot is delivered as
one keyframe per topic, and a reconnect subscribes again and delivers a fresh
snapshot.

| Member | Use |
| --- | --- |
| `subscribeMessages(cb)` | Every message. Returns an unsubscribe function. |
| `messages()` | The same as an async iterator, ending when the client closes. |
| `subscribeStatus(cb)` | `'connecting' \| 'connected' \| 'reconnecting' \| 'closed'`. |
| `status`, `topics`, `skippedTopics` | Current state. |
| `close()` | Unsubscribes and stops the connection. |

### `Recorder` and `loadRecording`

`Recorder.create(dir, { start? })` returns a recorder, `write(message)` appends
a message, and `close()` (or `await using`) writes the keyframes,
`Index.json` and `Recording.json`. `loadRecording(dir, options?)` reads a
recording or a downloaded archive session back into a `Timeline`.

### Topic helpers

`LIVE_TOPICS`, `ARCHIVE_ONLY_TOPICS`, `AUTH_TOPICS`, `toWireTopic`,
`fromWireTopic`, and `isCompressedTopic`. The constants `TrackStatusCode`,
`SessionStatusValue`, `Flag`, `Compound` and `CarDataChannel` are also
exported, along with a typed state interface for each known topic
(`TopicState<'TimingData'>`, for example).

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
npm run coverage
```

The tests run against fixtures from the 2026 Singapore Grand Prix archive in
`tests/fixtures`. `CarData.z` and `Position.z` are trimmed to their first 120
lines to keep the repository small.

## License

[MIT](LICENSE.md)
