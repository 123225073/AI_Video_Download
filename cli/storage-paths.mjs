import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function readableProfileExists(file) {
  try { return fs.statSync(file).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw Object.assign(new Error(`无法检查已有资料：${file}。请检查目录权限；未切换到新的空资料库。`), { code: 'DATA_DIRECTORY_UNREADABLE', cause: error });
  }
}

// Desktop and the bundled CLI must resolve the same profile. Existing installations
// keep their database in place; a failed access check must never open an empty one.
export function storagePaths({ packaged = false, executable, sourceRoot, dataDirectory,
  localAppData = process.env.LOCALAPPDATA, homeDirectory = os.homedir(), videosDirectory,
  exists = readableProfileExists } = {}) {
  const sourceBase = path.join(sourceRoot || process.cwd(), '.local');
  const legacyBase = packaged ? path.resolve(path.dirname(executable), '..') : sourceBase;
  const legacyData = path.join(legacyBase, '用户数据');
  const legacy = packaged && !dataDirectory && exists(path.join(legacyData, 'library.sqlite'));
  const userBase = path.join(localAppData || path.join(homeDirectory, 'AppData', 'Local'), 'FengshaVideoDownloader');
  const selected = path.resolve(dataDirectory || (packaged && !legacy ? path.join(userBase, '用户数据') : legacyData));
  const isLegacy = selected === path.resolve(legacyData);
  const downloadDirectory = !packaged || isLegacy
    ? path.join(legacyBase, '下载视频')
    : path.join(videosDirectory || path.join(homeDirectory, 'Videos'), '风沙下载');
  return { dataDirectory: selected, downloadDirectory, legacy: packaged && isLegacy };
}

export function prepareDataDirectory(directory, io = fs) {
  const probe = path.join(directory, `.fengsha-write-${randomUUID()}`);
  let created = false;
  try {
    io.mkdirSync(directory, { recursive: true });
    const handle = io.openSync(probe, 'wx');
    created = true;
    io.closeSync(handle);
    io.unlinkSync(probe);
  } catch (error) {
    if (created) { try { io.unlinkSync(probe); } catch {} }
    const failure = new Error(`无法写入资料目录：${directory}。已有资料保持原位；请检查目录权限和磁盘可用空间。如需迁移，请完整保留旧资料后指定新的资料目录。`);
    failure.code = 'DATA_DIRECTORY_UNWRITABLE';
    failure.cause = error;
    throw failure;
  }
  return directory;
}
