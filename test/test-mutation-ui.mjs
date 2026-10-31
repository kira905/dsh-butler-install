// 变异测试：把代码改坏一处，看夹具**是不是真的会红**。
//
// 为什么非要有这一条：夹具最容易写成"永远绿" —— 判据写松了、断言的其实是自己刚写进去的值，
// 或者被测函数根本没被走到。这里的做法是：把仓复制一份到临时目录，用字符串替换改坏一处，
// 再在副本里跑夹具；**改坏了还绿 ⇒ 这条夹具是假的**。
//
// 覆盖四条红线：监听地址 / 令牌校验 / 写入口白名单 / 同源校验（外加"原样副本必须绿"的对照）。
// 2026-10-31 起，变异改在"页面能真装"之后的口径上：
//  - 原来那条「路由表放开非 GET」不再是缺陷（POST 本来就该有入口了，见方案 §11.6 · I3），
//    改成「POST 白名单放开到任意路径」；
//  - 补一条「去掉令牌校验」——这是新加写入口之后最该守住的一条；
//  - 再补一条「去掉同源校验」——令牌 + 同源是这一版写进对外的两条安全承诺，少一条就只剩一半。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const COPY_ENTRIES = ['package.json', 'suite-manifest.json', 'install-ui.cmd', 'bin', 'lib', 'test'];

// 两条夹具都要跑：老的那条守"只读面没被改坏"，新的那条守"写入口的八道闸"
const FIXTURES = ['test-ui.mjs', 'test-ui-install.mjs'];

const MUTATIONS = [
  {
    label: '监听地址改成 0.0.0.0（安全红线）',
    file: 'lib/ui-server.mjs',
    from: "export const UI_HOST = '127.0.0.1';",
    to: "export const UI_HOST = '0.0.0.0';",
    expect: '监听地址',
  },
  {
    label: '去掉令牌校验（写入口等于对本地任意页面敞开）',
    file: 'lib/ui-server.mjs',
    from: '  if (!sameToken(req, deps.token)) {',
    to: '  if (false) {',
    expect: '令牌',
  },
  {
    label: 'POST 白名单放开到任意路径（写方法的入口就不止那几条了）',
    file: 'lib/ui-server.mjs',
    from: '    if (postKind) return { kind: postKind };',
    to: "    if (postKind || true) return { kind: postKind || 'start' };",
    expect: '405',
  },
  {
    label: '去掉同源校验（任意本地页面都能借你的浏览器发 POST）',
    file: 'lib/ui-server.mjs',
    from: '  const origin = checkOrigin(req, deps.server);',
    to: '  const origin = { ok: true };',
    expect: '闸 3',
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
  let status = 0;
  let output = '';
  for (const file of FIXTURES) {
    const res = spawnSync(process.execPath, ['test/run-one.mjs', file], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 300000,
    });
    output += `\n### ${file}\n${res.stdout || ''}${res.stderr || ''}`;
    if (res.status !== 0) status = res.status || 1;
  }
  return { status, stdout: output, stderr: '' };
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
    c.eq(okRun.status, 0, `原样副本必须跑绿（rc=${okRun.status}）${okRun.status === 0 ? '' : `：${(okRun.stdout || okRun.stderr || '').split('\n').slice(-6).join(' | ')}`}`);
    fs.rmSync(control, { recursive: true, force: true });

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
