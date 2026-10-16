import { deflateRawSync } from 'node:zlib';

import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArchiveAuthError,
  ArchiveClient,
  ArchiveHttpError,
  ArchiveNotFoundError,
  buildSessionPath,
  sessionStartUtc,
  STATIC_BASE_URL,
} from '../../src/archive.js';
import { archiveAgent, SESSION_PATH, SESSION_START } from '../helpers/fixtures.js';

/** A MockAgent serving `files` under /static/, honouring `Range: bytes=0-N`. */
function serve(files: Record<string, string | Buffer>) {
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get('https://livetiming.formula1.com')
    .intercept({ path: () => true })
    .reply((options) => {
      const body = files[options.path];
      if (body === undefined) return { statusCode: 404, data: '' };
      const range = /bytes=0-(\d+)/.exec(String((options.headers as Record<string, string>)['range'] ?? ''));
      if (!range) return { statusCode: 200, data: body };
      return { statusCode: 206, data: Buffer.from(body).subarray(0, Number(range[1]) + 1) };
    })
    .persist();
  return mock;
}

const z = (value: unknown) => JSON.stringify(deflateRawSync(JSON.stringify(value)).toString('base64'));

let agent: MockAgent;
let archive: ArchiveClient;

beforeEach(() => {
  agent = archiveAgent();
  archive = new ArchiveClient({ dispatcher: agent });
});

afterEach(async () => {
  await agent.close();
});

describe('ArchiveClient indexes', () => {
  it('reads the static index, season and latest session', async () => {
    expect(await archive.index()).toEqual({ Years: [{ Year: 2026, Path: '2026/' }] });
    const season = await archive.season(2026);
    expect(season.Meetings.length).toBe(19);
    expect(season.Meetings.at(-1)?.Sessions.at(-1)?.Path).toBe(SESSION_PATH);
    const latest = await archive.latestSession();
    expect(latest.Path).toBe(SESSION_PATH);
    expect(await archive.streamingStatus()).toBe('Available');
  });

  it('reads session feeds, archive status and keyframes', async () => {
    const feeds = await archive.sessionFeeds(SESSION_PATH);
    expect(Object.keys(feeds.Feeds)).toHaveLength(33);
    expect(feeds.Feeds['CarData.z']).toEqual({ KeyFramePath: 'CarData.z.json', StreamPath: 'CarData.z.jsonStream' });
    expect(await archive.archiveStatus(`/${SESSION_PATH.slice(0, -1)}`)).toEqual({ Status: 'Complete' });
    expect(await archive.keyframe(SESSION_PATH, 'CarData')).toHaveProperty('Entries');
    expect(await archive.keyframe(SESSION_PATH, 'LapCount')).toEqual({ CurrentLap: 62, TotalLaps: 62 });
  });

  it('builds absolute URLs', () => {
    expect(archive.url(`${SESSION_PATH}TeamRadio/VER_3.mp3`)).toBe(`${STATIC_BASE_URL}${SESSION_PATH}TeamRadio/VER_3.mp3`);
    expect(new ArchiveClient({ baseUrl: 'https://example.com/static' }).url('/x.json')).toBe(
      'https://example.com/static/x.json',
    );
  });
});

describe('ArchiveClient streams', () => {
  it('finds the stream start from the first CarData line', async () => {
    expect(await archive.streamStart(SESSION_PATH)).toBeCloseTo(SESSION_START, 0);
  });

  it('streams messages with UTC times', async () => {
    const messages = [];
    for await (const message of archive.stream(SESSION_PATH, 'SessionStatus')) messages.push(message);
    expect(messages.map((m) => (m.data as { Status: string }).Status)).toEqual([
      'Inactive',
      'Started',
      'Finished',
      'Finalised',
      'Ends',
    ]);
    expect(messages[1]!.utc).toBeCloseTo(SESSION_START + 3_363_497, 0);
  });

  it('keeps raw compressed payloads on request', async () => {
    const stream = archive.stream(SESSION_PATH, 'Position.z', { start: 0, raw: true });
    const { value } = await stream.next();
    await stream.return(undefined);
    expect(value?.topic).toBe('Position');
    expect(typeof value?.raw).toBe('string');
  });

  it('throws ArchiveNotFoundError for missing files', async () => {
    await expect(archive.keyframe(SESSION_PATH, 'TimingData')).rejects.toBeInstanceOf(ArchiveNotFoundError);
    await expect(archive.streamStart('2026/nothing/')).rejects.toThrow('Cannot find the stream start');
  });

  it('throws ArchiveHttpError for other failures', async () => {
    const failing = new MockAgent();
    failing.disableNetConnect();
    failing.get('https://livetiming.formula1.com').intercept({ path: '/static/Index.json' }).reply(500, 'oops');
    await expect(new ArchiveClient({ dispatcher: failing, headers: { 'x-test': '1' } }).index()).rejects.toBeInstanceOf(
      ArchiveHttpError,
    );
    await failing.close();
  });
});

