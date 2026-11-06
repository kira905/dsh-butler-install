/**
 * 跑一条外部命令（只跑官方命令：`dsh plugin ...`、`npm ...`）。
 *
 * 🔴 这里有一条**绝不能退回去**的口径（2026-11-06 实测修的，见
 * `docs\交付报告-桌面端适配与骨架装机实测-20261106.md` §3.3）：
 * **不许过 shell**。历史版本用 `spawn(cmdline, { shell: true })`，Windows 上等于走
 * `cmd.exe /c`，而 `^` 是 cmd 的转义符：
 *     cmd /c "echo @kira905/dsh-ops-toolkit@^0.1.0"   →   @kira905/dsh-ops-toolkit@0.1.0
 * 于是 `npm i -g <包>@^x.y.z` 静默退化成"精确钉死下界"，而装后自检只查"落在区间内"，
 * 下界当然在区间内 ⇒ 全绿但全是旧版。参数一旦过 shell 就不再是我们写下的那串。
 *
 * Windows 上又不能直接 spawn `.cmd`（Node 18.20+ 起 `spawnSync('npm.cmd')` 直接 EINVAL，
 * 见下），所以这里的做法是：**把 .cmd 壳解析成它真正要跑的那个可执行 + 参数**，
 * 然后用 `shell: false` 直接起进程 —— 参数原样交给进程，一个字都不经过 cmd。
 *
 *   npm.cmd          → node.exe  <...>\node_modules\npm\bin\npm-cli.js
 *   dsh.cmd          → node.exe  <...>\node_modules\@deepseek-ai\dsh\lib\bin.js
 *   桌面版 dsh.cmd   → "DeepSeek Harness.exe" --expose-internals <...>\dsh-desktop-host\lib\cli.js
 *                      （外加壳里 set 的环境变量，例如 ELECTRON_RUN_AS_NODE=1）
 *
 * 解析不出来才退回 `cmd.exe /d /s /c`，并且**必须**把参数里的 cmd 元字符（`^` `&` `|`）
 * 转义 —— 兜底可以慢，但不能静默改成另一条命令。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ARG = /^[A-Za-z0-9@/._:+=,~^()-]+$/;

export function quoteArgForWindows(arg) {
  const s = String(arg);
  if (s.length > 0 && SAFE_ARG.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 生成"可打印"的命令行。⚠️ 它只用于**展示给人看**；真正执行走 resolveCommand + 参数数组。 */
