/**
 * 「45080 上是不是已经有一个我们自己的向导页」+ 「开浏览器」这两个动作。
 *
 * 为什么单独一层（2026-10-31 做 exe 分发物时拆出来的）：
 *  exe 的入口（`scripts/sea-entry.mjs`）要复用同一份探测与开浏览器逻辑，但它**不能** import
 *  `bin/install-ui.mjs` —— 那个文件顶层有 `await runEntry()`，ESM 打包成单文件 CJS（SEA 只吃 CJS）
 *  时 TLA 编不过去。与其在包里复制一份"看起来一样的探测"（两份实现必然漂移），不如把这两个函数
 *  搬到 lib 层：`bin/install-ui.mjs` 继续 re-export 它们（对外 API 与夹具引用路径一个不变）。
 *
 * 这里的判据一条都不能松（原注释照留）：
 *  认人靠 `/state` 里的 `service` 标记，不是"能连上"、也不是 `ok:true`。
 *  45080 上完全可能坐着别的本地服务，认错人比不起服务坏得多。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

import { UI_HOST, DEFAULT_UI_PORT, UI_SERVICE_ID } from './ui-server.mjs';

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