describe('ArchiveClient authToken', () => {
  /** An agent that records the request headers and answers with `status`. */
  function recording(status: number) {
    const seen: Array<Record<string, string>> = [];
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get('https://livetiming.formula1.com')
      .intercept({ path: () => true })
      .reply((options) => {
        seen.push(options.headers as Record<string, string>);
        return { statusCode: status, data: status === 200 ? '{"Years":[]}' : '' };
      })
      .persist();
    return { mock, seen };
  }

  it('sends the token as a Bearer Authorization header', async () => {
    const { mock, seen } = recording(200);
    await new ArchiveClient({ dispatcher: mock, authToken: 'tok.en.value' }).index();
    expect(seen[0]?.['authorization']).toBe('Bearer tok.en.value');
    await mock.close();
  });

  it('accepts a token that already starts with Bearer and ignores a blank one', async () => {
    const { mock, seen } = recording(200);
    await new ArchiveClient({ dispatcher: mock, authToken: ' Bearer abc ' }).index();
    await new ArchiveClient({ dispatcher: mock, authToken: '   ' }).index();
    expect(seen[0]?.['authorization']).toBe('Bearer abc');
    expect(seen[1]?.['authorization']).toBeUndefined();
    await mock.close();
  });

  it('lets an explicit authorization header win', async () => {
    const { mock, seen } = recording(200);
    await new ArchiveClient({
      dispatcher: mock,
      authToken: 'from-option',
      headers: { authorization: 'Bearer from-headers' },
    }).index();
    expect(seen[0]?.['authorization']).toBe('Bearer from-headers');
    await mock.close();
  });

  it('throws ArchiveAuthError on 401, telling a rejected token from a missing one', async () => {
    const { mock } = recording(401);
    const rejected = await new ArchiveClient({ dispatcher: mock, authToken: 'old' }).index().catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ArchiveAuthError);
    expect(rejected).toBeInstanceOf(ArchiveHttpError);
    expect(rejected).toMatchObject({ statusCode: 401, hadToken: true, name: 'ArchiveAuthError' });
    expect((rejected as Error).message).toMatch(/rejected the authToken/);

    const missing = await new ArchiveClient({ dispatcher: mock }).index().catch((e: unknown) => e);
    expect(missing).toMatchObject({ hadToken: false });
    expect((missing as Error).message).toMatch(/needs an authToken/);

    const viaHeader = await new ArchiveClient({ dispatcher: mock, headers: { Authorization: 'Bearer x' } })
      .index()
      .catch((e: unknown) => e);
    expect(viaHeader).toMatchObject({ hadToken: true });
    await mock.close();
  });

  it('still reports 403 and 404 as missing files', async () => {
    const { mock } = recording(403);
    await expect(new ArchiveClient({ dispatcher: mock, authToken: 't' }).index()).rejects.toBeInstanceOf(
      ArchiveNotFoundError,
    );
    await mock.close();
  });
});

