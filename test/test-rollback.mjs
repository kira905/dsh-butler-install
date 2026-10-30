// 失败回滚：退出码三档（0/3/4）、步级与整批级的区别、回滚不干净要人看
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, EXIT } from '../lib/run.mjs';
import { makeFakeEnv, pluginItem, cliItem } from './lib/fake-env.mjs';
import { readJsonSafe } from './lib/harness.mjs';

export const name = '失败回滚与退出码';

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

async function withEnvVar(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

export async function run(c) {
  c.eq([EXIT.OK, EXIT.ROLLED_BACK, EXIT.UNCLEAN], [0, 3, 4], '退出码三档必须是 0 / 3 / 4');

  // ── A. 步级回滚：第 3 步失败 ⇒ 前两步保留，第 3 步退回去 ──────────
  const envA = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/ok1'), cliItem('@fake/cli-b', 'cli-b'), pluginItem('@fake/nope')],
  });
  const runA = await envA.withPath(() => runSuite(options(envA)));
  c.eq(runA.exitCode, EXIT.ROLLED_BACK, '有步骤失败但已回滚 ⇒ 退出码 3');
  c.contains(runA.text, '回滚（模式 step', '要写明回滚模式');
  c.contains(runA.text, '404', '失败原因要把命令输出的首行原文带出来');

  const profileA = readJsonSafe(path.join(envA.home, 'profiles', 'fixture', 'package.json'), {});
  c.eq((profileA.dependencies || {})['@fake/ok1'], '^0.1.0', '步级回滚要保留已成功的前几步');
  c.eq((profileA.dependencies || {})['@fake/nope'], undefined, '失败那一步的声明要退掉');
  c.eq((profileA.dsh.profile.bundles || []).includes('@fake/nope'), false, '失败那一步的组合登记也要退掉');
  c.eq(fs.existsSync(path.join(envA.npmPrefix, process.platform === 'win32' ? 'cli-b.cmd' : 'cli-b')), true, '前两步的产物要留着');
  envA.cleanup();

  // ── B. 整批回滚：同样的失败，退到本轮开跑之前 ────────────────
  const envB = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/ok1'), cliItem('@fake/cli-b', 'cli-b'), pluginItem('@fake/nope')],
  });
  const runB = await envB.withPath(() => runSuite(options(envB, { rollbackMode: 'batch' })));
  c.eq(runB.exitCode, EXIT.ROLLED_BACK, '整批回滚干净时还是 3');
  c.contains(runB.text, '模式 batch', '要写明整批回滚');
  const profileFileB = path.join(envB.home, 'profiles', 'fixture', 'package.json');
  c.eq(fs.existsSync(profileFileB), false, '整批回滚后 profile 的 package.json 应回到"开跑前没有这份文件"');
  c.eq(fs.existsSync(path.join(envB.npmPrefix, process.platform === 'win32' ? 'cli-b.cmd' : 'cli-b')), false, '整批回滚要把本轮装的命令行也卸掉');
  envB.cleanup();

  // ── C. 装完不生效（命令成功但没挂载）⇒ 判据拦下 ──────────────
  const envC = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/ok1'), pluginItem('@fake/nostore')],
  });
  const runC = await envC.withPath(() => runSuite(options(envC)));
  c.eq(runC.exitCode, EXIT.ROLLED_BACK, '"装完不生效"要判失败并回滚');
  c.contains(runC.text, '判据没过', '要说清是"命令成功但判据没过"');
  c.contains(runC.text, '组合头', '失败说明要点出组合树缺了它');
  envC.cleanup();

  // ── D. 回滚不干净 ⇒ 4（要人看）──────────────────────────────
  const envD = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/nostore')],
  });
  const runD = await withEnvVar('FAKE_DASH_REMOVE_DIRTY', '1', () => envD.withPath(() => runSuite(options(envD))));
  c.eq(runD.exitCode, EXIT.UNCLEAN, '回滚过程出错 ⇒ 退出码 4');
  c.contains(runD.text, '回滚过程出错', '要把回滚失败本身报出来（不许装作成功）');
  // ── E. 包实体本版就没声明 bundle ⇒ 不判红，如实报"装成普通依赖" ──────
  const envE = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/nobundle')],
  });
  const runE = await envE.withPath(() => runSuite(options(envE)));
  c.eq(runE.exitCode, EXIT.OK, '这一版包没声明 bundle 时不该判红（它不是故障，是版本现状）');
  c.contains(runE.text, '不带 dsh.bundle', '要如实说明本版不带声明');
  c.contains(runE.text, '⏭ 挂载', '挂载这一格要记成"未知/跳过"而不是通过');
  envE.cleanup();
}
