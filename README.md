# PerfSight

一个面向 Android App 的本地实时观测工具，目标是替代简单的 `watch adb shell ...` 方式，支持：

- 可配置采样间隔，默认 `0.5s`
- 实时显示 App CPU、TOTAL PSS、PSS 结构变化
- 支持本地 HTML 网页实时折线图
- `web` 模式可自动打开浏览器
- 结束采样时自动导出离线 HTML 报表
- 持续归档到 CSV 文件
- npm CLI 形态发布，纯 Node.js 标准库实现，不依赖第三方包
- 内置正式的 npm release 流程，可做 dry-run、pack、publish、tag

泄漏捕获规则设计见：

- [docs/leak_capture_design.md](docs/leak_capture_design.md)
- [docs/product.md](docs/product.md)
- [docs/npm_architecture.md](docs/npm_architecture.md)

## 方案

直接每 `0.5s` 跑一次 `dumpsys meminfo` 不稳定，开销也偏大。所以实现拆成两层：

- 高频层：每个采样周期读取 `/proc/stat` 和 `/proc/<pid>/stat`，用差分计算 App CPU
- CPU 降级：如果 `/proc/<pid>/stat` 读取失败，自动退化到 `top -b -n 1 -p <pid>` 解析 CPU 占用，并在输出中标记 `cpu_source=top`
- 低频层：每隔一段时间再跑一次 `dumpsys meminfo <package>`，提取 `TOTAL PSS` 和 `App Summary` 结构项，比如 `Java Heap`、`Native Heap`、`Graphics`、`Private Other`、`System`

这样可以同时满足“0.5 秒级实时观测 CPU”和“低频但更准确地观察 PSS 总量与结构”的目标。

## 用法

本地开发运行：

```bash
npm run text -- com.mi.car.mobile
```

发布后运行：

```bash
npx @perfsight/cli text com.mi.car.mobile
```

也可以全局安装：

```bash
npm install -g @perfsight/cli
perfsight text com.mi.car.mobile
```

查看帮助：

```bash
npm run help
npm run help -- text
npm run help -- web
npm run help -- leak-capture
```

旧 Python 脚本保留在 `tools/adb_perf_watch.py`，作为历史参考实现。

模式一：纯命令行模式

```bash
perfsight text com.mi.car.mobile
```

开发调试时对应命令：

```bash
npm run text -- com.mi.car.mobile
```

纯命令行模式并开启泄漏检测：

```bash
perfsight text com.mi.car.mobile --enable-leak-capture
```

开发调试时对应命令：

```bash
npm run text -- com.mi.car.mobile --enable-leak-capture
```

模式二：Web 模式

```bash
perfsight web com.mi.car.mobile
```

开发调试时对应命令：

```bash
npm run web -- com.mi.car.mobile
```

Web 模式并开启泄漏检测：

```bash
perfsight web com.mi.car.mobile --enable-leak-capture
```

开发调试时对应命令：

```bash
npm run web -- com.mi.car.mobile --enable-leak-capture
```

默认会自动打开浏览器，并且结束采样后会自动导出离线 HTML 报表。

指定网页端口：

```bash
perfsight web com.mi.car.mobile --port 9000
```

指定采样间隔：

```bash
perfsight text com.mi.car.mobile --interval 1.0
```

指定 PSS 刷新周期：

```bash
perfsight text com.mi.car.mobile --interval 0.5 --pss-interval 3
```

常用泄漏判定参数：

- `--enable-leak-capture`
- `--leak-java-max-heap-mb`
- `--leak-java-watch-ratio`
- `--leak-java-dump-ratio`
- `--leak-dump-threshold-mb`
- `--leak-cooldown-sec`
- `--leak-dump-dir`

说明：

- `--leak-java-max-heap-mb` 不指定时会尝试读取设备上的 `dalvik.vm.heapgrowthlimit`
- `--leak-java-watch-ratio` 默认 `0.70`，达到最大 Java Heap 的 70% 后进入观察态
- `--leak-java-dump-ratio` 默认 `0.80`，达到最大 Java Heap 的 80% 后判定为高水位
- `--leak-dump-threshold-mb` 仅作为结构规则触发 dump 时的 Total PSS 兜底阈值
- `warmup` 与结构 gap 阈值使用内置默认值，不再作为 CLI 参数暴露

指定设备：

```bash
perfsight text com.mi.car.mobile --serial <device-id>
```

## 输出

默认会在 `data/` 目录下生成两个文件：

- `*.csv`：每次采样的归档数据
- `*.json`：本次会话的元信息
- `*_report.html`：会话结束后导出的离线报表

如果使用 `web` 模式，脚本还会启动一个本地 HTTP 服务，默认地址：

```bash
http://127.0.0.1:8765
```

页面会实时展示：

- CPU 折线
- TOTAL PSS 折线
- PSS breakdown 堆叠图
- 当前采样状态、PID、CPU 来源、当前结构拆分表

停止采样后，离线报表会自动导出，报表包含：

- 整段会话的 CPU / TOTAL PSS 曲线
- PSS breakdown 结构堆叠图
- 峰值统计
- 会话开始/结束时间
- 当前结构拆分和数据文件路径

会话结束后会自动导出离线报表。

CSV 字段包括：

- `timestamp_iso`
- `app_cpu_pct`
- `pss_mb`
- `java_heap_mb`
- `native_heap_mb`
- `activities`
- `view_root_impl`
- `activity_gap`
- `leak_status`
- `pss_breakdown_json`
- `pid_count`
- `pids`
- `status`
- `cpu_source`

## npm 发布检查

```bash
npm run check
npm test
npm run smoke
npm pack --dry-run --cache /private/tmp/perfsight-npm-cache
```

## npm 正式发版

发版前先确认 npm 登录态和 registry：

```bash
npm run release:preflight
```

查看当前 package 版本和 changelog 发布状态：

```bash
npm run release:status
```

准备一个正式版本：

```bash
npm run release:prepare -- patch
```

或者准备一个 snapshot 版本：

```bash
npm run release:prepare -- snapshot
```

发版链路建议顺序：

```bash
npm run release:check
npm run release:pack
npm run release:publish -- --otp <code>
npm run release:tag
```

snapshot 渠道使用：

```bash
npm run release:check:snapshot
npm run release:publish:snapshot -- --otp <code>
```

其中：

- `release:check` 会先执行 `npm run verify`，再跑 `npm publish --dry-run`
- `release:pack` 会在 `.optimus-release/pack/` 下产出可检查的 tarball
- `release:publish` 会先执行 `npm run verify`，再执行正式 `npm publish`
- `release:tag` 会按当前版本创建 `v<version>` git tag

## 注意

- CPU 百分比是基于相邻两次采样间隔的差分值，不是 Android Studio 那种长期平均值
- 内存展示已经收敛到 `PSS` 口径，不再强调 `RSS`
- `PSS breakdown` 依赖 `dumpsys meminfo` 的 `App Summary` 字段，不同 Android 版本字段可能略有差异
- 如果 App 重启或 PID 变化，CSV 中会记录 `pid changed` 或 `process exited`
