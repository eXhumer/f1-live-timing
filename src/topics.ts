/**
 * Topic names, constants and the state shapes of each topic.
 *
 * Shapes describe the *merged state* (what `Cursor#get()` returns), checked
 * against the 2026 Singapore Grand Prix live feed and archive. Fields F1 does
 * not always send are optional, and every object stays open to fields F1 may
 * add later.
 */

// ─── Topic names ──────────────────────────────────────────────────────────────

/** Topics the formula1.com live timing app subscribes to. */
export const LIVE_TOPICS = [
  'Heartbeat',
  'AudioStreams',
  'DriverList',
  'ExtrapolatedClock',
  'RaceControlMessages',
  'SessionInfo',
  'SessionStatus',
  'TeamRadio',
  'TimingAppData',
  'TimingStats',
  'TrackStatus',
  'WeatherData',
  'Position',
  'CarData',
  'ContentStreams',
  'SessionData',
  'TimingData',
  'LapCount',
  'ChampionshipPrediction',
] as const satisfies readonly string[];

/** Topics recorded in session archives in addition to {@link LIVE_TOPICS}. */
export const ARCHIVE_ONLY_TOPICS = [
  'ArchiveStatus',
  'TimingDataF1',
  'LapSeries',
  'TopThree',
  'DriverTracker',
  'DriverRaceInfo',
  'TyreStintSeries',
  'CurrentTyres',
  'WeatherDataSeries',
  'TlaRcm',
  'OvertakeSeries',
  'PitLaneTimeCollection',
  'PitStop',
  'PitStopSeries',
] as const satisfies readonly string[];

/** Topics that need an F1 subscription token on the live feed. */
export const AUTH_TOPICS = ['CarData', 'Position'] as const satisfies readonly string[];

export type LiveTopic = (typeof LIVE_TOPICS)[number];
export type ArchiveOnlyTopic = (typeof ARCHIVE_ONLY_TOPICS)[number];
export type KnownTopic = LiveTopic | ArchiveOnlyTopic;

/**
 * A topic name as this library exposes it. Compressed wire topics drop their
 * `.z` suffix (`CarData.z` → `CarData`) because their data is always inflated
 * before it reaches the consumer. Unknown topics pass through as plain strings.
 */
export type Topic = KnownTopic | (string & {});

/** Topics whose wire name carries a `.z` suffix (base64 raw-deflate JSON). */
const COMPRESSED = new Set<string>(['CarData', 'Position']);

/** Wire name for a topic (`CarData` → `CarData.z`). Accepts either form. */
export function toWireTopic(topic: string): string {
  return COMPRESSED.has(topic) ? `${topic}.z` : topic;
}

/** Library name for a wire topic (`CarData.z` → `CarData`). Accepts either form. */
export function fromWireTopic(wire: string): Topic {
  return wire.endsWith('.z') ? wire.slice(0, -2) : wire;
}

