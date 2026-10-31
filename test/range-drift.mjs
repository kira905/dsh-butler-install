#!/usr/bin/env node
/**
 * 判据件：清单里的 versionRange 还接不接受 npm 上真正装得到的 latest。
 *
 * 为什么要有它 —— 清单是单一真相，但真相会烂：写清单那天按当天的 latest 填区间，
 * 之后某个包跨了 0.x 的小版本（0 版本阶段里这就是"大版本"），caret 的上界就把新版
 * 挡在门外。于是照清单装一遍拿到的是旧一套，而且**装后自检还是绿的** —— 它读同一份
 * 清单、同样认为旧版本"符合期望"。两处一致地错，比不一致更难发现，所以判据必须
 * 对着清单外面的世界（registry）核，不能自己核自己。
 *
 * 两种取数路子，都是只读：
 *   node test/range-drift.mjs                                  # npm view，真网络
 *   node test/range-drift.mjs --offline test/fixtures/npm-latest-snapshot.json   # 读快照，零网络
 *   node test/range-drift.mjs --manifest <path> --json          # 换清单 / 机读
 *
 * 退出码：
 *   0 全绿（每一项的区间都接受 latest）
 *   3 有漂移（至少一项不接受 latest —— 照清单装会拿到旧版）
 *   4 取数失败 / 无法判定（**绝不当通过**：判不了就说判不了）
 *   2 用法错 / 清单本身读不进来
 *
 * 三条纪律：
 *   ① `satisfies` 的 `unknown` 不算通过，也不假装是红 —— 单列一类，独立退出码。
 *   ② 只读：不写清单、不发版、不改安装器任何行为；连 registry 也只读 version 一个字段。
 *   ③ 本件既是一条命令（CLI），也是 run-all 里的一个夹具（导出 name/run），
 *      夹具部分**只用临时夹具 + 仓内快照，零网络**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadManifest, formatManifestError } from '../lib/manifest.mjs';
import { parseRange, parseVersion, compareVersions, satisfies, describeRange } from '../lib/semver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const name = '清单版本区间 vs npm latest（漂移判据）';

export const EXIT = { OK: 0, USAGE: 2, DRIFT: 3, UNRESOLVED: 4 };

/** 真网络取数时单包超时；16 个包串行最坏也不过几分钟，够用且不会挂死 */
const NPM_TIMEOUT_MS = 30000;

export const HELP_TEXT = `用法：node test/range-drift.mjs [选项]

对清单里每一项判「它写的 versionRange 是否接受 npm 上的 latest」。

选项：
  --offline <json>   改读一份快照，不联网（快照形态见 test/fixtures/npm-latest-snapshot.json）
  --manifest <path>  换一份清单（缺省 = 仓根 suite-manifest.json）
  --json             机读输出（一行一个字段，不美化）
  --quiet            只打汇总行与漂移项
  --help / -h        这份说明

退出码：0 全绿 · 3 有漂移 · 4 取数失败/无法判定 · 2 用法错
`;

/* ------------------------------------------------------------------ 参数 */

export function parseDriftArgs(argv) {
  const options = { help: false, json: false, quiet: false, manifestPath: '', offlinePath: '' };
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--manifest' || arg === '--offline') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
        errors.push(`${arg} 后面要跟一个路径`);
      } else if (arg === '--manifest') options.manifestPath = value;
      else options.offlinePath = value;
      i += 1;
    } else {
      errors.push(`不认识的参数：${arg}`);
    }
  }
  if (!options.manifestPath) options.manifestPath = path.join(here, '..', 'suite-manifest.json');
  return { options, errors };
}

/* ---------------------------------------------------------------- 取数 */

/**
 * 读快照。接受两种形态：直接映射 `{"包名": "版本"}`，或外面包一层 `{packages: {...}}`
 * （本仓快照用后者，因为要顺带记 capturedAt / source）。
 * @returns {{ok: boolean, versions: Object, meta: Object, problem?: string}}
 */
