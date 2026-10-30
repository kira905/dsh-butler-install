/**
 * `--ui`：把「这次会做什么」摆成一个**挂在 DSH 外面**的本地只读页面。
 *
 * 为什么不塞进 DSH 侧边栏（这是本模块存在的理由，不是懒）：
 *  - 插件页要装插件 + 写 cordis.patch.yml + 重启；DSH 一升级，client DOM 注入就可能崩。
 *  - 本页零安装、零重启，连"DSH 还没装"的时候都能开起来 —— 那时候它正好能告诉你"你得先装 DSH"。
 *  - 代价只有一个：要监听一个本地端口。所以**只许 127.0.0.1**，写死，不接受任何形式的放宽。
 *
 * 三条红线（改这个文件之前先读）：
 *  1. 只绑 `127.0.0.1`。任何人把它改成 `0.0.0.0` / `::` 都是把本机服务摊到局域网，夹具会红。
 *  2. 只有两个 GET 路由：`GET /` 与 `GET /state`。其余方法（含 HEAD/OPTIONS）一律 405，
 *     其余路径一律 404；**服务端不执行任何 dsh/npm 命令，也没有任何写入口**。
 *  3. 数据与 `--dry-run` 同源：`GET /state` 返回的就是 lib/plan.mjs#buildSuiteState 的 `state`，
 *     页面上「复制命令」读到的那行字符串也是它 —— 页面自己不许拼命令。
 */
import http from 'node:http';
import { resolveNpmPrefix } from './state.mjs';
import { buildSuiteState } from './plan.mjs';
import { renderPage } from './ui-page.mjs';

/** 写死。不读环境变量、不加参数 —— 这类"临时放宽一下"的开关最后都会留在生产里。 */
export const UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT = 45080;
/** 端口被占时往后试几个（45080, 45081, …），都不行就让系统随便挑一个 */
export const PORT_SCAN = 20;

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function writeHtml(res, status, body) {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': HTML_CSP,
  });
  res.end(body);
}

function writeJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

/**
 * 端口口径：没给（null/undefined）⇒ 默认 45080；给了 0 ⇒ 明确表示"让系统挑"，尊重它。
 * （`port = DEFAULT_UI_PORT` 的默认参数挡不住显式传进来的 null —— 这个坑实测踩过：
 *   `--ui` 不带 --port 时服务落到了系统随机端口，打印的地址和文档里写的默认端口对不上。）
 */
export function resolvePort(requested) {
  if (requested === null || requested === undefined) return DEFAULT_UI_PORT;
  return requested;
}

/** 只允许环回地址。传别的一律抛，绝不给"先跑起来再说"的机会。 */
export function assertLoopbackHost(host) {
  if (host !== UI_HOST) {
    throw new Error(`向导页只许绑 ${UI_HOST}（现在传的是 ${JSON.stringify(host)}）：绑 0.0.0.0 / :: 等于把本机服务摊给同网段的每台机器`);
  }
  return host;
}

/**
 * 建 server（不 listen），把路由表焊死在这里。
 * @param {{getState:() => Promise<object>}} deps
 */