/** Whether a topic's wire data is compressed. Accepts either form. */
export function isCompressedTopic(topic: string): boolean {
  return COMPRESSED.has(fromWireTopic(topic));
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** `TrackStatus.Status` codes. */
export const TrackStatusCode = {
  AllClear: '1',
  Yellow: '2',
  Green: '3',
  SCDeployed: '4',
  Red: '5',
  VSCDeployed: '6',
  VSCEnding: '7',
} as const;
export type TrackStatusCode = (typeof TrackStatusCode)[keyof typeof TrackStatusCode];

/** `SessionStatus.Status` values. */
export const SessionStatusValue = {
  Inactive: 'Inactive',
  Started: 'Started',
  Aborted: 'Aborted',
  Finished: 'Finished',
  Finalised: 'Finalised',
  Ends: 'Ends',
} as const;
export type SessionStatusValue = (typeof SessionStatusValue)[keyof typeof SessionStatusValue];

/** `RaceControlMessage.Flag` values. */
export const Flag = {
  Black: 'BLACK',
  BlackAndOrange: 'BLACK AND ORANGE',
  BlackAndWhite: 'BLACK AND WHITE',
  Blue: 'BLUE',
  Chequered: 'CHEQUERED',
  Clear: 'CLEAR',
  Green: 'GREEN',
  Yellow: 'YELLOW',
  DoubleYellow: 'DOUBLE YELLOW',
  Red: 'RED',
} as const;
export type Flag = (typeof Flag)[keyof typeof Flag];

/** Tyre compounds seen in `TimingAppData` stints and `CurrentTyres`. */
export const Compound = {
  Soft: 'SOFT',
  Medium: 'MEDIUM',
  Hard: 'HARD',
  Intermediate: 'INTERMEDIATE',
  Wet: 'WET',
  Hypersoft: 'HYPERSOFT',
  Ultrasoft: 'ULTRASOFT',
  Supersoft: 'SUPERSOFT',
  TestUnknown: 'TEST_UNKNOWN',
  Unknown: 'UNKNOWN',
} as const;
export type Compound = (typeof Compound)[keyof typeof Compound];

/**
 * `CarData` channel numbers. DRS (`45`) is absent from 2026 onwards, since the
 * 2026 regulations removed DRS.
 */
export const CarDataChannel = {
  Rpm: '0',
  Speed: '2',
  Gear: '3',
  Throttle: '4',
  Brake: '5',
  Drs: '45',
} as const;
export type CarDataChannel = (typeof CarDataChannel)[keyof typeof CarDataChannel];

// ─── State shapes ─────────────────────────────────────────────────────────────

/** Racing number as a string key, e.g. `"44"`. */
export type RacingNumber = string;

export interface Heartbeat {
  Utc: string;
}

export interface ArchiveStatus {
  Status: 'Generating' | 'Complete' | (string & {});
}

export interface StreamInfo {
  Name: string;
  Language: string;
  Uri: string;
  /** Archive copy, relative to the session path. */
  Path?: string;
  Utc: string;
  Type?: string;
}

export interface AudioStreams {
  Streams: StreamInfo[];
}

export interface ContentStreams {
  Streams: StreamInfo[];
}

export interface Driver {
  RacingNumber: string;
  BroadcastName: string;
  FullName: string;
  Tla: string;
  Line: number;
  TeamName: string;
  TeamColour: string;
  FirstName: string;
  LastName: string;
  Reference: string;
  HeadshotUrl?: string;
  CountryCode?: string;
}

export type DriverList = Record<RacingNumber, Driver>;

export interface ExtrapolatedClock {
  Utc: string;
  /** `hh:mm:ss` remaining at `Utc`. Count down from it while `Extrapolating`. */
  Remaining: string;
  Extrapolating: boolean;
}

export interface RaceControlMessage {
  Utc: string;
  Message: string;
  Category: string;
  Lap?: number;
  Flag?: Flag | (string & {});
  RacingNumber?: string;
  Scope?: string;
  Sector?: number;
  Status?: string;
  Mode?: string;
}

export interface RaceControlMessages {
  Messages: RaceControlMessage[];
}

export interface SessionInfo {
  Meeting: {
    Key: number;
    Name: string;
    OfficialName: string;
    Location: string;
    Number?: number;
    Country: { Key: number; Code: string; Name: string };
    Circuit: { Key: number; ShortName: string };
  };
  SessionStatus?: SessionStatusValue | (string & {});
  ArchiveStatus: ArchiveStatus;
  Key: number;
  Type: string;
  Number?: number;
  Name: string;
  /** Local time at the circuit. Subtract `GmtOffset` for UTC. */
  StartDate: string;
  EndDate: string;
  GmtOffset: string;
  /** Archive path, e.g. `2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/`. */
  Path: string;
}

export interface SessionStatus {
  Status: SessionStatusValue | (string & {});
  Started?: string;
}

export interface TrackStatus {
  Status: TrackStatusCode | (string & {});
  Message: string;
}

export interface LapCount {
  CurrentLap: number;
  TotalLaps: number;
}

export interface WeatherData {
  AirTemp: string;
  Humidity: string;
  Pressure: string;
  Rainfall: string;
  TrackTemp: string;
  WindDirection: string;
  WindSpeed: string;
}

export interface TeamRadioCapture {
  Utc: string;
  RacingNumber: string;
  /** Relative to the session path, e.g. `TeamRadio/VER_3_20261011_202550.mp3`. */
  Path: string;
}

export interface TeamRadio {
  Captures: TeamRadioCapture[];
}

export interface SessionData {
  Series: { Utc: string; Lap?: number; QualifyingPart?: number }[];
  StatusSeries: { Utc: string; TrackStatus?: string; SessionStatus?: string }[];
}

export interface TimingSegment {
  Status: number;
}

export interface TimingSector {
  Stopped: boolean;
  Value: string;
  PreviousValue?: string;
  Status: number;
  OverallFastest: boolean;
  PersonalFastest: boolean;
  Segments?: TimingSegment[];
}

export interface TimingSpeed {
  Value: string;
  Status: number;
  OverallFastest: boolean;
  PersonalFastest: boolean;
}

export interface TimingDataLine {
  RacingNumber: string;
  Line: number;
  Position: string;
  ShowPosition: boolean;
  GapToLeader?: string;
  IntervalToPositionAhead?: { Value: string; Catching: boolean };
  /** Qualifying: one entry per part. */
  Stats?: { TimeDiffToFastest: string; TimeDifftoPositionAhead: string }[];
  Retired: boolean;
  InPit: boolean;
  PitOut: boolean;
  Stopped: boolean;
  Status: number;
  NumberOfLaps?: number;
  NumberOfPitStops?: number;
  Sectors: TimingSector[];
  Speeds: { I1: TimingSpeed; I2: TimingSpeed; FL: TimingSpeed; ST: TimingSpeed };
  BestLapTime: { Value: string; Lap?: number };
  LastLapTime: { Value: string; Status: number; OverallFastest: boolean; PersonalFastest: boolean };
  KnockedOut?: boolean;
  Cutoff?: boolean;
}

export interface TimingData {
  Lines: Record<RacingNumber, TimingDataLine>;
  Withheld?: boolean;
  SessionPart?: number;
  NoEntries?: number[];
}

export interface TimingStint {
  LapFlags: number;
  Compound: Compound | (string & {});
  New: string;
  TyresNotChanged: string;
  TotalLaps: number;
  StartLaps: number;
  LapTime?: string;
  LapNumber?: number;
}

export interface TimingAppData {
  Lines: Record<
    RacingNumber,
    { RacingNumber: string; Line: number; GridPos?: string; Stints: TimingStint[] }
  >;
}

export interface TimingStats {
  Withheld: boolean;
  SessionType: string;
  Lines: Record<
    RacingNumber,
    {
      Line: number;
      RacingNumber: string;
      PersonalBestLapTime: { Lap?: number; Position?: number; Value: string };
      BestSectors: { Position?: number; Value: string }[];
      BestSpeeds: Record<'I1' | 'I2' | 'FL' | 'ST', { Position?: number; Value: string }>;
    }
  >;
}

export interface CurrentTyres {
  Tyres: Record<RacingNumber, { Compound: Compound | (string & {}); New: boolean }>;
}

export interface PitLaneTimeCollection {
  PitTimes: Record<RacingNumber, { RacingNumber: string; Duration: string; Lap: string }>;
}

/** One `CarData` sample batch. Channels are keyed by {@link CarDataChannel}. */
export interface CarDataEntry {
  Utc: string;
  Cars: Record<RacingNumber, { Channels: Partial<Record<CarDataChannel, number>> }>;
}

/** Latest `CarData` batch (each message replaces the previous one). */
export interface CarData {
  Entries: CarDataEntry[];
}

export interface PositionEntry {
  Timestamp: string;
  Entries: Record<
    RacingNumber,
    { Status: 'OnTrack' | 'OffTrack' | (string & {}); X: number; Y: number; Z: number }
  >;
}

/** Latest `Position` batch (each message replaces the previous one). */
export interface Position {
  Position: PositionEntry[];
}

/** Merged state type of each known topic. Unlisted topics are `unknown`. */
export interface TopicStateMap {
  Heartbeat: Heartbeat;
  ArchiveStatus: ArchiveStatus;
  AudioStreams: AudioStreams;
  ContentStreams: ContentStreams;
  DriverList: DriverList;
  ExtrapolatedClock: ExtrapolatedClock;
  RaceControlMessages: RaceControlMessages;
  SessionInfo: SessionInfo;
  SessionStatus: SessionStatus;
  TrackStatus: TrackStatus;
  LapCount: LapCount;
  WeatherData: WeatherData;
  TeamRadio: TeamRadio;
  SessionData: SessionData;
  TimingData: TimingData;
  TimingDataF1: TimingData;
  TimingAppData: TimingAppData;
  TimingStats: TimingStats;
  CurrentTyres: CurrentTyres;
  PitLaneTimeCollection: PitLaneTimeCollection;
  CarData: CarData;
  Position: Position;
}

/** State type of a topic: typed for known topics, `unknown` otherwise. */
export type TopicState<T extends Topic> = T extends keyof TopicStateMap ? TopicStateMap[T] : unknown;
