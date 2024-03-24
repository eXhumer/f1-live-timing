import { Client as SignalRClient, HubEvent } from "node-signalr";

import { EventEmitter } from "events";
import { LiveTimingData, F1LiveTiming } from "./type";
import { deepMerge, decompressZlibData } from "./utils";

export class F1LiveTimingClient extends (EventEmitter as F1LiveTiming.EventEmitter) {
  public readonly Current: LiveTimingData.Current;
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
            if (topic.endsWith(".z") && typeof data === "string")
              topic = topic.replace(/\.z$/, "");

            const key = topic as keyof LiveTimingData.Current;

            console.debug("received", data);
            console.debug("current", this.Current[key]);

            this.Current[key] = (key === "Position" || key === "CarData") ?
              decompressZlibData(data as string) :
              deepMerge(!this.Current[key] ? {} : this.Current[key], data);

            this.emit("feed", key, data, timestamp);
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
      this.Current[key.replace(/\.z$/, "") as keyof LiveTimingData.Current] = key.endsWith(".z") ?
        decompressZlibData(current[key] as string) :
        current[key];

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
