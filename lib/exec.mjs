/**
 * 跑一条外部命令（只跑官方命令：`dsh plugin ...`、`npm ...`）。
 *
 * Windows 上的两个实测坑，这里一次兜住：
 *  1) `spawnSync('npm')` 直接 **ENOENT** —— `npm` 其实是 `npm.cmd` 壳，无 shell 解析不到；
 *  2) `spawnSync('npm.cmd')` 直接 **EINVAL** —— Node 18.20+ 拒绝在没有 shell 的情况下执行 .cmd。
 * 结论：在 Windows 上必须过 shell。为了不让参数被 shell 二次解释，这里对所有参数做
 * 最小必要引号化（只有含空格/特殊字符的参数才加引号），并且命令与参数分开维护 ——
 * 打印出来的命令行与真正执行的命令行是同一个函数生成的，报告里不会出现"说要跑 A、
 * 实际跑了 B"。
 */
import { spawn, spawnSync } from 'node:child_process';

const SAFE_ARG = /^[A-Za-z0-9@/._:+=,~^()-]+$/;

export function quoteArgForWindows(arg) {
  const s = String(arg);
  if (s.length > 0 && SAFE_ARG.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 生成"可打印也可执行"的命令行（Windows 走 shell，其它平台参数数组直传） */
export function formatCommandLine(file, args) {
  const parts = [file, ...args];
  if (process.platform === 'win32') return parts.map(quoteArgForWindows).join(' ');
  return parts.map((p) => (/^[A-Za-z0-9@/._:+=,~^-]+$/.test(String(p)) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`)).join(' ');
}

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
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, cmdline:string, error?:string}>}
 */
export function spawnCommand(file, args, options = {}) {
  const { timeoutMs = 120000, env = {}, cwd, onLine, quiet = false, signal } = options;
  const cmdline = formatCommandLine(file, args);

  // 已经取消过了就别起进程：起一个立刻杀一个既慢又会给用户看一个假的"正在装"
  if (signal && signal.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, cmdline, error: 'aborted-before-start' });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmdline, {
        shell: true,
        cwd,
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, cmdline, error: String(err && err.message ? err.message : err) });
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
      resolve(payload);
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
