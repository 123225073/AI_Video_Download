export const commands = ['help', 'version', 'environment', 'inspect', 'creator', 'download', 'tasks', 'task', 'media', 'probe', 'accounts', 'service'];
const values = new Set(['limit', 'indices', 'list', 'record', 'output', 'quality', 'archive', 'timeout', 'id', 'action', 'period', 'from', 'to', 'keyword', 'data-dir', 'file']);
const flags = new Set(['json', 'all', 'no-wait', 'force', 'include-unknown', 'include-downloaded', 'continue', 'refresh', 'help']);
export function usage() {
  return { name: 'fengsha-cli', format: 'JSON', commands: {
    inspect: 'inspect <分享链接或文案> [--limit 30]',
    creator: 'creator <视频或主页链接> [--limit 50] [--period 7|30|90|all|custom] [--from YYYY-MM-DD --to YYYY-MM-DD] [--keyword 文字]；或 creator --record ID --continue；B站旧清单补全：creator --record ID --refresh',
    download: 'download <链接> 或 --list 清单.json 或 --record ID [--indices 1,2 | --all] [--output 目录] [--quality best|1080|720|480] [--archive flat|author|collection] [--no-wait]',
    tasks: 'tasks [--id ID]', task: 'task --id ID --action pause|resume|retry|cancel',
    media: 'media [--id ID]', probe: 'probe --file 本地视频路径',
    accounts: 'accounts（仅返回账号状态，不返回会话）', environment: 'environment',
    service: 'service 或 service stop（仅停止空闲后台实例）', version: 'version', help: 'help'
  }, common: { '--data-dir': '可选隔离资料目录，默认与桌面应用共享', '--timeout': '秒，默认 3600；超时不取消已经入队的下载', '--json': '默认就是 JSON；stdout 仅输出一个 JSON 对象' }, exitCodes: { 0: '完成', 1: '运行失败', 2: '参数或选择错误', 3: '等待超时，任务可能仍在运行', 4: '部分下载失败 / 清单读取未完成' } };
}
export function parseArgs(argv) {
  const options = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, ...tail] = arg.slice(2).split('=');
    if (flags.has(name)) { if (tail.length) throw new Error(`参数 --${name} 不接受值`); options[name] = true; }
    else if (values.has(name)) {
      const value = tail.length ? tail.join('=') : argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`参数 --${name} 缺少值`);
      options[name] = value;
    } else throw new Error(`未知参数 --${name}`);
  }
  let command = positional.shift() || 'help';
  if (options.help) command = 'help';
  if (!commands.includes(command)) throw new Error(`未知命令 ${command}`);
  if (positional.length > 1 || (positional.length && !['inspect', 'creator', 'download', 'service'].includes(command))) throw new Error('位置参数过多；请将分享文案和含空格路径放在引号中');
  for (const name of ['limit', 'timeout']) if (options[name] !== undefined) {
    const n = Number(options[name]); if (!Number.isInteger(n) || n < 1 || n > (name === 'limit' ? 100000 : 86400)) throw new Error(`--${name} 超出允许范围`); options[name] = n;
  }
  if (options.quality && !['best', '1080', '720', '480'].includes(options.quality)) throw new Error('无效画质');
  if (options.archive && !['flat', 'author', 'collection'].includes(options.archive)) throw new Error('无效归档规则');
  if (options.all && options.indices) throw new Error('--all 和 --indices 不能同时使用');
  if (options.refresh && (command !== 'creator' || !options.record || options.continue || positional[0])) throw new Error('--refresh 仅用于 creator --record，不能同时提供链接或 --continue');
  if (options.indices && !/^\d+(,\d+)*$/.test(options.indices)) throw new Error('--indices 使用从 1 开始的逗号分隔编号');
  if (command === 'download' && [positional[0], options.list, options.record].filter(Boolean).length !== 1) throw new Error('下载需提供且仅提供一个链接、--list 或 --record');
  if (command === 'inspect' && !positional[0] || command === 'creator' && !positional[0] && !options.record) throw new Error('请提供链接或已保存博主记录');
  if (command === 'probe' && !options.file) throw new Error('probe 需要 --file');
  if (command === 'task' && (!options.id || !['pause', 'resume', 'retry', 'cancel'].includes(options.action))) throw new Error('task 需要 --id 与有效 --action');
  if (command === 'service' && positional[0] && positional[0] !== 'stop') throw new Error('service 仅支持 stop');
  return { command, source: positional[0], options };
}
export function selectItems(items, options) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('清单没有可下载视频'), { code: 'EMPTY_LIST', exitCode: 2 });
  if (options.indices) {
    const indices = [...new Set(options.indices.split(',').map(Number))];
    if (indices.some(i => i < 1 || i > items.length)) throw Object.assign(new Error('选中编号超出清单范围'), { code: 'INVALID_SELECTION', exitCode: 2 });
    return indices.map(i => items[i - 1]);
  }
  if (items.length > 1 && !options.all) throw Object.assign(new Error('清单包含多个视频，请用 --indices 指定编号或 --all 明确选择全部'), { code: 'SELECTION_REQUIRED', exitCode: 2, details: { count: items.length } });
  return items;
}
