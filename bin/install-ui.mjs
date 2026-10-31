#!/usr/bin/env node
/**
 * 双击入口（方案 §11.6 · B4：**第 0 步**）—— 先探、再起、然后自己开浏览器。
 *
 * 为什么"探测"能替代锁文件：
 *  双击两次 `.cmd` = 两个进程。`listenLoopback()` 会很规矩地各自绑到 45080 / 45081，
 *  于是两个页面都能点【开始安装】，同时对同一个 profile 跑 `dsh plugin add` + `npm i -g`。
 *  与其落盘一把锁（还要处理陈旧锁、跨进程），不如先问一句"45080 上是不是已经有一个我们自己"：
 *  是 ⇒ **不再起第二个服务**，把浏览器指过去。双击两次 = 两个标签看同一个服务，天然单实例。
 *
 * 🔴 为什么不在核心 CLI 上加 `--open`：
 *  `lib/cli-args.mjs` 的纪律是"未知参数一律报错退出"，加参数 = 改对外契约。
 *  而且"谁开浏览器"是 shell 行为，不该塞进核心 CLI（`dsh-butler-install --ui` 仍是"起服务 + 打印地址"）。
 *
 * 边界如实登记：用户显式 `--port <别的端口>` 时会探那个端口（不会去探 45080）；
 * `--port 0` 时无从探测 ⇒ 直接起一个新的（这就是"我想要第二个实例"的显式表达）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, HELP_TEXT, EXIT } from '../lib/cli-args.mjs';
import {
  startUiServer,
  uiBannerLines,
  installExitHooks,
  resolvePort,
  UI_HOST,
  DEFAULT_UI_PORT,
  UI_SERVICE_ID,
} from '../lib/ui-server.mjs';
import { killAllRunningSync } from '../lib/exec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 探测超时：本地环回，1.5 秒还不回答就当"没有" */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * 探"这个端口上是不是已经有一个我们自己的向导页"。
 * 判据不是"能连上"、也不是 `ok:true` —— 而是 `/state` 里那个 `service` 标记：
 * 45080 上完全可能坐着别的本地服务，认错人比不起服务坏得多。
 *
 * @returns {Promise<{ok:boolean, port?:number, url?:string, profile?:string, reason?:string}>}
 */
export function probeExistingUi({ port = DEFAULT_UI_PORT, host = UI_HOST, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.request({
        host,
        port,
        path: '/state',
        method: 'GET',
        headers: { accept: 'application/json', connection: 'close' },
        timeout: timeoutMs,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 2 * 1024 * 1024) {
            req.destroy();
            done({ ok: false, reason: '/state 太大（不像我们的页面）' });
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done({ ok: false, reason: `/state 回了 HTTP ${res.statusCode}` });
            return;
          }
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            done({ ok: false, reason: '/state 不是 JSON' });
            return;
          }
          if (!body || body.ok !== true || body.service !== UI_SERVICE_ID) {
            done({ ok: false, reason: `${port} 上确实有人在听，但不是我们自己的向导页（service=${body && body.service ? body.service : '无'}）` });
            return;
          }
          done({ ok: true, port, url: `http://${host}:${port}/`, profile: body.profile, generatedAt: body.generatedAt });
        });
      });
    } catch (err) {
      done({ ok: false, reason: String(err && err.message ? err.message : err) });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, reason: `探测超时（${timeoutMs}ms）` });
    });
    req.on('error', (err) => {
      done({ ok: false, reason: String(err && err.code ? err.code : err && err.message ? err.message : err) });
    });
    req.end();
  });
}

/** 开浏览器：Win 用 `cmd /c start "" <url>`（空标题位不能省，否则 start 会把 URL 当窗口标题）；mac `open`；其它 `xdg-open` */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * 入口本体（可注入：夹具要能在不起浏览器、也能不真起服务的前提下验"第二次只得到一个服务"）。
 *
 * @param {object} [io]
 * @param {string[]} [io.argv]           参数（缺省 process.argv.slice(2)）
 * @param {{write:(s:string)=>any}} [io.out]
 * @param {(url:string) => boolean} [io.openBrowser]
 * @param {Function} [io.startServer]    缺省 = lib/ui-server.mjs#startUiServer
 * @param {boolean} [io.waitForShutdown] 缺省 true；夹具传 false（不然它会一直挂到 Ctrl+C）
 * @returns {Promise<{exitCode:number, action:'help'|'version'|'error'|'reuse'|'start'|'closed', url?:string, port?:number}>}
 */
export async function runEntry({
  argv = process.argv.slice(2),
  out = process.stdout,
  openBrowser: opener = openBrowser,
  startServer = startUiServer,
  waitForShutdown = true,
} = {}) {
  // 本入口等价于 `--ui`：用户不用知道这个开关（但给了也不冲突）
  const args = argv.includes('--ui') ? argv.slice() : ['--ui', ...argv];
  const { options, errors } = parseArgs(args);

  if (options.help) {
    out.write(HELP_TEXT);
    return { exitCode: EXIT.OK, action: 'help' };
  }
  if (options.version) {
    out.write(`${pkgVersion()}\n`);
    return { exitCode: EXIT.OK, action: 'version' };
  }
  if (errors.length) {
    for (const e of errors) out.write(`✖ ${e}\n`);
    out.write('用 --help 看可用参数。\n');
    return { exitCode: EXIT.USAGE, action: 'error' };
  }

  const port = resolvePort(options.uiPort);
  if (port > 0) {
    const found = await probeExistingUi({ port });
    if (found.ok) {
      out.write(`已经有一个向导页在 ${found.url} 跑着了（profile=${found.profile || '?'}）。\n`);
      out.write('  不再起第二个：两个标签看同一个服务，天然单实例（这样不会同时对同一个 profile 装两遍）。\n');
      opener(found.url);
      return { exitCode: EXIT.OK, action: 'reuse', url: found.url, port };
    }
    out.write(`端口 ${port} 上没有我们自己的向导页（${found.reason}）⇒ 现在起一个。\n`);
  }

  const started = await startServer({ options, port: options.uiPort });
  if (!started.ok) {
    for (const line of started.log) out.write(`${line}\n`);
    return { exitCode: started.exitCode, action: 'error' };
  }
  if (started.portChanged) {
    out.write(`⚠ 端口 ${started.requestedPort} 被占了，已改用 ${started.port}\n`);
  }
  for (const line of uiBannerLines(started)) out.write(`${line}\n`);
  installExitHooks({ out });
  opener(started.url);
  if (!waitForShutdown) {
    return { exitCode: EXIT.OK, action: 'start', url: started.url, port: started.port };
  }
  await new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  killAllRunningSync();
  await started.close();
  out.write('\n向导页已关。\n');
  return { exitCode: EXIT.OK, action: 'closed', url: started.url, port: started.port };
}

/** 直接跑（不是被 import）时才算主程序 —— junction 下面 argv[1] 是逻辑路径、import.meta.url 是物理路径，两边都取 realpath 再比 */
function isMain() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const arg = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return Boolean(arg) && self === arg;
  } catch {
    return false;
  }
}

if (isMain()) {
  const result = await runEntry();
  process.exitCode = result.exitCode;
}
