// 双击入口（bin/install-ui.mjs + install-ui.cmd）：第 0 步
//
// 这一格要钉住的四件事：
//  1. `.cmd` 是**纯 ASCII + CRLF**（中文会被 cmd 按 GBK 解析拆坏，这条是踩过的坑）；
//  2. 探测认人靠 `/state` 里的 `service` 标记，不是"能连上"、也不是 `ok:true`
//     —— 45080 上完全可能坐着别的本地服务，认错人比不起服务坏得多；
//  3. **连起两次只得到一个服务**：第二次必须 `action==='reuse'` 且**一次都没调** startServer；
//  4. 开浏览器是入口的事（`openBrowser`），不是核心 CLI 的事；参数清单没被改（`--open` 不存在）。
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeExistingUi, runEntry, PROBE_TIMEOUT_MS } from '../bin/install-ui.mjs';
import { startUiServer, UI_HOST, UI_SERVICE_ID } from '../lib/ui-server.mjs';
import { parseArgs } from '../lib/cli-args.mjs';
import { makeFakeEnv, cliItem, pluginItem } from './lib/fake-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, UI_HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function fakeImpostor(port, body) {
  // 一个"别家的本地服务"：会回 JSON，甚至 ok:true，但没有我们的 service 标记
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, UI_HOST, () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function optionsOf(env) {
  return {
    profile: 'fixture',
    manifest: env.manifestPath,
    apply: false,
    only: [],
    skip: [],
    upgrade: false,
    rollbackMode: 'step',
    uninstall: false,
    npmPrefix: env.npmPrefix,
    home: env.home,
    timeoutMs: 30000,
    budgetMs: 300000,
    json: true,
    ui: true,
    uiPort: null,
  };
}

export const name = '双击入口（探测式单实例 + 纯 ASCII 壳 + 开浏览器归入口）';

