import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mediaTypeOf, extensionOf } from '../mime.js';
import { PathGuard, normalizePath, isWithin, resolveRoots } from '../path-guard.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-test-'));
  return {
    dir,
    file(name, bytes = 'x') {
      const p = join(dir, name);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, bytes);
      return p;
    },
    sub(name) {
      const p = join(dir, name);
      mkdirSync(p, { recursive: true });
      return p;
    },
    done() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('mime: 常见扩展名映射正确，未知扩展名返回 null', () => {
  assert.deepEqual(mediaTypeOf('D:/a/b.PNG'), { kind: 'image', type: 'image/png' });
  assert.deepEqual(mediaTypeOf('/tmp/x/y.MP4'), { kind: 'video', type: 'video/mp4' });
  assert.deepEqual(mediaTypeOf('c:\\music\\song.mp3'), { kind: 'audio', type: 'audio/mpeg' });
  assert.equal(mediaTypeOf('notes.txt'), null);
  assert.equal(mediaTypeOf('archive.zip'), null);
  assert.equal(mediaTypeOf('no-extension'), null);
  assert.equal(mediaTypeOf('.png'), null, '隐藏文件名不应被当成扩展名');
  assert.equal(extensionOf('a/b/c.WebM'), 'webm');
});

test('normalizePath: 统一分隔符/盘符大小写/去尾斜杠', () => {
  assert.equal(normalizePath('d:\\a\\b.png'), 'D:/a/b.png');
  assert.equal(normalizePath('D:/a//b.png'), 'D:/a/b.png');
  assert.equal(normalizePath('D:/a/b.png/'), 'D:/a/b.png');
  assert.equal(normalizePath('  /home/u/a.png  '), '/home/u/a.png');
  assert.equal(normalizePath(null), '');
});

test('isWithin: 相等/go 之内/go 之外/前缀陷阱', () => {
  assert.equal(isWithin('D:/root', 'D:/root'), true);
  assert.equal(isWithin('D:/root', 'D:/root/a/b.png'), true);
  assert.equal(isWithin('D:/root', 'D:/root2/a.png'), false, '同前缀不同目录不算在内');
  assert.equal(isWithin('D:/root', 'D:/other/a.png'), false);
  assert.equal(isWithin('', 'D:/root/a.png'), false);
});

test('PathGuard: 允许根之内的媒体通过', () => {
  const s = scratch();
  try {
    const png = s.file('out/a.png', 'PNGDATA');
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(png, mediaTypeOf);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.media.type, 'image/png');
    assert.equal(r.name, 'a.png');
    assert.equal(r.size, 7);
  } finally {
    s.done();
  }
});

test('PathGuard: 根之外的媒体一律拒绝（这是安全边界的核心）', () => {
  const inside = scratch();
  const outside = scratch();
  try {
    const secret = outside.file('secret.png');
    const guard = new PathGuard({ roots: () => [inside.dir] });
    const r = guard.resolve(secret, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'outside_roots');
  } finally {
    inside.done();
    outside.done();
  }
});

test('PathGuard: 非媒体扩展名被拒（本路由不是通用文件服务器）', () => {
  const s = scratch();
  try {
    const txt = s.file('notes.txt');
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(txt, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.status, 415);
    assert.equal(r.code, 'unsupported_media');
  } finally {
    s.done();
  }
});

test('PathGuard: 点开头的文件被拒（.env 之类）', () => {
  const s = scratch();
  try {
    // 关键在第二道闸门。注意顺序：宿主先按扩展名白名单过滤，所以
    // 「.env」会先撞上 unsupported_media；而「.secret.png」既有合法媒体
    // 扩展名、又是点开头，正是需要 segment 规则兜住的形态。
    const hidden = s.file('.secret.png', 'x');
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(hidden, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'denied_path', '点开头的文件名不得暴露');
  } finally {
    s.done();
  }
});

test('PathGuard: 受保护目录段被拒', () => {
  const s = scratch();
  try {
    const ssh = s.sub('.ssh');
    const key = join(ssh, 'id_rsa.png');
    writeFileSync(key, 'x');
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(key, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'denied_path');
  } finally {
    s.done();
  }
});

test('PathGuard: 相对路径被拒', () => {
  const s = scratch();
  try {
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve('out/a.png', mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_absolute');
  } finally {
    s.done();
  }
});

test('PathGuard: 不存在的文件返回 404', () => {
  const s = scratch();
  try {
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(join(s.dir, 'nope.png'), mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    s.done();
  }
});

test('PathGuard: 目录不算文件', () => {
  const s = scratch();
  try {
    const d = s.sub('a.png');
    const guard = new PathGuard({ roots: () => [s.dir] });
    const r = guard.resolve(d, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_a_file');
  } finally {
    s.done();
  }
});

test('PathGuard: 没有允许根时明确报错而不是放行', () => {
  const s = scratch();
  try {
    const png = s.file('a.png');
    const guard = new PathGuard({ roots: () => [] });
    const r = guard.resolve(png, mediaTypeOf);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_root');
    assert.equal(r.status, 403);
  } finally {
    s.done();
  }
});

test('resolveRoots: 丢掉不存在的根、去重、realpath 归一', () => {
  const s = scratch();
  try {
    const roots = resolveRoots([s.dir, s.dir, join(s.dir, 'missing')]);
    assert.equal(roots.length, 1);
  } finally {
    s.done();
  }
});

test('PathGuard: 符号链接指向根外时按 realpath 判定（逃逸被拦）', { skip: process.platform === 'win32' ? '需要管理员权限创建符号链接' : false }, () => {
  const inside = scratch();
  const outside = scratch();
  try {
    const target = outside.file('secret.png');
    const link = join(inside.dir, 'link.png');
    symlinkSync(target, link);
    const guard = new PathGuard({ roots: () => [inside.dir] });
    const r = guard.resolve(link, mediaTypeOf);
    assert.equal(r.ok, false, 'realpath 之后落在根外，必须拒绝');
    assert.equal(r.code, 'outside_roots');
  } finally {
    inside.done();
    outside.done();
  }
});
