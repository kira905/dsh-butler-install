// 版本区间比对的三种状态：满足 / 不满足 / 无法比较
import { satisfies, parseRange, parseVersion, describeRange } from '../lib/semver.mjs';

export const name = '版本区间三态';

export async function run(c) {
  c.eq(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '', raw: '1.2.3' }, '解析普通版本');
  c.eq(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '', raw: 'v1.2.3' }, '解析带 v 前缀的版本');
  c.eq(parseVersion('nope'), null, '非法版本返回 null');
  c.eq(parseVersion('1.2'), null, '两段式版本不算合法');

  c.eq(parseRange('^0.4.5').op, '^', '解析插入号区间');
  c.eq(parseRange('~0.4.5').op, '~', '解析波浪号区间');
  c.eq(parseRange('0.4.5').op, '=', '解析精确版本');
  c.eq(parseRange('>=1.2'), null, '不支持的写法返回 null');

  // 满足
  c.eq(satisfies('^0.4.5', '0.4.6'), 'yes', '^0.4.5 接受 0.4.6');
  c.eq(satisfies('^0.4.5', '0.4.5'), 'yes', '下界本身满足');
  c.eq(satisfies('^1.2.3', '1.9.9'), 'yes', '^1.2.3 的上界是 2.0.0');
  c.eq(satisfies('~0.4.5', '0.4.9'), 'yes', '~0.4.5 向上接受同 minor');
  c.eq(satisfies('0.4.5', '0.4.5'), 'yes', '精确版本相等');

  // 不满足
  c.eq(satisfies('^0.4.5', '0.5.0'), 'no', '^0.4.5 不接受 0.5.0（0.x 只允许改补丁号）');
  c.eq(satisfies('^0.4.5', '0.4.4'), 'no', '低于下界');
  c.eq(satisfies('^0.0.3', '0.0.4'), 'no', '0.0.x 只接受自己');
  c.eq(satisfies('^1.2.3', '2.0.0'), 'no', '^1.2.3 的上界不含 2.0.0');
  c.eq(satisfies('~0.4.5', '0.5.0'), 'no', '~ 不接受跨 minor');
  c.eq(satisfies('0.4.5', '0.4.6'), 'no', '精确版本不接受邻居');

  // 无法比较：这是本工具唯一允许"不当通过也不报红"的状态
  c.eq(satisfies('^0.4.5', '0.4.6-rc.1'), 'unknown', '带预发布后缀的实体版本一律无法比较');
  c.eq(satisfies('^0.4.5', 'garbage'), 'unknown', '实体版本解析不了 → 无法比较');
  c.eq(satisfies('>=1.2', '1.3.0'), 'unknown', '区间写法不支持 → 无法比较');

  c.contains(describeRange(parseRange('^0.4.5')), '< 0.5.0', '人读文案要写出上界');
  c.contains(describeRange(parseRange('~0.4.5')), '< 0.5.0', '波浪号的人读文案');
  c.contains(describeRange(parseRange('0.4.5')), '= 0.4.5', '精确版本的人读文案');
}
