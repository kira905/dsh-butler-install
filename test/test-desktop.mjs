/**
 * 桌面版（Electron 版 DSH）适配的夹具。
 *
 * 背景（2026-11-06 真机实测）：桌面版把 `~/.dsh/profiles/desktop` 当自己的 profile，
 * npm 装的 CLI 改它会被宿主直接拒绝；但桌面版**自带**一条
 * `<安装目录>\resources\runtime\cli\bin\dsh.cmd`，用它加 `--profile desktop` 是能成的。
 *
 * 所以这一格要证明四件事：
 *   ① 认得出来（profile + 安装目录两处证据）
 *   ② 认出来之后真的改用自带命令（不是嘴上说说）
 *   ③ 装上的东西进的是 **dsh.profile.bundles**（只看 dependencies 不算）
 *   ④ 找不到自带命令时**硬拒绝**（rc=2 + 桌面版专属提示），而不是偷偷用 CLI 版去撞
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSuiteState, resetDesktopDetectCache } from '../lib/plan.mjs';
import { runSuite, EXIT } from '../lib/run.mjs';
import { detectDesktop, looksLikeDesktopRoot, resetDesktopCliCache } from '../lib/desktop.mjs';
import { makeFakeEnv, pluginItem } from './lib/fake-env.mjs';
import { readJsonSafe, writeJson } from './lib/harness.mjs';

export const name = '桌面版（Electron）识别 + 改用自带命令 + 找不到就硬拒绝';

/** 在 fixture 里造一套"桌面版安装目录"：主程序 + 自带命令（命令内部转调假 dsh） */
function makeDesktopTree(rootDir, fakeDshScript) {
  const cliDir = path.join(rootDir, 'resources', 'runtime', 'cli', 'bin');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'DeepSeek Harness.exe'), 'not-a-real-exe', 'utf8');
  const cli = path.join(cliDir, 'dsh.cmd');
  // 真实的桌面版壳是「set ELECTRON_RUN_AS_NODE=1 → 起 exe」；夹具里换成 node 跑假 dsh，
  // 这样验证的是"我们会不会用它自带的那条命令"，而不是 Electron 本身。
  fs.writeFileSync(cli, `@echo off\r\nnode "${fakeDshScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  return { cli, exe: path.join(rootDir, 'DeepSeek Harness.exe') };
}

function baseOptions(env, extra = {}) {
  return {
    profile: 'desktop',
    profileExplicit: true,
    manifest: env.manifestPath,
    apply: false,
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
    // 夹具里把候选安装目录钉死在这套伪造目录上（本机真装了桌面版也不影响判定）
    desktopRoots: [path.join(env.dir, 'DSH Desktop')],
    allowProcessProbe: false,
    ...extra,
  };
}

export async function run(c) {
  const env = makeFakeEnv({ profile: 'desktop', items: [pluginItem('@fake/desk-plug')] });
  const desktopRoot = path.join(env.dir, 'DSH Desktop');
  let desktop = null;
  try {
    desktop = makeDesktopTree(desktopRoot, path.join(env.binDir, 'fake-dsh.mjs'));
    // 桌面版自建的 profile（宿主第一次启动就会建）
    writeJson(path.join(env.home, 'profiles', 'desktop', 'package.json'), {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    });

    resetDesktopDetectCache();
    resetDesktopCliCache();

    // ── ① 识别：profile + 安装目录 ────────────────────────────
    const detected = await detectDesktop({
      home: env.home,
      env: { DSH_DESKTOP_DIR: desktopRoot },
      roots: [desktopRoot],
      allowProcessProbe: false,
    });
    c.eq(detected.detected, true, '有桌面版 profile 与安装目录 ⇒ 认出来');
    c.eq(detected.desktopProfileExists, true, '证据一：数据根里有 profiles/desktop');
    c.eq(detected.cliCmd, desktop.cli, '证据二：找到它自带的 dsh.cmd');
    c.ok(detected.evidence.some((e) => /desktop/i.test(e)), '证据要能说给人看');
    c.eq(looksLikeDesktopRoot(path.join(env.dir, 'nope')), null, '不存在的目录不算桌面版安装目录');
    c.eq(looksLikeDesktopRoot(env.home), null, '只有 profile 没有主程序的目录也不算');

    // ── ② 计划层：命令真的换成自带命令 ────────────────────────
    const built = await env.withPath(() => buildSuiteState(baseOptions(env)));
    c.eq(built.ok, true, '计划能算出来');
    c.eq(built.state.profile, 'desktop', 'profile 是 desktop');
    c.eq(built.state.desktop.cliCmd, desktop.cli, 'state 里带出自带命令的路径');
    const cmd = built.state.items[0].command;
    c.contains(cmd, desktop.cli, '插件类命令改用桌面版自带命令（不是 PATH 上的 dsh）');
    c.contains(cmd, '--profile desktop', '命令里点名 desktop profile');
    c.contains(cmd, '@fake/desk-plug@^0.1.0', '期望区间原样进命令（^ 不许丢）');

    // ── ③ 真装：落进 dsh.profile.bundles（只看 dependencies 不算）──
    resetDesktopDetectCache();
    const applied = await env.withPath(() => runSuite(baseOptions(env, { apply: true })));
    c.eq(applied.exitCode, EXIT.OK, `用自带命令真装要成功（rc=${applied.exitCode}）`);
    const profileFile = path.join(env.home, 'profiles', 'desktop', 'package.json');
    const after = readJsonSafe(profileFile, {});
    c.eq(after.dependencies['@fake/desk-plug'], '^0.1.0', '依赖列表里要有它');
    c.eq((after.dsh.profile.bundles || []).includes('@fake/desk-plug'), true, '组合列表里也要有（才算桌面版真会加载）');

    // 装完卸干净：夹具自己收拾，别留半装
    resetDesktopDetectCache();
    const removed = await env.withPath(() => runSuite(baseOptions(env, { apply: true, uninstall: true })));
    c.eq(removed.exitCode, EXIT.OK, '卸载要干净');
    const afterRemove = readJsonSafe(profileFile, {});
    c.eq(Object.keys(afterRemove.dependencies || {}).length, 0, '卸载后依赖列表空');
    c.eq((afterRemove.dsh.profile.bundles || []).includes('@fake/desk-plug'), false, '卸载后组合列表里没有它');

    // ── ④ 找不到自带命令 ⇒ 硬拒绝（rc=2 + 桌面版专属提示）────────
    resetDesktopDetectCache();
    resetDesktopCliCache();
    const emptyHome = path.join(env.dir, 'bare-home');
    fs.mkdirSync(emptyHome, { recursive: true });
    const missing = await env.withPath(() => buildSuiteState(baseOptions(env, {
      home: emptyHome,
      desktopRoots: [],
    })));
    c.eq(missing.ok, false, '找不到桌面版命令时计划必须失败（不许退回 CLI 版硬撞）');
    c.eq(missing.exitCode, EXIT.USAGE, '退出码 2（用法/前置条件错，什么都没改）');
    const text = (missing.log || []).join('\n');
    c.contains(text, '桌面版', '提示里要说清这是桌面版的事');
    c.contains(text, 'resources\\runtime\\cli\\bin\\dsh.cmd', '提示里要写清该用哪条命令');
    c.contains(text, 'DSH_DESKTOP_DIR', '提示里要给个能自救的入口（环境变量）');

    // ── ⑤ 自动切 profile：只有桌面版 profile、没有 web ⇒ 用 desktop ──
    resetDesktopDetectCache();
    const auto = await env.withPath(() => buildSuiteState(baseOptions(env, {
      profile: 'web',
      profileExplicit: false,
    })));
    c.eq(auto.ok, true, '自动切 profile 不算失败');
    c.eq(auto.state.profile, 'desktop', '数据根里只有 desktop profile ⇒ 自动用 desktop');
    c.eq(auto.state.profileSource, 'auto-desktop', '来源标成 auto-desktop（报告里要能看出是自动切的）');

    // ── ⑥ 明确要 web 而机器上有桌面版 ⇒ 只提示、不阻断 ──────────
    resetDesktopDetectCache();
    writeJson(path.join(env.home, 'profiles', 'web', 'package.json'), { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
    const explicitWeb = await env.withPath(() => buildSuiteState(baseOptions(env, {
      profile: 'web',
      profileExplicit: true,
    })));
    c.eq(explicitWeb.ok, true, '显式 --profile web 不被阻断');
    c.eq(explicitWeb.state.profile, 'web', '用户亲手写的 profile 不许被改');
    c.contains(explicitWeb.log.join('\n'), '桌面版', '但要提示"桌面版不加载 web profile"');
    // 而且这时插件命令必须还是 PATH 上的 dsh（桌面命令只对 desktop profile 有效）
    c.eq(explicitWeb.state.desktop.cliCmd, desktop.cli, '探测信息仍然如实带出来');
    c.notContains(explicitWeb.state.items[0].command || '', desktop.cli, '但 web profile 的命令不许用桌面版自带命令');
  } finally {
    env.cleanup();
  }
}
