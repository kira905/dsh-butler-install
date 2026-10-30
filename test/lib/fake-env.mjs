// 假环境：一个假 dsh、一个假 npm、一份假 profile。
// 只落在夹具自己的临时目录里，绝不碰真实数据根。
//
// 为什么值得造这两个假命令：安装器的退出码（0/3/4）与回滚是否干净，只有在
// "命令真的会失败 / 真的会写文件"时才验得出来。用打桩函数直接返回字符串虽然省事，
// 但验不到"失败之后世界回到了哪一步"。
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, writeJson } from './harness.mjs';

const FAKE_DSH = `import fs from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME;
const args = process.argv.slice(2);
const VERSION = process.env.FAKE_VERSION || '0.1.0';
const BAD = /nope|missing|nonexistent/;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function fresh(profile) {
  return { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
}

if (args[0] === '--version') { console.log('9.9.9-fake'); process.exit(0); }

if (args[0] === 'plugin') {
  const profile = args[args.indexOf('--profile') + 1];
  const verb = args[args.indexOf('--profile') + 2];
  const rawSpec = args[args.indexOf('--profile') + 3];
  // 安装时清单会把期望区间一起点名（<包>@^x.y.z）；卸载时是裸包名
  const at = rawSpec.lastIndexOf('@');
  const name = at > 0 ? rawSpec.slice(0, at) : rawSpec;
  const dir = path.join(home, 'profiles', profile);
  const pkgFile = path.join(dir, 'package.json');
  const pkg = readJson(pkgFile, fresh(profile));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || { profile: { bundles: [] } };
  pkg.dsh.profile = pkg.dsh.profile || { bundles: [] };
  if (verb === 'add') {
    if (BAD.test(name)) {
      console.error('ERR_PNPM_FETCH_404  GET https://registry.invalid/' + name + ' - 404 Not Found');
      process.exit(1);
    }
    pkg.dependencies[name] = '^' + VERSION;
    const bundles = new Set(pkg.dsh.profile.bundles || []);
    bundles.add('@deepseek-ai/dsh-base');
    // nobundle：模拟"这一版包实体压根没声明 dsh.bundle"（修复版还没发布时的真实形态）
    const declaresBundle = !/nobundle/.test(name);
    // nostore：模拟"声明了 bundle、但宿主没把它登记进组合列表"（本工具要抓的假成功）
    if (!process.env.FAKE_NO_BUNDLE && declaresBundle && !/nostore/.test(name)) bundles.add(name);
    pkg.dsh.profile.bundles = [...bundles];
    writeJson(pkgFile, pkg);
    writeJson(path.join(dir, 'node_modules', name, 'package.json'), {
      name,
      version: VERSION,
      ...(declaresBundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
    });
    console.log('+ ' + name + ' ^' + VERSION);
    process.exit(0);
  }
  if (verb === 'remove') {
    if (process.env.FAKE_DASH_REMOVE_FAIL) {
      console.error('ERR_PNPM 假装的删除失败');
      process.exit(1);
    }
    if (process.env.FAKE_DASH_REMOVE_DIRTY) {
      // 模拟"回滚时快照已经坏了"：把数据根下的快照记录删掉
      const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name === 'snapshot.json') fs.rmSync(full, { force: true });
        }
      };
      walk(path.join(home, 'butler-install', 'snapshots'));
    }
    delete pkg.dependencies[name];
    pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles || []).filter((b) => b !== name);
    writeJson(pkgFile, pkg);
    fs.rmSync(path.join(dir, 'node_modules', name), { recursive: true, force: true });
    console.log('- ' + name);
    process.exit(0);
  }
}

if (args[0] === '--profile' && args.includes('--dump-config')) {
  const profile = args[args.indexOf('--profile') + 1];
  const pkg = readJson(path.join(home, 'profiles', profile, 'package.json'), null);
  const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || ['@deepseek-ai/dsh-base'];
  const out = [];
  for (const b of bundles) {
    out.push('# == ' + b);
    const id = b === '@deepseek-ai/dsh-base' ? 'base' : b.replace(/^@[^/]+\\//, '');
    out.push('- id: ' + id, "  name: '" + b + "'");
    if (process.env.FAKE_DUMP_COLLIDE) out.push('- id: ' + id, "  name: '" + b + "'");
  }
  console.log(out.join('\\n'));
  process.exit(0);
}

console.error('fake dsh: 不认识的参数 ' + args.join(' '));
process.exit(64);
`;

