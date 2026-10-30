/**
 * 只读地看"现在装了什么"。这一层**零写入、零网络、零执行装的命令**。
 *
 * 为什么坚持读文件而不是问包管理器：
 *  - `npm ls -g` / `pnpm ls` 都要起进程，Windows 上还要过 `.cmd` 壳，慢且脆；
 *  - 装完的判据必须能被"人工复现"—— 读同一份 `package.json`，谁都能验。
 * 唯一会 spawn 的是 `npm config get prefix`（只读、一次、失败可回退）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './exec.mjs';

/** DSH 数据根：显式 > $DSH_HOME > ~/.dsh（与宿主同一优先级口径） */
export function resolveHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

export function profileDirOf(home, profile) {
  return path.join(home, 'profiles', profile);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** profile 的 package.json：dependencies 与 dsh.profile.bundles 是两个不同的东西，分开读 */
export function readProfile(home, profile) {
  const dir = profileDirOf(home, profile);
  const file = path.join(dir, 'package.json');
  const json = readJson(file);
  return {
    dir,
    file,
    exists: json !== null,
    deps: (json && json.dependencies) || {},
    bundles: (json && json.dsh && json.dsh.profile && Array.isArray(json.dsh.profile.bundles))
      ? json.dsh.profile.bundles
      : [],
  };
}

/** profile 里某个包的实体版本（走 pnpm 的符号链接没问题，readFileSync 会跟随） */
export function profileInstalledVersion(home, profile, name) {
  const pkg = readJson(path.join(profileDirOf(home, profile), 'node_modules', name, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

/** 全局前缀：显式 > $npm_config_prefix > `npm config get prefix` > 平台默认 */
export async function resolveNpmPrefix(explicit) {
  if (explicit) return { prefix: path.resolve(explicit), source: '--npm-prefix' };
  if (process.env.npm_config_prefix) return { prefix: path.resolve(process.env.npm_config_prefix), source: '$npm_config_prefix' };
  const res = await spawnCommand('npm', ['config', 'get', 'prefix'], { timeoutMs: 15000 });
  const line = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (res.code === 0 && line) return { prefix: path.resolve(line), source: 'npm config get prefix' };
  const fallback = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
    : '/usr/local';
  return { prefix: fallback, source: `平台默认（npm 不可用：${res.error || `rc=${res.code}`}）` };
}

/** 全局装的某个包的实体版本 */
export function globalInstalledVersion(npmPrefix, name) {
  const pkg = readJson(path.join(npmPrefix, 'node_modules', name, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

/** 一个命令名在本机可能落成的文件（只查存在，不执行） */
export function binCandidates({ cmd, home, profile, npmPrefix }) {
  const names = process.platform === 'win32' ? [`${cmd}.CMD`, `${cmd}.cmd`, cmd] : [cmd];
  const out = [];
  for (const n of names) {
    out.push(path.join(profileDirOf(home, profile), 'node_modules', '.bin', n));
    out.push(path.join(npmPrefix, n));
  }
  return out;
}

export function findExistingBin(opts) {
  for (const file of binCandidates(opts)) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 在 PATH 上找一个命令（只查文件存在，不执行；Windows 按 PATHEXT 补壳后缀） */
export function findOnPath(cmd) {
  const exts = process.platform === 'win32'
    ? ['', '.cmd', '.CMD', '.exe', '.bat', '.ps1']
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${cmd}${ext}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
      } catch {
        /* 权限/竞态一律跳过，PATH 扫描不该抛 */
      }
    }
  }
  return null;
}

/**
 * 读**已装实体**自己的 dsh 声明。判"该不该挂载"的权威源是这个，不是清单里的期望值：
 * 清单说"期望自动挂载"，但装得上来的这一版可能压根没声明 bundle（比如修复版还没发布）
 * —— 那时判"挂载失败"就是冤枉它；正确做法是如实报"本版不带声明、装成普通依赖"。
 */
export function readInstalledDshDecl(home, profile, name) {
  const json = readJson(path.join(profileDirOf(home, profile), 'node_modules', name, 'package.json'));
  const dsh = json && json.dsh ? json.dsh : null;
  return {
    found: Boolean(json),
    version: (json && typeof json.version === 'string') ? json.version : null,
    hasBundle: Boolean(dsh && dsh.bundle),
    hasClient: Boolean(dsh && dsh.client),
  };
}

/** 找已装包里的 bin 源文件（help 探针要静态扫它，装之前不该猜） */
export function resolveInstalledBinFile({ home, profile, npmPrefix, pkgName, cmd }) {
  const roots = [
    path.join(profileDirOf(home, profile), 'node_modules'),
    path.join(npmPrefix, 'node_modules'),
  ];
  for (const root of roots) {
    const pkgDir = path.join(root, pkgName);
    const json = readJson(path.join(pkgDir, 'package.json'));
    if (!json) continue;
    const bin = json.bin;
    let rel = null;
    if (typeof bin === 'string') rel = bin;
    else if (bin && typeof bin === 'object') {
      rel = bin[cmd] || (Object.keys(bin).length === 1 ? bin[Object.keys(bin)[0]] : null);
    }
    if (rel) {
      const file = path.resolve(pkgDir, rel);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}
