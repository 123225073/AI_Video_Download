import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMediaUrl, resolveMedia, zoomLevel } from '../src/media-preview.js';

test('remote video cover stays a cover, never a playable video', () => {
  const result = resolveMedia({ tag: 'img', src: 'https://example.com/cover.jpg', cover: true });
  assert.equal(result.kind, 'image');
  assert.equal(result.src, 'https://example.com/cover.jpg');
  assert.equal(result.notice, '当前仅有封面，尚未取得可播放的视频；下载后可直接放大播放。');
});

test('downloaded video resolves only an existing unambiguous library record', () => {
  const rows = [{ id: 'video-1', filePath: 'D:/fixture/video.mp4', exists: true, thumbnail: 'https://example.com/cover.jpg' }];
  assert.equal(resolveMedia({ tag: 'img', src: rows[0].thumbnail, cover: true }, rows).src, 'fengsha-media://video-1');
  assert.equal(resolveMedia({ tag: 'img', src: rows[0].thumbnail, mediaId: 'video-1' }, rows).kind, 'video');
  assert.equal(resolveMedia({ tag: 'img', src: rows[0].thumbnail, cover: true }, [{ ...rows[0], exists: false }]).kind, 'image');
  assert.equal(resolveMedia({ tag: 'img', src: rows[0].thumbnail, cover: true }, [...rows, { ...rows[0], id: 'video-2' }]).kind, 'image');
  assert.equal(resolveMedia({ tag: 'img', src: rows[0].thumbnail, cover: true }, [{ ...rows[0], filePath: '' }]).kind, 'image');
});

test('explicit and native video sources work without interpreting poster as video', () => {
  assert.equal(resolveMedia({ tag: 'video', src: 'https://example.com/video.mp4', poster: 'https://example.com/cover.jpg' }).kind, 'video');
  assert.equal(resolveMedia({ tag: 'img', src: 'https://example.com/cover.jpg', videoSrc: 'fengsha-media://video-2' }).src, 'fengsha-media://video-2');
  const missing = resolveMedia({ tag: 'video', src: '', poster: 'https://example.com/cover.jpg' });
  assert.equal(missing.kind, 'image');
  assert.equal(missing.src, 'https://example.com/cover.jpg');
  assert.match(missing.notice, /尚未取得可播放的视频/);
  assert.match(resolveMedia({ tag: 'video' }).error, /未提供/);
});

test('source policy rejects navigations, files, insecure URLs and embedded credentials', () => {
  for (const src of ['javascript:alert(1)', 'file:///C:/private.jpg', 'http://example.com/x.jpg', 'https://user:password@example.com/x', 'data:text/html,<script/>', '']) assert.equal(safeMediaUrl(src), '');
  assert.equal(safeMediaUrl('https://cdn.example.com/video.mp4?token=fixture', 'video'), 'https://cdn.example.com/video.mp4?token=fixture');
  assert.equal(safeMediaUrl('fengsha-media://draft-1/a.png'), 'fengsha-media://draft-1/a.png');
  assert.equal(safeMediaUrl('data:image/png;base64,AAAA', 'video'), '');
  assert.equal(safeMediaUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('image zoom has a usable minimum, a maximum and an exact reset', () => {
  assert.equal(zoomLevel(1, '+'), 1.25);
  assert.equal(zoomLevel(1, '-'), .75);
  assert.equal(zoomLevel(.25, '-'), .25);
  assert.equal(zoomLevel(4, '+'), 4);
  assert.equal(zoomLevel(2.25, 'reset'), 1);
});
