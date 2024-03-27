import { Client, HubEvent } from "node-signalr";

export abstract class AbstractF1LiveTimingClient extends Client {
  constructor(url: string = "https://livetiming.formula1.com/signalr") {
    super(url, ["streaming"]);
    this.on("connected", () => {
      this.connection.hub.on("streaming", "feed", this.feed.bind(this) as HubEvent);
    });
  }

  public Subscribe = async (topics: string[]) => {
    return await this.connection.hub.call("streaming", "Subscribe", topics);
  };

  public Unsubscribe = async (topics: string[]) => {
    return await this.connection.hub.call("streaming", "Unsubscribe", topics);
  };

  abstract feed(topic: string, data: any, timestamp: string): void;
};
