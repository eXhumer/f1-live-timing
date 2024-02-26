import { Client as SignalRClient, HubEvent } from "node-signalr";

import { EventEmitter } from "events";
import { F1LiveTiming } from "./type";
import { deepMerge } from "./utils";

export class F1LiveTimingClient extends (EventEmitter as F1LiveTiming.EventEmitter) {
  public readonly Current: Record<string, unknown>;
  private readonly signalrClient: SignalRClient;
  private readonly streamingHub: string;

  constructor(url = "https://livetiming.formula1.com/signalr", streamingHub = "streaming") {
    super();
    this.Current = {};
    this.streamingHub = streamingHub;
    this.signalrClient = new SignalRClient(url, [this.streamingHub]);

    this.signalrClient.on("connected", () => {
      this.emit("connected");

      this.signalrClient
      .connection
      .hub
      .on(this.streamingHub, "feed",
          ((topic: string, data: unknown, timestamp: string) => {
            this.Current[topic] = (topic === "Position.z" || topic === "CarData.z") ?
              data :
              deepMerge(this.Current[topic], data);

            this.emit("feed", topic, data, timestamp);
          }) as HubEvent);
    });

    this.signalrClient.on("disconnected", reason => {
      this.emit("disconnected", reason);
    });

    this.signalrClient.on("error", err => {
      this.emit("error", err);
    });

    this.signalrClient.on("reconnecting", count => {
      this.emit("reconnecting", count);
    });
  }

  public ConnectionState = () => {
    return this.signalrClient.connection.state;
  };

  public End = () => {
    this.signalrClient.end();
  }

  public Start = () => {
    this.signalrClient.start();
  };

  public Subscribe = async (topics: string[]) => {
    const current = await this.signalrClient
      .connection
      .hub
      .call(this.streamingHub, "Subscribe", topics) as Record<string, unknown>;

    for (const key in current)
      this.Current[key] = current[key];

    return current;
  }

  public Unsubscribe = async (topics: string[]) => {
    const data = await this.signalrClient
      .connection
      .hub
      .call(this.streamingHub, "Unsubscribe", topics);
    return data;
  }
}
