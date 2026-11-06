/**
 * 命令解析 + 「`^` 不许被吃掉」的夹具。
 *
 * 这一格护的是 2026-11-06 修的那个**最严重的真缺陷**：
 * 老实现用 `spawn(cmdline, { shell: true })`，Windows 上等于过 `cmd.exe /c`，
 * 而 `^` 是 cmd 的转义符 —— `pkg@^0.1.0` 到了 npm 手里变成 `pkg@0.1.0`（精确钉死下界）。
 * 整批装完 rc=0 全绿，实际上 11 个包全是旧版。
 *
 * 所以这里的判据不是"函数返回了什么"，而是**子进程真的收到了什么**：
 * 造一个把 argv 原样打出来的假 shim，跑一遍，逐字比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseWindowsShim,
  resolveCommand,
  spawnCommand,
  escapeForCmd,
  formatCommandLine,
  findExecutableOnPath,
} from '../lib/exec.mjs';
import { makeTempDir } from './lib/harness.mjs';

export const name = '命令解析（不过 shell · ^ 保真 · .cmd 壳解析）';

const isWin = process.platform === 'win32';

function writeShim(dir, cmd, body) {
  const file = path.join(dir, `${cmd}.cmd`);
  fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, 'utf8');
  return file;
}

/** 一个把 argv 原样吐成 JSON 的小脚本（判据要读它，不能读我们的日志） */
function writeEchoScript(dir) {
  const file = path.join(dir, 'echo-args.mjs');
  fs.writeFileSync(file, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", 'utf8');
  return file;
}

export async function run(c) {
  const dir = makeTempDir('exec-resolve');
  try {
    const echo = writeEchoScript(dir);

    // ① 纯函数：cmd 转义规则（参数要过 cmd /c + 批处理两层 ⇒ ^ 要写四个；
    //    加了引号时 cmd 不把 ^ 当转义符，一个都不能加，否则会多出 ^）
    c.eq(escapeForCmd('a^b'), 'a^^^^b', '不加引号的 ^ 要写成四个（实测：两个会被第二层再吃一次）');
    c.eq(escapeForCmd('a b^c'), '"a b^c"', '含空格的参数只加引号，引号内不转义 ^');
    c.eq(escapeForCmd('plain'), 'plain', '普通参数原样');
    // 打印用的命令行保持人话（带 ^），这一点不能为了执行而改丑
    c.contains(formatCommandLine('npm', ['i', '-g', '@kira905/x@^0.1.0']), '@kira905/x@^0.1.0', '展示用的命令行要保留 ^');

    if (isWin) {
      // ② shim 解析：npm/pnpm 生成的壳 = `node "%~dp0<script>" %*`
      const shim = writeShim(dir, 'fake-npm', `node "%~dp0echo-args.mjs" %*`);
      const parsed = parseWindowsShim(shim);
      c.eq(parsed.via, 'shim-parsed', '标准 shim 能被解析');
      c.eq(path.basename(parsed.file).toLowerCase(), path.basename(process.execPath).toLowerCase(), 'shim 里的 node 解析到 node 解释器');
      c.eq(parsed.args.length, 1, 'shim 的前置参数只有那个脚本');
      c.eq(path.resolve(parsed.args[0]), path.resolve(echo), 'shim 的前置参数指向脚本本身');

      // ③ 端到端：带 ^ 的 spec 必须原样到子进程（这是缺陷 A 的直接对照）
      const spec = '@kira905/dsh-ops-toolkit@^0.1.0';
      const res = await spawnCommand(shim, [spec], { timeoutMs: 20000, quiet: true });
      c.eq(res.code, 0, `假 shim 能跑起来（rc=${res.code} ${res.stderr ? res.stderr.slice(0, 120) : ''}）`);
      c.eq(res.resolved.via, 'shim', '执行走的是解析过的 shim 路径，不是 shell');
      let argv = null;
      try { argv = JSON.parse(res.stdout.trim()); } catch { argv = null; }
      c.eq(argv, [spec], '子进程收到的参数与写下的**逐字**相同（^ 没被吃掉）');

      // ④ 阴性对照：同样的 spec 过一遍 cmd.exe /d /s /c，^ 会丢 —— 证明这条判据不是空转
      const viaCmd = await spawnCommand('cmd.exe', ['/d', '/s', '/c', `echo ${spec}`], { timeoutMs: 10000, quiet: true });
      c.notContains(viaCmd.stdout, spec, '阴性对照：过 cmd 直传时 ^ 会丢（所以本工具不许过 shell）');

      // ⑤ 解析不出的壳 → 退到 cmd 兜底，但参数必须转义（仍然保真）
      const weird = writeShim(dir, 'fake-weird', 'echo %*');
      const weirdResolved = resolveCommand(weird);
      c.eq(weirdResolved.via, 'cmd-fallback', '解析不出的壳退回 cmd 兜底（而不是静默失败）');
      const weirdRun = await spawnCommand(weird, [spec], { timeoutMs: 20000, quiet: true });
      c.contains(weirdRun.stdout, spec, '兜底路径也要把 ^ 原样送到（参数已按 cmd 规则转义）');

      // ⑥ PATH 上同名命令同时存在 `dsh`（bash 脚本）与 `dsh.cmd` 时，必须挑 .cmd
      const binDir = path.join(dir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'dual'), '#!/bin/sh\nexit 0\n', 'utf8');
      writeShim(binDir, 'dual', `node "%~dp0..\\echo-args.mjs" %*`);
      const picked = findExecutableOnPath('dual', { platform: 'win32', env: { PATH: binDir } });
      c.eq(picked && picked.toLowerCase(), path.join(binDir, 'dual.cmd').toLowerCase(), '同名的无扩展脚本与 .cmd 并存时挑 .cmd（无扩展那个 spawn 必失败）');
    } else {
      // 非 Windows：命令原样直传，本来就不该有 shell
      const r = resolveCommand('/bin/echo', { platform: 'linux', env: { PATH: '/bin' } });
      c.eq(r.via, 'direct', '非 Windows 命令原样直传');
      const res = await spawnCommand('/bin/echo', ['a^b'], { timeoutMs: 10000, quiet: true });
      c.contains(res.stdout, 'a^b', '非 Windows 上 ^ 本来就不过 shell');
    }

    // ⑦ 找不到的命令：resolveCommand 明确说 not-found，spawnCommand 把 error 带回来（不假装成功）
    const missing = resolveCommand('definitely-not-a-real-command-xyz', { platform: 'win32', env: { PATH: dir } });
    c.eq(missing.via, 'not-found', '找不到的命令要标 not-found');
    c.ok(/找不到/.test(missing.problem), 'not-found 要带一句人话原因');
    const missRun = await spawnCommand('definitely-not-a-real-command-xyz', [], { timeoutMs: 5000, quiet: true });
    c.ok(missRun.code === null && missRun.error, '起不来的命令：code=null 且带回 error（不是 rc=0）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影响判定 */ }
  }
}
