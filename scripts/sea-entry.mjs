#!/usr/bin/env node
/**
 * **exe 的运行时入口**（不是 npm 包的一部分，也不进 `files`）。
 *
 * 谁在用它：`scripts/build-exe.mjs` 用 esbuild 把这个文件连同 `lib/` 打成单文件 CJS，
 * 再走 Node SEA（node --experimental-sea-config + postject）注入进一份 node.exe 副本。
 * 于是用户拿到的是 **一个 exe**：双击 → 出控制台 + 自动弹浏览器 → 页面是那套安装向导。
 *
 * 与 `bin/install-ui.mjs`（npm 版双击入口）的分工，改之前先看一眼：
 *  · npm 版 = 给会敲命令的人：`npx` 下来、探端口、开浏览器，出问题看得到终端里的字。
 *  · exe 版 = 给完全不会命令的人：**先体检**（dsh / npm 在不在），不在就用大字说清楚并停住
 *    （双击出来的窗口一闪就没，是最劝退的失败方式）；探到已有向导页就直接开第二个标签；
 *    关窗口 = 真的收工（子进程树一起杀掉，不然 npm 会在后台继续改 profile）。
 *
 * 复用关系（刻意不复制实现）：
 *  · 探测 / 开浏览器 → `lib/ui-probe.mjs`（`bin/install-ui.mjs` 也 re-export 同一份）
 *  · 起服务 / 退出钩子 → `lib/ui-server.mjs`
 *  · 参数解析 → `lib/cli-args.mjs`（exe 只开放 `--help` / `--version` / `--port`）
 *
 * 单文件自足（方案硬要求）：**不读 exe 旁边的任何文件**。
 *  · 界面 HTML 本来就在 `lib/ui-page.mjs` 里是字符串（零外部资源）；
 *  · 清单 `suite-manifest.json` 由 SEA asset 内嵌，下面 patch `fs.readFileSync` 把它喂给 `loadManifest()`
 *    —— 否则 exe 会去 `<exe 所在目录>\..\suite-manifest.json` 找，拷到空目录就废了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { parseArgs, EXIT } from '../lib/cli-args.mjs';
import { probeExistingUi, openBrowser } from '../lib/ui-probe.mjs';
import { startUiServer, resolvePort, installExitHooks } from '../lib/ui-server.mjs';
import { killAllRunningSync } from '../lib/exec.mjs';

/* global __DSH_INSTALL_EXE_VERSION__ */
/** 由 build-exe.mjs 的 esbuild define 注入；直接用 node 跑这个文件时是 dev */
const EXE_VERSION = typeof __DSH_INSTALL_EXE_VERSION__ === 'string' ? __DSH_INSTALL_EXE_VERSION__ : 'dev';

const MANIFEST_ASSET_NAME = 'suite-manifest.json';
const EXE_TITLE = 'DSH 管家套装 · 安装向导';

const EXIT_PREREQ = EXIT.USAGE; // 2：前提不满足（没 dsh / 没 npm）—— 与参数错误同码，都是"人得先去干点别的"

/** 停住的判据：真双击（stdin 是终端）才等回车；管道/重定向时直接走，免得自动化卡死 */
function shouldPause() {
  if (process.env.DSH_INSTALL_EXE_NO_PAUSE === '1') return false;
  if (process.env.DSH_INSTALL_EXE_PAUSE === '1') return true; // 夹具用：强制停住，证明"不是闪退"
  return Boolean(process.stdin.isTTY);
}

/**
 * 停住等用户按键（"别让窗口一闪就没"）。
 *
 * 为什么用 cmd 的 `pause >nul` 而不是在 Node 里听 `process.stdin` 的 data：
 *  双击场景里窗口的 stdin 是控制台，在 SEA 打包出来的 exe 里靠 Node 的 stdin 事件等按键
 *  **实测收不到数据**（夹具里往管道写换行，进程不醒；同一段逻辑纯 node 跑是正常的）。
 *  `pause` 是 cmd 内置、直接吃控制台输入，语义就是"等一个键"，比我们猜 Node 的流状态可靠得多。
 *  非 TTY（管道/重定向）时不调它 —— 否则自动化会卡在一个没人按的键上。
 */