export function readSnapshot(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, versions: {}, meta: {}, problem: `读不到快照：${file}（${err.code || err.message}）` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, versions: {}, meta: {}, problem: `快照不是合法 JSON：${err.message}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, versions: {}, meta: {}, problem: '快照根节点必须是对象' };
  }
  const versions = {};
  const bag = data.packages !== undefined ? data.packages : data;
  if (bag === null || typeof bag !== 'object' || Array.isArray(bag)) {
    return { ok: false, versions: {}, meta: {}, problem: '快照里没有可用的 {包名: 版本} 映射' };
  }
  for (const [key, value] of Object.entries(bag)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'string' && value.trim()) versions[key] = value.trim();
  }
  if (!Object.keys(versions).length) {
    return { ok: false, versions: {}, meta: {}, problem: '快照里一个包版本都没有' };
  }
  return {
    ok: true,
    versions,
    meta: { capturedAt: data.capturedAt || '', source: data.source || '', registry: data.registry || '' },
  };
}

/**
 * 问 registry 要一个包的 latest（真网络）。
 * Windows 上 npm 是 .cmd，不经 shell 找不到，所以整条命令按字符串交给 shell ——
 * **不要**写成"args 数组 + shell:true"（Node 会报 DEP0190 弃用警告，噪声会混进判据输出）。
 * 包名进这里之前已被清单校验成 `@scope/name` 形态，没有空格与 shell 元字符，不是拼接注入。
 */
export function npmViewLatest(pkgName) {
  try {
    const out = execFileSync(`npm view ${pkgName} version`, {
      encoding: 'utf8',
      timeout: NPM_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (!parseVersion(line)) {
      return { ok: false, problem: `npm view 的输出不是版本号：${JSON.stringify(line.slice(0, 80))}` };
    }
    return { ok: true, version: line };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim().split(/\r?\n/)[0] : '';
    const detail = stderr || (err && err.message ? err.message : String(err));
    return { ok: false, problem: `npm view 取数失败：${detail.slice(0, 200)}` };
  }
}

/** 统一取数入口：offlinePath 有值就走快照，否则逐包问 registry */
export function collectLatest(items, { offlinePath = '' } = {}) {
  if (offlinePath) {
    const snap = readSnapshot(offlinePath);
    if (!snap.ok) return { ok: false, source: `offline:${offlinePath}`, versions: {}, meta: {}, problem: snap.problem };
    return { ok: true, source: `offline:${offlinePath}`, versions: snap.versions, meta: snap.meta, problem: '' };
  }
  const versions = {};
  const problems = [];
  for (const item of items) {
    const got = npmViewLatest(item.name);
    if (got.ok) versions[item.name] = got.version;
    else problems.push(`${item.name}：${got.problem}`);
  }
  if (Object.keys(versions).length === 0) {
    return { ok: false, source: 'npm-view', versions: {}, meta: {}, problem: problems.join('；') || '一个包的 latest 都没取到' };
  }
  return { ok: true, source: 'npm-view', versions, meta: {}, problem: problems.join('；') };
}

/* ---------------------------------------------------------------- 判定 */

/**
 * 判一项。三态 + 一句"该怎么修"。
 * @returns {{name, range, latest, verdict: 'yes'|'no'|'unknown', detail: string, hint: string}}
 */
export function classifyItem(item, versions) {
  const rangeText = item.versionRange;
  const latest = versions[item.name];
  const row = { name: item.name, range: rangeText, latest: latest || '', verdict: 'unknown', detail: '', hint: '' };
  const range = parseRange(rangeText);
  if (!range) {
    row.detail = `区间写法解析不了：${JSON.stringify(rangeText)}`;
    row.hint = '只接受 ^x.y.z / ~x.y.z / x.y.z';
    return row;
  }
  if (typeof latest !== 'string' || !latest.trim()) {
    row.detail = '这个包没有拿到 latest（快照缺项 / registry 取不到）⇒ 无法判定';
    return row;
  }
  const version = parseVersion(latest);
  if (!version) {
    row.detail = `latest 解析不了：${JSON.stringify(latest)} ⇒ 无法判定`;
    return row;
  }
  const verdict = satisfies(range, version);
  row.verdict = verdict;
  if (verdict === 'yes') {
    row.detail = `接受 latest ${latest}`;
    return row;
  }
  if (verdict === 'unknown') {
    row.detail = `带预发布后缀的 latest（${latest}）边界各家不一，本工具不猜 ⇒ 无法判定`;
    return row;
  }
  // verdict === 'no'
  const lower = { major: range.major, minor: range.minor, patch: range.patch };
  if (compareVersions(version, lower) < 0) {
    row.detail = `latest ${latest} 低于区间下界 ${rangeText}（清单超前于 registry）`;
    row.hint = `确认 registry 上真的有 ${rangeText} 及以上的版本；没有就把区间降回 ^${latest}`;
  } else {
    row.detail = `latest ${latest} 落在区间外（${describeRange(range)}）`;
    row.hint = `把区间刷成 ^${version.major}.${version.minor}.${version.patch}`;
  }
  return row;
}

/* ---------------------------------------------------------------- 汇报 */

function padRight(text, width) {
  const s = String(text);
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

export function formatRows(rows, { quiet = false } = {}) {
  const lines = [];
  const shown = quiet ? rows.filter((r) => r.verdict !== 'yes') : rows;
  for (const row of shown) {
    const mark = row.verdict === 'yes' ? '✅' : row.verdict === 'no' ? '✖' : '？';
    lines.push(`${mark}  ${padRight(row.name, 34)}${padRight(row.range, 10)}${row.detail}`);
    if (row.hint) lines.push(`     ${' '.repeat(34)}↳ ${row.hint}`);
  }
  return lines.join('\n');
}

export function summarize(rows) {
  const summary = { total: rows.length, ok: 0, drift: 0, unresolved: 0 };
  for (const row of rows) {
    if (row.verdict === 'yes') summary.ok += 1;
    else if (row.verdict === 'no') summary.drift += 1;
    else summary.unresolved += 1;
  }
  return summary;
}

export function evaluate({ manifestPath, offlinePath = '', json = false, quiet = false } = {}) {
  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err) {
    const text = formatManifestError(err, path.basename(manifestPath || 'suite-manifest.json'));
    return { exitCode: EXIT.USAGE, manifestPath, source: '', summary: null, rows: [], text, problem: text };
  }

  const fetched = collectLatest(manifest.items, { offlinePath });
  if (!fetched.ok) {
    const text = [
      `清单：${manifest.path}`,
      `✖ 取不到 latest（来源 ${fetched.source}）：${fetched.problem}`,
      '  取数失败不等于通过：本件按「无法判定」退出 4，别把这条红当噪声。',
    ].join('\n');
    return { exitCode: EXIT.UNRESOLVED, manifestPath: manifest.path, source: fetched.source, summary: null, rows: [], text, problem: fetched.problem };
  }

  const rows = manifest.items.map((item) => classifyItem(item, fetched.versions));
  const summary = summarize(rows);
  const sourceNote = fetched.source.startsWith('offline:')
    ? `离线快照 ${fetched.source.slice('offline:'.length)}${fetched.meta.capturedAt ? `（取数时间 ${fetched.meta.capturedAt}）` : ''}`
    : 'npm view（真网络）';

  let exitCode = EXIT.OK;
  if (summary.drift > 0) exitCode = EXIT.DRIFT;
  else if (summary.unresolved > 0) exitCode = EXIT.UNRESOLVED;

  if (json) {
    const payload = {
      exitCode,
      manifest: manifest.path,
      source: fetched.source,
      snapshotCapturedAt: fetched.meta.capturedAt || '',
      summary,
      items: rows,
    };
    if (fetched.problem) payload.partialFetchProblem = fetched.problem;
    return { exitCode, manifestPath: manifest.path, source: fetched.source, summary, rows, text: `${JSON.stringify(payload, null, 2)}\n`, problem: fetched.problem };
  }

  const lines = [`清单：${manifest.path}`, `取数：${sourceNote}`, ''];
  const body = formatRows(rows, { quiet });
  if (body) lines.push(body, '');
  lines.push(`${summary.total} 项：${summary.ok} 接受 / ${summary.drift} 漂移 / ${summary.unresolved} 无法判定`);
  if (exitCode === EXIT.OK) {
    lines.push('✅ 全部接受：照这份清单装，拿到的是 registry 上当前发布的那一套。');
  } else if (exitCode === EXIT.DRIFT) {
    const names = rows.filter((r) => r.verdict === 'no').map((r) => `${r.name} ${r.range} → ${r.hint || '见上'}`);
    lines.push(`✖ ${summary.drift} 项漂移：照这份清单装会拿到旧版，而且装后自检照样绿（它读同一份清单）。`);
    for (const line of names) lines.push(`   · ${line}`);
    lines.push('发版前先把这些区间刷到 latest 的当前大版本，再跑一遍本命令。');
  } else {
    lines.push(`？${summary.unresolved} 项无法判定：补上取数（或刷新快照）再判，别当成通过。`);
  }
  if (fetched.problem) lines.push(`  ⚠ 部分包取数有错：${fetched.problem}`);

  return { exitCode, manifestPath: manifest.path, source: fetched.source, summary, rows, text: `${lines.join('\n')}\n`, problem: fetched.problem };
}

/* ------------------------------------------------------------- 夹具入口 */

/**
 * run-all 里的这一格：**零网络**。
 * 分两段：①用临时夹具证判据本身行为对（该绿绿、该红红、判不了不冒充通过）；
 * ②用仓内快照核真实清单（抓漂移；快照过期只会漏判，不会假红）。
 */
export async function run(c) {
  const { makeTempDir, writeJson } = await import('./lib/harness.mjs');
  const dir = makeTempDir('range-drift-fixture');
  try {
    const mkManifest = (file, items) => writeJson(file, { schemaVersion: 1, items });
    const cliItem = (pkg, range) => ({ name: pkg, versionRange: range, type: 'cli', group: 'CLI', probe: { kind: 'existence', cmd: 'x' } });

    // ① 全接受 → 0，且输出明确说"全部接受"
    const okManifest = path.join(dir, 'ok.json');
    mkManifest(okManifest, [cliItem('@fake/ok', '^0.1.0'), cliItem('@fake/ok2', '^2.0.0')]);
    const okSnap = path.join(dir, 'ok-snapshot.json');
    writeJson(okSnap, { packages: { '@fake/ok': '0.1.4', '@fake/ok2': '2.3.1' } });
    const a = evaluate({ manifestPath: okManifest, offlinePath: okSnap });
    c.eq(a.exitCode, 0, '每一项都接受 latest → 退出码 0');
    c.contains(a.text, '全部接受', '全绿时要说"全部接受"');
    c.contains(a.text, '@fake/ok2', '逐项打印（不能只给汇总）');

    // ② 有一条漂移 → 3，且给出"刷成什么"的建议值
    const driftManifest = path.join(dir, 'drift.json');
    mkManifest(driftManifest, [cliItem('@fake/ok', '^0.1.0'), cliItem('@fake/old', '^0.3.5')]);
    const driftSnap = path.join(dir, 'drift-snapshot.json');
    writeJson(driftSnap, { packages: { '@fake/ok': '0.1.4', '@fake/old': '0.4.0' } });
    const b = evaluate({ manifestPath: driftManifest, offlinePath: driftSnap });
    c.eq(b.exitCode, 3, '有一项不接受 latest → 退出码 3');
    c.eq(b.summary.drift, 1, '漂移计数 1');
    c.eq(b.summary.ok, 1, '接受计数 1');
    c.contains(b.text, '^0.4.0', '漂移项要给出建议刷成的区间');
    c.contains(b.text, '装后自检照样绿', '要说清"为什么危险"（自检读同一份清单）');
    c.eq(b.rows.find((r) => r.name === '@fake/old').verdict, 'no', '漂移项判定为 no');

    // ③ 快照缺项 → 4（无法判定绝不当通过）
    const missingSnap = path.join(dir, 'missing-snapshot.json');
    writeJson(missingSnap, { packages: { '@fake/ok': '0.1.4' } });
    const d = evaluate({ manifestPath: driftManifest, offlinePath: missingSnap });
    c.eq(d.exitCode, 4, '缺 latest → 退出码 4（不是 0 也不是 3）');
    c.eq(d.summary.unresolved, 1, '无法判定计数 1');
    c.notContains(d.text, '全部接受', '判不了的时候不许出现"全部接受"');

    // ④ 清单本身坏了 → 2，且报错带文件名与行号
    const badManifest = path.join(dir, 'bad.json');
    writeJson(badManifest, { schemaVersion: 1, items: [{ name: '@fake/x', versionRange: '>=1.2', type: 'cli', group: 'CLI', probe: { kind: 'existence', cmd: 'x' } }] });
    const e = evaluate({ manifestPath: badManifest, offlinePath: okSnap });
    c.eq(e.exitCode, 2, '清单校验不过 → 退出码 2');
    c.contains(e.text, 'bad.json', '清单报错要带文件名');
    // 行号只要求"带上"，不钉死具体数字：夹具清单的格式化方式一改，钉死的行号就成了假红
    c.ok(/bad\.json:\d+:/.test(e.text), '清单报错要带行号（形如 bad.json:4: …）');

    // ⑤ 取数一个都拿不到 → 4，绝不静默当通过
    const emptySnap = path.join(dir, 'empty-snapshot.json');
    writeJson(emptySnap, { packages: {} });
    const f = evaluate({ manifestPath: okManifest, offlinePath: emptySnap });
    c.eq(f.exitCode, 4, '快照是空的 → 退出码 4');
    c.contains(f.text, '取不到 latest', '取数失败要说清楚');

    // ⑥ 参数：--offline 后缺值要报用法错
    const g = parseDriftArgs(['--offline']);
    c.eq(g.errors.length, 1, '--offline 不带值要报用法错');
    c.eq(parseDriftArgs([]).options.manifestPath.endsWith('suite-manifest.json'), true, '缺省清单路径指向仓根清单');

    // ⑦ 真实清单 × 仓内快照（零网络）：这才是"抓漂移"的那一格
    const real = evaluate({
      manifestPath: path.join(here, '..', 'suite-manifest.json'),
      offlinePath: path.join(here, 'fixtures', 'npm-latest-snapshot.json'),
    });
    c.eq(real.rows.length, 16, '真实清单是 16 项');
    c.eq(real.summary.ok, 16, '16 项全部接受仓内快照的 latest');
    c.eq(real.exitCode, 0, '真实清单对仓内快照全绿');
    if (real.exitCode !== 0) {
      for (const row of real.rows.filter((r) => r.verdict !== 'yes')) {
        c.ok(false, `漂移：${row.name} ${row.range} vs latest ${row.latest || '<缺>'} —— ${row.detail}`);
      }
    }

    // ⑧ 快照与清单的包名集合必须一一对应：清单增删包而快照没跟，会静默漏判
    const snap = readSnapshot(path.join(here, 'fixtures', 'npm-latest-snapshot.json'));
    c.eq(snap.ok, true, '仓内快照能读');
    const { loadManifest } = await import('../lib/manifest.mjs');
    const manifest = loadManifest(path.join(here, '..', 'suite-manifest.json'));
    const manifestNames = manifest.items.map((i) => i.name).sort();
    const snapNames = Object.keys(snap.versions).sort();
    c.eq(snapNames, manifestNames, '快照包名集合与清单完全一致（清单增删包时快照必须跟着改）');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响判定 */
    }
  }
}

/* ---------------------------------------------------------------- CLI */

function main() {
  const { options, errors } = parseDriftArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = EXIT.OK;
    return;
  }
  if (errors.length) {
    for (const err of errors) process.stderr.write(`✖ ${err}\n`);
    process.stderr.write('用 --help 看可用参数。\n');
    process.exitCode = EXIT.USAGE;
    return;
  }
  const result = evaluate(options);
  process.stdout.write(result.text);
  process.exitCode = result.exitCode;
}

/** 只在"被当成命令直接跑"时执行；被 import（run-all / run-one）时什么都不做。
 *  判据用 realpath 两边比：junction 下 argv[1] 是逻辑路径、import.meta.url 是物理路径，
 *  只比字面会静默判成"没被直接跑"，命令就永远不会执行。 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
