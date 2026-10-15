import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  decodeTopicData,
  inflate,
  parseJson,
  parseStreamLine,
  splitLines,
  streamLineToMessage,
  stripBom,
} from '../../src/decode.js';
import { sessionFile } from '../helpers/fixtures.js';

const compress = (value: unknown) => deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64');

describe('stripBom / parseJson', () => {
  it('removes a leading BOM only', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(parseJson('﻿{"a":1}')).toEqual({ a: 1 });
  });
});

describe('inflate / decodeTopicData', () => {
  it('inflates base64 raw deflate', () => {
    expect(inflate(compress({ Entries: [] }))).toEqual({ Entries: [] });
  });

  it('only inflates compressed topics with string data', () => {
    expect(decodeTopicData('CarData.z', compress({ x: 1 }))).toEqual({ x: 1 });
    expect(decodeTopicData('CarData', compress({ x: 1 }))).toEqual({ x: 1 });
    expect(decodeTopicData('TimingData', { x: 1 })).toEqual({ x: 1 });
    expect(decodeTopicData('Position.z', { already: 'decoded' })).toEqual({ already: 'decoded' });
  });
});

describe('parseStreamLine', () => {
  it('parses the offset and JSON of a real line', () => {
    const [first] = sessionFile('SessionStatus.jsonStream').split('\n');
    const line = parseStreamLine(first!);
    expect(line?.offset).toBeTypeOf('number');
    expect(line?.data).toHaveProperty('Status');
  });

  it('handles CRLF and blank lines', () => {
    expect(parseStreamLine('00:00:01.500{"a":1}\r')).toEqual({ offset: 1500, data: { a: 1 } });
    expect(parseStreamLine('\r')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
  });
});

describe('streamLineToMessage', () => {
  const line = { offset: 1000, data: compress({ Entries: [] }) };

  it('converts offsets to UTC and inflates compressed data', () => {
    const message = streamLineToMessage('CarData.z', line, 5000);
    expect(message).toEqual({ topic: 'CarData', utc: 6000, data: { Entries: [] } });
  });

  it('keeps the raw string on request', () => {
    expect(streamLineToMessage('CarData.z', line, 0, true).raw).toBe(line.data);
    expect(streamLineToMessage('TimingData', { offset: 0, data: { a: 1 } }, 0, true)).not.toHaveProperty('raw');
  });
});

describe('splitLines', () => {
  it('joins lines across chunks and yields a trailing line', async () => {
    async function* chunks() {
      yield 'a\nb';
      yield 'c\n';
      yield 'd';
    }
    const lines: string[] = [];
    for await (const line of splitLines(chunks())) lines.push(line);
    expect(lines).toEqual(['a', 'bc', 'd']);
  });

  it('yields nothing for an empty stream', async () => {
    async function* chunks() {}
    const lines: string[] = [];
    for await (const line of splitLines(chunks())) lines.push(line);
    expect(lines).toEqual([]);
  });
});
