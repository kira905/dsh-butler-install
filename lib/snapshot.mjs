/**
 * 整批回滚要用的快照。
 *
 * 拍的是**声明层**文件：`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`，
 * 外加 `pnpm-workspace.yaml` —— 最后这份是实测踩出来的：装包时包管理器的
 * minimumReleaseAge 机制会往 profile 里写这份文件，它同样是声明层，不拍就漏。
 * 四份都是"文件本来就存在才拍"，没有就不拍、回滚时也不凭空造出来。
 * 🔴 诚实边界：`node_modules` 里的物理文件**不在快照内**。`dsh plugin remove` 能摘掉
 * 依赖链接，但清不干净包管理器自己的缓存与虚拟store。所以快照文件里固定带一个
 * `warning` 字段，回滚后报告必须把这句念出来 —— 不然用户会以为"回滚 = 什么都没变"。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml'];

export const SNAPSHOT_WARNING =
  '快照只覆盖声明层文件（package.json / pnpm-lock.yaml / cordis.patch.yml，以及包管理器自己会写的 pnpm-workspace.yaml）；node_modules 里的实体文件与包管理器缓存不在快照内，回滚不会还原它们。';

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256OrNull(file) {
  try {
    return sha256(file);
  } catch {
    return null;
  }
}

/** 拍快照：把三份文件（存在的）复制到 dir，并写下每份的 sha256 */
export function takeSnapshot({ profileDir, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = SNAPSHOT_FILES.map((name, index) => {
    const source = path.join(profileDir, name);
    const existed = fs.existsSync(source);
    const savedAs = existed ? `${String(index + 1).padStart(2, '0')}-${name}` : null;
    if (existed) fs.copyFileSync(source, path.join(dir, savedAs));
    return {
      name,
      existed,
      savedAs,
      sha256: existed ? sha256OrNull(source) : null,
      bytes: existed ? fs.statSync(source).size : 0,
    };
  });
  const record = {
    kind: 'butler-install-snapshot',
    createdAt: new Date().toISOString(),
    profileDir,
    warning: SNAPSHOT_WARNING,
    files,
  };
  fs.writeFileSync(path.join(dir, 'snapshot.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function readSnapshot(dir) {
  const file = path.join(dir, 'snapshot.json');
  if (!fs.existsSync(file)) throw new Error(`快照目录里没有 snapshot.json：${dir}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 重放快照：存在的文件按原样写回，原本不存在的文件（例如首次装前 profile 里还没有
 * cordis.patch.yml）**要从目标删掉**，否则"回滚"会留下一份凭空出现的文件。
 */
export function restoreSnapshot({ dir, profileDir }) {
  const record = readSnapshot(dir);
  const actions = [];
  for (const entry of record.files) {
    const target = path.join(profileDir, entry.name);
    if (entry.existed) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, entry.savedAs), target);
      actions.push({ name: entry.name, action: 'restored', sha256: sha256OrNull(target) });
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      actions.push({ name: entry.name, action: 'removed(装前不存在)', sha256: null });
    } else {
      actions.push({ name: entry.name, action: 'noop(装前不存在，现在也没有)', sha256: null });
    }
  }
  return actions;
}

/** 回滚后的核对：三份文件的 sha256 必须逐份回到快照值 */
export function verifySnapshotRestored({ dir, profileDir }) {
  const record = readSnapshot(dir);
  const mismatches = [];
  for (const entry of record.files) {
    const target = path.join(profileDir, entry.name);
    const now = sha256OrNull(target);
    if (entry.existed) {
      if (now !== entry.sha256) {
        mismatches.push({ name: entry.name, expected: entry.sha256, actual: now, problem: now === null ? '文件不见了' : '内容与快照不一致' });
      }
    } else if (now !== null) {
      mismatches.push({ name: entry.name, expected: null, actual: now, problem: '装前不存在、回滚后却还在' });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
