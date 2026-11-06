/**
 * 桌面版（Electron 版 DSH）的识别与它自带命令的定位。
 *
 * 为什么要单独一层（2026-11-06 真机实测，见
 * `docs\交付报告-桌面端适配与骨架装机实测-20261106.md` §2.5）：
 *  - 桌面版把 `~/.dsh/profiles/desktop` 当**自己的** profile，用 npm 装的 CLI 去改它，
 *    宿主会直接拒绝：`error: profile "desktop" is managed exclusively by the Electron application`（rc=1）；
 *  - 但桌面版**自带一条命令** `<安装目录>\resources\runtime\cli\bin\dsh.cmd`，
 *    用它加 `--profile desktop` 是**能成**的（实测 rc=0，dependencies 与 dsh.profile.bundles 都登记）；
 *  - 反过来，往桌面版用户的机器上用 `--profile web` 装插件 = 那套界面永远不加载 = 假绿。
 *
 * 所以这里只做两件事：认出来，找到它自带的命令。**找不到就如实说找不到**，
 * 由上层决定硬拒绝（绝不偷偷退回用 CLI 版去改桌面版 profile）。
 *
 * 探测只看三个来源，全都不写盘：① 桌面版自建的 profile ② 已知安装路径 ③ 运行中的进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './exec.mjs';

/** 桌面版自带的命令行入口在安装目录里的固定相对位置 */
export const DESKTOP_CLI_REL = path.join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const DESKTOP_EXE = 'DeepSeek Harness.exe';

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `<root>` 下面是否真的有一套桌面版（主程序 + 自带命令都在位） */
export function looksLikeDesktopRoot(root) {
  if (!root) return null;
  const exe = path.join(root, DESKTOP_EXE);
  const cli = path.join(root, DESKTOP_CLI_REL);
  if (isFile(exe) && isFile(cli)) return { root, exe, cli };
  return null;
}

/** 已知安装目录（Windows 上安装器默认落在 %LOCALAPPDATA%\Programs 或用户指定的盘） */
export function desktopRootCandidates(env = process.env, platform = process.platform) {
  const out = [];
  const push = (dir) => { if (dir) out.push(path.resolve(dir)); };
  if (env.DSH_DESKTOP_DIR) push(env.DSH_DESKTOP_DIR);
  if (platform !== 'win32') {
    push('/Applications/DSH Desktop.app/Contents/Resources/..');
    return out;
  }
  const local = env.LOCALAPPDATA || '';
  const roaming = env.APPDATA || '';
  if (local) {
    push(path.join(local, 'Programs', 'DSH Desktop'));
    push(path.join(local, 'Programs', 'DSH-Desktop'));
    push(path.join(local, 'DSH Desktop'));
    // %LOCALAPPDATA%\Programs 下常见一批 Electron 应用：按名字捞一遍（只 readdir 一层）
    try {
      for (const name of fs.readdirSync(path.join(local, 'Programs'), { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        if (/dsh|deepseek/i.test(name.name)) push(path.join(local, 'Programs', name.name));
      }
    } catch { /* 目录不存在是常态 */ }
  }
  if (roaming) push(path.join(roaming, 'DSH Desktop'));
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    if (env[key]) {
      push(path.join(env[key], 'DSH Desktop'));
      push(path.join(env[key], 'DSH-Desktop'));
    }
  }
  // 用户的安装器允许挑盘：只查存在的盘符，名字就两种写法，成本是几十次 existsSync
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const driveRoot = `${letter}:\\`;
    try {
      if (!fs.existsSync(driveRoot)) continue;
    } catch { continue; }
    push(path.join(driveRoot, 'DSH Desktop'));
    push(path.join(driveRoot, 'DSH-Desktop'));
  }
  return out;
}

/**
 * 从运行中的桌面版进程反查安装目录。**只在这台机器上真的跑着桌面版时才有结果**，
 * 所以放在最后一道 —— 它要起一个 PowerShell（几百毫秒），前面能命中就别用它。
 */
export async function findDesktopRootFromProcess(opts = {}) {
  if ((opts.platform || process.platform) !== 'win32') return null;
  const run = opts.run || ((f, a, o) => spawnCommand(f, a, o));
  const script = `$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*Harness*' } | Select-Object -First 1; if ($p) { $p.Path }`;
  const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: opts.timeoutMs || 15000, quiet: true });
  if (res.code !== 0) return null;
  const exePath = String(res.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (!exePath || !isFile(exePath)) return null;
  return path.dirname(exePath);
}

/**
 * 「桌面版自带命令在哪」的缓存 —— 它跟数据根无关，只跟安装目录有关。
 * 为什么必须有：向导页的 GET /state 每个请求都会走 buildSuiteState，一开页面就是几百次
 * 探测；不缓存的话每次都扫 26 个盘符、必要时还起一个 PowerShell（本机实测把测试从 1 分钟拖到 4 分钟以上）。
 */
const cliCache = new Map();

