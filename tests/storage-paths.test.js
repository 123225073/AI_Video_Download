import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storagePaths, prepareDataDirectory } from '../cli/storage-paths.mjs';

const root = path.resolve('output', 'storage-path-fixture');
const options = { packaged: true, executable: path.join(root, '安装', '程序', 'FengshaVideoDownloader.exe'),
  sourceRoot: path.join(root, '源码'), localAppData: path.join(root, 'LocalAppData'), homeDirectory: path.join(root, '用户'),
  videosDirectory: path.join(root, '个人视频'), exists: () => false };

test('全新安装的资料与下载目录属于当前用户，与安装磁盘及受保护安装路径无关', () => {
  const actual = storagePaths(options);
  assert.equal(actual.dataDirectory, path.join(options.localAppData, 'FengshaVideoDownloader', '用户数据'));
  assert.equal(actual.downloadDirectory, path.join(options.videosDirectory, '风沙下载'));
  assert.equal(actual.legacy, false);
  assert.deepEqual(storagePaths({ ...options, executable: path.join(root, 'Program Files', 'tool', 'app.exe') }), actual);
});

test('升级保留已有数据库与下载目录，不创建隐藏旧资料的新空库', () => {
  const legacyBase = path.dirname(path.dirname(options.executable));
  const database = path.join(legacyBase, '用户数据', 'library.sqlite');
  const actual = storagePaths({ ...options, exists: value => value === database });
  assert.equal(actual.dataDirectory, path.dirname(database));
  assert.equal(actual.downloadDirectory, path.join(legacyBase, '下载视频'));
  assert.equal(actual.legacy, true);
});

test('源码与显式资料目录继续有效，CLI 和桌面使用同一个解析器', () => {
  const source = storagePaths({ ...options, packaged: false });
  assert.equal(source.dataDirectory, path.join(options.sourceRoot, '.local', '用户数据'));
  assert.equal(source.downloadDirectory, path.join(options.sourceRoot, '.local', '下载视频'));
  const dataDirectory = path.join(root, '隔离资料');
  assert.equal(storagePaths({ ...options, dataDirectory, exists: () => { throw new Error('显式目录不应检查默认库'); } }).dataDirectory, dataDirectory);
});

test('新资料目录自动创建并实际验证可写，探针不留在资料目录', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-storage-'));
  const directory = path.join(temporary, '资料');
  try {
    assert.equal(prepareDataDirectory(directory), directory);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('旧目录不可写时明确失败，不回退到新资料库或尝试提升权限', () => {
  const directory = path.join(root, '旧资料');
  const calls = [];
  const io = { mkdirSync: value => calls.push(value), openSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.throws(() => prepareDataDirectory(directory, io), error => error.code === 'DATA_DIRECTORY_UNWRITABLE' && error.message.includes('已有资料保持原位'));
  assert.deepEqual(calls, [directory]);
});
