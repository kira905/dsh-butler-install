// 失败归因（人话环境归因）：两类"环境障碍"翻成人话 + 退出码写人话；
// 并验真跑通路（runSuite）里「原始报错在前、归因在后、退出码语义不变」。
//
// 这里的三段真实 stderr 是 2026-10-31 第 24 棒真装验收里撞到的**原文**（一字未改）：
// 拿真文本当夹具，比手写一段"像那么回事"的更有价值 —— 换了 pnpm 版本就靠它报警。
import fs from 'node:fs';
import path from 'node:path';
import { explainPnpmFailure, formatExitCode } from '../lib/explain-failure.mjs';
import { runSuite, EXIT } from '../lib/run.mjs';
import { makeFakeEnv, pluginItem } from './lib/fake-env.mjs';

export const name = '失败归因（人话环境归因）';

/** ① 安全软件拦 pnpm 建符号链接（含 registerProject 栈） */
const BLOCKED_SYMLINK = String.raw`[EPERM] EPERM: operation not permitted, symlink 'C:\Users\51367\AppData\Local\Temp\p24-full-home\profiles\web' -> 'C:\Users\51367\AppData\Local\pnpm\store\v11\projects\a4f7f3ed28c225f67a3375d618e5108a'
pnpm: EPERM: operation not permitted, symlink '...' -> '...'
    at async Object.symlink (node:internal/fs/promises:1059:10)
    at async createSymlinkAsync (file:///C:/Users/51367/AppData/Roaming/npm/node_modules/pnpm/dist/pnpm.mjs:51013:13)
    at async forceSymlink (...)
    at async registerProject (file:///C:/Users/51367/AppData/Roaming/npm/node_modules/pnpm/dist/pnpm.mjs:184446:3)`;

/** ② pnpm store 与已有 node_modules 不在同一处 */
const STORE_MISMATCH = String.raw`[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
The dependencies at "D:\DSH-offsync\DSH-test\.dsh\profiles\web\node_modules" are currently linked from the store at "C:\Users\51367\AppData\Local\pnpm\store\v11".
pnpm now wants to use the store at "D:\.pnpm-store\v11" to link dependencies.
If you want to use the new store location, reinstall your dependencies with "pnpm install".`;

/**
 * 「假 dsh」的破例版：`plugin add` 直接吐 EPERM 原文并退出 1。
 * 只用来验"人话归因真的从真跑通路里打印出来、且排在原始报错后面" —— 它是夹具，不碰生产。
 */
const FAKE_DSH_EPERM = String.raw`import path from 'node:path';
const args = process.argv.slice(2);
const home = process.env.DSH_HOME || '';
if (args[0] === '--version') { console.log('9.9.9-fake'); process.exit(0); }
if (args[0] === 'plugin') {
  const verb = args[args.indexOf('--profile') + 2];
  if (verb === 'remove') { console.log('- removed'); process.exit(0); }
  console.error("[EPERM] EPERM: operation not permitted, symlink '" + path.join(home, 'profiles', 'fixture') + "' -> 'C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v11\\projects\\a4f7f3ed'");
  console.error('    at async Object.symlink (node:internal/fs/promises:1059:10)');
  console.error('    at async registerProject (file:///C:/pnpm/dist/pnpm.mjs:184446:3)');
  process.exit(1);
}
if (args[0] === '--profile' && args.includes('--dump-config')) { console.log('# == @deepseek-ai/dsh-base'); process.exit(0); }
console.error('fake dsh (eperm): 不认识的参数 ' + args.join(' '));
process.exit(64);
`;

function options(env, extra = {}) {
  return {
    profile: 'fixture',
    manifest: env.manifestPath,
    apply: true,
    only: [],
    skip: [],
    upgrade: false,
    rollbackMode: 'step',
    uninstall: false,
    npmPrefix: env.npmPrefix,
    home: env.home,
    timeoutMs: 60000,
    budgetMs: 300000,
    json: true,
    ...extra,
  };
}