/** 夹具用：伪造/撤掉一套桌面版目录之后清缓存 */
export function resetDesktopCliCache() {
  cliCache.clear();
}

function cliCacheKey(opts, env, platform) {
  return [
    platform,
    env.DSH_DESKTOP_DIR || '',
    env.DSH_DESKTOP_CLI || '',
    Array.isArray(opts.roots) ? opts.roots.join('|') : '',
    opts.allowProcessProbe === false ? 'noprobe' : 'probe',
  ].join('::');
}

/**
 * 找出桌面版自带命令。
 * @param {object} [opts] { home, env, platform, run, allowProcessProbe, roots }
 * @returns {Promise<{cli:string, root:string, source:string, evidence:string[]}>}
 */
export async function findDesktopCli(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const key = cliCacheKey(opts, env, platform);
  if (cliCache.has(key)) return cliCache.get(key);
  const result = await findDesktopCliUncached({ ...opts, env, platform });
  cliCache.set(key, result);
  return result;
}

async function findDesktopCliUncached(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const evidence = [];

  const explicit = env.DSH_DESKTOP_CLI;
  if (explicit) {
    if (isFile(explicit)) return { cli: explicit, root: path.dirname(path.dirname(path.dirname(path.dirname(explicit)))), source: '$DSH_DESKTOP_CLI', evidence: [`显式指定 ${explicit}`] };
    evidence.push(`$DSH_DESKTOP_CLI 指向的文件不存在：${explicit}`);
  }

  for (const root of (Array.isArray(opts.roots) ? opts.roots : desktopRootCandidates(env, platform))) {
    const hit = looksLikeDesktopRoot(root);
    if (hit) {
      evidence.push(`安装目录命中：${root}`);
      return { cli: hit.cli, root: hit.root, source: 'known-path', evidence };
    }
  }

  if (opts.allowProcessProbe !== false && platform === 'win32') {
    try {
      const root = await findDesktopRootFromProcess({ run: opts.run, platform, timeoutMs: opts.timeoutMs });
      if (root) {
        const hit = looksLikeDesktopRoot(root);
        if (hit) {
          evidence.push(`从运行中的进程反查到安装目录：${root}`);
          return { cli: hit.cli, root: hit.root, source: 'process', evidence };
        }
        evidence.push(`进程目录 ${root} 里没有完整的一套桌面版文件`);
      }
    } catch (err) {
      evidence.push(`进程反查失败（${err && err.message ? err.message : err}）`);
    }
  }
  if (!evidence.length) evidence.push('已知安装目录、$DSH_DESKTOP_DIR、运行中的进程三处都没找到');
  return { cli: '', root: '', source: '', evidence };
}

/**
 * 综合探测：桌面版在不在、自带命令在哪、它自建的 profile 在不在。
 *
 * @returns {Promise<{detected:boolean, cliCmd:string, root:string, source:string,
 *   desktopProfileExists:boolean, evidence:string[]}>}
 */
export async function detectDesktop(opts = {}) {
  const home = opts.home;
  const env = opts.env || process.env;
  const desktopProfileFile = home ? path.join(home, 'profiles', 'desktop', 'package.json') : '';
  let desktopProfileExists = false;
  try {
    desktopProfileExists = Boolean(desktopProfileFile) && fs.existsSync(desktopProfileFile);
  } catch { desktopProfileExists = false; }

  const found = await findDesktopCli({ env, platform: opts.platform, run: opts.run, allowProcessProbe: opts.allowProcessProbe, timeoutMs: opts.timeoutMs, roots: opts.roots });
  const evidence = found.evidence.slice();
  if (desktopProfileExists) evidence.unshift(`数据根里有桌面版自建的 profile：${desktopProfileFile}`);
  return {
    detected: Boolean(desktopProfileExists || found.cli),
    cliCmd: found.cli,
    root: found.root,
    source: found.source,
    desktopProfileExists,
    evidence,
  };
}

/** 找不到自带命令时给人看的那段话（硬拒绝时原样打印） */
export function desktopMissingHelp(home) {
  const homeText = home || '<数据根>';
  return [
    '这是桌面版（Electron 版）DSH 的 profile：本机 npm 装的 CLI 改不动它',
    '（宿主会回 error: profile "desktop" is managed exclusively by the Electron application）。',
    '要装就得用桌面版**自带**的那条命令：',
    '  <桌面版安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd',
    '本工具在下面三处都找过，没找到它：',
    '  ① 环境变量 DSH_DESKTOP_DIR / DSH_DESKTOP_CLI',
    '  ② 常见安装目录（%LOCALAPPDATA%\\Programs\\DSH Desktop、Program Files、各盘根下的 DSH Desktop）',
    '  ③ 正在运行的桌面版进程',
    `要么把桌面版装上/打开一次让它出现在上面任一位置，要么用 DSH_DESKTOP_DIR 指一下安装目录；`,
    `确认这本机压根没有桌面版的话，就别用 --profile desktop（当前数据根：${homeText}）。`,
  ].join('\n');
}
