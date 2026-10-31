/**
 * `--ui`：把「这次会做什么」摆成一个**挂在 DSH 外面**的本地页面。
 *
 * 为什么不塞进 DSH 侧边栏（这是本模块存在的理由，不是懒）：
 *  - 插件页要装插件 + 写 cordis.patch.yml + 重启；DSH 一升级，client DOM 注入就可能崩。
 *  - 本页零安装、零重启，连"DSH 还没装"的时候都能开起来 —— 那时候它正好能告诉你"你得先装 DSH"。
 *  - 代价只有一个：要监听一个本地端口。所以**只许 127.0.0.1**，写死，不接受任何形式的放宽。
 *
 * 四条红线（改这个文件之前先读）：
 *  1. 只绑 `127.0.0.1`。任何人把它改成 `0.0.0.0` / `::` 都是把本机服务摊到局域网，夹具会红。
 *  2. 写入口**只有四条**，全部是 POST，全部要过闸：
 *       POST /install/preview   —— 只算不做（两步确认的第一半）
 *       POST /install/start     —— 真装（必须带 `confirm:true`）
 *       POST /install/cancel    —— 取消（AbortSignal → killTree）
 *       POST /install/rollback  —— 撤回的两个诚实动作（见 lib/ui-rollback.mjs）
 *     GET 只有三条：`/`（页面）、`/state`（与 --dry-run 同源的 JSON）、`/install/progress`（纯内存读）。
 *     其余「方法 + 路径」组合一律 405/404，`Allow` 响应头**按路径给**（写死 GET 会自相矛盾）。
 *  3. 每个 POST 先过两道前置闸：**进程级令牌**（`x-install-token`，整个进程生命周期有效）与
 *     **同源校验**（`Origin` 的 `host:port` 逐字等于 `server.address()` 的 `address:port`；
 *     `Sec-Fetch-Site` **存在才校验**，老浏览器/360 兼容模式没有这个头，硬要求就等于全按钮静默 403）。
 *     🔴 不许把端口写死成 45080：`--port 0` 或端口被占时，写死会让所有 POST 必然 403。
 *  4. 数据与 `--dry-run` 同源：`GET /state` 返回的就是 lib/plan.mjs#buildSuiteState 的 `state`，
 *     页面上「复制命令」读到的那行字符串也是它 —— 页面自己不许拼命令。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { resolveNpmPrefix } from './state.mjs';
import { buildSuiteState } from './plan.mjs';
import { renderPage } from './ui-page.mjs';
import { decorateState } from './item-status.mjs';
import { createInstallRunner } from './ui-install.mjs';
import { killAllRunningSync, runningChildPids } from './exec.mjs';

/** 写死。不读环境变量、不加参数 —— 这类"临时放宽一下"的开关最后都会留在生产里。 */
export const UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT = 45080;
/** 端口被占时往后试几个（45080, 45081, …），都不行就让系统随便挑一个 */
export const PORT_SCAN = 20;
/**
 * 这个串出现在 `GET /state` 里：双击入口（bin/install-ui.mjs）靠它确认
 * "45080 上那个服务到底是不是我们自己的" —— 只看 `ok:true` 会认错人。
 */
export const UI_SERVICE_ID = 'dsh-butler-install-ui';
/** 令牌走这个头。放头里不放 cookie：cookie 会被同站其它页面顺手带上，头不会 */
export const TOKEN_HEADER = 'x-install-token';
/** 请求体上限：这几个 POST 只收一个小 JSON，超过就拒（别让人拿 body 灌内存） */
export const MAX_BODY_BYTES = 64 * 1024;

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

