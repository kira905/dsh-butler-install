// --ui 向导页：监听地址 / 路由表 / 与 --dry-run 同源 / 每请求零 spawn / 端口冲突 / 向后兼容
//
// 为什么这几条必须逐条钉住：
//  - 监听地址：绑 0.0.0.0 = 把本机服务摊给同网段每一台机器，这是安全红线，不是配置项；
//  - 路由表：0.2.x 时这里断言的是"POST 一律 405"。0.3.0 起页面能装（方案 §11.6 · I3），
//    所以改成"**POST 只有白名单那四条，其余仍 405**" —— 只放开这四条，别的一寸不让；
//  - 同源：页面自己拼命令 ⇒ 用户复制到的不是安装器真会跑的那行（假一致比没有界面更坏）；
//  - 零 spawn：处理请求的路径一旦会起进程，"读一遍现在装了什么"就不再可信；
//  - 向后兼容：不给 --ui 时输出要一字不差（金标 = 加 --ui 之前的原始输出，逐字节冻结）。
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite, EXIT } from '../lib/run.mjs';
import { buildSuiteState } from '../lib/plan.mjs';
import {
  startUiServer,
  routeOf,
  assertLoopbackHost,
  resolvePort,
  UI_HOST,
  DEFAULT_UI_PORT,
  GET_PATHS,
  POST_PATHS,
} from '../lib/ui-server.mjs';
import { escapeHtml } from '../lib/ui-page.mjs';
import { parseArgs } from '../lib/cli-args.mjs';
import { makeFakeEnv, pluginItem, cliItem } from './lib/fake-env.mjs';
import { fingerprint } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'legacy-dryrun.txt');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 与"改前基线"同一套假环境：4 项清单，plug-a 与 cli-b 已经装好 */
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
    ui: false,
    uiPort: null,
  };
}

