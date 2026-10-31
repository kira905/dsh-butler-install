#!/usr/bin/env node
/**
 * 产出一个**自足的 Windows exe**（给不会敲命令的人：网盘下载 → 双击 → 出界面）。
 *
 * 一条命令：`npm run build:exe`  （等价 `node scripts/build-exe.mjs`）
 * 产物：`dist/dsh-butler-install-<版本>-win-x64.exe`
 *
 * 三步，一步都不能省（换路线前先看每步为什么）：
 *  ① **esbuild** 把 `scripts/sea-entry.mjs` 连同 `lib/` 打成**单文件 CJS**
 *    —— Node SEA 只吃 CommonJS，ESM 进去会报错；`lib/` 里只有相对 import，没有原生依赖，打得动。
 *  ② `node --experimental-sea-config` 把单文件 + 内嵌的 `suite-manifest.json` 打包成 **blob**
 *    —— 清单必须进 blob：exe 拷到空目录要能起界面，不能去旁边找 `suite-manifest.json`。
 *  ③ 复制**本机那份** `node.exe`，用 **postject** 把 blob 注进去 → 改名 `.exe`
 *    —— 用户机器上没 node 也能跑（内置运行时），代价是体积 ~80MB+。
 *
 * 不做的三件事（都是刻意的）：
 *  · 不装 Electron / 任何重型壳（产物会到几百 MB，还要处理原生依赖）；
 *  · 不把 exe 提交进 git（`.gitignore` 里有 `dist/`，exe 走网盘）；
 *  · 不改 `package.json` 的 `files`（exe 是分发物，不是 npm 包内容）。
 *
 * 为什么 require 本机 node.exe：SEA 的 blob 必须注入到**同版本**的 node 可执行文件里；
 * 换机器构建时用那台的 node 就行，别从别处抄一个 exe 过来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** SEA 注入的固定 sentinel（Node 官方文档里的常量，不能改） */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`);
  process.exitCode = 1;
}

function run(cmd, args, { label, cwd = repoRoot, timeoutMs = 10 * 60 * 1000 } = {}) {
  const shown = `${cmd} ${args.join(' ')}`;
  process.stdout.write(`\n▶ ${label || shown}\n`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw new Error(`${label || shown} 起不来：${result.error.code || result.error.message}`);
  if (result.status !== 0) throw new Error(`${label || shown} 失败（退出码 ${result.status}）`);
}

/** postject 的 CLI 入口（走 node 调 js，别依赖 .cmd 壳：那玩意在 PATH 里不一定有） */
function postjectCli() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

async function main() {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version;
  const platformTag = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const exeName = `dsh-butler-install-${version}-${platformTag}${process.platform === 'win32' ? '.exe' : ''}`;

  const buildDir = path.join(repoRoot, 'dist', '_build');
  const distDir = path.join(repoRoot, 'dist');
  const bundlePath = path.join(buildDir, 'sea-bundle.cjs');
  const blobPath = path.join(buildDir, 'sea-prep.blob');
  const configPath = path.join(buildDir, 'sea-config.json');
  const manifestPath = path.join(repoRoot, 'suite-manifest.json');
  const exePath = path.join(distDir, exeName);

  // 0) 前置：依赖装没装、清单在不在、本机 node 能不能当模板
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    fail('没找到 esbuild。先在这个仓里跑一次  npm install  （devDependencies：esbuild / postject）');
    return;
  }
  const postject = postjectCli();
  if (!postject) {
    fail('没找到 postject。先在这个仓里跑一次  npm install');
    return;
  }
  if (!fs.existsSync(manifestPath)) {
    fail(`清单不在：${manifestPath}（exe 要把清单内嵌进去，没清单做不出自足的产物）`);
    return;
  }
  const nodeExe = process.execPath;
  if (!fs.existsSync(nodeExe)) {
    fail(`找不到本机 node.exe（${nodeExe}）—— SEA 要注入到同版本的可执行文件里`);
    return;
  }

  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  process.stdout.write(`\nDSH 管家套装 · exe 构建\n  版本 ${version}\n  模板 ${nodeExe}（node ${process.version}）\n  产物 ${exePath}\n`);

  // ① esbuild：ESM → 单文件 CJS
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'scripts', 'sea-entry.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // SEA 里没有"这个文件的 URL"，而 lib/plan.mjs 要拿它算 DEFAULT_MANIFEST。
    // esbuild 在 cjs 输出下会把 `import.meta.url` 换成 CJS 等价物（见下面 build 之后的兜底核验）；
    // 这里只注入版本号（define 的值必须是字面量，不能塞表达式）。
    define: {
      __DSH_INSTALL_EXE_VERSION__: JSON.stringify(version),
    },
    logLevel: 'warning',
    metafile: true,
  });
  // 🔴 esbuild 的 cjs 输出会把 `import.meta.url` 换成 `var import_meta = {};` 再用 `import_meta.url`
  //    —— 那是 `undefined`，而 lib/plan.mjs 顶层要 `fileURLToPath(import.meta.url)` ⇒ **启动即崩**。
  //    SEA 里也不存在"这个脚本的 URL"，CJS 等价物就是 `pathToFileURL(__filename)`（__filename = exe 路径）。
  //    所以这里按文本补上（只影响拼接路径；清单真正的来源是内嵌 asset，命不中磁盘也不会炸）。
  const bundleText = fs.readFileSync(bundlePath, 'utf8');
  const patched = bundleText
    // 函数式替换：模板里的 `$` 不会被 String.replace 当捕获组展开
    .replace(/var (import_meta\d*) = \{\};/g, (whole, name) => `var ${name} = { url: require("url").pathToFileURL(__filename).href };`)
    .split('import.meta.url').join('require("url").pathToFileURL(__filename).href');
  if (patched !== bundleText) fs.writeFileSync(bundlePath, patched, 'utf8');

  // 核验：凡是引用 `import_metaN.url` 的地方，声明必须已经被补上 url（fail-closed，别做个看起来绿的空壳）
  const missingMeta = [...new Set([...patched.matchAll(/\b(import_meta\d*)\.url\b/g)].map((m) => m[1]))]
    .filter((name) => !new RegExp(`var ${name} = \\{ url: require\\("url"\\)`).test(patched));
  if (missingMeta.length) {
    fail(`bundle 里这些 import.meta 垫片没补上：${missingMeta.join(', ')}（esbuild 的产物形态变了，去 scripts/build-exe.mjs 改补丁）`);
    return;
  }
  const bundleSize = fs.statSync(bundlePath).size;
  process.stdout.write(`  ① 单文件 CJS：${path.relative(repoRoot, bundlePath)}（${human(bundleSize)}）\n`);

  // ② SEA blob：单文件 + 内嵌清单
  const seaConfig = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    assets: {
      // key 就是运行时 `sea.getAsset('suite-manifest.json')` 用的名字
      'suite-manifest.json': manifestPath,
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8');
  run(process.execPath, ['--experimental-sea-config', configPath], { label: '② 生成 SEA blob' });
  if (!fs.existsSync(blobPath)) {
    fail('SEA blob 没生成出来（node --experimental-sea-config 没报错但产物不在）');
    return;
  }
  const blobSize = fs.statSync(blobPath).size;
  process.stdout.write(`  ② blob：${path.relative(repoRoot, blobPath)}（${human(blobSize)}）\n`);

  // ③ 复制 node.exe + postject 注入
  fs.copyFileSync(nodeExe, exePath);
  run(process.execPath, [
    postject,
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ], { label: '③ 注入 blob（postject）' });

  const exeSize = fs.statSync(exePath).size;
  if (exeSize < 5 * 1024 * 1024) {
    fail(`产物只有 ${human(exeSize)}，不像一个带运行时的 exe（注入可能没生效）`);
    return;
  }

  process.stdout.write('\n✔ 构建完成\n');
  process.stdout.write(`  产物：${exePath}\n`);
  process.stdout.write(`  大小：${human(exeSize)}（node.exe ${human(fs.statSync(nodeExe).size)} + 单文件 ${human(bundleSize)} + blob ${human(blobSize)}）\n`);
  process.stdout.write('  中间件留在 dist/_build/（排障用；dist/ 不进 git）\n');
  process.stdout.write(`  平台：${os.platform()} ${os.arch()} · node ${process.version}\n`);
  process.stdout.write('\n  下一步：双击它试一次（第一次会被 SmartScreen 拦一下，点「更多信息」→「仍要运行」）。\n');
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
