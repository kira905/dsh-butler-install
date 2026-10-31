// 夹具总入口：逐个跑、汇总 PASS/FAIL 数，有一处红就 rc 1。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeChecker } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = [
  'test-semver.mjs',
  'test-manifest.mjs',
  'test-probe.mjs',
  'test-dump.mjs',
  'test-snapshot.mjs',
  'test-dryrun.mjs',
  'test-apply.mjs',
  'test-rollback.mjs',
  'test-ui.mjs',
  // 可视化安装后端：八道闸 + 执行器 + 撤回两条路（方案 §11.6 修订后的实现规格）
  'test-ui-install.mjs',
  // 双击入口：探测式单实例（连起两次只得到一个服务）+ 纯 ASCII 壳
  'test-install-ui-entry.mjs',
  'test-mutation-ui.mjs',
  // 失败归因：两类环境障碍（安全软件拦符号链接 / store 不同处）翻成人话 + 退出码人话化
  'test-explain-failure.mjs',
  // 清单是单一真相，但真相会烂：这一格拿仓内 npm latest 快照核清单的区间还接不接受
  // 当前发布出来的版本（零网络；真网络版本 = 直接跑 `node test/range-drift.mjs`）。
  'range-drift.mjs',
];

let pass = 0;
let fail = 0;
const failures = [];
const lines = [];

for (const file of modules) {
  const checker = makeChecker();
  let label = file;
  try {
    const mod = await import(`file://${path.join(here, file).replace(/\\/g, '/')}`);
    label = mod.name || file;
    await mod.run(checker);
  } catch (err) {
    checker.state.fail += 1;
    checker.state.failures.push(`（这个夹具自己抛错了）${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  }
  pass += checker.state.pass;
  fail += checker.state.fail;
  for (const f of checker.state.failures) failures.push(`${label} → ${f}`);
  lines.push(`${checker.state.fail === 0 ? 'PASS' : 'FAIL'}  ${label}  ${checker.state.pass}/${checker.state.pass + checker.state.fail}`);
}

process.stdout.write(`${lines.join('\n')}\n\n`);
if (fail) {
  process.stdout.write(`共 ${pass + fail} 条断言：${pass} 通过 / ${fail} 失败\n`);
  for (const f of failures) process.stdout.write(`  ✖ ${f}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`共 ${pass} 条断言：全部通过\n`);
  process.exitCode = 0;
}
