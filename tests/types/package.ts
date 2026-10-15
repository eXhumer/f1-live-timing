// Type-checks the built package through its public exports (run after `npm run build`).
import {
  ArchiveClient,
  type CarSample,
  type Cursor,
  LiveClient,
  type LiveTimingMessage,
  loadRecording,
  loadReplay,
  Recorder,
  type SessionState,
  Timeline,
  type TopicState,
} from '@exhumer/f1-live-timing';

export async function usage(): Promise<void> {
  const archive = new ArchiveClient();
  const { timeline, missing } = await loadReplay(archive, '2026/x/y/', { topics: ['LapCount', 'CarData'] });
  const cursor: Cursor = timeline.cursor();
  cursor.subscribe('LapCount', (state: TopicState<'LapCount'> | undefined, { updates, reset }) => {
    const lap: number | undefined = state?.CurrentLap;
    const messages: readonly LiveTimingMessage[] = updates;
    void [lap, messages, reset, missing];
  });
  cursor.subscribe(['TrackStatus', 'SessionStatus'], (changed, reset) => void [changed, reset]);
  const sample: CarSample | undefined = timeline.telemetry.carAt('1', cursor.time);
  const state: SessionState = cursor.state;

  const live = await LiveClient.connect({ authToken: 'token', raw: true });
  using liveTimeline = Timeline.fromLive(live);
  await using recorder = await Recorder.create('rec');
  for await (const message of live.messages()) recorder.write(message);
  const replayed: Timeline = await loadRecording('rec');
  void [sample, state, liveTimeline, replayed];
}
