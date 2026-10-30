// 变异测试：把代码改坏一处，看夹具**是不是真的会红**。
//
// 为什么非要有这一条：夹具最容易写成"永远绿" —— 判据写松了、断言的其实是自己刚写进去的值，
// 或者被测函数根本没被走到。这里的做法是：把仓复制一份到临时目录，用字符串替换改坏一处，
// 再在副本里跑同一个夹具；**改坏了还绿 ⇒ 这条夹具是假的**。
//
// 覆盖三处红线：监听地址 / 只读路由 / 命令同源（外加"原样副本必须绿"的对照）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const COPY_ENTRIES = ['package.json', 'suite-manifest.json', 'bin', 'lib', 'test'];

const MUTATIONS = [
  {
    label: '监听地址改成 0.0.0.0（安全红线）',
    file: 'lib/ui-server.mjs',
    from: "export const UI_HOST = '127.0.0.1';",
    to: "export const UI_HOST = '0.0.0.0';",
    expect: '监听地址',
  },
  {
    label: '路由表放开非 GET（只要多一个写入口，"只读"就没了）',
    file: 'lib/ui-server.mjs',
    from: "  if (String(method || '').toUpperCase() !== 'GET') return { kind: 'method-not-allowed' };",
    to: '  if (false) return { kind: \'method-not-allowed\' };',
    expect: '405',
  },
  {
    label: '安装命令不再带期望区间（演练文本与 /state 会一起变）',
    file: 'lib/plan.mjs',
    from: 'const spec = `${item.name}@${item.versionRange}`;',
    to: 'const spec = `${item.name}`;',
    expect: '逐字节一致',
  },
];

function copyRepo(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    const from = path.join(repoRoot, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dest, entry), { recursive: true });
  }
}

function runFixture(dir) {
  return spawnSync(process.execPath, ['test/run-one.mjs', 'test-ui.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
  });
}

function freshCopy(root, label) {
  const dir = path.join(root, label);
  copyRepo(dir);
  return dir;
}

export const name = '向导页夹具的变异测试（改坏必须红）';

export async function run(c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-install-mut-'));
  try {
    // 对照：原样副本必须绿 —— 否则下面那几条"变红"可能只是复制坏了
    const control = freshCopy(root, 'control');
    const okRun = runFixture(control);
    c.eq(okRun.status, 0, `原样副本必须跑绿（rc=${okRun.status}）${okRun.status === 0 ? '' : `：${(okRun.stdout || okRun.stderr || '').split('\n').slice(0, 4).join(' | ')}`}`);

    for (const [index, mutation] of MUTATIONS.entries()) {
      const dir = freshCopy(root, `mut-${index + 1}`);
      const file = path.join(dir, mutation.file);
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes(mutation.from)) {
        c.ok(false, `变异 ${mutation.label}：锚点在 ${mutation.file} 里找不到了（夹具要跟着改，别让它静默失效）`);
        continue;
      }
      fs.writeFileSync(file, source.replace(mutation.from, () => mutation.to), 'utf8');
      const res = runFixture(dir);
      const output = `${res.stdout || ''}${res.stderr || ''}`;
      c.ok(res.status !== 0, `🔴 变异「${mutation.label}」之后夹具必须变红（实际 rc=${res.status}）`);
      c.contains(output, 'FAIL', `变异「${mutation.label}」的输出里要有 FAIL`);
      c.contains(output, mutation.expect, `变异「${mutation.label}」要红在判据上（找 ${JSON.stringify(mutation.expect)}）`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
