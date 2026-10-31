// 可视化安装 · 后端八道闸 + 执行器 + 撤回两条路（方案 §3.2 / §11.6）
//
// 这一格的分工：
//  A. `runSuite(options, hooks)` 的**向后兼容**：不传 hooks / 传空对象 / 传 onEvent，输出逐字节相同；
//  B–C. `spawnCommand` 的 `signal` 与退出钩子用的 `killTreeSync` / `killAllRunningSync`；
//  D–P. 八道闸逐条（令牌 / 同源 / 路由与 Allow / 两步确认 / 单飞 / 快照 / 可停）+ 进度轮询口径；
//  Q–T. 撤回两条路（A 卸载=不覆盖文件；B 恢复声明层=先过前置核对，改过就拒动）。
//
// 🔴 夹具专用的安全姿势：页面那条路上 `runSuite` 是**后台异步**跑的，所以假 PATH/DSH_HOME 必须
//    在整批跑完之前一直挂着（`enterEnv`），不能像同步夹具那样用 withPath 一包就还 ——
//    否则子进程会落到**真的** dsh/npm 上，那就不再是夹具了。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  startUiServer,
  routeOf,
  assertLoopbackHost,
  sameToken,
  checkOrigin,
  UI_HOST,
  UI_SERVICE_ID,
  TOKEN_HEADER,
  MAX_BODY_BYTES,
  POST_PATHS,
  GET_PATHS,
} from '../lib/ui-server.mjs';
import { runSuite, EXIT } from '../lib/run.mjs';
import { spawnCommand, killTreeSync, killAllRunningSync, runningChildPids } from '../lib/exec.mjs';
import {
  MAX_LINES,
  CLI_DEFAULT_BUDGET_MS,
  UI_BUDGET_CAP_MS,
  effectiveBudgetMs,
  estimateDurationMs,
  equivalentCommand,
} from '../lib/ui-install.mjs';
import { makeFakeEnv, pluginItem, cliItem } from './lib/fake-env.mjs';
import { fingerprint } from './lib/harness.mjs';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 与 test-ui.mjs 同一套种子：plug-a 与 cli-b 已装，plug-b 与 cli-a 待装 */
function seed(env) {
  const profileDir = path.join(env.home, 'profiles', 'fixture');
  writeJson(path.join(profileDir, 'package.json'), {
    name: 'dsh-profile-fixture',
    private: true,
    dependencies: { '@deepseek-ai/dsh-base': '^0.1.0', '@fake/plug-a': '^0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fake/plug-a'] } },
  });
  writeJson(path.join(profileDir, 'node_modules', '@fake', 'plug-a', 'package.json'), {
    name: '@fake/plug-a',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: {id: plug-a, name: "@fake/plug-a"}\n', 'utf8');
  writeJson(path.join(env.npmPrefix, 'node_modules', '@fake', 'cli-b', 'package.json'), { name: '@fake/cli-b', version: '0.1.0' });
  fs.writeFileSync(path.join(env.npmPrefix, 'cli-b.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
}

function fixtureEnv() {
  const env = makeFakeEnv({
    profile: 'fixture',
    items: [
      pluginItem('@fake/plug-a'),
      pluginItem('@fake/plug-b'),
      cliItem('@fake/cli-a', 'cli-a'),
      cliItem('@fake/cli-b', 'cli-b'),
    ],
    excluded: [{ id: 'fake-aggregate-repo', reason: '仓根没有 package.json，不是可安装的包' }],
  });
  seed(env);
  return env;
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

/**
 * 让假 PATH / 假 DSH_HOME 在**整段异步批**期间一直生效。
 * 返回 `restore()`，必须放 finally 里。
 */
function enterEnv(env) {
  const savedPath = process.env.PATH;
  const savedHome = process.env.DSH_HOME;
  const savedSleep = process.env.FAKE_SLEEP_MS;
  process.env.PATH = `${env.binDir}${path.delimiter}${savedPath || ''}`;
  process.env.DSH_HOME = env.home;
  return () => {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    if (savedSleep === undefined) delete process.env.FAKE_SLEEP_MS; else process.env.FAKE_SLEEP_MS = savedSleep;
  };
}

/** 把 runSuite 直接写 stdout 的那堆输出静音（夹具里为了能读断言，不是改被测代码） */
async function silenced(fn) {
  const saved = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = saved;
  }
}

/**
 * 页面那条路上，`runSuite` 是**后台异步**跑的 —— 光把某一次请求包起来不够，
 * 整个批次期间都得静音（不然夹具输出会被 npm 的流水刷满）。
 */
function enterQuiet() {
  const saved = process.stdout.write;
  process.stdout.write = () => true;
  return () => { process.stdout.write = saved; };
}

function request(port, method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: UI_HOST,
      port,
      method,
      path: pathname,
      headers: { connection: 'close', ...(headers || {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postRaw(started, pathname, body, headers = {}) {
  return request(started.port, 'POST', pathname, {
    body: typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const tokenOf = (started) => ({ [TOKEN_HEADER]: started.token });
const originOf = (started) => ({ origin: `http://127.0.0.1:${started.port}` });
const sameSiteOf = (started) => ({ ...tokenOf(started), ...originOf(started), 'sec-fetch-site': 'same-origin' });

function post(started, pathname, body, headers = {}) {
  return postRaw(started, pathname, body, { ...sameSiteOf(started), ...headers });
}

async function waitFor(port, predicate, { timeoutMs = 60000, intervalMs = 200 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const res = await request(port, 'GET', '/install/progress');
    if (res.status === 200) {
      last = JSON.parse(res.body);
      if (predicate(last)) return { ok: true, progress: last, ms: Date.now() - t0 };
    }
    await sleep(intervalMs);
  }
  return { ok: false, progress: last, ms: Date.now() - t0 };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const name = '可视化安装后端（八道闸 + 执行器 + 撤回两条路）';

export async function run(c) {
  // ══════════════════════════════════════════════════════════
  // A. 不传 hooks / 传空对象 / 传 onEvent ⇒ 输出逐字节相同
  // ══════════════════════════════════════════════════════════
  const envA = fixtureEnv();
  const restoreA = enterEnv(envA);
  const restoreQuietA = enterQuiet();
  let startedA = null;
  try {
    const dryOptions = { ...optionsOf(envA), apply: false, json: true };
    // json:true 时人读输出走 stderr（与 CLI 口径一致）：夹具里静音，别刷屏
    const savedErrWrite = process.stderr.write;
    process.stderr.write = () => true;
    let plainText;
    let emptyHooksText;
    const events = [];
    let hookedText;
    try {
      ({ text: plainText } = await silenced(() => runSuite(dryOptions)));
      ({ text: emptyHooksText } = await silenced(() => runSuite(dryOptions, {})));
      ({ text: hookedText } = await silenced(() => runSuite(dryOptions, { onEvent: (e) => events.push(e) })));
    } finally {
      process.stderr.write = savedErrWrite;
    }
    c.eq(emptyHooksText, plainText, '🔴 传空 hooks 对象时输出必须逐字节相同（不传 = 现状）');
    c.eq(hookedText, plainText, '🔴 传了 onEvent 也不能改变人读输出（进度是旁路，不是改写）');
    c.ok(events.length > 0, 'onEvent 要真的收到事件');
    const logs = events.filter((e) => e.kind === 'log');
    c.ok(logs.length > 0, '要收到 log 事件');
    c.eq(logs.every((e) => !String(e.detail).startsWith('    ')), true, '🔴 进度只带摘要行：缩进 4 格的子命令原始输出不许进事件');
    c.eq(logs.every((e) => String(e.detail).length <= 501), true, '摘要行要截断（别把 MB 级输出塞进内存与页面）');
    const done = events.find((e) => e.kind === 'batch-done');
    c.ok(Boolean(done), '要收到 batch-done（页面靠它判"这一批结束"）');
    c.eq(done && done.exitCode, EXIT.OK, 'batch-done 要带退出码');
    c.eq(Array.isArray(done && done.installed), true, 'batch-done 要带"这一批装了什么"');

    // 预算口径（I4）：--ui 路径把缺省 300s 抬起来，显式给了就尊重
    c.eq(effectiveBudgetMs({ options: { timeoutMs: 120000, budgetMs: CLI_DEFAULT_BUDGET_MS }, installCount: 16 }), UI_BUDGET_CAP_MS, '🔴 16 项 × 120s 会被 30 分钟天花板夹住（缺省 300s 必须抬）');
    c.eq(effectiveBudgetMs({ options: { timeoutMs: 30000, budgetMs: CLI_DEFAULT_BUDGET_MS }, installCount: 2 }), CLI_DEFAULT_BUDGET_MS, '推算只往上抬、不往下压：2 × 30s < 缺省 300s ⇒ 仍用缺省（不许压到比 CLI 缺省还小）');
    c.eq(effectiveBudgetMs({ options: { timeoutMs: 120000, budgetMs: CLI_DEFAULT_BUDGET_MS }, installCount: 3 }), 360000, '按"每步超时 × 待装项数"推算（3 × 120s > 300s ⇒ 抬到 360s）');
    c.eq(effectiveBudgetMs({ options: { timeoutMs: 120000, budgetMs: 900000 }, installCount: 16 }), 900000, '显式给的 --budget 要尊重（不自作主张）');
    const est = estimateDurationMs([{ type: 'cli' }, { type: 'plugin' }]);
    c.eq(est.minMs < est.maxMs, true, '预计时长给区间，不是一个假装精确的数字');
    c.contains(est.text, '分钟', '预计时长用人话给（分钟）');
    const eqCmd = equivalentCommand({ options: { manifest: 'C:\\a b\\m.json' }, profile: 'web', budgetMs: 600000 });
    c.contains(eqCmd, '--apply', '🔴 等价命令行必须带 --apply（不然用户复制到的是演练命令）');
    c.contains(eqCmd, '--profile web', '等价命令行要写清 profile');
    c.contains(eqCmd, '--budget 600', '等价命令行要把预算带上（否则复现出来是另一件事）');

    // ── spawnCommand 的 signal（不传 ⇒ 行为不变）──────────────
    const envForSpawn = { npm_config_prefix: envA.npmPrefix };
    const plainSpawn = await silenced(() => spawnCommand('npm', ['config', 'get', 'prefix'], { timeoutMs: 30000, env: envForSpawn }));
    c.eq(plainSpawn.code, 0, '不传 signal 时命令照常跑完');
    c.eq(plainSpawn.aborted, false, '不传 signal ⇒ aborted 必须是 false');
    c.eq(plainSpawn.stdout.trim(), envA.npmPrefix, '不传 signal 时输出原样');
    const preAborted = new AbortController();
    preAborted.abort();
    const abortedBefore = await spawnCommand('npm', ['config', 'get', 'prefix'], { timeoutMs: 30000, env: envForSpawn, signal: preAborted.signal });
    c.eq(abortedBefore.aborted, true, '已经取消过的 signal ⇒ 直接回 aborted');
    c.eq(abortedBefore.stdout, '', '已经取消就不该真的去跑那条命令');
    c.eq(abortedBefore.code, null, '取消的命令没有退出码');

    // 跑到一半取消：必须真的把进程树杀掉（≤5s 内收工），不能等它自己超时
    const liveController = new AbortController();
    const liveRun = spawnCommand('npm', ['i', '-g', '@fake/slow@^0.1.0'], {
      timeoutMs: 60000,
      env: { ...envForSpawn, FAKE_SLEEP_MS: '20000' },
      signal: liveController.signal,
    });
    await sleep(400);
    c.eq(runningChildPids().length >= 1, true, '跑着的子进程要在名册里（退出钩子靠它）');
    const abortAt = Date.now();
    liveController.abort();
    const liveRes = await Promise.race([liveRun, sleep(8000).then(() => ({ timedOutWait: true }))]);
    const abortCost = Date.now() - abortAt;
    c.eq(liveRes.aborted, true, '取消后返回 aborted=true');
    c.ok(abortCost < 5000, `取消要真的停（实测 ${abortCost}ms，命令本来要睡 20s）`);
    c.eq(runningChildPids().length, 0, '取消之后名册要清空（没有孤儿）');

    // 退出钩子那一路：killTreeSync + killAllRunningSync（同步，因为 process.on('exit') 只能跑同步代码）
    c.eq(typeof killTreeSync, 'function', '必须有同步版 killTreeSync（异步 spawn 在 exit 钩子里来不及）');
    c.eq(killTreeSync(0), false, 'pid 为空时不假装杀成功');
    const orphanRun = spawnCommand('npm', ['i', '-g', '@fake/slow2@^0.1.0'], {
      timeoutMs: 60000,
      env: { ...envForSpawn, FAKE_SLEEP_MS: '20000' },
    });
    await sleep(400);
    c.eq(runningChildPids().length, 1, '没有 signal 的命令也要登记进名册');
    const killed = killAllRunningSync();
    c.eq(killed, 1, '同步杀要报告杀掉了几个');
    const orphanRes = await Promise.race([orphanRun, sleep(8000).then(() => ({ neverSettled: true }))]);
    c.eq(orphanRes.neverSettled, undefined, '被杀之后命令要收尾（不能永远挂着）');
    c.eq(runningChildPids().length, 0, '杀完之后名册要空');

    // ══════════════════════════════════════════════════════════
    // D. 起服务（--port 0 ⇒ 系统挑端口，顺便当"端口口径"夹具）
    // ══════════════════════════════════════════════════════════
    startedA = await startUiServer({ options: optionsOf(envA), port: 0, onLog: () => {} });
    c.ok(startedA.ok === true, '向导页要能起来');
    // 闸 1：只绑回环
    let threw = null;
    try { assertLoopbackHost('0.0.0.0'); } catch (err) { threw = err; }
    c.ok(Boolean(threw), '🔴 闸 1：传 0.0.0.0 必须当场抛');
    const addr = startedA.server.address();
    c.eq(addr.address, UI_HOST, '🔴 闸 1：实际监听地址就是 127.0.0.1');
    c.ok(startedA.port !== 0 && startedA.port !== 45080, `这一轮用的是系统挑的随机端口（${startedA.port}）⇒ 下面每条 POST 都在证明"没写死 45080"`);

    // 闸 2：令牌
    const noToken = await postRaw(startedA, '/install/preview', {});
    c.eq(noToken.status, 403, '🔴 闸 2：缺令牌 ⇒ 403');
    c.contains(noToken.body, 'bad-token', '缺令牌的正文要说清是令牌问题');
    const wrongToken = await postRaw(startedA, '/install/preview', {}, { [TOKEN_HEADER]: 'f'.repeat(32) });
    c.eq(wrongToken.status, 403, '🔴 闸 2：令牌错了也 403');
    const shortToken = await postRaw(startedA, '/install/preview', {}, { [TOKEN_HEADER]: 'abc' });
    c.eq(shortToken.status, 403, '闸 2：长度不对的令牌同样 403');
    c.eq(startedA.token.length, 32, '闸 2：进程级令牌是 32 hex');
    const tokenReq = { headers: { [TOKEN_HEADER]: startedA.token } };
    c.eq(sameToken(tokenReq, startedA.token), true, 'sameToken：对的令牌通过');
    c.eq(sameToken({ headers: {} }, startedA.token), false, 'sameToken：没令牌不通过');

    // 闸 3：同源（Origin 逐字等于 server.address() 的 address:port）
    const page = await request(startedA.port, 'GET', '/');
    c.eq(page.status, 200, 'GET / 仍是 200');
    c.contains(page.body, `<meta name="install-token" content="${startedA.token}">`, '闸 2：令牌要内嵌在页面里（页面只从 meta 读，不拼 URL）');
    c.contains(page.body, 'install-token', '页面里要有令牌的载体');

    const forged = await postRaw(startedA, '/install/preview', {}, { ...tokenOf(startedA), origin: 'http://evil.example' });
    c.eq(forged.status, 403, '🔴 闸 3：伪造 Origin ⇒ 403（别站偷偷发请求进不来）');
    c.contains(forged.body, 'origin', '拒动时要说明是 Origin 的问题');
    const noOrigin = await postRaw(startedA, '/install/preview', {}, { ...tokenOf(startedA) });
    c.eq(noOrigin.status, 403, '闸 3：没有 Origin 的 POST 也要拒（浏览器一定会带）');
    c.contains(noOrigin.body, 'origin-missing', '缺 Origin 的错误码要认得出来');
    const wrongPort = await postRaw(startedA, '/install/preview', {}, { ...tokenOf(startedA), origin: 'http://127.0.0.1:45080' });
    c.eq(wrongPort.status, 403, '🔴 闸 3（I1）：端口对不上就 403 —— 这正是不许把 45080 写死的理由');
    const crossSite = await postRaw(startedA, '/install/preview', {}, { ...tokenOf(startedA), ...originOf(startedA), 'sec-fetch-site': 'cross-site' });
    c.eq(crossSite.status, 403, '闸 3：Sec-Fetch-Site 是 cross-site ⇒ 403');
    const noSite = await postRaw(startedA, '/install/preview', {}, { ...tokenOf(startedA), ...originOf(startedA) });
    c.eq(noSite.status, 200, '🔴 闸 3（I2）：没有 Sec-Fetch-Site 头的 POST 仍要 200（360 兼容模式/老浏览器没有这个头）');
    const originCheck = checkOrigin({ headers: { origin: `http://127.0.0.1:${startedA.port}` } }, startedA.server);
    c.eq(originCheck.ok, true, 'checkOrigin：正确 Origin 通过');
    c.eq(originCheck.expected, `127.0.0.1:${startedA.port}`, 'checkOrigin 的口径是 address:port（不是写死的端口）');

    // 闸 4：路由与方法白名单 + Allow 按路径给
    c.eq(routeOf('DELETE', '/install/start').kind, 'method-not-allowed', '闸 4：DELETE /install/start ⇒ 405');
    c.eq(routeOf('DELETE', '/install/start').allow, 'POST', '闸 4：Allow 要按路径给（/install/start 只认 POST）');
    c.eq(routeOf('GET', '/install/preview').allow, 'POST', 'GET 一条写路径 ⇒ Allow: POST');
    c.eq(routeOf('POST', '/install/nope').allow, 'GET', '未知路径上的写方法 ⇒ Allow: GET');
    c.eq(routeOf('GET', '/install/progress').kind, 'progress', 'GET /install/progress 是读入口');
    c.eq(routeOf('POST', '/install/rollback').kind, 'rollback', 'POST /install/rollback 是撤回入口');
    c.eq(routeOf('GET', '/').kind, 'page', 'GET / 还是页面');
    const del = await request(startedA.port, 'DELETE', '/install/start', {});
    c.eq(del.status, 405, '闸 4：DELETE /install/start ⇒ 405');
    c.eq(String(del.headers.allow), 'POST', '闸 4：Allow 头按路径给（写死 GET 会自相矛盾）');
    const getOnPost = await request(startedA.port, 'GET', '/install/preview', {});
    c.eq(getOnPost.status, 405, '闸 4：GET 写路径 ⇒ 405');
    const unknownPost = await post(startedA, '/install/nope', {});
    c.eq(unknownPost.status, 405, '闸 4：带齐令牌与同源的未知写路径 ⇒ 405（不是 200、也不是 500）');
    const progressGet = await request(startedA.port, 'GET', '/install/progress', {});
    c.eq(progressGet.status, 200, '闸 4：GET /install/progress ⇒ 200');
    const nf = await request(startedA.port, 'GET', '/nope', {});
    c.eq(nf.status, 404, '闸 4：未知 GET 路径 ⇒ 404');

    // 闸 5：两步确认
    const homeBeforePreview = fingerprint(envA.home);
    const preview = await post(startedA, '/install/preview', {});
    c.eq(preview.status, 200, '闸 5：preview 是 200');
    const previewBody = JSON.parse(preview.body);
    c.eq(previewBody.willInstall.length, 2, 'preview 要念出"将装这 2 项"');
    c.eq(previewBody.profile, 'fixture', 'preview 要把 profile 名字念出来（别装错地方）');
    c.contains(previewBody.equivalentCommand, '--apply', 'preview 要给出带 --apply 的等价命令行（S3）');
    c.contains(previewBody.snapshotHint, 'snapshots', '闸 7：开跑前要告诉用户"回滚点会落在哪"');
    c.ok(previewBody.estimate && previewBody.estimate.text, 'I4：要给出预计时长');
    c.ok(previewBody.budgetMs >= CLI_DEFAULT_BUDGET_MS, 'I4：给页面显示的预算不能比 CLI 缺省还小');
    c.eq(fingerprint(envA.home), homeBeforePreview, '🔴 闸 5：preview 一条命令都不跑、一个文件都不写');

    const skipConfirm = await post(startedA, '/install/start', {});
    c.eq(skipConfirm.status, 400, '🔴 闸 5：start 不带 confirm:true ⇒ 400');
    c.contains(skipConfirm.body, 'confirm-required', '要明确说缺 confirm');
    c.eq(fingerprint(envA.home), homeBeforePreview, '🔴 跳确认被拒之后也要零副作用');
    const noConfirmFalse = await post(startedA, '/install/start', { confirm: 'yes' });
    c.eq(noConfirmFalse.status, 400, 'confirm 只认严格的 true（"yes"/1 都不算）');

    // 闸 6：单飞（这一批故意跑慢一点，好让第二次 start 一定撞上锁）
    process.env.FAKE_SLEEP_MS = '1200';
    const firstStart = await silenced(() => post(startedA, '/install/start', { confirm: true }));
    c.eq(firstStart.status, 202, '🚀 confirm:true ⇒ 202 起跑');
    const firstBody = JSON.parse(firstStart.body);
    c.ok(Boolean(firstBody.batchId), '要回一个批次 id');
    const secondStart = await post(startedA, '/install/start', { confirm: true });
    c.eq(secondStart.status, 409, '🔴 闸 6：重复 start ⇒ 409（同一时刻只允许一批）');
    const secondBody = JSON.parse(secondStart.body);
    c.eq(secondBody.error, 'busy', '409 要说清是"有一批在跑"');
    c.eq(secondBody.progress && secondBody.progress.batchId, firstBody.batchId, '409 要带当前进度（页面能接着显示那一批）');
    c.eq(secondBody.progress && secondBody.progress.status, 'running', '409 时状态是 running');
    c.eq(secondBody.progress && secondBody.progress.can.cancel, true, '在跑的时候【取消】是可用的');
    delete process.env.FAKE_SLEEP_MS;

    // 进度轮询口径（S4）：500–1000ms + 幂等 + 带 lastLineAt
    const p1Res = await request(startedA.port, 'GET', '/install/progress', {});
    const p1 = JSON.parse(p1Res.body);
    await sleep(600);
    const p2 = JSON.parse((await request(startedA.port, 'GET', '/install/progress', {})).body);
    c.eq(p1Res.status, 200, '进度接口 200');
    c.eq(p1.batchId, p2.batchId, '进度读是幂等的（两次读到同一个批次）');
    c.ok('lastLineAt' in p1, '进度要带 lastLineAt（区分"卡住"与 npm 静默下载）');
    c.ok('sinceLastLineMs' in p1, '还要给"距上一行多久"的读数');
    c.ok(p1.lines.length <= MAX_LINES, `进度只留最近 ${MAX_LINES} 行摘要`);
    c.eq(p1.lines.every((l) => !l.startsWith('    ')), true, '进度里的行全是摘要行');

    const finishedA = await waitFor(startedA.port, (p) => p.status !== 'running' && p.status !== 'cancelling', { timeoutMs: 90000 });
    c.ok(finishedA.ok, '这一批要跑完（夹具等不到就是卡住了）');
    const doneA = finishedA.progress;
    c.eq(doneA.status, 'done', `这一批该是全绿（实际 ${doneA.status}：${doneA.message}）`);
    c.eq(doneA.exitCode, EXIT.OK, '退出码 0');
    c.eq(doneA.counts.ok, 2, '两项装好');
    c.eq(doneA.counts.skip, 2, '两项已满足跳过');
    c.eq(doneA.can.cancel, false, '跑完之后不能再取消');
    c.eq(doneA.can.rollback, true, '跑完之后可以撤回（两条路之一）');
    c.contains(doneA.message, '判据', '结果说明要点出"判据过了才算成功"');
    c.eq(doneA.settlement !== null, true, '跑完要记下"本轮收尾时的 sha"（撤回动作 B 的基准）');
    c.ok(doneA.result && doneA.result.snapshotRoot, '结果里要带快照根');

    // 闸 7：快照真的落在盘上，且 pre-run 可读
    const snapRoot = doneA.result.snapshotRoot;
    c.eq(fs.existsSync(path.join(snapRoot, 'pre-run', 'snapshot.json')), true, '闸 7：装前快照要落在盘上（撤回动作 B 靠它）');
    const preRecord = readJson(path.join(snapRoot, 'pre-run', 'snapshot.json'));
    c.ok(preRecord && Array.isArray(preRecord.files), '快照记录可读');
    c.contains(String(preRecord.warning), 'node_modules', '快照自带的诚实提示要留着（回滚不还原 node_modules）');

    // 真装的落点对得上（跟 CLI 那条路同一个 runSuite）
    const profileA = readJson(path.join(envA.home, 'profiles', 'fixture', 'package.json'));
    c.eq(profileA.dependencies['@fake/plug-b'], '^0.1.0', '页面装的插件要落进 profile 依赖');
    c.eq((profileA.dsh.profile.bundles || []).includes('@fake/plug-b'), true, '还要进组合列表（不然是"装了不生效"）');
    c.eq(fs.existsSync(path.join(envA.npmPrefix, process.platform === 'win32' ? 'cli-a.cmd' : 'cli-a')), true, '命令行类要落到全局前缀');

    // 进度不是持久真相（B4）：服务重启后不该读出一份"看起来还在跑"的旧状态
    c.eq(fs.existsSync(path.join(envA.home, 'butler-install', 'ui-state.json')), false, '不许把进度落盘（现象：重启后读旧状态比现跑更不准）');

    // ══════════════════════════════════════════════════════════
    // Q. 撤回动作 A【卸载这次装的】
    // ══════════════════════════════════════════════════════════
    const rollbackA = await silenced(() => post(startedA, '/install/rollback', { action: 'uninstall' }));
    c.eq(rollbackA.status, 200, '动作 A：200');
    const rbA = JSON.parse(rollbackA.body);
    c.eq(rbA.action, 'uninstall', '回执要写明是哪个动作');
    c.eq(rbA.ok, true, `动作 A 要成功（退出码 ${rbA.exitCode}）`);
    c.eq(rbA.exitCode, EXIT.OK, '动作 A 的退出码 0 = 卸干净了');
    c.eq(Array.isArray(rbA.honest) && rbA.honest.length >= 2, true, '动作 A 要带"这是什么/它不做什么"的实话');
    c.eq(rbA.honest.some((h) => h.includes('不覆盖')), true, '要讲明"不覆盖任何文件"（这是它与动作 B 的关键差别）');
    const profileAfterUninstall = readJson(path.join(envA.home, 'profiles', 'fixture', 'package.json'));
    c.eq(profileAfterUninstall.dependencies['@fake/plug-b'], undefined, '动作 A 之后"已装"要真的变回"未装"（依赖摘掉了）');
    c.eq((profileAfterUninstall.dsh.profile.bundles || []).includes('@fake/plug-b'), false, '组合列表也摘掉');
    c.eq(fs.existsSync(path.join(envA.npmPrefix, process.platform === 'win32' ? 'cli-a.cmd' : 'cli-a')), false, '命令行工具也要卸掉');
    c.eq(profileAfterUninstall.dependencies['@fake/plug-a'], '^0.1.0', '只卸"这次装的"：装前就有的 plug-a 不能动');
    // 动作 A 动过声明层 ⇒ "本轮收尾 sha"作废：动作 B 现在必须拒动（不假装还能撤）
    const bAfterA = await post(startedA, '/install/rollback', { action: 'restore-declarations' });
    c.eq(bAfterA.status, 412, '🔴 动作 A 之后再做动作 B ⇒ 412（基准已作废，不许盲覆盖）');
    c.contains(bAfterA.body, 'no-settlement', '要如实说"没有可核的基准"');
    const badAction = await post(startedA, '/install/rollback', { action: 'rollback' });
    c.eq(badAction.status, 400, '🔴 不许把 --rollback 当动作：action=rollback ⇒ 400');
    c.contains(badAction.body, 'unknown-action', '要列出只有两个诚实动作');

    await startedA.close();
    startedA = null;
  } finally {
    if (startedA) await startedA.close();
    restoreQuietA();
    restoreA();
    envA.cleanup();
  }

  // ══════════════════════════════════════════════════════════
  // R. 闸 8：可停（取消要真的杀掉正在跑的命令树）
  // ══════════════════════════════════════════════════════════
  const envR = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/plug-slow'), cliItem('@fake/cli-slow', 'cli-slow')],
  });
  const restoreR = enterEnv(envR);
  const restoreQuietR = enterQuiet();
  let startedR = null;
  try {
    process.env.FAKE_SLEEP_MS = '20000';
    startedR = await startUiServer({ options: optionsOf(envR), port: 0, onLog: () => {} });
    c.ok(startedR.ok === true, '取消夹具的服务要能起来');
    const startedBatch = await silenced(() => post(startedR, '/install/start', { confirm: true }));
    c.eq(startedBatch.status, 202, '慢批次起跑');
    const running = await waitFor(startedR.port, (p) => p.status === 'running' && Boolean(p.current), { timeoutMs: 20000, intervalMs: 150 });
    c.ok(running.ok, '要能看到"正在装第 1 项"');
    c.eq(running.progress.current.name, '@fake/plug-slow', '当前项要是那一项');
    c.eq(running.progress.items[0].status, 'running', '它的状态是 running');

    const cancelled = await post(startedR, '/install/cancel', {});
    const cancelAt = Date.now();
    c.eq(cancelled.status, 202, '闸 8：cancel ⇒ 202');
    const cancelledBody = JSON.parse(cancelled.body);
    c.eq(cancelledBody.status, 'cancelling', '立刻回"正在停"（不是假装已经停干净）');
    c.contains(cancelledBody.message, '不', '取消的文案要如实说这不是干净撤回');
    const finishedR = await waitFor(startedR.port, (p) => p.status === 'cancelled', { timeoutMs: 20000, intervalMs: 150 });
    const cancelCost = Date.now() - cancelAt;
    c.ok(finishedR.ok, '闸 8：取消之后这一批要收尾（不能永远挂在"取消中"）');
    c.ok(cancelCost < 5000, `闸 8：点【取消】→ 真停 要 ≤5s（实测 ${cancelCost}ms，那条命令本来要睡 20s）`);
    const afterCancel = finishedR.progress;
    c.eq(afterCancel.status, 'cancelled', '状态是 cancelled');
    c.contains(afterCancel.message, '装了一半', '🔴 不许假装干净：必须说"装了一半"');
    c.contains(afterCancel.message, '卸载这次装的', '还要给出"接着该点哪个"');
    c.eq(afterCancel.counts.cancelled + afterCancel.counts.fail >= 1, true, '被取消的那一项要记成 cancelled/fail（不是 ok）');
    const cancelAgain = await post(startedR, '/install/cancel', {});
    c.eq(cancelAgain.status, 409, '没有在跑的批次时 cancel ⇒ 409');
    c.contains(cancelAgain.body, 'not-running', '要说明为什么没得取消');
    c.eq(runningChildPids().length, 0, '取消之后不许留下孤儿子进程');

    // 取消过的批次也能撤（页面必须给这个出口）
    const rbAfterCancel = await silenced(() => post(startedR, '/install/rollback', { action: 'uninstall' }));
    const rbCancelBody = JSON.parse(rbAfterCancel.body);
    c.ok([200, 400].includes(rbAfterCancel.status), '取消之后点撤回要么真的卸、要么老实说没得卸（不许 500）');
    c.eq(typeof rbCancelBody.ok, 'boolean', '回执要有明确的 ok');
    await startedR.close();
    startedR = null;
  } finally {
    if (startedR) await startedR.close();
    delete process.env.FAKE_SLEEP_MS;
    restoreQuietR();
    restoreR();
    envR.cleanup();
  }

  // ══════════════════════════════════════════════════════════
  // S. 撤回动作 B【恢复声明层到装前】—— 先过前置核对（最危险的一条）
  // ══════════════════════════════════════════════════════════
  const envS = fixtureEnv();
  const restoreS = enterEnv(envS);
  const restoreQuietS = enterQuiet();
  let startedS = null;
  try {
    startedS = await startUiServer({ options: optionsOf(envS), port: 0, onLog: () => {} });
    const startS = await silenced(() => post(startedS, '/install/start', { confirm: true }));
    c.eq(startS.status, 202, '动作 B 的夹具：先装好一批');
    const doneS = await waitFor(startedS.port, (p) => p.status === 'done' || p.status === 'failed', { timeoutMs: 90000 });
    c.eq(doneS.progress && doneS.progress.status, 'done', '这一批要全绿（不然下面比的是失败现场）');

    // S1. 期间被别的程序改过 ⇒ 拒动
    const pkgFile = path.join(envS.home, 'profiles', 'fixture', 'package.json');
    const original = fs.readFileSync(pkgFile, 'utf8');
    fs.writeFileSync(pkgFile, `${original}\n`, 'utf8'); // 模拟"DSH 侧边栏又装了个插件，宿主写了同一份 package.json"
    const tampered = await post(startedS, '/install/rollback', { action: 'restore-declarations' });
    c.eq(tampered.status, 412, '🔴 动作 B：声明层被别人改过 ⇒ 412 拒动（不许 copyFileSync 静默抹掉别人的写入）');
    const tamperedBody = JSON.parse(tampered.body);
    c.eq(tamperedBody.error, 'precondition-failed', '要报前置核对没过');
    c.eq(tamperedBody.reason, 'changed', '原因要说清是"文件被改过"');
    c.eq(Array.isArray(tamperedBody.changed) && tamperedBody.changed.length >= 1, true, '要点名是哪几份文件变了');
    c.contains(tamperedBody.message, '别的程序', '要用人话说清发生了什么');
    c.eq(fs.readFileSync(pkgFile, 'utf8'), `${original}\n`, '拒动之后一个字节都不许动');

    // S2. 改回去（等于"没人动过"）⇒ 允许恢复，且必须如实说清"只还原声明层"
    fs.writeFileSync(pkgFile, original, 'utf8');
    const restored = await post(startedS, '/install/rollback', { action: 'restore-declarations' });
    c.eq(restored.status, 200, '动作 B：基准对得上 ⇒ 200');
    const restoredBody = JSON.parse(restored.body);
    c.eq(restoredBody.ok, true, '复核要通过（verifySnapshotRestored）');
    c.eq(restoredBody.verify && restoredBody.verify.ok, true, '回放之后四份文件的 sha 要回到快照值');
    c.eq(Array.isArray(restoredBody.actions) && restoredBody.actions.length >= 1, true, '要列出每份文件做了什么');
    c.eq(restoredBody.honest.some((h) => h.includes('node_modules')), true, '🔴 必须说"node_modules 里的实体不会消失"');
    c.eq(restoredBody.honest.some((h) => h.includes('仍显示') || h.includes('已装')), true, '🔴 必须说"重开页面大概率仍显示已装"（不许声称撤回干净）');
    const afterRestore = readJson(pkgFile);
    c.eq(afterRestore.dependencies['@fake/plug-b'], undefined, '声明层回到装前：依赖里没有新装的那项');
    c.eq(fs.existsSync(path.join(envS.home, 'profiles', 'fixture', 'node_modules', '@fake', 'plug-b', 'package.json')), true, '诚实边界的实证：实体文件还在（所以页面仍会显示"已装"）');

    await startedS.close();
    startedS = null;
  } finally {
    if (startedS) await startedS.close();
    restoreQuietS();
    restoreS();
    envS.cleanup();
  }

  // ══════════════════════════════════════════════════════════
  // T. 失败批次走页面那条路：退出码 3 + 快照被用上（闸 7 全链路）
  // ══════════════════════════════════════════════════════════
  const envT = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/ok-z'), pluginItem('@fake/nope')],
  });
  const restoreT = enterEnv(envT);
  const restoreQuietT = enterQuiet();
  let startedT = null;
  try {
    startedT = await startUiServer({ options: optionsOf(envT), port: 0, onLog: () => {} });
    const startT = await silenced(() => post(startedT, '/install/start', { confirm: true }));
    c.eq(startT.status, 202, '失败夹具起跑');
    const doneT = await waitFor(startedT.port, (p) => p.status === 'done' || p.status === 'failed' || p.status === 'error', { timeoutMs: 90000 });
    c.eq(doneT.progress && doneT.progress.status, 'failed', '装到失败项要标 failed');
    c.eq(doneT.progress.exitCode, EXIT.ROLLED_BACK, '闸 7：失败后回滚干净 ⇒ 退出码 3（不是 0）');
    c.contains(doneT.progress.message, '回滚', '结果说明要点出回滚的去向');
    c.ok(doneT.progress.result && doneT.progress.result.rollback, '结果里要带回滚的细节（哪份快照、干净没有）');
    c.eq(doneT.progress.result.rollback.clean, true, '这一例的回滚是干净的');
    c.eq(fs.existsSync(doneT.progress.result.snapshotRoot), true, '快照目录要留着给人看');
    const rbt = await silenced(() => post(startedT, '/install/rollback', { action: 'uninstall' }));
    c.eq(rbt.status, 200, '失败批次之后也能点【卸载这次装的】');
    await startedT.close();
    startedT = null;
  } finally {
    if (startedT) await startedT.close();
    restoreQuietT();
    restoreT();
    envT.cleanup();
  }

  // ══════════════════════════════════════════════════════════
  // U. 路由常量与请求体上限（写入口就那么几条，别的都是 405/404）
  // ══════════════════════════════════════════════════════════
  c.eq(GET_PATHS, ['/', '/state', '/install/progress'], 'GET 入口就三条');
  c.eq(POST_PATHS, ['/install/preview', '/install/start', '/install/cancel', '/install/rollback'], 'POST 入口就四条（第四条是撤回，方案 §11.3 要的）');
  c.eq(MAX_BODY_BYTES <= 256 * 1024, true, '请求体上限要小（这几个接口只收一个小 JSON）');
  c.eq(UI_SERVICE_ID, 'dsh-butler-install-ui', 'service 标记是探测认人的依据，不能随便改');
}
