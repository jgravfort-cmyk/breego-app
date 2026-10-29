// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, formatTemp, command, LineAssembler } from '../js/protocol.js';

test('parses the dual-zone status example from the spec', () => {
  const s = parseLine('/S00/F/2,1,1,+06,000,+09,000,1,124,1');
  assert.equal(s.kind, 'status');
  assert.equal(s.model, 'X30');
  assert.equal(s.zones, 2);
  assert.equal(s.on, true);
  assert.equal(s.unit, 'C');
  assert.equal(s.leftCur, 6);
  assert.equal(s.leftSet, 9);
  assert.equal(s.protection, 1);
  assert.equal(s.volt, 12.4);
  assert.equal(s.speed, 'eco');
  assert.equal(s.max, null);
});

test('parses optional max, min and binding fields', () => {
  const s = parseLine('/S00/H/2,0,2,+40,-04,+04,-18,3,121,2,+10,-20,1');
  assert.equal(s.unit, 'F');
  assert.equal(s.on, false);
  assert.equal(s.rightSet, -18);
  assert.equal(s.speed, 'max');
  assert.deepEqual([s.max, s.min, s.binding], [10, -20, 1]);
});

test('parses fault codes', () => {
  assert.deepEqual(parseLine('/SEE/1/6'), { kind: 'fault', zone: 1, code: 6, raw: '/SEE/1/6' });
});

test('formats temperatures with sign and two digits', () => {
  assert.equal(formatTemp(6), '+06');
  assert.equal(formatTemp(-18), '-18');
  assert.equal(formatTemp(0), '+00');
  assert.equal(command.leftTemp(-4), '/S03/1/-04');
  assert.equal(command.rightTemp(10), '/S05/1/+10');
  assert.equal(command.power(false), '/S01/1/000');
  assert.equal(command.protection(3), '/S04/1/003');
  assert.equal(command.speed(true), '/S06/1/002');
  assert.equal(command.unit(true), '/S07/1/002');
  // The spec says commands are 12 characters: 10 plus a two-character "\n".
  assert.equal((command.status() + '\\n').length, 12);
});

test('joins Bluetooth chunks into lines, with real or literal newlines', () => {
  const lines = [];
  const a = new LineAssembler((l) => lines.push(l), 10);
  a.push('/S00/F/2,1,1,+06,000');
  a.push(',+09,000,1,124,1\n/SEE');
  a.push('/1/1\\n');
  assert.deepEqual(lines, ['/S00/F/2,1,1,+06,000,+09,000,1,124,1', '/SEE/1/1']);
});

test('splits back-to-back messages that have no line ending', () => {
  const lines = [];
  const a = new LineAssembler((l) => lines.push(l), 10);
  a.push('/SEE/1/2/S00/F/2,1,1,+06,000,+09,000,1,124,1');
  a.flush();
  assert.deepEqual(lines, ['/SEE/1/2', '/S00/F/2,1,1,+06,000,+09,000,1,124,1']);
});