export async function run(c) {
  // ── A. 三种 kind + 不误报 ────────────────────────────────────
  const h1 = explainPnpmFailure({ stderr: BLOCKED_SYMLINK });
  c.eq(h1 && h1.kind, 'blocked-symlink', '安全软件拦符号链接的真实 stderr ⇒ blocked-symlink');
  c.contains(h1 && h1.title, '安全软件', '标题要说清"是安全软件拦的"（用户第一眼要看到这句）');
  c.contains(h1 && h1.title, '不是包坏了', '标题要否掉"包坏了"这个最容易被误认的答案');
  c.contains(h1 && h1.fix, '放行', '怎么办里要有"给 pnpm/node 放行"这条');
  c.contains(h1 && h1.fix, '重试', '怎么办里要有"直接重试"这条（这类拦截是间歇的）');
  c.contains(h1 && h1.fix, '数据根', '怎么办里要有"换个位置做数据根"这条');

  const h2 = explainPnpmFailure({ stderr: STORE_MISMATCH });
  c.eq(h2 && h2.kind, 'store-mismatch', 'store 与 node_modules 不同处的真实 stderr ⇒ store-mismatch');
  c.contains(h2 && h2.fix, 'store-dir', '怎么办里要给出"让 pnpm 用回原来那处"的具体命令');
  c.contains(h2 && h2.fix, '重装', '怎么办里要有"在那个 profile 里重装依赖"这条');

  const h3 = explainPnpmFailure({ stderr: ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for x@^9' });
  c.eq(h3 && h3.kind, 'unknown-pnpm', '陌生 pnpm 码 ⇒ unknown-pnpm（认得出层层，但不猜原因）');
  c.eq(h3 && h3.code, 'ERR_PNPM_NO_MATCHING_VERSION', '要把原码原样带回来');
  c.contains(h3 && h3.title, 'ERR_PNPM_NO_MATCHING_VERSION', '标题里要能看到原码（用户好去搜）');

  // 不误报：这三个都必须 null
  const n1 = explainPnpmFailure({ stderr: 'Error: spawn dsh ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:283:19)' });
  c.eq(n1, null, '完全无关的报错（spawn ENOENT）⇒ null（不许瞎猜）');
  const n2 = explainPnpmFailure({ stderr: 'EPERM: operation not permitted, open \'C:\\x\'' });
  c.eq(n2, null, '只有 EPERM 没有 symlink / registerProject ⇒ null（别把别的 EPERM 说成拦链接）');
  c.eq(explainPnpmFailure({}), null, '空输入 ⇒ null');
  c.eq(explainPnpmFailure(), null, '连参数都不给 ⇒ null');

  // 两个流任一命中都算；两个签名撞一起时取更精确的那个
  const h4 = explainPnpmFailure({ stdout: BLOCKED_SYMLINK });
  c.eq(h4 && h4.kind, 'blocked-symlink', 'stdout 里命中同样要认（表格要求 stderr/stdout 任一）');
  const h5 = explainPnpmFailure({ stderr: `${STORE_MISMATCH}\n${BLOCKED_SYMLINK}` });
  c.eq(h5 && h5.kind, 'store-mismatch', '两个签名同时出现 ⇒ 取更精确的 store-mismatch（"用回原来那处 store"更可执行）');

  // ── B. 退出码写人话：原值仍可见 + 负数 + 十六进制 ─────────────
  const wrapped = formatExitCode(4294963248); // = 0xFFFFFFF0 + 0x30 那种无符号包装（实际 -4048）
  c.contains(wrapped, '4294963248', '无符号巨值：原始数值必须原样留在最前面（别丢可解析性）');
  c.contains(wrapped, '-4048', '要给出等价的负数（人读得出来）');
  c.contains(wrapped, '0xFFFFF030', '要给出十六进制补码形态');
  c.contains(formatExitCode(-4048), '0xFFFFF030', '已经是有符号负数时也要能换算成补码');
  c.eq(formatExitCode(1), '1', '常规退码一个字符都不改（1）');
  c.eq(formatExitCode(3), '3', '常规退码一个字符都不改（3）');
  c.eq(formatExitCode(0), '0', '常规退码一个字符都不改（0）');
  c.eq(formatExitCode(null), '未知', '没有退出码（被信号杀 / 没起来）⇒ 写"未知"而不是 null');

  // ── C. 真跑通路：原始报错在前、归因在后、退出码语义不变 ────────
  const envS = makeFakeEnv({ profile: 'fixture', items: [pluginItem('@fake/ok1')] });
  fs.writeFileSync(path.join(envS.binDir, 'fake-dsh.mjs'), FAKE_DSH_EPERM, 'utf8');
  const eventsS = [];
  const runS = await envS.withPath(() => runSuite(options(envS), { onEvent: (e) => eventsS.push(e) }));
  const textS = runS.text;
  c.eq(runS.exitCode, EXIT.ROLLED_BACK, '归因只做展示：失败+回滚干净仍然是退出码 3（语义不动）');
  c.contains(textS, '❌ 安装命令退出码 1：', '失败行照旧带退出码与原始首行');
  c.contains(textS, 'operation not permitted, symlink', '原始报错一个字都不许吞（EPERM 原文仍在）');
  c.contains(textS, '💡', '要真的打印出人话归因');
  c.contains(textS, '安全软件', '归因要落到"安全软件拦链接"这件事上');
  c.contains(textS, '怎么办：', '归因要带"怎么办"');
  const idxRaw = textS.indexOf('operation not permitted, symlink');
  const idxHint = textS.indexOf('💡');
  c.ok(idxRaw >= 0 && idxHint > idxRaw, `归因必须排在原始报错**后面**（原位 ${idxRaw} / 归因位 ${idxHint}）`);
  c.contains(textS, 'registerProject', '子命令原始输出的栈也在（缩进 4 格那一段没被吃掉）');
  // 页面（--ui / exe）通路：终端那三行缩进 4 格进不了进度事件，所以另发一条摘要行
  const hintLogs = eventsS.filter((e) => e.kind === 'log' && String(e.detail).includes('💡'));
  c.eq(hintLogs.length, 1, '页面通路：失败时要另发**一条**带归因的摘要行（不多不少）');
  c.eq(hintLogs.every((e) => !String(e.detail).startsWith('    ')), true, '归因摘要行不许带 4 空格缩进（否则进不了页面 lines）');
  c.contains(hintLogs[0] && hintLogs[0].detail, '安全软件', '页面那一条要能看出"是安全软件拦的"');
  c.contains(hintLogs[0] && hintLogs[0].detail, '怎么办', '页面那一条要带"怎么办"（页面上最有用的是这句）');
  c.contains(hintLogs[0] && hintLogs[0].detail, '放行', '页面那一条的"怎么办"要是可执行的三选一，不是空话');
  envS.cleanup();

  // 陌生 pnpm 码在真跑里同样给归因（假 dsh 装一个"注册表上不存在"的包 ⇒ ERR_PNPM_FETCH_404）
  const envU = makeFakeEnv({ profile: 'fixture', items: [pluginItem('@fake/nope')] });
  const runU = await envU.withPath(() => runSuite(options(envU)));
  const textU = runU.text;
  c.contains(textU, 'ERR_PNPM_FETCH_404', '原始码仍在输出里（原样打印）');
  c.contains(textU, '这条码本工具还没收录', '陌生 pnpm 码要给"没收录"的归因，而不是沉默');
  const idxRawU = textU.indexOf('ERR_PNPM_FETCH_404');
  const idxHintU = textU.indexOf('💡');
  c.ok(idxRawU >= 0 && idxHintU > idxRawU, `陌生 pnpm 码的归因也排在原文后面（原位 ${idxRawU} / 归因位 ${idxHintU}）`);
  c.ok(runU.exitCode === EXIT.ROLLED_BACK || runU.exitCode === EXIT.UNCLEAN, `失败仍然走回滚那两档（实际 ${runU.exitCode}）`);
  envU.cleanup();
}
