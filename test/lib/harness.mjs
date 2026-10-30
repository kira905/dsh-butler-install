// 夹具用的最小工具箱：计数器 + 临时目录 + 目录指纹。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function makeChecker() {
  const state = { pass: 0, fail: 0, failures: [] };
  return {
    state,
    ok(cond, msg) {
      if (cond) state.pass += 1;
      else {
        state.fail += 1;
        state.failures.push(msg);
      }
      return Boolean(cond);
    },
    eq(actual, expected, msg) {
      const good = JSON.stringify(actual) === JSON.stringify(expected);
      if (!good) state.failures.push(`${msg}（实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}）`);
      if (good) state.pass += 1; else state.fail += 1;
      return good;
    },
    contains(text, needle, msg) {
      const good = String(text).includes(needle);
      if (!good) state.failures.push(`${msg}（输出里找不到 ${JSON.stringify(needle)}）`);
      if (good) state.pass += 1; else state.fail += 1;
      return good;
    },
    notContains(text, needle, msg) {
      const good = !String(text).includes(needle);
      if (!good) state.failures.push(`${msg}（输出里不该出现 ${JSON.stringify(needle)}）`);
      if (good) state.pass += 1; else state.fail += 1;
      return good;
    },
  };
}

export function makeTempDir(prefix = 'butler-install-fixture') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** 目录指纹：所有文件的相对路径 + sha256，用来证明"dry-run 零副作用" */
export function fingerprint(dir) {
  const parts = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        parts.push(`D ${path.relative(dir, full)}`);
        walk(full);
      } else {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        parts.push(`F ${path.relative(dir, full)} ${sha}`);
      }
    }
  };
  walk(dir);
  return parts.join('\n');
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
