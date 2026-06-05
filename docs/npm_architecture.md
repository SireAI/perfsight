# NPM Package Architecture

PerfSight 的 npm 版本采用纯 Node.js ESM + 标准库实现，目标是直接发布为 CLI 包，不依赖编译型构建步骤，但具备正式的 npm release 流程。

## 发布入口

- `package.json`
  - `bin.perfsight`：主 CLI
  - `bin.adb-perf-watch`：兼容命令别名
  - `exports`：开放 SDK 入口
  - `publishConfig.access`：公开包发布
  - `repository/homepage/bugs`：GitHub 包元数据
- `bin/perfsight.js`
  - 只保留 shebang 和 CLI 启动，不承载业务逻辑
- `scripts/release.mjs`
  - 负责 release status / prepare / preflight / check / pack / publish / tag

## 分层

```text
bin/
  perfsight.js

src/
  cli/        参数解析、help 输出
  app/        应用编排，组装采样、判定、Web、报表
  adb/        adb shell/pull/process 封装
  parsers/    /proc、top、dumpsys meminfo 纯解析器
  sampling/   进程采样、CPU/PSS sample 构建
  leak/       结构规则 + 最大 Java Heap 水位规则
  capture/    HPROF dump、pull、本地 manifest
  storage/    CSV、session meta
  web/        本地 HTTP API、WebState、轻量前端
  report/     离线 HTML 报表
  core/       时间、格式化等通用工具
```

## 核心数据流

```text
CLI args
  -> app/run
  -> AdbClient
  -> PackageCollector.snapshot()
  -> buildSample(prev, curr)
  -> LeakJudge.evaluate(sample)
  -> HprofCapture.capture(sample)
  -> SampleWriter / WebState / Report
```

## 设计约束

- CLI 层不直接调用 adb。
- parser 模块保持纯函数，便于后续加单元测试。
- leak 模块只关心 sample 和配置，不关心文件、Web 或 adb。
- capture 模块只负责 HPROF 现场保留，不负责判定。
- app/run 是唯一编排层，负责生命周期和模块连接。

## 已废弃规则

旧 Java Heap 趋势窗口规则不再参与架构：

- 不再保留 `--leak-window-sec`
- 不再保留 `--leak-floor-growth-mb`
- 不再保留 `--leak-growth-mb`
- 不再保留 `--leak-fallback-ratio`
- 不再保留 `--leak-pss-growth-mb`

当前泄漏捕获仅由两类规则组成：

- `struct`：`Activities - ViewRootImpl`
- `watermark`：`java_heap_mb / java_heap_max_mb`

## 发布前检查

```bash
npm run check
npm run smoke
npm pack --dry-run
```

## 正式发版流程

```bash
npm run release:preflight
npm run release:status
npm run release:prepare -- patch
npm run release:check
npm run release:pack
npm run release:publish -- --otp <code>
npm run release:tag
```

说明：

- `release:prepare` 会更新 `package.json` 版本号
- 非 snapshot 发版会同时把 `CHANGELOG.md` 的 `Unreleased` 段落滚动成正式版本
- `release:check` 和 `release:publish` 都会先执行 `npm run verify`
- `release:pack` 的产物落在 `.optimus-release/pack/`
