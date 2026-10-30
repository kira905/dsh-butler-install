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