function waitForKey() {
  if (process.platform !== 'win32') {
    // 本 exe 只发 Windows；留着这条是为了别人在别的平台上跑同一份源码时不至于卡死
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          stdin.pause();
        } catch {
          /* 关不上就算了 */
        }
        resolve();
      };
      try {
        stdin.resume();
        stdin.once('data', finish);
        stdin.once('end', finish);
        stdin.once('error', finish);
      } catch {
        finish();
      }
    });
  }
  return new Promise((resolve) => {
    try {
      spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pause >nul'], {
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
      });
    } catch {
      /* 起不来就当用户已经按过了 */
    }
    resolve();
  });
}

const requireModule = createRequire(import.meta.url);

/** SEA 里把内嵌的清单喂给 `loadManifest()`：只兜"读一份叫 suite-manifest.json 的文本"这一种用法 */
function installManifestAsset() {
  let sea = null;
  try {
    sea = requireModule('node:sea');
  } catch {
    return false;
  }
  if (!sea || typeof sea.isSea !== 'function' || !sea.isSea()) return false;
  let text = null;
  try {
    text = sea.getAsset(MANIFEST_ASSET_NAME, 'utf8');
  } catch {
    return false;
  }
  if (typeof text !== 'string' || !text.trim()) return false;

  const original = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(file, options) {
    if (typeof file === 'string' && file.endsWith(MANIFEST_ASSET_NAME)) {
      const wantsText = options === undefined
        || options === 'utf8'
        || options === 'utf-8'
        || (options && typeof options === 'object' && options.encoding);
      if (wantsText) return text;
    }
    return original.apply(this, arguments);
  };
  return true;
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function banner() {
  line('');
  line('  ============================================================');
  line(`   ${EXE_TITLE}`);
  line('  ============================================================');
  line('');
}

/** 跑一个命令、只读地拿退出码与输出（体检用；超时短，别让窗口卡住） */
function runQuiet(file, args, { timeoutMs = 20000 } = {}) {
  try {
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
    if (result.error) return { ok: false, code: null, out: '', reason: String(result.error.code || result.error.message) };
    return {
      ok: result.status === 0,
      code: result.status,
      out: `${result.stdout || ''}`.trim(),
      reason: `${result.stderr || ''}`.trim(),
    };
  } catch (err) {
    return { ok: false, code: null, out: '', reason: String(err && err.message ? err.message : err) };
  }
}

/** 跑 `<cmd> --version`：Windows 上走 `cmd /d /s /c`，因为 npm 装出来的是 .cmd 壳 */
function versionOf(command, args = ['--version']) {
  if (process.platform === 'win32') {
    return runQuiet('cmd', ['/d', '/s', '/c', `${command} ${args.join(' ')}`]);
  }
  return runQuiet(command, args);
}

/** `where <name>` 只为了把路径说给用户听；判据永远是"命令真能跑起来" */
function locate(command) {
  if (process.platform === 'win32') {
    const found = runQuiet('where', [command]);
    if (found.ok && found.out) return found.out.split(/\r?\n/).filter(Boolean)[0] || '';
    return '';
  }
  const found = runQuiet('sh', ['-c', `command -v ${command}`]);
  return found.ok ? found.out.split(/\r?\n/).filter(Boolean)[0] || '' : '';
}

function firstLine(text, max = 80) {
  const line0 = `${text || ''}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  return line0.length > max ? `${line0.slice(0, max)}…` : line0;
}

/** 体检：dsh 与 npm 都得能跑。返回 {ok, missing:'dsh'|'npm'|null, detail} */
function checkPrerequisites(log) {
  log('[1/3] 看看这台电脑上装没装 DSH …');
  const dshWhere = locate('dsh');
  const dshVersion = versionOf('dsh');
  if (!dshVersion.ok) {
    return { ok: false, missing: 'dsh', detail: firstLine(dshVersion.reason) };
  }
  log(`      ✔ DSH ${firstLine(dshVersion.out) || '(版本号没打印，但能跑)'}${dshWhere ? `  ← ${dshWhere}` : ''}`);

  log('[2/3] 看看 npm 在不在 …');
  const npmWhere = locate('npm');
  const npmVersion = versionOf('npm');
  if (!npmVersion.ok) {
    return { ok: false, missing: 'npm', detail: firstLine(npmVersion.reason) };
  }
  log(`      ✔ npm ${firstLine(npmVersion.out)}${npmWhere ? `  ← ${npmWhere}` : ''}`);
  return { ok: true, missing: null, detail: '' };
}

function printMissingDsh() {
  line('');
  line('  ============================================================');
  line('   ✖ 这台电脑上还没装 DSH');
  line('  ============================================================');
  line('');
  line('  这个 exe 只负责打开「安装界面」，它不会替你装 DSH 本身。');
  line('  先把 DSH 装好，再回来双击这个 exe。装 DSH 只要一行（在 PowerShell 里跑）：');
  line('');
  line('        npm i -g @deepseek-ai/dsh');
  line('');
  line('  看不懂上面这行？那就先装 Node.js（22 或更新版本，npm 会一起装好）：');
  line('        https://nodejs.org/');
  line('  装完重新打开一个 PowerShell 窗口，再跑上面那行 npm 命令。');
  line('');
  line('  想确认装好了：敲  dsh --version  能打出版本号就对了。');
  line('');
}

function printMissingNpm(detail) {
  line('');
  line('  ============================================================');
  line('   ✖ 这台电脑上没有 npm（装插件要用它）');
  line('  ============================================================');
  line('');
  line('  安装界面里装插件时会调用 npm，没有它装不了。');
  line('  装 Node.js（22 或更新版本）就会把 npm 一起装好：');
  line('        https://nodejs.org/');
  line('');
  if (detail) line(`  （系统说：${detail}）`);
  line('  装完重开一个窗口，再双击这个 exe。');
  line('');
}

function printExeHelp() {
  banner();
  line('  怎么用：直接双击这个 exe，不用参数。');
  line('          它会检查环境、起本地向导页、并自动打开浏览器。');
  line('');
  line('  可选参数（一般用不到）：');
  line('    --port <端口>   换一个端口（默认 45080，被占会自动往后挑）');
  line('    --version       看这个 exe 的版本');
  line('    --help          看这份说明');
  line('');
  line('  它不会装 DSH 本身：这台电脑上得先有 dsh 和 npm。');
  line('');
}

/**
 * 主体。返回退出码。
 * @param {object} io
 * @param {string[]} io.argv
 * @param {(s:string)=>void} io.log
 * @param {(url:string)=>boolean} io.open
 * @param {Function} io.startServer
 * @param {boolean} io.waitForShutdown  夹具传 false（不然会一直挂着）
 */
export async function runExe({
  argv = process.argv.slice(2),
  log = (text) => process.stdout.write(`${text}\n`),
  open = openBrowser,
  startServer = startUiServer,
  waitForShutdown = true,
} = {}) {
  const hasManifestAsset = installManifestAsset();

  // 先解析参数：`--help` / `--version` 不该被"没装 DSH"挡住
  const { options, errors } = parseArgs(['--ui', ...argv]);
  if (options.help) {
    printExeHelp();
    return EXIT.OK;
  }
  if (options.version) {
    log(`dsh-butler-install ${EXE_VERSION}（exe 版）`);
    return EXIT.OK;
  }
  if (errors.length) {
    for (const e of errors) log(`✖ ${e}`);
    log('用 --help 看可用参数（这个小窗口只认 --port / --version / --help）。');
    return EXIT.USAGE;
  }

  banner();

  // ── ① 环境体检 ───────────────────────────────────────────────
  const check = checkPrerequisites(log);
  if (!check.ok) {
    if (check.missing === 'dsh') printMissingDsh();
    else printMissingNpm(check.detail);
    line('  ------------------------------------------------------------');
    line('  按任意键关闭这个窗口。');
    if (waitForShutdown && shouldPause()) await waitForKey();
    return EXIT_PREREQ;
  }
  log('[3/3] 环境齐了，准备打开安装界面 …');
  line('');

  const port = resolvePort(options.uiPort);

  // ── ② 已经有向导页在跑？直接把浏览器指过去（双击两次 = 两个标签看同一个服务）──
  if (port > 0) {
    const found = await probeExistingUi({ port });
    if (found.ok) {
      line(`  已经有一个安装界面在跑了（${found.url}）——不再起第二个，直接把浏览器指过去。`);
      line('  两个窗口看的是同一个服务，不会同时对同一个 profile 装两遍。');
      open(found.url);
      line('');
      line('  这个黑窗口可以关掉，界面不会跟着关（它是另一个进程）。');
      if (waitForShutdown && shouldPause()) await waitForKey();
      return EXIT.OK;
    }
  }

  // ── ③ 起界面 ─────────────────────────────────────────────────
  const started = await startServer({ options, port: options.uiPort });
  if (!started.ok) {
    for (const text of started.log || []) log(`${text}`);
    line('');
    line('  ✖ 安装界面没能起来（具体原因见上面几行）。');
    line('    常见原因：清单读不到 / 端口全被占。把这个窗口的内容截给作者看。');
    line('  ------------------------------------------------------------');
    line('  按任意键关闭这个窗口。');
    if (waitForShutdown && shouldPause()) await waitForKey();
    return started.exitCode || EXIT.UNCLEAN;
  }
  if (started.portChanged) {
    line(`  ⚠ 端口 ${started.requestedPort} 被别的程序占了，已经改用 ${started.port}`);
  }

  // 退出钩子：Ctrl+C / 关窗口 / 进程退出时，把还在跑的子进程树一起杀掉
  // （不然"界面停了、npm 还在后台改 profile"）
  installExitHooks({ out: { write: (s) => process.stdout.write(s) } });

  line(`  安装界面已经起来了：${started.url}`);
  line(`  浏览器正在打开（没弹出来就把上面这行地址复制到浏览器里）。`);
  line('');
  line('  · 只绑本机 127.0.0.1：同一局域网的别的机器连不上');
  line('  · 页面上点了【确认，开始】才会真装，不点不装');
  line('  · 这个黑窗口别关：关了界面就停了（装到一半关掉，正在跑的命令会被一起杀掉）');
  line('  · 收工就直接关这个窗口（或者 Ctrl+C）');
  line('');
  open(started.url);

  if (!waitForShutdown) {
    return EXIT.OK;
  }

  // ── ④ 关窗即收工 ─────────────────────────────────────────────
  await new Promise((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    process.once('SIGBREAK', done); // Windows：Ctrl+Break
    process.once('SIGHUP', done); // Windows：直接点窗口的 × 时由 Node 映射过来
  });
  killAllRunningSync();
  try {
    await started.close();
  } catch {
    /* 关不上就算了，进程本来就要走 */
  }
  line('');
  line('  安装界面已关。');
  return EXIT.OK;
}

// 只在 exe（SEA）里自跑；被 esbuild 打包时这里就是真正的入口。
// 为什么不用 isMain() 那套：SEA 里 `import.meta.url`/`argv[1]` 都不指向这个文件，
// 而且这个入口本来就是"只跑一次"的 —— 直接跑。
if (process.env.DSH_INSTALL_EXE_IMPORT_ONLY !== '1') {
  // 夹具用：不真开浏览器（否则每跑一次就多一个标签页）
  const open = process.env.DSH_INSTALL_EXE_NO_BROWSER === '1' ? () => false : openBrowser;
  runExe({ open }).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    line('');
    line(`  ✖ 出了个意料之外的错：${err && err.message ? err.message : err}`);
    line('  ------------------------------------------------------------');
    line('  按任意键关闭这个窗口。');
    const finish = () => {
      process.exitCode = EXIT.UNCLEAN;
    };
    if (shouldPause()) waitForKey().then(finish, finish);
    else finish();
  });
}
