// 探针三分支：存在性 / help（带硬闸）/ 只读命令
import fs from 'node:fs';
import path from 'node:path';
import { runProbe, hasHelpBranch } from '../lib/probe.mjs';
import { makeTempDir, writeJson } from './lib/harness.mjs';

export const name = '探针三分支';

function makeContext() {
  const dir = makeTempDir('butler-install-probe');
  const home = path.join(dir, 'home');
  const npmPrefix = path.join(dir, 'npm-global');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(npmPrefix, { recursive: true });
  return { dir, home, npmPrefix, profile: 'fixture' };
}

export async function run(c) {
  // ── 存在性：插件（看包实体）──────────────────────────────
  const pluginCtx = makeContext();
  const pluginItem = {
    name: '@fake/plug',
    versionRange: '^0.1.0',
    type: 'plugin',
    group: '核心',
    mount: 'auto',
    probe: { kind: 'existence' },
  };
  const missing = await runProbe(pluginItem, pluginCtx);
  c.eq(missing.status, 'fail', '插件实体不在时存在性探针要判失败');
  c.contains(missing.detail, 'package.json', '失败说明要指出查的是哪份文件');

  writeJson(path.join(pluginCtx.home, 'profiles', 'fixture', 'node_modules', '@fake/plug', 'package.json'), {
    name: '@fake/plug',
    version: '0.1.0',
  });
  const present = await runProbe(pluginItem, pluginCtx);
  c.eq(present.status, 'pass', '插件实体在位时存在性探针要判通过');

  // ── 存在性：命令行工具（看 bin 文件，两处都查）─────────────
  const cliCtx = makeContext();
  const cliItem = {
    name: '@fake/cli',
    versionRange: '^0.1.0',
    type: 'cli',
    group: 'CLI',
    probe: { kind: 'existence', cmd: 'fake-cli' },
  };
  c.eq((await runProbe(cliItem, cliCtx)).status, 'fail', '命令文件不在时判失败');
  const binName = process.platform === 'win32' ? 'fake-cli.cmd' : 'fake-cli';
  fs.writeFileSync(path.join(cliCtx.npmPrefix, binName), '');
  c.eq((await runProbe(cliItem, cliCtx)).status, 'pass', '全局前缀下命令文件在位时判通过');

  // ── help：源码里真有分支才允许执行 ────────────────────────
  const helpCtx = makeContext();
  const helpItem = {
    name: '@fake/helpy',
    versionRange: '^0.1.0',
    type: 'cli',
    group: 'CLI',
    probe: { kind: 'help', cmd: 'helpy', helpVerified: { file: 'helpy.mjs', line: 3 } },
  };
  const pkgDir = path.join(helpCtx.npmPrefix, 'node_modules', '@fake/helpy');
  writeJson(path.join(pkgDir, 'package.json'), { name: '@fake/helpy', version: '0.1.0', bin: { helpy: './helpy.mjs' } });

  const calls = [];
  const fakeRun = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: 'usage: helpy', stderr: '', timedOut: false };
  };

  // 先放一个"没有 --help 分支"的实现
  fs.writeFileSync(path.join(pkgDir, 'helpy.mjs'), 'const args = process.argv.slice(2);\ndoTheRealThing(args);\n', 'utf8');
  const refused = await runProbe(helpItem, { ...helpCtx, run: fakeRun });
  c.eq(refused.status, 'fail', '标了 help 但源码里没有 --help 分支 ⇒ 必须判失败');
  c.eq(calls.length, 0, '🔴 必须一条命令都没执行（--help 在没实现的命令上是真动作）');
  c.contains(refused.detail, '拒执行', '拒绝的说明要写清"拒执行"');

  // 换成"真有 --help 分支"的实现
  fs.writeFileSync(
    path.join(pkgDir, 'helpy.mjs'),
    "const args = process.argv.slice(2);\nif (args.includes('--help')) { console.log('usage: helpy'); process.exit(0); }\n",
    'utf8',
  );
  const passed = await runProbe(helpItem, { ...helpCtx, run: fakeRun });
  c.eq(passed.status, 'pass', '确有 --help 分支时允许跑，并判通过');
  c.eq(calls.length, 1, '核过之后应该正好执行一次 --help');
  c.eq(calls[0].args, ['--help'], '执行的就是 --help 本身');

  // help 分支判定本身
  c.eq(hasHelpBranch('console.log("usage")'), false, '只打印 usage 不算实现了 --help');
  c.eq(hasHelpBranch("if (argv.includes('--help')) return usage();"), true, '有 --help 判断且有 usage 输出才算实现');

  // 装都没装、找不到源文件 ⇒ 拒
  const notInstalled = await runProbe(
    { ...helpItem, name: '@fake/nothere' },
    { ...helpCtx, run: fakeRun },
  );
  c.eq(notInstalled.status, 'fail', '找不到命令源文件时 help 探针必须失败（不许盲跑）');

  // ── cmd：清单指定的只读命令 ──────────────────────────────
  const cmdItem = {
    name: '@fake/cli',
    versionRange: '^0.1.0',
    type: 'cli',
    group: 'CLI',
    probe: { kind: 'cmd', cmd: 'fake-cli', argv: ['--status'], readonlyBecause: '只打印状态，不写任何文件' },
  };
  const okCmd = await runProbe(cmdItem, { ...cliCtx, run: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }) });
  c.eq(okCmd.status, 'pass', '只读命令 rc=0 判通过');
  const badCmd = await runProbe(cmdItem, {
    ...cliCtx,
    run: async () => ({ code: 3, stdout: '', stderr: 'boom: 读不到状态文件', timedOut: false }),
  });
  c.eq(badCmd.status, 'fail', '只读命令 rc≠0 判失败');
  c.contains(badCmd.detail, 'boom', '失败要把首行错误原文打出来');
  const slowCmd = await runProbe(cmdItem, { ...cliCtx, run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) });
  c.eq(slowCmd.status, 'fail', '探针超时判失败');

  for (const ctx of [pluginCtx, cliCtx, helpCtx]) fs.rmSync(ctx.dir, { recursive: true, force: true });
}
