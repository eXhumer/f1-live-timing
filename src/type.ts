/*
  eXViewer - Live timing and content streaming client for F1TV
  Copyright © 2023 eXhumer

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, version 3 of the License.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { SignalRError } from "node-signalr";
import TypedEventEmitter from "typed-emitter";


export namespace F1LiveTiming {
  export type ConnectionState = "Connected" | "Reconnecting" | "Disconnected";

  export type DisconnectionReason = "failed" | "unauthorized" | "end";
  
  type Events = {
    connected: () => void;
    disconnected: (reason: "failed" | "unauthorized" | "end") => void;
    error: (err: SignalRError) => void;
    feed: (topic: string, data: unknown, timestamp: string) => void;
    reconnecting: (count: number) => void;
  };
  
  export type EventEmitter = new () => TypedEventEmitter<Events>;  
}

export namespace LiveTimingData {
  export type CarData = {
    Entries: {
      Utc: string;
      Cars: {[key: string]: {
        Channels: {
          0: number;
          2: number;
          3: number;
          4: number;
          5: number;
          45: number;
        };
      }};
    }[];
  };

  export type Position = {
    Position: {
      Timestamp: string;
      Entries: {[key: string]: {
        Status: "OnTrack" | 0 | 1;
        X: number;
        Y: number;
        Z: number;
      }};
    }[];
  };

  export type SessionInfo = {
    Meeting: {
      Key: number;
      Name: string;
      OfficialName?: string;
      Location: string;
      Country: {
        Key: number;
        Code: string;
        Name: string;
      };
      Circuit: {
        Key: number;
        ShortName: string;
      };
    };
    ArchiveStatus: {
      Status: "Complete" | "Generating";
    };
    Key: number;
    Type: string;
    Number?: number;
    Name: string;
    StartDate: string;
    EndDate: string;
    GmtOffset: string;
    Path: string;
  };

  export type ArchiveStatus = {
    Status: "Complete" | "Generating";
  };

  export type ContentStreams = {
    Streams: {
      Type: string;
      Name: string;
      Language: string;
      Uri: string;
      Path?: string;
      Utc: string;
    }[];
  };

  export type TrackStatus = {

  };

  export type SessionData = {

  };

  export type AudioStreams = {
    Streams: {
      Name: string;
      Language: string;
      Uri: string;
      Path?: string;
      Utc: string;
    }[];
  };

  export type TyreStintSeries = {

  };

  export type ExtrapolatedClock = {

  };

  export type ChampionshipPrediction = {

  };

  export type LapCount = {

  };

  export type DriverList = {

  };

  export type DriverRaceInfo = {

  };

  export type SPFeed = {};

  export type TimingDataF1 = {

  };

  export type LapSeries = {

  };

  export type TimingData = {

  };

  export type TeamRadio = {

  };

  export type TopThree = {

  };

  export type TimingAppData = {

  };

  export type TimingStats = {

  };

  export type SessionStatus = {

  };

  export type Heartbeat = {

  };

  export type WeatherData = {
    AirTemp: string;
    TrackTemp: string;
    Humidity: string;
    Pressure: string;
    Rainfall: string;
    WindDirection: string;
    WindSpeed: string;
  };


  export type WeatherDataSeries = {

  };


  export type CurrentTyres = {

  };


  export type TlaRcm = {

  };


  export type RaceControlMessages = {

  };


  export type PitLaneTimeCollection = {

  };

  export type Current = {

  };
}

export namespace ArchiveLiveTiming {
  export type YearIndex = {
    Year: number;
    Meetings: {
      Sessions: {
        Key: number;
        Type: "Practice" | "Qualifying" | "Race";
        Number?: 0 | 1 | 2 | 3;
        Name?: "Practice 1" | "Practice 2" | "Practice 3" | "Qualifying" | "Race" | "Sprint" | "Sprint Shootout";
        StartDate: string;
        EndDate: string;
        GmtOffset: string;
        Path?: string;
      }[];
      Key: number;
      Code: string;
      Number: number;
      Location: string;
      OfficialName: string;
      Name: string;
      Country: {
        Key: number;
        Code: string;
        Name: string;
      };
      Circuit: {
        Key: number;
        ShortName: string;
      };
    }[];
  };

  export type SessionIndex = {
    Feeds: Record<string, {
      KeyFramePath: string;
      StreamPath: string;
    }>;
  };
};
