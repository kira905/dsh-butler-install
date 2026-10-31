/**
 * 把「环境障碍」翻成人话 —— 只给展示用，**不参与任何判据**。
 *
 * 为什么要有这一层：真装验收里撞到过两类拦路虎，安装器原来只甩一段英文原文，
 * 用户看不出"这到底是包坏了、网络坏了、还是我自己的机器拦了它"。
 *
 * 三条硬边界（改这个文件之前先读一遍）：
 *  1. **纯函数**：不 spawn 子进程、不读盘、不发网络请求、不打日志。传什么进来看什么。
 *  2. 认不出就返回 `null` —— 宁可不说，也不许瞎猜。猜错比不说更糟：
 *     用户会照着错的"怎么办"去改机器。
 *  3. 只做**追加**：调用方必须先原样打印原始 stderr，归因永远排在它后面。
 *     本文件不认识退出码语义，也不允许谁拿 `kind` 当判据（0/2/3/4 一个不动）。
 *
 * 两类签名的真实出处（都来自真跑，不是编的）：
 *  - `blocked-symlink`：Windows 上 360 / EDR 拦 pnpm 建符号链接，pnpm 栈里落在 registerProject
 *  - `store-mismatch`：pnpm store 与已有 node_modules 不是同一处（不同盘 / 换过数据根）
 */

/** 认得出来的码：`ERR_PNPM_UNEXPECTED_STORE` 最精确，先认它 */
const CODE_STORE_MISMATCH = 'ERR_PNPM_UNEXPECTED_STORE';
/** pnpm 所有自己的错误码都是这个前缀（认得出"是 pnpm 的错"，但具体含义未必收录） */
const ANY_PNPM_CODE = /\bERR_PNPM_[A-Z0-9_]+\b/;

function splitLines(text) {
  return String(text || '').split(/\r?\n/);
}

/**
 * 解释一次 pnpm（或经 pnpm 的 `dsh plugin`）失败。
 *
 * @param {{stderr?: string, stdout?: string}} [input] 两个流任一命中都算
 * @returns {{kind: string, code: string|null, title: string, why: string, fix: string}|null}
 */
export function explainPnpmFailure({ stderr, stdout } = {}) {
  const errText = String(stderr || '');
  const outText = String(stdout || '');
  const text = `${errText}\n${outText}`;
  if (!text.trim()) return null;
  const lines = splitLines(text);

  // ① store 与已有 node_modules 不是同一处：码是本工具最精确的指纹，先认它。
  //    先于 blocked-symlink 判：两者万一同时出现，"要你用回原来那处 store"这句更可执行。
  if (text.includes(CODE_STORE_MISMATCH)) {
    return {
      kind: 'store-mismatch',
      code: CODE_STORE_MISMATCH,
      title: '这个 profile 的 node_modules 是用另一处 pnpm store 装的，pnpm 现在想用新的那处，两边对不上。',
      why: 'pnpm 在 node_modules 里记着"我是从哪个 store 链过来的"；发现要用的 store 不是同一条就停手，'
        + '免得把已装依赖的链接链断掉。这条不是包坏了，也不是网络问题。',
      fix: '① 让 pnpm 用回原来那处（pnpm config set store-dir <上面报的那个 store>）'
        + '  ② 或者就在那个 profile 里重装依赖（pnpm install，让 pnpm 按新 store 重链一遍）'
        + '  ③ 换一个干净的数据根（--home 指到一个空目录）',
    };
  }

  // ② 安全软件拦符号链接。判据两条，任一命中：
  //    a) 某一行里同时出现 EPERM 与 symlink（pnpm 的原样报错就长这样）
  //    b) 栈里出现 registerProject（pnpm「给这个 project 登记 store 链接」那一步被拦）
  const epermSymlink = lines.some((l) => /\bEPERM\b/.test(l) && /symlink/i.test(l));
  const registerProject = /registerProject/.test(text);
  if (epermSymlink || registerProject) {
    return {
      kind: 'blocked-symlink',
      code: epermSymlink ? 'EPERM' : null,
      title: '这不是包坏了：你的安全软件（360 / EDR）拦了 pnpm 往 store 里建符号链接。',
      why: 'pnpm 靠"store 里存一份真文件、各 profile 只放符号链接"来省空间；建链接这一步会被安全软件当成可疑动作拦掉。'
        + '这类拦截是间歇出现的 —— 同一条命令重试一次可能就过了。',
      fix: '① 在安全软件里给 pnpm / node 放行（或暂时退出）'
        + '  ② 换个不会被拦的位置做数据根（--home 指到别处）'
        + '  ③ 直接重试一次（这类拦截是间歇的）',
    };
  }

  // ③ 认得出是 pnpm 自己的错，但这条码没收录 ⇒ 给原码 + 让用户把原文带走。
  //    注意：这里**不**猜原因 —— 只说"是 pnpm 这一层报的，怎么修得看这个码"。
  const anyCode = text.match(ANY_PNPM_CODE);
  if (anyCode) {
    const code = anyCode[0];
    return {
      kind: 'unknown-pnpm',
      code,
      title: `pnpm 自己报的错（${code}），这条码本工具还没收录。`,
      why: '能确定是 pnpm 这一层的错（不是本工具的判据失败，也不是网络偶发），但具体怎么修得看这个码的含义。',
      fix: `把上面那段原始输出整段贴给维护者，或者去 pnpm 文档 / 搜索引擎里搜「${code}」。`,
    };
  }

  // 认不出 —— 别硬编。
  return null;
}

/**
 * 退出码写人话：Windows 上子进程被信号/异常结束时，`res.code` 是**无符号**值，
 * 日志里就出现过 `退出码 4294963248`（其实是 -4048 / 0xFFFFF030 那一类）。人读不出来。
 *
 * 规则：原始数值**一律保留**在最前面（可解析性不能丢），能解释成负数/十六进制时追加在括号里。
 * 常规退码（0~65535）原样返回 —— 不减一个字。
 *
 * @param {number|string|null|undefined} code
 * @returns {string}
 */
export function formatExitCode(code) {
  if (code === null || code === undefined) return '未知';
  const n = Number(code);
  if (!Number.isFinite(n)) return String(code);
  if (!Number.isInteger(n)) return String(code);
  if (n === 0) return '0';

  const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  // 负数：补码形态最能对上文档里的 0xFFFFF030 那种写法
  if (n < 0) return `${n}（${hex(n)}）`;
  // 2^31 以上：极可能是无符号包装过的负数（Windows 的 CRASH / 异常退出码都在这段）
  if (n > 0x7fffffff) return `${n}（= ${n - 0x100000000}，${hex(n)}）`;
  // 65535 以上但没溢出符号位：罕见的自定义码，给出十六进制方便对照
  if (n > 0xffff) return `${n}（${hex(n)}）`;
  return String(n);
}