export function formatCommandLine(file, args) {
  const parts = [file, ...args];
  if (process.platform === 'win32') return parts.map(quoteArgForWindows).join(' ');
  return parts.map((p) => (/^[A-Za-z0-9@/._:+=,~^-]+$/.test(String(p)) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`)).join(' ');
}

/* ------------------------------------------------------------------ 找命令 */

const WIN_EXTS = ['', '.cmd', '.CMD', '.exe', '.EXE', '.bat', '.BAT', '.ps1', '.js'];

/**
 * 在 PATH 上找一个**能被 spawn 起来**的命令。
 *
 * 🔴 后缀顺序是有讲究的（2026-11-06 实测）：Windows 的 npm 全局目录里，同一个命令常常
 * 同时存在 `dsh`（给 bash 用的无扩展脚本）、`dsh.cmd`、`dsh.ps1`。按"无扩展优先"找，
 * 拿到的是那个 bash 脚本，spawn 必失败。所以这里显式按 exe → cmd → bat 排。
 * `.ps1` 不认：要另起 PowerShell 才能跑，不属于本工具的用法。
 */
export function findExecutableOnPath(cmd, { platform = process.platform, env = process.env } = {}) {
  const exts = platform === 'win32' ? ['.exe', '.EXE', '.cmd', '.CMD', '.bat', '.BAT'] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${cmd}${ext}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
      } catch {
        /* 权限/竞态一律跳过，PATH 扫描不该抛 */
      }
    }
  }
  return null;
}

/** 在 PATH 上找一个命令（只查文件存在，不执行；Windows 按常见后缀补壳） */
export function findOnPath(cmd, { platform = process.platform, env = process.env } = {}) {
  const exts = platform === 'win32' ? WIN_EXTS : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${cmd}${ext}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
      } catch {
        /* 权限/竞态一律跳过，PATH 扫描不该抛 */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------- .cmd / .bat 壳解析 */

/** `set "NAME=value"`（含大小写混杂的 SET） */
const SET_RE = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?\s*$/i;

/** `%~dp0` 自带尾部分隔符，拼完会出现 `\\`；绝对路径统一过一遍 path.normalize（展示与 spawn 都干净） */
function tidyPathToken(token) {
  const t = String(token);
  if (!/[\\/]/.test(t)) return t;
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\')) return path.normalize(t);
  return t;
}

/** 壳内部的局部变量（`_prog` / `NODE_EXE` / `PATHEXT` …）不该漏进子进程的环境 */
const SHIM_INTERNAL_VARS = new Set(['_prog', 'node_exe', 'pathext', 'dp0', 'comspec']);

function tokenizeCmdLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < line.length && line[j] !== '"') { buf += line[j]; j += 1; }
      tokens.push(buf);
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j += 1;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/**
 * 读一个 .cmd/.bat 壳，抽出「它到底会起什么进程」。
 *
 * 只认结构清晰的三类（npm/pnpm 生成的 shim、桌面版自带 shim 都属于这三类）：
 *   ① `"<prog>" "<script>.js" %*`（prog 可能是个变量，如 %_prog%）
 *   ② `node "<script>.js" %*`
 *   ③ `"<...>.exe" <args...> "<...>.js" %*`（桌面版：先 set 环境变量再起 Electron）
 *
 * @returns {{file:string, args:string[], env:Object, via:string, problem?:string}}
 */
export function parseWindowsShim(shimFile) {
  let text;
  try {
    text = fs.readFileSync(shimFile, 'utf8');
  } catch (err) {
    return { file: '', args: [], env: {}, via: 'shim-error', problem: `读不到壳文件 ${shimFile}（${err.code || err.message}）` };
  }
  const dir = path.dirname(shimFile);
  const vars = new Map();
  const setVars = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = SET_RE.exec(rawLine);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const value = m[2].trim();
    setVars.push({ name, value });
    if (!vars.has(name)) vars.set(name, []);
    vars.get(name).push(value);
  }

  const expand = (token) => String(token)
    .replace(/%~?dp0%?/gi, `${dir}${path.sep}`)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
      const list = vars.get(String(name).toLowerCase());
      if (!list) return whole;
      for (const v of list) {
        const expanded = expandOnce(v, dir, vars);
        if (expanded && fs.existsSync(expanded)) return expanded;
      }
      return expandOnce(list[list.length - 1], dir, vars);
    });

  // 执行行 = 最后一行带 %* 的（npm.cmd 里前面几行也可能出现 %*，最后那行才是真调用）
  const execLines = text.split(/\r?\n/).filter((l) => l.includes('%*'));
  if (!execLines.length) {
    return { file: '', args: [], env: {}, via: 'shim-no-exec', problem: `${path.basename(shimFile)} 里找不到带 %* 的执行行` };
  }
  // npm.cmd 的执行行是 `endLocal & goto ... || title %COMSPEC% & "<prog>" "<script>" %*`
  const pieces = execLines[execLines.length - 1].split('&');
  const callPiece = pieces.find((p) => p.includes('%*')) || execLines[execLines.length - 1];
  const tokens = tokenizeCmdLine(callPiece.replace(/%\*/g, ' '))
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) {
    return { file: '', args: [], env: {}, via: 'shim-empty', problem: `${path.basename(shimFile)} 的执行行里没有可执行命令` };
  }

  // `endLocal` / `title` 这类 cmd 内建可能在同一个 & 段里，先剥掉
  const BUILTINS = new Set(['endlocal', 'setlocal', 'title', 'echo', 'call', 'goto', 'if', 'exit']);
  while (tokens.length && BUILTINS.has(tokens[0].toLowerCase())) tokens.shift();
  if (!tokens.length) {
    return { file: '', args: [], env: {}, via: 'shim-builtin', problem: `${path.basename(shimFile)} 的执行行只有 cmd 内建命令` };
  }

  const headRaw = tokens.shift();
  const head = tidyPathToken(expand(headRaw));
  let file = head;
  if (!path.isAbsolute(file)) {
    // 壳里写的 `node` / `node.exe`：先用壳目录（npm 的 shim 会优先用自带的 node.exe），
    // 再用 PATH，最后用跑本工具的这个 node。
    const local = path.join(dir, file);
    if (fs.existsSync(local)) file = local;
    else file = findExecutableOnPath(file) || '';
  }
  if (!file || !fs.existsSync(file)) {
    return { file: '', args: [], env: {}, via: 'shim-unresolved', problem: `${path.basename(shimFile)} 里的可执行解析不到（读到 ${JSON.stringify(headRaw)}）` };
  }

  const args = tokens.map((t) => tidyPathToken(expand(t)));
  const env = {};
  for (const { name, value } of setVars) {
    // 只收"静态赋值"（不含 % 变量的），例如桌面版壳里的 ELECTRON_RUN_AS_NODE=1；
    // 壳自己的局部变量（_prog / NODE_EXE …）必须滤掉，否则会污染子进程环境。
    if (/%/.test(value)) continue;
    if (name.startsWith('_') || SHIM_INTERNAL_VARS.has(name)) continue;
    env[name.toUpperCase()] = value;
  }
  return { file, args, env, via: 'shim-parsed' };
}

function expandOnce(value, dir, vars) {
  return String(value)
    .replace(/%~?dp0%?/gi, `${dir}${path.sep}`)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
      const list = vars.get(String(name).toLowerCase());
      return list ? list[0] : whole;
    });
}

/* ------------------------------------------------------------- 命令解析入口 */

/**
 * 把一个"命令名或路径"解析成可以直接 spawn 的 { file, argsPrefix, env, via }。
 *
 * - Windows：`.cmd/.bat` 走壳解析；`.exe` 直接用；裸名字先找 PATH。
 * - 其它平台：原样直传（本来就不需要 shell）。
 *
 * @param {string} command
 * @param {object} [opts] { platform, env, allowCmdFallback }
 */
export function resolveCommand(command, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const base = { file: command, argsPrefix: [], env: {}, via: 'direct', command, problem: '' };
  if (platform !== 'win32') return base;

  let file = String(command);
  const looksLikePath = /[\\/]/.test(file);
  if (!looksLikePath) {
    const found = findExecutableOnPath(file, { platform, env });
    if (!found) {
      // 让 spawn 自己去报 ENOENT：这里不改写命令，但把话说清楚
      return { ...base, via: 'not-found', problem: `PATH 上找不到 ${file}` };
    }
    file = found;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const shim = parseWindowsShim(file);
    if (shim.via === 'shim-parsed') {
      return { file: shim.file, argsPrefix: shim.args, env: shim.env, via: 'shim', command, shim: file, problem: '' };
    }
    return {
      file: opts.comspec || env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', buildCmdLineWithEscapes(file, [])],
      env: {},
      via: 'cmd-fallback',
      command,
      shim: file,
      problem: shim.problem || '',
      cmdFallback: true,
    };
  }
  return { ...base, file, via: 'direct-file' };
}

/**
 * cmd 兜底用：把参数按 cmd 的规则转义后再拼成一行。
 *
 * 🔴 层数是实测出来的（2026-11-06，连测两轮）：
 *   - `cmd /c <bat> x^y`    → bat 里 `%*` 收到 `xy`（第一层就吃了）
 *   - `cmd /c <bat> x^^y`   → 还是 `xy`（第二层又吃了一次）
 *   - `cmd /c <bat> x^^^^y` → `x^y` ✅
 *   因为参数要过**两层**解析（`cmd /c` 那一行 + 批处理自己的 `%*` 展开），`^` 要写四个。
 *   - **加了引号**时 cmd 不再把 `^` 当转义符 —— 这时一个都不该加（加了多少就原样多出多少）。
 * 这个兜底只在 `.cmd` 壳解析不出来时才走；含 `&`/`|`/`"` 的参数一律不承诺（那类不该出现在
 * 我们这条调用链里 —— 我们只传包名、版本区间、`-g`、`--profile`、profile 名）。
 */
export function escapeForCmd(arg) {
  const s = String(arg);
  if (/[\s()]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s.replace(/\^/g, '^^^^');
}

export function buildCmdLineWithEscapes(file, args) {
  return [file, ...args].map(escapeForCmd).join(' ');
}

/* ------------------------------------------------------------------ 杀进程 */

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // 只针对我们自己起的子进程树；不带 /T 会留下一半还在写盘的 pnpm
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch {
    /* 杀不掉不掩埋：调用方会按超时判失败 */
  }
}

/** 当前还活着的子进程 pid（只记我们自己 spawn 的；进程退出时要靠它把树杀干净） */
const liveChildren = new Set();

export function runningChildPids() {
  return [...liveChildren];
}

/** 退出钩子专用：把还在跑的子进程树**同步**杀一遍，返回杀了几棵 */
export function killAllRunningSync() {
  let killed = 0;
  for (const pid of liveChildren) {
    if (killTreeSync(pid)) killed += 1;
  }
  liveChildren.clear();
  return killed;
}

/**
 * 同步版杀进程树 —— **只给退出钩子用**。
 *
 * 为什么非要有这一份：`killTree()` 走的是**异步** `spawn`，而 Node 的 `process.on('exit')`
 * 里只能跑同步代码。于是"Ctrl+C 不留孤儿 npm"如果用异步版，会有两种假象之一：
 * 要么钩子跑完异步 spawn 还没被执行（进程已经没了），要么子进程被杀了一半。
 * 实测结论：退出钩子必须同步 —— 这里用 `spawnSync('taskkill', …)`。
 *
 * ⚠️ `/T` 在这里是对的：它只针对**我们自己起的**那棵子进程树。
 * 与"杀 dsh 不能带 /T（会连坐守护鱼）"是两件不同的事，别把结论搬过去。
 */
export function killTreeSync(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return res && res.status === 0;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    return true;
  } catch {
    return false;
  }
}

/** 取消之后最多再等这么久就把它当成"已停"（子进程被杀但不发 close 的兜底） */
const ABORT_SETTLE_MS = 3000;

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 单步超时（到点按超时处理，走 killTree）
 * @param {AbortSignal} [options.signal] 外部取消。**不传 ⇒ 行为与加这个参数之前一模一样**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, cmdline:string, error?:string, resolved?:object}>}
 */