/** 读请求体（小 JSON）。失败一律回 {ok:false,error}，不抛 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const settle = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      raw += chunk.toString('utf8');
      if (raw.length > limit) {
        req.resume();
        settle({ ok: false, error: 'body-too-large' });
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        settle({ ok: true, value: {} });
        return;
      }
      try {
        const value = JSON.parse(raw);
        settle({ ok: true, value: value && typeof value === 'object' ? value : {} });
      } catch {
        settle({ ok: false, error: 'bad-json' });
      }
    });
    req.on('error', () => settle({ ok: false, error: 'body-error' }));
  });
}

/** 闸 2：进程级令牌（定长比较，避免时序侧信道） */
export function sameToken(req, token) {
  const given = req.headers[TOKEN_HEADER];
  if (typeof given !== 'string' || !given) return false;
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * 闸 3：同源校验。
 *  - `Origin` **必须**有，且它的 `host:port` 要**逐字等于**我们自己 listen 到的 `address:port`
 *    （🔴 不许写死 45080：`--port 0` / 端口被占时会让所有 POST 必然 403）
 *  - `Sec-Fetch-Site`：**存在才校验**。Chrome 76+ / Safari 16.4+ 才有这个头，
 *    而双击入口打开的是系统默认浏览器（可能是 360 兼容模式）—— 硬要求等于全按钮静默 403。
 */
export function checkOrigin(req, server) {
  const addr = server && typeof server.address === 'function' ? server.address() : null;
  if (!addr || typeof addr !== 'object') {
    return { ok: false, error: 'origin-unknown', reason: '服务还没 listen，拿不到自己的 address:port' };
  }
  const expected = `${addr.address}:${addr.port}`;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) {
    return { ok: false, error: 'origin-missing', reason: 'POST 必须带 Origin（浏览器一定会带）；没有它说明不是这个页面发出来的', expected };
  }
  let got = null;
  try {
    const u = new URL(origin);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    got = `${u.hostname}:${port}`;
  } catch {
    return { ok: false, error: 'origin-invalid', reason: `Origin 解析不了：${origin}`, expected };
  }
  if (got !== expected) {
    return { ok: false, error: 'origin-mismatch', reason: `Origin 是 ${got}，本服务是 ${expected}`, expected, got };
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site && site !== 'same-origin') {
    return { ok: false, error: 'cross-site', reason: `Sec-Fetch-Site=${site}`, expected };
  }
  return { ok: true, origin, expected };
}

const GET_ROUTES = new Map([
  ['/', 'page'],
  ['/state', 'state'],
  ['/install/progress', 'progress'],
]);
const POST_ROUTES = new Map([
  ['/install/preview', 'preview'],
  ['/install/start', 'start'],
  ['/install/cancel', 'cancel'],
  ['/install/rollback', 'rollback'],
]);

export const GET_PATHS = [...GET_ROUTES.keys()];
export const POST_PATHS = [...POST_ROUTES.keys()];

/**
 * 建 server（不 listen），把路由表焊死在这里。
 * @param {{getState: () => Promise<object>, install?: object, token?: string}} deps
 */
