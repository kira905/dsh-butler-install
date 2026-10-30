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
import { spawn } from 'node:child_process';

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

/**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, cmdline:string, error?:string}>}
 */
export function spawnCommand(file, args, options = {}) {
  const { timeoutMs = 120000, env = {}, cwd, onLine, quiet = false } = options;
  const cmdline = formatCommandLine(file, args);
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
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, cmdline, error: String(err && err.message ? err.message : err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, cmdline, error: String(err && err.message ? err.message : err) });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, cmdline });
    });
  });
}
