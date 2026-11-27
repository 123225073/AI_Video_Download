import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const LIBPAG_URL_RE = /https:\/\/res\.wx\.qq\.com\/t\/wx_fed\/cdn_libs\/res\/libpag\/[^/\s"'<>]+\/libpag(?:\.min)?\.js/i;
const SIMPLE_CACHE_RE = /^[0-9a-f]{16}_0$/;
const WECHAT_PROCESSES = new Set([
  'weixin.exe', 'wechat.exe', 'wechatappex.exe', 'weixinappex.exe', 'wechatplayer.exe', 'weixinplayer.exe'
]);

export function defaultLiteAppProfilesRoot(appData = process.env.APPDATA || '') {
  if (!appData) return '';
  return path.join(appData, 'Tencent', 'xwechat', 'radium', 'web', 'profiles');
}

export function isWeChatProcessRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(true); // Fail safe: assume running so we never touch locked cache.
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line.trim());
        if (match && WECHAT_PROCESSES.has(match[1].toLowerCase())) return resolve(true);
      }
      resolve(false);
    });
  });
}

function safeDirectory(dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch { return false; }
}

function fileContainsLibpagUrl(filePath, maxBytes = 16 * 1024 * 1024) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 24 || st.size > maxBytes) return false;
    const text = fs.readFileSync(filePath).toString('latin1');
    return LIBPAG_URL_RE.test(text);
  } catch { return false; }
}

export function cacheDirHasStaleLibpag(cacheDir) {
  if (!safeDirectory(cacheDir)) return false;
  let entries;
  try { entries = fs.readdirSync(cacheDir); } catch { return false; }
  // 1. Chromium Blockfile layout on Windows (index + data_0..data_3)
  if (entries.includes('index')) {
    for (const name of entries) {
      if (/^data_[0-9]+$/.test(name) && fileContainsLibpagUrl(path.join(cacheDir, name))) return true;
    }
  }
  // 2. Chromium Simple Cache layout (*_0 header carries key URL)
  for (const name of entries) {
    if (!SIMPLE_CACHE_RE.test(name)) continue;
    try {
      const fp = path.join(cacheDir, name);
      const st = fs.lstatSync(fp);
      if (!st.isFile() || st.isSymbolicLink() || st.size < 24) continue;
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, 4096));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        if (LIBPAG_URL_RE.test(buf.subarray(0, n).toString('latin1'))) return true;
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  return false;
}

export async function inspectLiteAppSdkCache({ profilesRoot = defaultLiteAppProfilesRoot(), isRunning = isWeChatProcessRunning } = {}) {
  const matchedDirs = [];
  if (profilesRoot && safeDirectory(profilesRoot)) {
    let profiles = [];
    try { profiles = fs.readdirSync(profilesRoot); } catch {}
    for (const profile of profiles) {
      const profileDir = path.join(profilesRoot, profile);
      if (!safeDirectory(profileDir)) continue;
      const cacheDir = path.join(profileDir, 'Cache', 'Cache_Data');
      if (cacheDirHasStaleLibpag(cacheDir)) matchedDirs.push(cacheDir);
    }
  }
  const wechatRunning = matchedDirs.length ? await isRunning() : false;
  return { hasStaleCache: matchedDirs.length > 0, matchedDirs, wechatRunning };
}

export async function prepareLiteAppSdkCache({ profilesRoot = defaultLiteAppProfilesRoot(), isRunning = isWeChatProcessRunning } = {}) {
  const info = await inspectLiteAppSdkCache({ profilesRoot, isRunning });
  if (!info.hasStaleCache) return { status: 'clean', cleaned: 0, backupDirs: [], wechatRunning: false };
  if (info.wechatRunning) return { status: 'needs-wechat-restart', cleaned: 0, matchedDirs: info.matchedDirs, backupDirs: [], wechatRunning: true };
  const backupDirs = [];
  let locked = false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const cacheDir of info.matchedDirs) {
    if (await isRunning()) { locked = true; break; }
    const profileDir = path.dirname(path.dirname(cacheDir));
    const backupRoot = path.join(profileDir, 'wxchannels-liteapp-sdk-backup');
    try {
      fs.mkdirSync(backupRoot, { recursive: true });
      if (!safeDirectory(backupRoot)) continue;
      const targetDir = path.join(backupRoot, `fengsha-${stamp}`);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(cacheDir, path.join(targetDir, 'Cache_Data'));
      backupDirs.push(targetDir);
    } catch {
      locked = true;
    }
  }
  if (locked && backupDirs.length < info.matchedDirs.length) {
    return { status: 'needs-wechat-restart', cleaned: backupDirs.length, matchedDirs: info.matchedDirs, backupDirs, wechatRunning: true };
  }
  return { status: backupDirs.length ? 'cleaned' : 'clean', cleaned: backupDirs.length, backupDirs, wechatRunning: false };
}
