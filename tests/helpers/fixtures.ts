import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockAgent } from 'undici';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Archive path of the fixture session. */
export const SESSION_PATH = '2026/2026-10-11_Singapore_Grand_Prix/2026-10-11_Race/';
/** Folder holding the fixture session's files. */
export const SESSION_DIR = join(FIXTURES, 'singapore-2026-race');
/** Offset zero of the fixture session, measured from the full download. */
export const SESSION_START = Date.parse('2026-10-11T11:07:35.580Z');

/** Topics whose full stream is in the fixtures (CarData/Position are trimmed). */
export const FULL_TOPICS = readdirSync(SESSION_DIR)
  .filter((name) => name.endsWith('.jsonStream') && !name.endsWith('.z.jsonStream'))
  .map((name) => name.slice(0, -'.jsonStream'.length));

export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

export function sessionFile(name: string): string {
  return readFileSync(join(SESSION_DIR, name), 'utf8');
}

export interface LiveFeedFixture {
  snapshot: Record<string, unknown>;
  feeds: [string, unknown, string][];
}

export function liveFeed(): LiveFeedFixture {
  return JSON.parse(fixture('live-feed.json')) as LiveFeedFixture;
}

/**
 * A MockAgent serving the fixture archive at livetiming.formula1.com/static.
 * Files that are not in the fixtures return 403 like S3 does.
 */
export function archiveAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get('https://livetiming.formula1.com');
  const files = new Map<string, string>([
    ['/static/Index.json', fixture('static-index.json')],
    ['/static/2026/Index.json', fixture('season-2026.json')],
    ['/static/SessionInfo.json', sessionFile('SessionInfo.json')],
    ['/static/StreamingStatus.json', '﻿{"Status":"Available"}'],
  ]);
  for (const name of readdirSync(SESSION_DIR)) files.set(`/static/${SESSION_PATH}${name}`, sessionFile(name));
  pool
    .intercept({ path: (path) => true, method: 'GET' })
    .reply((options) => {
      const body = files.get(options.path);
      return body === undefined ? { statusCode: 403, data: 'AccessDenied' } : { statusCode: 200, data: body };
    })
    .persist();
  return agent;
}
