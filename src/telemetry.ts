import type { LiveTimingMessage } from './decode.js';
import { isPlainObject } from './merge.js';
import { parseUtc } from './time.js';
import { CarDataChannel, type RacingNumber } from './topics.js';

/** One car telemetry sample with named channels. */
export interface CarSample {
  readonly utc: number;
  readonly rpm: number;
  readonly speed: number;
  readonly gear: number;
  readonly throttle: number;
  readonly brake: number;
  /** DRS channel. Absent from 2026 onwards. */
  readonly drs?: number;
}

/** One car position sample in circuit coordinates. */
export interface PositionSample {
  readonly utc: number;
  readonly status: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Sorted per-driver sample lists, kept up to date as messages arrive. */
class Series<S extends { readonly utc: number }> {
  readonly #byDriver = new Map<RacingNumber, S[]>();

  add(driver: RacingNumber, sample: S): void {
    let list = this.#byDriver.get(driver);
    if (!list) this.#byDriver.set(driver, (list = []));
    const last = list[list.length - 1];
    if (!last || last.utc <= sample.utc) list.push(sample);
    else list.splice(upperBound(list, sample.utc), 0, sample);
  }

  drivers(): RacingNumber[] {
    return [...this.#byDriver.keys()];
  }

  all(driver: RacingNumber): readonly S[] {
    return this.#byDriver.get(driver) ?? [];
  }

  range(driver: RacingNumber, from: number, to: number): S[] {
    const list = this.all(driver);
    return list.slice(lowerBound(list, from), upperBound(list, to));
  }

  /** The samples around `utc`: the last one at or before it and the next one. */
  around(driver: RacingNumber, utc: number): [S | undefined, S | undefined] {
    const list = this.all(driver);
    const index = upperBound(list, utc);
    return [list[index - 1], list[index]];
  }

  clear(): void {
    this.#byDriver.clear();
  }
}

/**
 * Per-driver car telemetry and position series built from `CarData` and
 * `Position` messages, with lookups by UTC time.
 */
export class TelemetryStore {
  readonly #car = new Series<CarSample>();
  readonly #position = new Series<PositionSample>();

  /** Add the samples in a `CarData` or `Position` message. Other topics are ignored. */
  add(message: LiveTimingMessage): void {
    if (message.topic === 'CarData') this.#addCarData(message.data);
    else if (message.topic === 'Position') this.#addPosition(message.data);
  }

  /** Racing numbers with car telemetry. */
  drivers(): RacingNumber[] {
    return this.#car.drivers();
  }

  /** Racing numbers with positions. */
  positionDrivers(): RacingNumber[] {
    return this.#position.drivers();
  }

  /** Every car sample of a driver, oldest first. */
  car(driver: RacingNumber): readonly CarSample[] {
    return this.#car.all(driver);
  }

  /** Every position sample of a driver, oldest first. */
  position(driver: RacingNumber): readonly PositionSample[] {
    return this.#position.all(driver);
  }

  /** Car samples with `from <= utc <= to`. */
  carRange(driver: RacingNumber, from: number, to: number): CarSample[] {
    return this.#car.range(driver, from, to);
  }

  /** Position samples with `from <= utc <= to`. */
  positionRange(driver: RacingNumber, from: number, to: number): PositionSample[] {
    return this.#position.range(driver, from, to);
  }

  /**
   * Car telemetry at a UTC time. Continuous channels are interpolated between
   * the samples around `utc`; gear and DRS hold the earlier sample's value.
   * After the last sample the last sample is returned, and before the first
   * sample the result is `undefined`.
   */
  carAt(driver: RacingNumber, utc: number): CarSample | undefined {
    const [a, b] = this.#car.around(driver, utc);
    if (!a) return undefined;
    if (!b) return a;
    const t = (utc - a.utc) / (b.utc - a.utc);
    const sample: CarSample = {
      utc,
      rpm: lerp(a.rpm, b.rpm, t),
      speed: lerp(a.speed, b.speed, t),
      gear: a.gear,
      throttle: lerp(a.throttle, b.throttle, t),
      brake: lerp(a.brake, b.brake, t),
    };
    return a.drs === undefined ? sample : { ...sample, drs: a.drs };
  }

  /** Car position at a UTC time, interpolated like {@link carAt}. */
  positionAt(driver: RacingNumber, utc: number): PositionSample | undefined {
    const [a, b] = this.#position.around(driver, utc);
    if (!a) return undefined;
    if (!b) return a;
    const t = (utc - a.utc) / (b.utc - a.utc);
    return {
      utc,
      status: a.status,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
    };
  }

  /** Drop every sample. */
  clear(): void {
    this.#car.clear();
    this.#position.clear();
  }

  #addCarData(data: unknown): void {
    if (!isPlainObject(data) || !Array.isArray(data['Entries'])) return;
    for (const entry of data['Entries'] as unknown[]) {
      if (!isPlainObject(entry) || typeof entry['Utc'] !== 'string' || !isPlainObject(entry['Cars'])) continue;
      const utc = parseUtc(entry['Utc']);
      for (const [driver, car] of Object.entries(entry['Cars'])) {
        if (!isPlainObject(car) || !isPlainObject(car['Channels'])) continue;
        const ch = car['Channels'];
        const sample: CarSample = {
          utc,
          rpm: num(ch[CarDataChannel.Rpm]),
          speed: num(ch[CarDataChannel.Speed]),
          gear: num(ch[CarDataChannel.Gear]),
          throttle: num(ch[CarDataChannel.Throttle]),
          brake: num(ch[CarDataChannel.Brake]),
        };
        const drs = ch[CarDataChannel.Drs];
        this.#car.add(driver, typeof drs === 'number' ? { ...sample, drs } : sample);
      }
    }
  }

  #addPosition(data: unknown): void {
    if (!isPlainObject(data) || !Array.isArray(data['Position'])) return;
    for (const entry of data['Position'] as unknown[]) {
      if (!isPlainObject(entry) || typeof entry['Timestamp'] !== 'string' || !isPlainObject(entry['Entries'])) continue;
      const utc = parseUtc(entry['Timestamp']);
      for (const [driver, pos] of Object.entries(entry['Entries'])) {
        if (!isPlainObject(pos)) continue;
        this.#position.add(driver, {
          utc,
          status: typeof pos['Status'] === 'string' ? pos['Status'] : '',
          x: num(pos['X']),
          y: num(pos['Y']),
          z: num(pos['Z']),
        });
      }
    }
  }
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** First index whose `utc` is `>= utc`. */
export function lowerBound(list: readonly { readonly utc: number }[], utc: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.utc < utc) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose `utc` is `> utc`. */
export function upperBound(list: readonly { readonly utc: number }[], utc: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.utc <= utc) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
