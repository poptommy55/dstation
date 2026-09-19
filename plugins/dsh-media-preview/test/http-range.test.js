import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange, contentRange } from '../http-range.js';

test('无 Range 头 → ignored', () => {
  assert.equal(parseRange(undefined, 100).status, 'ignored');
  assert.equal(parseRange('', 100).status, 'ignored');
  assert.equal(parseRange('items=0-1', 100).status, 'ignored');
  assert.equal(parseRange('bytes=abc', 100).status, 'ignored');
  assert.equal(parseRange('bytes=0-1,3-4', 100).status, 'ignored', '多区间不伪造 multipart');
});

test('闭区间 bytes=a-b', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { status: 'ok', start: 0, end: 9, length: 10 });
  assert.deepEqual(parseRange('bytes=90-99', 100), { status: 'ok', start: 90, end: 99, length: 10 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { status: 'ok', start: 90, end: 99, length: 10 }, '尾部越界要收敛到 size-1');
});

test('开区间 bytes=a-', () => {
  assert.deepEqual(parseRange('bytes=10-', 100), { status: 'ok', start: 10, end: 99, length: 90 });
  assert.deepEqual(parseRange('bytes=0-', 100), { status: 'ok', start: 0, end: 99, length: 100 });
  assert.deepEqual(parseRange('bytes=99-', 100), { status: 'ok', start: 99, end: 99, length: 1 });
});

test('后缀区间 bytes=-N', () => {
  assert.deepEqual(parseRange('bytes=-10', 100), { status: 'ok', start: 90, end: 99, length: 10 });
  assert.deepEqual(parseRange('bytes=-1000', 100), { status: 'ok', start: 0, end: 99, length: 100 });
});

test('不可满足区间', () => {
  assert.equal(parseRange('bytes=100-', 100).status, 'unsatisfiable');
  assert.equal(parseRange('bytes=200-300', 100).status, 'unsatisfiable');
  assert.equal(parseRange('bytes=50-10', 100).status, 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100).status, 'unsatisfiable');
  assert.equal(parseRange('bytes=0-0', 0).status, 'unsatisfiable');
});

test('Content-Range 头格式', () => {
  assert.equal(contentRange(0, 99, 100), 'bytes 0-99/100');
});
