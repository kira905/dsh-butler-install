# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

## [0.1.0] - 2026-10-30

### Added

- **薄壳安装器** `dsh-butler-install`：按清单逐包调用官方的两条原语
  （`dsh plugin --profile <p> add|remove`、`npm i -g|npm rm -g`），装完逐项核对，
  任一步失败即回滚。默认演练档（零执行、零写入），真装要显式 `--apply`。
- **清单** `suite-manifest.json`：16 项（5 插件 + 11 命令行），每项写
  包名 / 期望版本**区间** / 类型 / 组名 / 探针类型；另含 `excluded` 段说明
  「不是可安装包」的历史聚合目录。安装器与将来的装后自检共用这一份。
- **三步判据**：包实体在位（探针）/ 实体版本落在期望区间 / 插件真的进了组合列表
  —— 组合树里按"组合头恰好 1 行、条目 name 恰好 1 条、该 id 在整棵树里恰好 1 次"数次数，
  因为撞 id 时宿主不报错、只多打一行。
- **探针三种**：`existence`（默认，只查文件在不在、一条命令都不跑）/ `help`
  （**执行前先静态核源码确有 `--help` 分支**，核不到就拒跑）/ `cmd`（清单指定的只读命令，
  必须写明凭什么认定只读）。
- **两级回滚**：`--rollback`（默认，只退失败那一步）/ `--rollback=batch`（退整批）；
  快照拍声明层文件（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` /
  `pnpm-workspace.yaml`），开跑前一份、每成功一步一份；回滚后按 sha256 重核。
- **退出码三档**：`0` 全绿 / `3` 失败但已回滚干净 / `4` 失败且回滚不干净（要人看）。
- **只读取证工具** `dsh-butler-install-probe-scan`：扫包的 `bin` 源文件，逐个命令回答
  「它到底有没有实现 `--help`」，一个命令都不执行。
- **夹具** 151 条断言：清单校验（每条错误带文件名 + 行号）/ 版本区间三态 / 探针三分支 /
  组合树三条计数判据各自独立可触发 / 快照回放 / 演练档零副作用 / 退出码 0·3·4 /
  步级与整批回滚 / 卸载；另跑过 5 处变异测试（改坏判据必红、还原必绿）。