export function createUiServer({ getState }) {
  if (typeof getState !== 'function') throw new Error('createUiServer 需要 getState（返回与 --dry-run 同源的 state）');
  const server = http.createServer((req, res) => {
    handle(req, res, { getState, server }).catch((err) => {
      // 处理器里出啥事都不能让进程崩：状态码照实报，正文说明白
      try {
        writeJson(res, 500, { ok: false, error: 'internal-error', message: String(err && err.message ? err.message : err) });
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

/** 路由表（纯函数式，好测）：返回 'page' | 'state' | 'method-not-allowed' | 'not-found' | 'bad-request' */
export function routeOf(method, rawUrl) {
  let pathname;
  try {
    pathname = new URL(String(rawUrl || '/'), `http://${UI_HOST}`).pathname;
  } catch {
    return { kind: 'bad-request' };
  }
  // 方法先判：非 GET 一律 405 —— 不管路径是什么，写方法的答案都只有一个"没有这种入口"
  if (String(method || '').toUpperCase() !== 'GET') return { kind: 'method-not-allowed' };
  if (pathname === '/') return { kind: 'page' };
  if (pathname === '/state') return { kind: 'state' };
  return { kind: 'not-found' };
}

async function handle(req, res, deps) {
  const route = routeOf(req.method, req.url);
  if (route.kind === 'bad-request') {
    req.resume();
    writeJson(res, 400, { ok: false, error: 'bad-request' });
    return;
  }
  if (route.kind === 'method-not-allowed') {
    // 不解析请求体、不落任何状态：把连接读空然后挂断式回答
    req.resume();
    writeJson(res, 405, {
      ok: false,
      error: 'method-not-allowed',
      allow: 'GET',
      message: '这个向导页是只读的：只有 GET / 与 GET /state，没有写入口，也不会替你跑命令',
    }, { allow: 'GET' });
    return;
  }
  if (route.kind === 'not-found') {
    req.resume();
    writeJson(res, 404, { ok: false, error: 'not-found', paths: ['/', '/state'] });
    return;
  }
  if (route.kind === 'page') {
    let state;
    try {
      state = await deps.getState();
    } catch (err) {
      writeHtml(res, 200, renderPage({
        ok: false,
        manifest: '',
        home: '',
        profile: '',
        npmPrefix: '',
        items: [],
        counts: { total: 0, selected: 0, install: 0, skip: 0 },
        order: [],
        orderNotes: [],
        excluded: [],
        generatedAt: new Date().toISOString(),
        errors: [String(err && err.message ? err.message : err)],
      }, { url: urlOf(deps.server) }));
      return;
    }
    writeHtml(res, 200, renderPage(state, { url: urlOf(deps.server) }));
    return;
  }
  // route.kind === 'state'
  try {
    const state = await deps.getState();
    writeJson(res, 200, state);
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'internal-error', message: String(err && err.message ? err.message : err) });
  }
}

function urlOf(server) {
  try {
    const addr = server.address();
    return addr && typeof addr === 'object' ? `http://${UI_HOST}:${addr.port}/` : `http://${UI_HOST}:?/`;
  } catch {
    return `http://${UI_HOST}:?/`;
  }
}

/**
 * 在环回地址上听；端口被占就往后试，最后兜底让系统挑。
 * @returns {Promise<{port:number, address:string, requested:number, changed:boolean}>}
 */
export function listenLoopback(server, { port = DEFAULT_UI_PORT, attempts = PORT_SCAN } = {}) {
  assertLoopbackHost(UI_HOST);
  const candidates = [];
  if (Number.isInteger(port) && port > 0) {
    for (let i = 0; i < attempts && port + i <= 65535; i += 1) candidates.push(port + i);
  }
  candidates.push(0); // 兜底：让系统分配（只有全部撞车才会走到这里）

  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      const candidate = candidates[index];
      index += 1;
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          if (index < candidates.length) tryNext();
          else reject(err);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        // 兜底再核一次：真的只绑在 127.0.0.1 上，而不是"我以为我绑了"
        if (!addr || addr.address !== UI_HOST) {
          server.close();
          reject(new Error(`听的地址是 ${addr && addr.address}，不是 ${UI_HOST} —— 拒绝启动（这是红线，不是配置）`));
          return;
        }
        resolve({ port: addr.port, address: addr.address, requested: port, changed: port > 0 && addr.port !== port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, UI_HOST);
    };
    tryNext();
  });
}

/**
 * 起向导页（CLI 与夹具共用）。
 * 这里解析**一次** npm 全局前缀，之后每个请求都用它 ⇒ 处理请求的路径零 spawn。
 */
export async function startUiServer({ options, port, attempts = PORT_SCAN }) {
  const wantedPort = resolvePort(port);
  const npm = await resolveNpmPrefix(options.npmPrefix);
  // 向导页永远是"演练口径"：不带 --apply / --uninstall（CLI 层已拒绝这两个组合）
  const uiOptions = { ...options, apply: false, uninstall: false, json: false };
  const buildState = () => buildSuiteState(uiOptions, { npm });

  const first = await buildState();
  if (!first.ok) {
    return { ok: false, exitCode: first.exitCode, log: first.log };
  }

  const getState = async () => {
    const built = await buildState();
    if (built.ok) return built.state;
    // 清单/选择出问题（例如用户刚把清单改坏了）：别 500，也别硬撑旧数据 —— 把错误原样给页面
    return {
      ok: false,
      exitCode: built.exitCode,
      generatedAt: new Date().toISOString(),
      errors: built.log.filter((l) => l && l.trim()),
    };
  };

  const server = createUiServer({ getState });
  const bound = await listenLoopback(server, { port: wantedPort, attempts });
  return {
    ok: true,
    server,
    port: bound.port,
    address: bound.address,
    requestedPort: wantedPort,
    portChanged: bound.changed,
    url: `http://${UI_HOST}:${bound.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** `--ui` 的入口：起服务、打印地址、一直挂着直到 Ctrl+C。返回退出码。 */
export async function runUiCli(options, out = process.stdout) {
  const started = await startUiServer({ options, port: options.uiPort });
  if (!started.ok) {
    for (const line of started.log) out.write(`${line}\n`);
    return started.exitCode;
  }
  if (started.portChanged) {
    out.write(`⚠ 端口 ${started.requestedPort} 被占了，已改用 ${started.port}\n`);
  }
  out.write(`\n向导页已经起来了：${started.url}\n`);
  out.write('  · 只绑 127.0.0.1：同一局域网的别的机器连不上\n');
  out.write('  · 只有两个只读路由：GET /（页面）与 GET /state（与 --dry-run 同源的 JSON）；其余方法与路径一律 405/404\n');
  out.write('  · 页面上「复制命令」给你的就是 CLI 真会跑的那一行；页面自己一条命令都不执行\n');
  out.write('  · 换端口：--ui --port <n> · 关掉：Ctrl+C\n\n');

  await new Promise((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await started.close();
  out.write('\n向导页已关。\n');
  return 0;
}