/** 把夹具临时路径换成占位符（金标里就是这两个占位符） */
function normalize(text, envDir) {
  const forms = (v) => [v, v.replace(/\\/g, '/'), v.replace(/\\/g, '\\\\')];
  let out = String(text);
  for (const needle of forms(envDir)) out = out.split(needle).join('<ENV>');
  return out;
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: UI_HOST,
      port,
      method,
      path: pathname,
      headers: { connection: 'close' },
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

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, UI_HOST, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export const name = '向导页（--ui）';

export async function run(c) {
  const env = fixtureEnv();
  const options = optionsOf(env);
  let started = null;

  try {
    // ── 0. 参数层：--ui 的边界 ────────────────────────────────
    const a1 = parseArgs(['--ui']);
    c.eq(a1.errors, [], '--ui 单独用不该报错（--profile 缺省 web）');
    c.eq(a1.options.profile, 'web', '--ui 时 profile 默认 web');
    const a2 = parseArgs(['--ui', '--apply']);
    c.ok(a2.errors.some((e) => e.includes('--apply')), '🔴 --ui 不许和 --apply 混用（页面不会替你装）');
    const a3 = parseArgs(['--ui', '--uninstall']);
    c.ok(a3.errors.some((e) => e.includes('--uninstall')), '🔴 --ui 不许和 --uninstall 混用');
    const a4 = parseArgs(['--profile', 'web', '--port', '45080']);
    c.ok(a4.errors.some((e) => e.includes('--port')), '--port 离开 --ui 就是误用，要报错');
    const a5 = parseArgs(['--ui', '--port', '99999']);
    c.ok(a5.errors.length > 0, '--port 越界要报错');
    const a6 = parseArgs(['--profile', 'web']);
    c.eq(a6.errors, [], '不给 --ui 时行为不变：只给 --profile 照旧');

    // 红线守卫：非环回地址要当场抛
    let threw = null;
    try {
      assertLoopbackHost('0.0.0.0');
    } catch (err) {
      threw = err;
    }
    c.ok(Boolean(threw), '🔴 传 0.0.0.0 必须当场抛（红线不是配置项）');
    c.eq(assertLoopbackHost(UI_HOST), UI_HOST, '127.0.0.1 要通过');
    c.eq(DEFAULT_UI_PORT, 45080, '默认端口要稳定（文档与夹具都写它）');
    c.eq(resolvePort(null), DEFAULT_UI_PORT, '🔴 不给 --port 时必须落到默认端口（实测踩过：落成了系统随机端口）');
    c.eq(resolvePort(undefined), DEFAULT_UI_PORT, 'undefined 同样走默认端口');
    c.eq(resolvePort(0), 0, '显式给 0 = 让系统挑，要尊重它');
    c.eq(resolvePort(8080), 8080, '显式端口照用');
    c.eq(routeOf('POST', '/').kind, 'method-not-allowed', '路由表函数：POST / = 405');
    c.eq(routeOf('GET', '/state').kind, 'state', '路由表函数：GET /state = 数据接口');

    // ── 1. 对照基线：--dry-run 文本 + 结构化 summary ───────────
    // runSuite 在 json 档把人读的输出写 stderr；夹具里把它静音，免得刷屏
    const savedStderrWrite = process.stderr.write;
    process.stderr.write = () => true;
    let dry;
    try {
      dry = await env.withPath(() => runSuite({ ...options }));
    } finally {
      process.stderr.write = savedStderrWrite;
    }
    c.eq(dry.exitCode, EXIT.OK, '演练档退出码 0');
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    const actual = `${normalize(dry.text, env.dir)}\n`;
    if (actual !== golden) {
      const a = actual.split('\n');
      const b = golden.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) { firstDiff = i; break; }
      }
      c.ok(false, `🔴 不给 --ui 时的演练输出必须与加 --ui 之前逐字节一致（首个差异在第 ${firstDiff + 1} 行：实际 ${JSON.stringify(a[firstDiff])} / 金标 ${JSON.stringify(b[firstDiff])}）`);
    } else {
      c.ok(true, '演练输出与金标逐字节一致');
    }

    // ── 2. 起服务 + 监听地址 ──────────────────────────────────
    started = await env.withPath(() => startUiServer({ options, port: 0 }));
    c.ok(started.ok === true, '向导页要能起来');
    const addr = started.server.address();
    c.eq(addr.address, '127.0.0.1', '🔴 监听地址必须就是 127.0.0.1');
    c.ok(addr.address !== '0.0.0.0' && addr.address !== '::', '🔴 绝不许 0.0.0.0 / ::（那是把本机服务摊到局域网）');
    c.eq(started.url, `http://127.0.0.1:${started.port}/`, '打印的地址要是实际监听地址');
    c.ok(!started.url.includes('0.0.0.0'), '打印的地址里不能出现 0.0.0.0');

    // ── 3. GET / = 200 且含清单表 ─────────────────────────────
    const built = await buildSuiteState(options);
    c.ok(built.ok === true, '同源状态要算得出来');
    const page = await request(started.port, 'GET', '/');
    c.eq(page.status, 200, 'GET / 必须 200');
    c.contains(String(page.headers['content-type']), 'text/html', 'GET / 是 HTML');
    c.contains(page.body, '<table', 'GET / 要含清单表');
    for (const item of built.state.items) {
      c.contains(page.body, escapeHtml(item.name), `表格里要有 ${item.name}`);
    }
    const toInstall = built.state.items.filter((i) => i.action === 'install');
    c.ok(toInstall.length === 2, `这一套假环境应有 2 项待装（实际 ${toInstall.length}）`);
    for (const item of toInstall) {
      c.contains(page.body, `data-command="${escapeHtml(item.command)}"`, `页面上「复制命令」里存的必须就是 ${item.command}`);
    }
    for (const item of built.state.items.filter((i) => i.action === 'skip')) {
      c.eq(item.command, null, `已满足的 ${item.name} 不该给出可复制命令（CLI 什么都不跑）`);
    }
    c.contains(page.body, '复制命令', '要有一列「复制命令」');
    c.contains(page.body, '重查', '要有一列「重查」');
    // 卡面要求每行写清 未装|已装：已装的那两项（plug-a / cli-b）必须渲染成"已装"，待装的渲染成"未装"
    for (const item of built.state.items) {
      // 一行 = 从 `<tr data-key="<包名>"` 起到下一个 `<tr` 之前（每个单元格各占一行，不能按行找）
      const chunks = page.body.split('<tr data-key=');
      const chunk = chunks.find((c) => c.startsWith(`"${escapeHtml(item.name)}"`)) || '';
      c.eq((chunk.match(/class="badge badge-(\w+)"/) || [])[1], item.installed ? 'ok' : 'bad', `${item.name} 的状态徽标要是"${item.installed ? '已装' : '未装'}"`);
    }
    const installedNames = built.state.items.filter((i) => i.installed).map((i) => i.name);
    c.eq(installedNames, ['@fake/plug-a', '@fake/cli-b'], '这套假环境里"已装"的就该是这两项');
    // 版本列：已装的要写实体版本，未装的写占位符
    for (const item of built.state.items) {
      c.contains(page.body, item.installed ? `data-field="version">${escapeHtml(item.installedVersion)}<` : 'data-field="version">—<', `${item.name} 的版本列要填对（${item.installed ? item.installedVersion : '—'}）`);
      c.contains(page.body, `data-field="range" title="${escapeHtml(item.rangeText)}">${escapeHtml(item.versionRange)}<`, `${item.name} 的期望区间列要写清单里的 ${item.versionRange}`);
    }
    c.contains(page.body, '>插件<', '类型列要有"插件"');
    c.contains(page.body, '>命令行<', '类型列要有"命令行"');
    c.contains(page.body, '建议顺序', '要写建议顺序');
    c.contains(page.body, '不是"必须的顺序"', '要明说这不是"必须的顺序"');
    c.notContains(page.body, '必须按', '🔴 不许写"必须按 1→2→3"这种假仪式');
    c.notContains(page.body, '才能成功', '🔴 同上：不许把建议顺序说成成功前提');
    c.contains(page.body, '组件之间没有代码依赖', '要给"为什么这么建议"的口径');

    // 0.3.0 起页面能装：对外文案必须同时说清「点了才装」与「装完要重启」（判据 4 的机读版）
    c.contains(page.body, '要重启 DSH，插件才会出现在侧边栏', '🔴 必须写明"装完要重启 DSH 才在侧边栏出现"（最容易被当成被骗）');
    c.contains(page.body, '不点确认，一条命令都不会跑', '要说清"点了才装、不点不装"');
    c.contains(page.body, '不装 DSH', '要说清本工具不装 DSH（前提摆在最上面）');
    c.contains(page.body, 'data-action="preview"', '要有【开始安装】按钮');
    c.contains(page.body, 'data-action="start"', '要有【确认，开始】按钮');
    c.contains(page.body, 'data-action="cancel"', '要有【取消】按钮');
    c.contains(page.body, 'data-action="rollback-uninstall"', '撤回动作 A【卸载这次装的】要在页面上');
    c.contains(page.body, 'data-action="rollback-restore"', '撤回动作 B【只恢复配置文件到装前】要在页面上');
    c.contains(page.body, '已取消，装了一半', '🔴 取消之后必须承认"装了一半"，不许假装干净');
    c.contains(page.body, 'node_modules', '撤回 B 的文案要说清"实体还在"');
    c.contains(page.body, '拒动', '撤回 B 的文案要说清"期间有别人改过就拒动"');
    c.notContains(page.body, '（只读）', '🔴 页面标题不许还写着"只读"');
    c.notContains(page.body, '不执行任何命令', '🔴 页面正文不许还写着"不执行任何命令"');

    // ── 4. GET /state 与 --dry-run 逐项对照 ───────────────────
    const stateRes = await request(started.port, 'GET', '/state');
    c.eq(stateRes.status, 200, 'GET /state 必须 200');
    c.contains(String(stateRes.headers['content-type']), 'application/json', 'GET /state 是 JSON');
    const state = JSON.parse(stateRes.body);
    c.eq(state.ok, true, 'state.ok 要 true');
    c.eq(state.items.length, built.state.items.length, '条目数要一致');
    c.eq(state.profile, 'fixture', 'profile 要对');
    c.eq(state.npmPrefix, env.npmPrefix, '全局包落点要对');
    c.eq(
      state.items.map((i) => ({ name: i.name, type: i.type, group: i.group, mount: i.mount, installedVersion: i.installedVersion, inRange: i.inRange, satisfied: i.satisfied, action: i.action })),
      dry.summary.items,
      '🔴 /state 的每项读数必须与 --dry-run 的 summary 逐项一致（同一个函数产出）',
    );
    for (const item of state.items) {
      const d = built.state.items.find((x) => x.name === item.name);
      if (item.action === 'install') {
        c.contains(dry.text, `  命令：${d.command}`, `演练文本里的命令要与 /state 给的 ${d.command} 一致`);
        c.contains(dry.text, `  判据：${d.criteria}`, `判据也要一致（${item.name}）`);
      } else {
        c.eq(d.command, null, `${item.name} 已满足 ⇒ /state 里 command 必须是 null`);
      }
    }
    // 状态文案只该有一份实现（lib/item-status.mjs）：服务端算好随 state 下发，页面只读不算
    for (const item of state.items) {
      c.ok(item.status && typeof item.status.text === 'string' && typeof item.status.cls === 'string',
        `🔴 /state 要带上算好的状态文案（${item.name}）—— 页面脚本不许自己再算一遍`);
      c.eq(item.status.text, item.installed ? '已装' : '未装', `${item.name} 的状态文案要与"装着没有"一致`);
      c.contains(page.body, `class="badge ${item.status.cls}">${item.status.text}<`, `${item.name} 的首屏徽标要跟 /state 下发的是同一份`);
    }
    c.contains(dry.text, `演练结束：将执行 ${state.counts.install} 条命令，跳过 ${state.counts.skip} 项（已满足）。`, '/state 的计数要与演练尾巴一致');
    c.contains(page.body, `data-count="install">${state.counts.install}<`, '页面的"待装 N"要与 /state 一致');

    // ── 5. 路由表：POST 只有白名单那四条，其余一律 405 ────────
    // 两半都要断：
    //   ① 白名单那四条**不再是 405**（没令牌先 403）—— 否则页面上的按钮永远点不动；
    //   ② 白名单之外**仍然 405** —— 放开写入口只放开这四条，别的一寸不让。
    for (const pathname of POST_PATHS) {
      const res = await request(started.port, 'POST', pathname, '{}');
      c.eq(res.status, 403, `🔴 POST ${pathname} 是白名单入口：没令牌要先 403（不是 405）`);
      c.contains(res.body, 'bad-token', `POST ${pathname} 没令牌的正文要说是令牌问题`);
    }
    for (const pathname of GET_PATHS) {
      const res = await request(started.port, 'POST', pathname, '{}');
      c.eq(res.status, 405, `POST ${pathname} 是读路径 ⇒ 405（读路径不提供写方法）`);
      c.eq(String(res.headers.allow || ''), 'GET', `POST ${pathname} 要带 Allow: GET`);
      c.contains(res.body, 'method-not-allowed', `POST ${pathname} 的正文要说明原因`);
    }
    // method, path, body, 期望的 Allow（按路径给，不再一刀切）
    const writeAttempts = [
      ['POST', '/', '{}', 'GET'],
      ['PUT', '/state', '{"x":1}', 'GET'],
      ['DELETE', '/', undefined, 'GET'],
      ['PATCH', '/state', '{}', 'GET'],
      ['OPTIONS', '/', undefined, 'GET'],
      ['HEAD', '/', undefined, 'GET'],
      ['POST', '/nope', '{}', 'GET'],
      ['PUT', '/install/start', '{}', 'POST'],
      ['DELETE', '/install/rollback', undefined, 'POST'],
    ];
    for (const [method, target, body, allow] of writeAttempts) {
      const res = await request(started.port, method, target, body);
      c.eq(res.status, 405, `🔴 ${method} ${target} 必须 405（写入口只有那四条）`);
      c.eq(String(res.headers.allow || ''), allow, `${method} ${target} 的 Allow 要按路径给：${allow}`);
      if (method !== 'HEAD') c.contains(res.body, 'method-not-allowed', `${method} ${target} 的正文要说明原因`);
    }
    const notFound = await request(started.port, 'GET', '/nope');
    c.eq(notFound.status, 404, 'GET 未知路径 = 404（不是 200，也不是 500）');

    // ── 6. 每请求零 spawn + 零写入 ───────────────────────────
    const homeBefore = fingerprint(env.home);
    const npmBefore = fingerprint(env.npmPrefix);
    const emptyPath = path.join(env.dir, 'empty-path');
    fs.mkdirSync(emptyPath, { recursive: true });
    const savedPath = process.env.PATH;
    let withEmptyPath = null;
    try {
      process.env.PATH = emptyPath;
      withEmptyPath = await request(started.port, 'GET', '/state');
    } finally {
      process.env.PATH = savedPath;
    }
    c.eq(withEmptyPath.status, 200, '🔴 把 PATH 清空后 /state 仍要能回答 ⇒ 处理请求的路径零 spawn');
    c.eq(JSON.parse(withEmptyPath.body).npmPrefix, env.npmPrefix, '全局前缀用的是启动时那次只读解析，不是每次重查都去问 npm');
    c.eq(fingerprint(env.home), homeBefore, '🔴 处理请求不许写数据根（指纹必须一模一样）');
    c.eq(fingerprint(env.npmPrefix), npmBefore, '🔴 处理请求不许写全局包目录');
    c.eq(fs.existsSync(path.join(env.home, 'butler-install')), false, '向导页不该拍快照、不该留下任何自己的状态');

    // ── 7. 端口冲突：自动换一个并如实说 ──────────────────────
    const holder = net.createServer((socket) => socket.end());
    const heldPort = await listen(holder, 0);
    let second = null;
    try {
      second = await env.withPath(() => startUiServer({ options, port: heldPort }));
      c.ok(second.port !== heldPort, '🔴 端口被占时必须自动换一个');
      c.eq(second.portChanged, true, '要如实标记"换过端口了"');
      c.contains(second.url, `:${second.port}/`, '打印的地址要用实际端口');
      const okState = await request(second.port, 'GET', '/state');
      c.eq(okState.status, 200, '换端口之后服务照常能回答');
    } finally {
      if (second) await second.close();
      await closeServer(holder);
    }

    await started.close();
    started = null;
  } finally {
    if (started) await started.close();
    env.cleanup();
  }
}