describe('streamStart edge cases', () => {
  it('falls back to Position when CarData has no samples', async () => {
    const mock = serve({
      '/static/p/CarData.z.jsonStream': '00:00:01.000"q64FAA=="\r\n',
      '/static/p/Position.z.jsonStream': `00:00:02.000${JSON.stringify(
        Buffer.from(
          deflateRawSync(
            JSON.stringify({ Position: [{ Timestamp: '2026-01-01T00:00:10.000Z', Entries: {} }] }),
          ),
        ).toString('base64'),
      )}\r\n`,
    });
    const client = new ArchiveClient({ dispatcher: mock });
    expect(await client.streamStart('p')).toBe(Date.parse('2026-01-01T00:00:08.000Z'));
    await mock.close();
  });

  it('reads more when the first line is longer than the first range', async () => {
    const pad = 'x'.repeat(40_000);
    const payload = deflateRawSync(
      JSON.stringify({ Entries: [{ Utc: '2026-01-01T00:00:05.000Z', Cars: {}, pad }] }),
      { level: 0 },
    ).toString('base64');
    const mock = serve({ '/static/p/CarData.z.jsonStream': `00:00:05.000${JSON.stringify(payload)}\r\n00:00:06.000"x"` });
    expect(await new ArchiveClient({ dispatcher: mock }).streamStart('p')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    await mock.close();
  });

  it('gives up on a first line longer than 1 MiB', async () => {
    const mock = serve({ '/static/p/CarData.z.jsonStream': `00:00:00.000"${'A'.repeat(1_200_000)}"\r\n` });
    await expect(new ArchiveClient({ dispatcher: mock }).streamStart('p')).rejects.toThrow('Cannot find the stream start');
    await mock.close();
  });

  it('reads a single line without a newline', async () => {
    const mock = serve({
      '/static/p/CarData.z.jsonStream': `00:00:01.000${z({ Entries: [{ Utc: '2026-01-01T00:00:01Z' }] })}`,
    });
    expect(await new ArchiveClient({ dispatcher: mock }).streamStart('p')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    await mock.close();
  });

  it('skips stream data that is not an object', async () => {
    const mock = serve({
      '/static/p/CarData.z.jsonStream': `00:00:01.000${z(5)}\r\n`,
      '/static/p/Position.z.jsonStream': `00:00:01.000${z({ Position: [{}] })}\r\n`,
    });
    await expect(new ArchiveClient({ dispatcher: mock }).streamStart('p')).rejects.toThrow('Cannot find the stream start');
    await mock.close();
  });

  it('fails on empty streams', async () => {
    const mock = serve({ '/static/p/CarData.z.jsonStream': '', '/static/p/Position.z.jsonStream': '﻿' });
    await expect(new ArchiveClient({ dispatcher: mock }).streamStart('p')).rejects.toThrow('Cannot find the stream start');
    await mock.close();
  });
});

describe('ArchiveClient defaults', () => {
  it('uses the global dispatcher and default base URL', async () => {
    const previous = getGlobalDispatcher();
    const mock = serve({ '/static/StreamingStatus.json': '{"Status":"Offline"}' });
    setGlobalDispatcher(mock);
    try {
      expect(await new ArchiveClient().streamingStatus()).toBe('Offline');
    } finally {
      setGlobalDispatcher(previous);
      await mock.close();
    }
  });

  it('skips blank lines', async () => {
    const mock = serve({
      '/static/p/LapCount.jsonStream': '\uFEFF00:00:01.000{"CurrentLap":1}\r\n\r\n00:00:02.000{"CurrentLap":2}',
    });
    const lines = [];
    for await (const line of new ArchiveClient({ dispatcher: mock }).streamLines('p', 'LapCount')) lines.push(line);
    expect(lines).toEqual([
      { offset: 1000, data: { CurrentLap: 1 } },
      { offset: 2000, data: { CurrentLap: 2 } },
    ]);
    await mock.close();
  });
});

describe('session helpers', () => {
  it('rebuilds missing session paths', () => {
    const meeting = {
      Name: 'Pre-Season Test',
      Sessions: [
        { Name: 'Practice 1', StartDate: '2021-03-12T10:00:00' },
        { Name: 'Practice 3', StartDate: '2021-03-14T10:00:00' },
      ],
    } as never;
    expect(buildSessionPath(2021, meeting, { Name: 'Practice 1', StartDate: '2021-03-12T10:00:00' })).toBe(
      '2021/2021-03-14_Pre-Season_Test/2021-03-12_Practice_1/',
    );
    expect(buildSessionPath(2021, { Name: 'X', Sessions: [] }, { Name: 'Day 1', StartDate: '2021-01-01T00:00:00' })).toBe(
      '2021/2021-01-01_X/2021-01-01_Day_1/',
    );
  });

  it('fills paths missing from a season index', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get('https://livetiming.formula1.com')
      .intercept({ path: '/static/2021/Index.json' })
      .reply(
        200,
        JSON.stringify({
          Year: 2021,
          Meetings: [{ Name: 'Test', Sessions: [{ Name: 'Day 1', StartDate: '2021-03-12T10:00:00' }] }],
        }),
      );
    const season = await new ArchiveClient({ dispatcher: mock }).season(2021);
    expect(season.Meetings[0]!.Sessions[0]!.Path).toBe('2021/2021-03-12_Test/2021-03-12_Day_1/');
    await mock.close();
  });

  it('converts local start dates to UTC', () => {
    expect(sessionStartUtc({ StartDate: '2026-10-11T20:00:00', GmtOffset: '08:00:00' })).toBe(
      Date.parse('2026-10-11T12:00:00Z'),
    );
    expect(sessionStartUtc({ StartDate: '2026-06-14T14:00:00', GmtOffset: '-04:00:00' })).toBe(
      Date.parse('2026-06-14T18:00:00Z'),
    );
    expect(sessionStartUtc({ StartDate: '2026-06-14T14:00:00', GmtOffset: '02:00' })).toBe(
      Date.parse('2026-06-14T12:00:00Z'),
    );
    expect(sessionStartUtc({ StartDate: '2026-06-14T14:00:00', GmtOffset: '' })).toBe(
      Date.parse('2026-06-14T14:00:00Z'),
    );
  });
});