export async function run(c) {
  // ── 0. 双击壳：纯 ASCII + CRLF + 内容对得上 ──────────────────
  const cmdPath = path.join(repoRoot, 'install-ui.cmd');
  c.eq(fs.existsSync(cmdPath), true, 'install-ui.cmd 必须在仓库根（用户只需要拿到这一个文件）');
  const cmdBytes = fs.readFileSync(cmdPath);
  const nonAscii = [...cmdBytes].filter((b) => b > 127).length;
  c.eq(nonAscii, 0, `🔴 .cmd 必须纯 ASCII（现在有 ${nonAscii} 个非 ASCII 字节 ⇒ 中文会被按 GBK 解析拆坏）`);
  const cmdText = cmdBytes.toString('utf8');
  c.ok(cmdText.includes('\r\n'), '.cmd 要用 CRLF 行尾（老派稳妥）');
  c.contains(cmdText, 'where node', '第一步要查 node');
  c.contains(cmdText, 'pause', '出错要停住窗口（不然窗口一闪而过，用户什么都看不到）');
  c.contains(cmdText, 'dsh-butler-install-ui', '要调到新的 bin（开浏览器由它负责，不是核心 CLI）');
  c.contains(cmdText, '@kira905/dsh-butler-install@^0.3.0', '包名与区间要写清（用户不需要先 npm i）');
  c.notContains(cmdText, '--open', '🔴 不许出现 --open（那是没进参数清单的假开关）');
  const cmdLines = cmdText.split(/\r\n/).filter((l) => l.trim() && !/^rem\b/i.test(l.trim()));
  const allowed = ['@', ':', 'setlocal', 'endlocal', 'title', 'echo', 'where', 'if', 'goto', 'npx', 'pause', 'exit'];
  c.ok(cmdLines.every((l) => allowed.some((prefix) => l.trim().startsWith(prefix))), `壳里只有"查 node / 跑 npx / 出错 pause"这三件事（多出来的行：${cmdLines.filter((l) => !allowed.some((p) => l.trim().startsWith(p))).join(' | ')}）`);

  // 包清单：双击壳要能被 npm 打进去，bin 要能跑起来
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  c.eq(pkg.files.includes('install-ui.cmd'), true, '🔴 package.json#files 必须含 install-ui.cmd（不然用户根本拿不到这个壳）');
  c.eq(pkg.bin['dsh-butler-install-ui'], 'bin/install-ui.mjs', 'package.json#bin 要注册新入口');

  // ── 1. 参数面没被改：--open 不存在（未知参数一律报错）──────────
  const withOpen = parseArgs(['--ui', '--open']);
  c.ok(withOpen.errors.length > 0, '🔴 --open 不在参数清单里 ⇒ 必须报错（加参数 = 改对外契约）');
  const uiOnly = parseArgs(['--ui']);
  c.eq(uiOnly.errors, [], '--ui 本身仍然合法');

  const env = makeFakeEnv({ profile: 'fixture', items: [pluginItem('@fake/plug'), cliItem('@fake/cli-a', 'cli-a')] });
  let started = null;
  const holders = [];
  try {
    const options = optionsOf(env);

    // ── 2. 探一个"没人"的端口：必须 ok:false ────────────────────
    const emptyPort = await freePort();
    const none = await probeExistingUi({ port: emptyPort, timeoutMs: 800 });
    c.eq(none.ok, false, '端口上没服务时探测必须说"没有"（不能报错、也不能假装有）');
    c.ok(Boolean(none.reason), '要说清为什么不是我们');

    // ── 3. 探一个"别家的服务"：有 ok:true 但没有 service 标记 ⇒ 仍 ok:false ──
    const impostorPort = await freePort();
    const impostor = await fakeImpostor(impostorPort, { ok: true, items: [], profile: 'someone-else' });
    holders.push(impostor);
    const foreign = await probeExistingUi({ port: impostorPort, timeoutMs: 800 });
    c.eq(foreign.ok, false, '🔴 只看 ok:true 就会认错人：别家的本地服务必须判成"不是我们的向导页"');
    c.contains(String(foreign.reason), String(impostorPort), '要说清是哪个端口上那个人不是我们');

    // ── 4. 起一个真的向导页：探测必须认出来 ──────────────────────
    const port = await freePort();
    started = await env.withPath(() => startUiServer({ options, port, onLog: () => {} }));
    c.ok(started.ok === true, '夹具自己的向导页要能起来');
    c.eq(started.port, port, '端口就是我们要的那个');
    const found = await probeExistingUi({ port });
    c.eq(found.ok, true, '🔴 探测必须认出自己的向导页');
    c.eq(found.url, `http://127.0.0.1:${port}/`, '探测给的地址要是那个端口');
    c.eq(found.profile, 'fixture', '探测能顺带报出 profile（第二次双击时给人看）');
    c.eq(typeof started.token, 'string', '服务要带令牌');
    c.eq(started.token.length, 32, '闸 2：令牌是 32 hex');
    c.eq(/^[0-9a-f]{32}$/.test(started.token), true, '闸 2：令牌是十六进制');

    // ── 5. 连起两次只得到一个服务（第二次：reuse，且一次都没起服务）──
    const opened = [];
    let startCalls = 0;
    const countingStart = async () => {
      startCalls += 1;
      return { ok: true, url: 'http://127.0.0.1:1/', port: 1, requestedPort: 1, portChanged: false, token: 'f'.repeat(32), log: [], close: async () => {} };
    };
    const silence = { write: () => true };
    const second = await runEntry({
      argv: ['--port', String(port)],
      out: silence,
      openBrowser: (url) => { opened.push(url); return true; },
      startServer: countingStart,
      waitForShutdown: false,
    });
    c.eq(second.action, 'reuse', '🔴 第二次双击必须复用已在跑的服务（不再起第二个）');
    c.eq(second.url, `http://127.0.0.1:${port}/`, '复用的地址就是原来那个');
    c.eq(startCalls, 0, '🔴 复用路径下一次 startServer 都不许调（调了就是两个服务抢同一个 profile）');
    c.eq(opened, [`http://127.0.0.1:${port}/`], '第二次也要把浏览器指过去（两个标签看同一个服务）');

    // 真服务还在、而且还能回答（没有被"第二次"弄坏）
    const still = await new Promise((resolve, reject) => {
      const req = http.request({ host: UI_HOST, port, path: '/state', method: 'GET', headers: { connection: 'close' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject);
      req.end();
    });
    c.eq(still.status, 200, '复用之后原来那个服务照常能回答');
    c.eq(JSON.parse(still.body).service, UI_SERVICE_ID, '/state 要带 service 标记（探测就靠它认人）');

    // ── 6. 没有服务时：起一个 + 开浏览器 ─────────────────────────
    const freshPort = await freePort();
    const openedFresh = [];
    let startCallsFresh = 0;
    const freshStart = async ({ port: askedPort }) => {
      startCallsFresh += 1;
      const actual = askedPort && askedPort > 0 ? askedPort : freshPort;
      return { ok: true, url: `http://127.0.0.1:${actual}/`, port: actual, requestedPort: actual, portChanged: false, token: 'a'.repeat(32), log: [], close: async () => {} };
    };
    const fresh = await runEntry({
      argv: ['--port', String(freshPort)],
      out: silence,
      openBrowser: (url) => { openedFresh.push(url); return true; },
      startServer: freshStart,
      waitForShutdown: false,
    });
    c.eq(fresh.action, 'start', '端口空着 ⇒ 起一个');
    c.eq(startCallsFresh, 1, '起服务只调一次');
    c.eq(openedFresh, [`http://127.0.0.1:${freshPort}/`], '起完要自己开浏览器（用户不用去复制地址）');

    // ── 7. --port 0：无从探测 ⇒ 直接起（这是"我要第二个实例"的显式表达）──
    let zeroCalls = 0;
    const zeroStart = async ({ port: askedPort }) => {
      zeroCalls += 1;
      return { ok: true, url: 'http://127.0.0.1:45678/', port: 45678, requestedPort: askedPort, portChanged: true, token: 'b'.repeat(32), log: [], close: async () => {} };
    };
    const zero = await runEntry({
      argv: ['--port', '0'],
      out: silence,
      openBrowser: () => true,
      startServer: zeroStart,
      waitForShutdown: false,
    });
    c.eq(zero.action, 'start', '--port 0 ⇒ 直接起（探测无从下手，如实登记在文件头）');
    c.eq(zeroCalls, 1, '--port 0 时不探测也不复用');

    // ── 8. 参数错误 ⇒ 早退，绝不起服务 ─────────────────────────
    let errorStartCalls = 0;
    const bad = await runEntry({
      argv: ['--apply'],
      out: silence,
      openBrowser: () => true,
      startServer: async () => { errorStartCalls += 1; return { ok: false, log: [] }; },
      waitForShutdown: false,
    });
    c.eq(bad.action, 'error', '--ui 与 --apply 冲突要在入口就拦住');
    c.eq(bad.exitCode, 2, '用法错误 rc = 2');
    c.eq(errorStartCalls, 0, '参数错的时候一个服务都不许起');

    c.eq(PROBE_TIMEOUT_MS <= 3000, true, '探测超时要短（本地环回，别让人等）');
  } finally {
    if (started && started.close) await started.close();
    for (const holder of holders) await close(holder);
    env.cleanup();
  }
}