const FAKE_NPM = `import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VERSION = process.env.FAKE_VERSION || '0.1.0';
const prefix = process.env.npm_config_prefix || process.env.FAKE_NPM_PREFIX || '';
const BAD = /nope|missing|nonexistent/;

if (args[0] === 'config' && args[1] === 'get' && args[2] === 'prefix') {
  console.log(prefix);
  process.exit(0);
}

function shortName(name) {
  const parts = name.split('/');
  return parts[parts.length - 1];
}
function dirOf(name) {
  return path.join(prefix, 'node_modules', name);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

if (args[0] === 'i' && args[1] === '-g') {
  const rawSpec = args[2];
  const at = rawSpec.lastIndexOf('@');
  const name = at > 0 ? rawSpec.slice(0, at) : rawSpec;
  if (BAD.test(name)) {
    console.error('npm error 404 Not Found - GET https://registry.invalid/' + name);
    process.exit(1);
  }
  writeJson(path.join(dirOf(name), 'package.json'), { name, version: VERSION });
  const short = shortName(name);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(prefix, short + '.cmd'), '@echo off\\r\\nexit /b 0\\r\\n');
  } else {
    fs.writeFileSync(path.join(prefix, short), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
  }
  console.log('added 1 package');
  process.exit(0);
}

if (args[0] === 'rm' && args[1] === '-g') {
  const name = args[2];
  if (process.env.FAKE_NPM_REMOVE_FAIL) {
    console.error('npm error 假装的删除失败');
    process.exit(1);
  }
  fs.rmSync(dirOf(name), { recursive: true, force: true });
  const short = shortName(name);
  for (const suffix of ['', '.cmd', '.CMD']) {
    fs.rmSync(path.join(prefix, short + suffix), { force: true });
  }
  console.log('removed 1 package');
  process.exit(0);
}

console.error('fake npm: 不认识的参数 ' + args.join(' '));
process.exit(64);
`;

function writeShim(binDir, cmd, scriptName) {
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, `${cmd}.cmd`),
      `@echo off\r\nnode "%~dp0${scriptName}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(binDir, `${cmd}.ps1`), `node "$PSScriptRoot/${scriptName}" @args\nexit $LASTEXITCODE\n`, 'utf8');
  } else {
    fs.writeFileSync(path.join(binDir, cmd), `#!/bin/sh\nexec node "$(dirname "$0")/${scriptName}" "$@"\n`, { mode: 0o755 });
  }
}

/**
 * 造一套假环境。
 * @returns {{dir, home, npmPrefix, binDir, manifestPath, envOf(), withPath(fn), cleanup()}}
 */
export function makeFakeEnv({ profile = 'fixture', items = [], excluded = [] } = {}) {
  const dir = makeTempDir('butler-install-env');
  const home = path.join(dir, 'home');
  const npmPrefix = path.join(dir, 'npm-global');
  const binDir = path.join(dir, 'fakebin');
  for (const d of [home, npmPrefix, binDir]) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(binDir, 'fake-dsh.mjs'), FAKE_DSH, 'utf8');
  fs.writeFileSync(path.join(binDir, 'fake-npm.mjs'), FAKE_NPM, 'utf8');
  writeShim(binDir, 'dsh', 'fake-dsh.mjs');
  writeShim(binDir, 'npm', 'fake-npm.mjs');

  const manifestPath = path.join(dir, 'suite-manifest.json');
  writeJson(manifestPath, { schemaVersion: 1, suite: 'fixture', items, excluded });

  const savedPath = process.env.PATH;
  const savedHome = process.env.DSH_HOME;
  const envOf = () => ({ PATH: `${binDir}${path.delimiter}${savedPath || ''}`, DSH_HOME: home });

  return {
    dir,
    home,
    npmPrefix,
    binDir,
    manifestPath,
    profile,
    /** 在假 PATH 里跑一段代码（跑完复原） */
    async withPath(fn) {
      process.env.PATH = `${binDir}${path.delimiter}${savedPath || ''}`;
      process.env.DSH_HOME = home;
      try {
        return await fn();
      } finally {
        process.env.PATH = savedPath;
        if (savedHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = savedHome;
      }
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一个插件条目（fake dsh 会登记进组合列表） */
export function pluginItem(name, extra = {}) {
  return {
    name,
    versionRange: '^0.1.0',
    type: 'plugin',
    group: '核心',
    mount: 'auto',
    probe: { kind: 'existence' },
    ...extra,
  };
}

/** 一个命令行条目（fake npm 会装到假前缀并放一个 shim） */
export function cliItem(name, cmd, extra = {}) {
  return {
    name,
    versionRange: '^0.1.0',
    type: 'cli',
    group: 'CLI',
    probe: { kind: 'existence', cmd },
    ...extra,
  };
}
