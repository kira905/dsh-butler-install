// 快照 / 回放 / 核对：装前不存在的文件，回滚后必须"也不存在"
import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_FILES, SNAPSHOT_WARNING, takeSnapshot, restoreSnapshot, verifySnapshotRestored, sha256 } from '../lib/snapshot.mjs';
import { makeTempDir, writeJson } from './lib/harness.mjs';

export const name = '快照与回滚';

export async function run(c) {
  const dir = makeTempDir('butler-install-snapshot');
  const profileDir = path.join(dir, 'profile');
  const snapDir = path.join(dir, 'snap');
  fs.mkdirSync(profileDir, { recursive: true });

  writeJson(path.join(profileDir, 'package.json'), { name: 'dsh-profile-x', dependencies: {} });
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  const originalSha = sha256(path.join(profileDir, 'package.json'));

  const record = takeSnapshot({ profileDir, dir: snapDir });
  c.eq(record.files.map((f) => f.name), SNAPSHOT_FILES, '快照只拍三份声明层文件');
  c.eq(record.files.find((f) => f.name === 'cordis.patch.yml').existed, false, '装前没有的 patch 文件要记成不存在');
  c.eq(record.files.find((f) => f.name === 'package.json').sha256, originalSha, '快照要记下 sha256');
  c.contains(record.warning, 'node_modules', '快照里必须写明"node_modules 不在快照内"');
  c.eq(record.warning, SNAPSHOT_WARNING, 'warning 文案要来自同一处常量');

  // 模拟"装了一步"：改动 package.json、新建 patch 文件
  writeJson(path.join(profileDir, 'package.json'), { name: 'dsh-profile-x', dependencies: { '@fake/one': '^0.1.0' } });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8');
  c.eq(verifySnapshotRestored({ dir: snapDir, profileDir }).ok, false, '改过之后核对必须判"不干净"');

  const actions = restoreSnapshot({ dir: snapDir, profileDir });
  c.eq(actions.find((a) => a.name === 'package.json').action, 'restored', '存在的文件要写回');
  c.eq(actions.find((a) => a.name === 'cordis.patch.yml').action.includes('removed'), true, '装前不存在的文件要删掉');
  c.eq(sha256(path.join(profileDir, 'package.json')), originalSha, '回放后 sha256 必须回到快照值');
  c.eq(fs.existsSync(path.join(profileDir, 'cordis.patch.yml')), false, '装前不存在的 patch 文件回滚后不该冒出来');
  c.eq(verifySnapshotRestored({ dir: snapDir, profileDir }).ok, true, '回放干净时核对要通过');

  // 篡改后再核对：必须报出是哪一份、什么问题
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# 被别人改过\n', 'utf8');
  const broken = verifySnapshotRestored({ dir: snapDir, profileDir });
  c.eq(broken.ok, false, '被篡改后核对必须失败');
  c.eq(broken.mismatches[0].name, 'pnpm-lock.yaml', '要指出是哪一份文件对不上');
  c.contains(broken.mismatches[0].problem, '不一致', '要说明问题类型');

  // 快照记录本身丢了 ⇒ 回放要抛错（调用方据此判 rc 4，而不是装作成功）
  fs.rmSync(path.join(snapDir, 'snapshot.json'));
  let threw = false;
  try {
    restoreSnapshot({ dir: snapDir, profileDir });
  } catch {
    threw = true;
  }
  c.eq(threw, true, '快照记录缺失时回放必须抛错');

  fs.rmSync(dir, { recursive: true, force: true });
}
