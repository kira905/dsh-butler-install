/**
 * 探针：回答"这一项到底成没成"。
 *
 * 三种探针，默认最保守的那种：
 *  - `existence`（默认）：只看文件在不在，**一条命令都不执行**；
 *  - `help`：只有确认该命令实现了 `--help` 才允许用（按命令核，不是按仓一刀切）；
 *  - `cmd`：清单指定的只读命令，清单里必须写清"凭什么认定它只读"。
 *
 * 🔴 `help` 的硬闸（本模块最重要的一条）：执行前先静态扫一遍该命令的源码，
 * 扫不到 `--help` 分支就**拒绝执行**并判失败。原因很实在 —— 这些命令行工具里
 * 有相当一部分没有参数解析，未知参数被忽略后**直接执行真动作**（导出/归档/改状态）。
 * 拿 `--help` 当"只看一眼"是错的，错在它会真的干活。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnCommand } from './exec.mjs';
import { findExistingBin, resolveInstalledBinFile } from './state.mjs';

/**
 * 静态判断一个 bin 源文件有没有 `--help` 分支。
 * 判据故意宽（能看出"确实处理了 help"即可）：出现 `--help` 或 `-h` 字面量，
 * 并且在同一文件里出现 help/usage 相关的输出动作。判不出来就返回 false ——
 * 宁可拒跑，也不赌它是只读的。
 */
export function hasHelpBranch(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText) return false;
  const mentionsHelp = /--help\b|'--help'|"--help"|'-h'|"-h"/.test(sourceText);
  if (!mentionsHelp) return false;
  const printsUsage = /usage|Usage|USAGE|用法|help/i.test(sourceText);
  return printsUsage;
}

function ok(detail) {
  return { status: 'pass', detail };
}
function bad(detail) {
  return { status: 'fail', detail };
}
function skip(detail) {
  return { status: 'skip', detail };
}

/**
 * 跑一项探针。
 * @param item   清单条目
 * @param ctx    {home, profile, npmPrefix, run?} —— run 可注入（夹具用它，不真起进程）
 * @returns {Promise<{status:'pass'|'fail'|'skip', detail:string}>}
 */
export async function runProbe(item, ctx) {
  const probe = item.probe || {};
  const kind = probe.kind || 'existence';
  const run = ctx.run || defaultCommandRunner(ctx);

  if (kind === 'existence') return existenceProbe(item, ctx);

  if (kind === 'help') {
    const binFile = resolveInstalledBinFile({
      home: ctx.home,
      profile: ctx.profile,
      npmPrefix: ctx.npmPrefix,
      pkgName: item.name,
      cmd: probe.cmd,
    });
    if (!binFile) {
      return bad(`找不到 ${probe.cmd} 的源文件，无法核对 --help 实现（已拒绝执行，未跑任何命令）`);
    }
    let source = '';
    try {
      source = fs.readFileSync(binFile, 'utf8');
    } catch (err) {
      return bad(`读不了 ${binFile}（${err.code || err.message}）⇒ 拒绝执行 --help`);
    }
    if (!hasHelpBranch(source)) {
      return bad(`清单标了 probe.kind=help，但 ${probe.cmd} 的源码里没有 --help 分支 ⇒ 拒执行（它会把 --help 当普通参数、照常干活）`);
    }
    const res = await run(probe.cmd, ['--help'], { timeoutMs: 8000 });
    if (res.timedOut) return bad(`${probe.cmd} --help 超时（8s）`);
    if (res.code !== 0) return bad(`${probe.cmd} --help 退出码 ${res.code}：${firstLine(res.stderr) || firstLine(res.stdout)}`);
    return ok(`${probe.cmd} --help 正常（rc=0）`);
  }

  if (kind === 'cmd') {
    const args = Array.isArray(probe.argv) ? probe.argv.map(String) : [];
    const res = await run(probe.cmd, args, { timeoutMs: probe.timeoutMs || 8000 });
    const line = `${probe.cmd} ${args.join(' ')}`.trim();
    if (res.timedOut) return bad(`${line} 超时`);
    if (res.code !== 0) return bad(`${line} 退出码 ${res.code}：${firstLine(res.stderr) || firstLine(res.stdout) || '（无输出）'}`);
    return ok(`${line} rc=0`);
  }

  return skip(`未知的 probe.kind=${kind}`);
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/)[0] || '';
}

function defaultCommandRunner(ctx) {
  return async (cmd, args, opts = {}) => {
    const bin = findExistingBin({ cmd, home: ctx.home, profile: ctx.profile, npmPrefix: ctx.npmPrefix });
    const file = bin || cmd;
    return spawnCommand(file, args, { timeoutMs: opts.timeoutMs || 8000, quiet: true });
  };
}

/** 存在性探针：插件查包目录，命令行工具查 bin 文件；两条路都只碰文件系统 */
function existenceProbe(item, ctx) {
  const probe = item.probe || {};
  if (item.type === 'plugin') {
    const pkgJson = path.join(ctx.home, 'profiles', ctx.profile, 'node_modules', item.name, 'package.json');
    if (fs.existsSync(pkgJson)) return ok(`包实体在位：node_modules/${item.name}`);
    return bad(`包实体不在：${pkgJson} 不存在`);
  }
  const cmd = probe.cmd;
  if (!cmd) return skip('cli 类型但清单没给 probe.cmd');
  const found = findExistingBin({ cmd, home: ctx.home, profile: ctx.profile, npmPrefix: ctx.npmPrefix });
  if (found) return ok(`命令文件在位：${found}`);
  return bad(`命令文件不在（profile 的 .bin 与全局前缀两处都查过）：${cmd}`);
}