export function createUiServer({ getState, install, token }) {
  if (typeof getState !== 'function') throw new Error('createUiServer 需要 getState（返回与 --dry-run 同源的 state）');
  const server = http.createServer((req, res) => {
    handle(req, res, { getState, install, token, server }).catch((err) => {
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

/**
 * 路由表（纯函数式，好测）。
 * 返回 `{kind}`：'page' | 'state' | 'progress' | 'preview' | 'start' | 'cancel' | 'rollback'
 *              | 'method-not-allowed'（带 allow） | 'not-found' | 'bad-request'
 *
 * `Allow` 按路径给：
 *  - `/install/start` 这类写路径 ⇒ `Allow: POST`
 *  - `/` `/state` `/install/progress` ⇒ `Allow: GET`
 *  - 未知路径上的写方法 ⇒ 405 + `Allow: GET`（这个页面在未知路径上的答案就是"没有写入口"）
 */
export function routeOf(method, rawUrl) {
  let pathname;
  try {
    pathname = new URL(String(rawUrl || '/'), `http://${UI_HOST}`).pathname;
  } catch {
    return { kind: 'bad-request' };
  }
  const verb = String(method || '').toUpperCase();
  const getKind = GET_ROUTES.get(pathname);
  const postKind = POST_ROUTES.get(pathname);

  if (verb === 'GET') {
    if (getKind) return { kind: getKind };
    if (postKind) return { kind: 'method-not-allowed', allow: 'POST' };
    return { kind: 'not-found' };
  }
  if (verb === 'POST') {
    if (postKind) return { kind: postKind };
    // 未知路径 + 写方法：写方法的答案只有一个"这儿没有写入口"
    return { kind: 'method-not-allowed', allow: 'GET' };
  }
  // 其它方法（HEAD/PUT/DELETE/PATCH/OPTIONS…）一律不是入口；Allow 仍按路径给
  return { kind: 'method-not-allowed', allow: postKind ? 'POST' : 'GET' };
}

const POST_KINDS = new Set(['preview', 'start', 'cancel', 'rollback']);

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
      allow: route.allow,
      message: `这个方法不是入口。这个路径只接受 ${route.allow}；写入口只有 ${POST_PATHS.join(' / ')}，而且都要令牌 + 同源。`,
      getPaths: GET_PATHS,
      postPaths: POST_PATHS,
    }, { allow: route.allow });
    return;
  }
  if (route.kind === 'not-found') {
    req.resume();
    writeJson(res, 404, { ok: false, error: 'not-found', paths: GET_PATHS, postPaths: POST_PATHS });
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
      }, { url: urlOf(deps.server), token: deps.token }));
      return;
    }
    writeHtml(res, 200, renderPage(state, { url: urlOf(deps.server), token: deps.token }));
    return;
  }
  if (route.kind === 'state') {
    try {
      const state = await deps.getState();
      // service 字段是给"双击入口"认人的：只看 ok:true 会把别的本地服务当成自己的
      writeJson(res, 200, { ...state, service: UI_SERVICE_ID });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'internal-error', message: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (route.kind === 'progress') {
    // 纯内存读：不写日志、不 spawn、不加锁 —— 页面按 500–1000ms 轮询它
    if (!deps.install) {
      writeJson(res, 503, { ok: false, error: 'install-unavailable', message: '这个服务没有装执行器（不是 --ui 起的？）' });
      return;
    }
    const out = deps.install.progress();
    writeJson(res, out.status, out.body);
    return;
  }

  if (!POST_KINDS.has(route.kind)) {
    req.resume();
    writeJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  // ── 闸 2：令牌 ────────────────────────────────────────────
  if (!sameToken(req, deps.token)) {
    req.resume();
    writeJson(res, 403, {
      ok: false,
      error: 'bad-token',
      message: `缺少或错误的 ${TOKEN_HEADER}：令牌只在进程启动时生成一次，印在控制台、也内嵌在页面里（整个进程生命周期有效，退出即失效）`,
    });
    return;
  }
  // ── 闸 3：同源 ────────────────────────────────────────────
  const origin = checkOrigin(req, deps.server);
  if (!origin.ok) {
    req.resume();
    writeJson(res, 403, { ok: false, error: origin.error, message: origin.reason, expected: origin.expected });
    return;
  }
  if (!deps.install) {
    req.resume();
    writeJson(res, 503, { ok: false, error: 'install-unavailable', message: '这个服务没有装执行器' });
    return;
  }
  // ── 读体（只收小 JSON）──────────────────────────────────
  const body = await readJsonBody(req);
  if (!body.ok) {
    writeJson(res, 400, { ok: false, error: body.error, message: body.error === 'body-too-large' ? `请求体超过 ${MAX_BODY_BYTES} 字节` : '请求体不是合法 JSON' });
    return;
  }
  const value = body.value;
  let out;
  if (route.kind === 'preview') out = await deps.install.preview(value);
  else if (route.kind === 'start') out = await deps.install.start(value);
  else if (route.kind === 'cancel') out = deps.install.cancel(value);
  else out = await deps.install.rollback(value);
  writeJson(res, out.status, out.body);
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
 * 退出钩子：Ctrl+C / 关窗口时把**还在跑的子进程树**同步杀掉。
 * 🔴 必须同步（`killAllRunningSync` 用的是 spawnSync）：`process.on('exit')` 里只跑同步代码，
 * 用异步 spawn 的版本等于"页面停了、npm 还在改 profile"（方案 R2）。
 *
 * 这里**故意不写**"interrupted 状态"（方案 §11.6 · B4）：进度只在内存里，进程走了这一批就断了；
 * 落一份"看起来还在跑/被中断"的状态文件，比让页面重开后按 `buildSuiteState()` + `verifyItem()`
 * **现跑**给真实状态更不准 —— 而且 test-ui.mjs 断言的就是"向导页不往数据根留自己的状态"。
 */
export function installExitHooks({ out = process.stdout } = {}) {
  let done = false;
  const killOnce = (why) => {
    if (done) return 0;
    done = true;
    const pids = runningChildPids();
    const killed = killAllRunningSync();
    if (pids.length) out.write(`\n⏹ ${why}：已同步杀掉 ${killed}/${pids.length} 棵子进程树（不然 npm 会在后台继续改 profile）\n`);
    return killed;
  };
  process.once('exit', () => killOnce('进程退出'));
  return { killOnce };
}

/**
 * 起向导页（CLI 与夹具共用）。
 * 这里解析**一次** npm 全局前缀，之后每个请求都用它 ⇒ 处理请求的路径零 spawn。
 */
export async function startUiServer({ options, port, attempts = PORT_SCAN, token = null, onLog = null }) {
  const wantedPort = resolvePort(port);
  const npm = await resolveNpmPrefix(options.npmPrefix);
  // 向导页的**读**口径永远是"演练口径"；真装只发生在 POST /install/start 里面（由执行器决定）
  const uiOptions = { ...options, apply: false, uninstall: false, json: false };
  const buildState = () => buildSuiteState(uiOptions, { npm });

  const first = await buildState();
  if (!first.ok) {
    return { ok: false, exitCode: first.exitCode, log: first.log };
  }

  const getState = async () => {
    const built = await buildState();
    // 🔴 状态文案只在这里算一次（lib/item-status.mjs#statusOf），随 state 一起下发：
    //    页面首屏、/state、页面脚本读的都是同一个 `item.status` —— 两份实现必然漂移（§11.6 · S1）
    if (built.ok) return decorateState(built.state);
    // 清单/选择出问题（例如用户刚把清单改坏了）：别 500，也别硬撑旧数据 —— 把错误原样给页面
    return {
      ok: false,
      exitCode: built.exitCode,
      generatedAt: new Date().toISOString(),
      errors: built.log.filter((l) => l && l.trim()),
    };
  };

  // 闸 2 的令牌：进程级（整个进程生命周期有效，退出即失效）。不是一次性 ——
  // 一次性的话页面点第二个按钮就 403 了（preview 用完 start 就废）。
  const installToken = typeof token === 'string' && token ? token : crypto.randomBytes(16).toString('hex');
  const install = createInstallRunner({
    options: uiOptions,
    onLog: (line) => {
      if (typeof onLog === 'function') onLog(line);
      else process.stdout.write(`${line}\n`);
    },
  });

  const server = createUiServer({ getState, install, token: installToken });
  const bound = await listenLoopback(server, { port: wantedPort, attempts });
  return {
    ok: true,
    server,
    port: bound.port,
    address: bound.address,
    requestedPort: wantedPort,
    portChanged: bound.changed,
    url: `http://${UI_HOST}:${bound.port}/`,
    token: installToken,
    install,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 起服务之后给人看的几行（CLI 与双击入口共用同一份文案） */
export function uiBannerLines(started) {
  return [
    '',
    `向导页已经起来了：${started.url}`,
    `  安装令牌（页面里也内嵌了；curl 手打要带上）：${started.token}`,
    '  · 只绑 127.0.0.1：同一局域网的别的机器连不上',
    `  · 读：GET ${GET_PATHS.join('、')}`,
    `  · 写：POST ${POST_PATHS.join('、')}（都要 ${TOKEN_HEADER} + Origin 同源）`,
    '  · 页面上「复制命令」给你的就是 CLI 真会跑的那一行；命令行永远是真相，页面只是壳',
    '  · 换端口：--ui --port <n> · 关掉：Ctrl+C（关的时候会把还在跑的命令树一起杀掉）',
    '',
  ];
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
  for (const line of uiBannerLines(started)) out.write(`${line}\n`);
  installExitHooks({ out });

  await new Promise((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  // 关门前先把正在跑的命令杀掉：不然用户以为停了，npm 还在改 profile
  killAllRunningSync();
  await started.close();
  out.write('\n向导页已关。\n');
  return 0;
}