export function spawnCommand(file, args, options = {}) {
  const { timeoutMs = 120000, env = {}, cwd, onLine, quiet = false, signal } = options;
  const cmdline = formatCommandLine(file, args);

  // 已经取消过了就别起进程：起一个立刻杀一个既慢又会给用户看一个假的"正在装"
  if (signal && signal.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, cmdline, error: 'aborted-before-start' });
  }

  const mergedEnv = { ...process.env, ...env };
  const resolved = resolveCommand(file, { env: mergedEnv });
  // 兜底路径：.cmd 壳解析不出来才走 cmd.exe，此时必须自己把参数转义进那一行
  const spawnFile = resolved.file;
  const spawnArgs = resolved.cmdFallback
    ? [...resolved.argsPrefix.slice(0, 3), buildCmdLineWithEscapes(resolved.shim || file, args)]
    : [...resolved.argsPrefix, ...args];
  const spawnEnv = { ...mergedEnv, ...resolved.env };
  const diagnostics = {
    command: resolved.command,
    via: resolved.via,
    file: spawnFile,
    argsPrefix: resolved.argsPrefix,
    shim: resolved.shim || null,
    problem: resolved.problem || '',
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spawnFile, spawnArgs, {
        shell: false,
        cwd,
        windowsHide: true,
        env: spawnEnv,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, cmdline, resolved: diagnostics, error: String(err && err.message ? err.message : err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let abortSettleTimer = null;
    let timer = null;
    // 登记在册：进程退出时（Ctrl+C / 关 .cmd 窗口）要靠这份名册把子进程树同步杀掉，
    // 否则页面停了、npm 还在改 profile（方案 R2）
    if (child.pid) liveChildren.add(child.pid);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (child.pid) liveChildren.delete(child.pid);
      if (timer) clearTimeout(timer);
      if (abortSettleTimer) clearTimeout(abortSettleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ...payload, resolved: diagnostics });
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    // 取消与超时走**同一个** killTree 分支：都是"这条命令不能算成功"，只是原因不同
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killTree(child.pid);
      // 子进程被杀之后 close 一般很快就来；万一来不了，也不能让"取消中…"永远挂着
      abortSettleTimer = setTimeout(() => {
        finish({ code: null, stdout, stderr, timedOut, aborted, cmdline });
      }, ABORT_SETTLE_MS);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const pump = (stream, into) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (into === 'out') stdout += text; else stderr += text;
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        if (!quiet && typeof onLine === 'function') {
          for (const line of lines) if (line.trim()) onLine(line);
        }
      });
      stream.on('end', () => {
        if (!quiet && typeof onLine === 'function' && buffer.trim()) onLine(buffer);
      });
    };
    if (child.stdout) pump(child.stdout, 'out');
    if (child.stderr) pump(child.stderr, 'err');

    child.on('error', (err) => {
      finish({ code: null, stdout, stderr, timedOut, aborted, cmdline, error: String(err && err.message ? err.message : err) });
    });

    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut, aborted, cmdline });
    });
  });
}
