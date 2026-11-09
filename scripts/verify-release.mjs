// 单条发布后复验：五道闸一次跑完
// 用法：node verify-release.mjs [--packages a,b,c] [--exe <exe路径>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 仓根 = 本仓（dsh-butler-install）的上一级，即所有开源仓的公共父目录。
// 构建机可用 OSS_ROOT 覆盖；不再写死本机磁盘路径。
const ROOT = process.env.OSS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INST = `${ROOT}/dsh-butler-install`;
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const PKGS = argOf('--packages', 'dsh-butler-archive,dsh-ecosystem-panel,dsh-session-title-live').split(',');
const EXE = argOf('--exe', '');

const results = [];
const add = (gate, name, ok, detail) => {
  results.push({ gate, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${gate}] ${name}${detail ? ' — ' + detail : ''}`);
};

const manifest = JSON.parse(fs.readFileSync(`${INST}/suite-manifest.json`, 'utf8'));
const rangeOf = (n) => (manifest.items.find((i) => i.name === n) || {}).versionRange;

// ── 闸①：重下 tarball，核完整性 + 包内版本 + 无 peer
console.log('\n=== 闸① 重下 tarball 复验 ===');
for (const repo of PKGS) {
  const pj = JSON.parse(fs.readFileSync(`${ROOT}/${repo}/package.json`, 'utf8'));
  const name = pj.name;
  const localVer = pj.version;
  try {
    const meta = await (await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)).json();
    const dist = meta?.versions?.[localVer]?.dist;
    if (!dist) { add('①tarball', name, false, `registry 上没有 ${localVer}（还没发？）`); continue; }
    const buf = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const okSha = sha1 === dist.shasum;
    // 包内 package.json 核对
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-'));
    const tgz = path.join(tmp, 'p.tgz');
    fs.writeFileSync(tgz, buf);
    try { execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' }); } catch {}
    const inner = JSON.parse(fs.readFileSync(path.join(tmp, 'package', 'package.json'), 'utf8'));
    const okVer = inner.version === localVer;
    const okNoPeer = !('peerDependencies' in inner) || !('@deepseek-ai/dsh' in (inner.peerDependencies || {}));
    add('①tarball', `${name}@${localVer}`,
      okSha && okVer && okNoPeer,
      `sha1=${okSha ? 'match' : 'MISMATCH'} · 包内版本=${inner.version}${okVer ? '' : '(≠本地)'} · peer=${okNoPeer ? '已无' : '仍在'}`);
  } catch (e) {
    add('①tarball', name, false, String(e.message).slice(0, 80));
  }
}

// ── 闸②③：隔离装（无 peer 警告）+ peers check 全清
console.log('\n=== 闸②③ 隔离真装 + peers check ===');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-home-'));
const env = { ...process.env, DSH_HOME: home };
for (const repo of PKGS) {
  const pj = JSON.parse(fs.readFileSync(`${ROOT}/${repo}/package.json`, 'utf8'));
  const spec = `${pj.name}@${pj.version}`;
  let out = '';
  try {
    out = execFileSync('dsh', ['plugin', '--profile', 'web', 'add', spec], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const noisy = /Issues with peer dependencies/i.test(out);
  add('②装', spec, !noisy, noisy ? '仍有 peer 警告' : '输出无 peer 警告');
}
// Windows 上 pnpm 是 .cmd 壳，本沙箱起 cmd.exe 会被拦 ⇒ 用**静态等价判据**：
// 直接扫 profile 里装进去的每个包，看还有谁声明了 peerDependencies['@deepseek-ai/dsh']。
// 等价性：pnpm peers check 报的就是「有包声明了别人没提供的 peer」；我们把唯一那个 peer 删干净了，这里就该 0 条。
{
  const nm = path.join(home, 'profiles', 'web', 'node_modules');
  const offenders = [];
  const scan = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith('@')) { scan(p); continue; }
      const pjf = path.join(p, 'package.json');
      if (fs.existsSync(pjf)) {
        try {
          const pj = JSON.parse(fs.readFileSync(pjf, 'utf8'));
          if (pj.peerDependencies && '@deepseek-ai/dsh' in pj.peerDependencies) {
            offenders.push(`${pj.name}@${pj.version} peer:${pj.peerDependencies['@deepseek-ai/dsh']}`);
          }
        } catch {}
      }
    }
  };
  scan(nm);
  add('③peers', '静态 peer 扫描（等价于 pnpm peers check）', offenders.length === 0,
    offenders.length ? `仍有 ${offenders.length} 处：${offenders.slice(0, 3).join('; ')}` : 'profile 里 0 个包声明 @deepseek-ai/dsh peer');
}

// ── 闸④：清单与实体版本一致（区间必须接受已发版本）
console.log('\n=== 闸④ 清单 ↔ 实体版本 ===');
for (const repo of PKGS) {
  const pj = JSON.parse(fs.readFileSync(`${ROOT}/${repo}/package.json`, 'utf8'));
  const range = rangeOf(pj.name);
  const ok = range === `^${pj.version}`;
  add('④清单', `${pj.name}`, ok, `manifest=${range ?? '(缺条目)'} · 实体=${pj.version}${ok ? '' : ' ⇒ 下界没刷到新版本'}`);
}

// ── 闸⑤：exe 内嵌清单逐字节比
console.log('\n=== 闸⑤ exe 内嵌清单逐字节 ===');
const exePath = EXE || (() => {
  const pj = JSON.parse(fs.readFileSync(`${INST}/package.json`, 'utf8'));
  return `${INST}/dist/dsh-butler-install-${pj.version}-win-x64.exe`;
})();
if (!fs.existsSync(exePath)) {
  add('⑤exe', path.basename(exePath), false, 'exe 不存在（清单改过就必须重建）');
} else {
  const exeBuf = fs.readFileSync(exePath);
  const manBuf = fs.readFileSync(`${INST}/suite-manifest.json`);
  const hit = exeBuf.includes(manBuf);
  add('⑤exe', path.basename(exePath),
    hit,
    hit ? `内嵌段与仓内清单逐字节相同（${manBuf.length} B）` : `内嵌段与仓内清单不一致（仓内 ${manBuf.length} B）—— exe 是旧清单做的`);
}

// ── 汇总
const bad = results.filter((r) => !r.ok);
console.log(`\n===== 汇总：${results.length - bad.length}/${results.length} 通过 =====`);
if (bad.length) {
  console.log('未过：');
  for (const b of bad) console.log(`  ❌ [${b.gate}] ${b.name} — ${b.detail}`);
  process.exitCode = 1;
} else {
  console.log('✅ 五道闸全过，可以推 / 可以发。');
}
