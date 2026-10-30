// 只跑单个夹具（变异测试用：改坏一处代码，只跑这一个夹具，看它有没有变红）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChecker } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) {
  console.error('用法：node test/run-one.mjs <夹具文件名>');
  process.exit(2);
}

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

const total = checker.state.pass + checker.state.fail;
process.stdout.write(`${checker.state.fail === 0 ? 'PASS' : 'FAIL'}  ${label}  ${checker.state.pass}/${total}\n`);
for (const f of checker.state.failures) process.stdout.write(`  ✖ ${f}\n`);
process.exitCode = checker.state.fail ? 1 : 0;
