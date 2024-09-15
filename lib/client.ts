/**
 * f1-live-timing - Unofficial live timing client for Formula 1
 * Copyright (C) 2024  eXhumer
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, version 3 of the License.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

/**
 * Thin wrapper abstract class for F1 Live Timing Client.
 * 
 * Wraps the SignalR client and provides a common interface
 * for subscribing and receiving data from the F1 Live Timing
 * server.
 * 
 * No data is stored by this abstract class
 * and the incoming data feed method is an
 * abstract method that needs to be implemented
 * by the child class.
 */
export abstract class AbstractF1LiveTimingClient {
  /**
   * The SignalR connection object.
   */
  #connection: HubConnection;

  /**
   * Constructor for the LiveTimingClient.
   *
   * @param url The URL of the F1 Live Timing server.
   * @param logLevel The log level for the SignalR client.
   * @param automaticReconnect Whether to automatically reconnect to the server.
   */
  constructor(
    public readonly url = 'https://livetiming.formula1.com/signalrcore',
    logLevel: LogLevel = LogLevel.Warning,
    automaticReconnect = true,
  ) {
    let builder = new HubConnectionBuilder()
      .configureLogging(logLevel)
      .withUrl(url);

    if (automaticReconnect)
      builder = builder.withAutomaticReconnect();

    this.#connection = builder.build();

    this.#connection.on('feed', this.feed.bind(this));
  }

  /**
   * Get the current SignalR connection ID.
   */
  public get connectionId () {
    return this.#connection.connectionId;
  }

  /**
   * Get the current SignalR connection state.
   */
  public get state () {
    return this.#connection.state;
  }

  /**
   * Method called with update data from the SignalR connection.
   * 
   * @param topic F1 live timing topic
   * @param data update data
   * @param timestamp update timestamp
   */
  abstract feed(topic: string, data: unknown, timestamp: string): void;

  /**
   * Registers a handler that will be invoked when the SignalR connection is closed.
   * 
   * @param cb The handler that will be invoked when the SignalR connection is closed. Optionally receives a single argument containing the error that caused the SignalR connection to close (if any).
   */
  public onclose = (cb: (err?: Error) => void) => {
    this.#connection.onclose(cb);
  };

  /**
   * Registers a handler that will be invoked when the SignalR connection successfully reconnects.
   * 
   * @param cb The handler that will be invoked when the SignalR connection successfully reconnects.
   */
  public onreconnected = (cb: (connectionId?: string) => void) => {
    this.#connection.onreconnected(cb);
  };

  /**
   * Registers a handler that will be invoked when the SignalR connection starts reconnecting.
   * 
   * @param cb The handler that will be invoked when the SignalR connection starts reconnecting. Optionally receives a single argument containing the error that caused the connection to start reconnecting (if any).
   */
  public onreconnecting = (cb: (err?: Error) => void) => {
    this.#connection.onreconnecting(cb);
  };

  /**
   * Start the SignalR connection
   * 
   * @returns A Promise that resolves when the connection has been successfully established, or rejects with an error.
   */
  public start(): Promise<void> {
    return this.#connection.start();
  }

  /**
   * Stop the SignalR connection
   * 
   * @returns A Promise that resolves when the connection has been successfully terminated, or rejects with an error.
   */
  public stop(): Promise<void> {
    return this.#connection.stop();
  }

  /**
   * Subscribe to F1 live timing topics
   * 
   * @param topics 
   * @returns A Promise that resolves with the current topic data, or rejects with an error.
   */
  public subscribe(topics: string[]): Promise<any> {
    return this.#connection.invoke('Subscribe', topics);
  }

  /**
   * Unsubscribe from F1 live timing topics
   * 
   * @param topics F1 live timing topics to unsubscribe from
   * @returns A Promise that resolves with the result of the unsubscription, or rejects with an error.
   */
  public unsubscribe(topics: string[]): Promise<any> {
    return this.#connection.invoke('Unsubscribe', topics);
  }
};
