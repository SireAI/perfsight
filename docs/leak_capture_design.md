# Leak Capture Design

面向 `monkey` 随机测试和压测场景的内存泄漏捕获方案。

目标只包含两件事：

1. 判定当前进程是否疑似内存泄漏
2. 在满足条件时自动 dump HPROF，并把文件拉回本地

不负责：

- 实时 UI
- 全量性能分析
- 自动归因报告
- 截图、日志、线程等扩展现场

## 1. 适用边界

HPROF 主要服务于 Java/Kotlin 堆问题，所以本方案把结果分成三类：

- `NOT_LEAKING`
- `LEAK_SUSPECTED`
- `NON_JAVA_MEMORY_PRESSURE`

只有 `LEAK_SUSPECTED` 才触发 HPROF dump。

## 2. 采样输入

每个采样点至少需要这些字段：

- `timestamp`
- `pid`
- `total_pss_mb`
- `java_heap_mb`
- `native_heap_mb`
- `activities`
- `view_root_impl`

其中：

- `total_pss_mb`、`java_heap_mb`、`native_heap_mb` 来自 `dumpsys meminfo <package>` 的 `App Summary`
- `activities`、`view_root_impl` 来自 `dumpsys meminfo` 的 `Objects`

Monkey 场景不建议过高频率跑 `dumpsys meminfo`，建议通过 `--pss-interval` 控制刷新周期。

## 3. 判定思路

采用两套规则并行：

1. `结构规则`：直接看 `Activities` 与 `ViewRootImpl` 的关系
2. `最大内存水位规则`：看当前 `Java Heap` 是否达到最大 Java Heap 的配置比例

旧的 Java Heap 趋势窗口规则已经废弃，不再参与判定。

## 4. 结构规则

定义：

```text
activity_gap = Activities - ViewRootImpl
```

经验约束：

- 正常：`activity_gap <= 1`
- 可疑：`activity_gap == 2`
- 高危：`activity_gap >= 3`

状态：

- `STRUCT_NORMAL`
- `STRUCT_SUSPECTED`
- `STRUCT_HIGH_CONFIDENCE`

命中规则：

- 连续 `2` 个点满足 `activity_gap >= 2` => `STRUCT_SUSPECTED`
- 连续 `6` 个点满足 `activity_gap >= 2` => `STRUCT_HIGH_CONFIDENCE`
- 连续 `3` 个点满足 `activity_gap >= 3` => `STRUCT_HIGH_CONFIDENCE`

恢复规则：

- 连续 `3` 个点满足 `activity_gap <= 1` 后，清空结构异常计数并回到 `STRUCT_NORMAL`

## 5. 最大内存水位规则

水位规则基于最大 Java Heap：

- 优先使用 `--leak-java-max-heap-mb`
- 如果未指定，尝试读取设备属性 `dalvik.vm.heapgrowthlimit`

配置：

- `--leak-java-watch-ratio`：默认 `0.70`
- `--leak-java-dump-ratio`：默认 `0.80`

状态：

- `WATERMARK_NORMAL`
- `WATERMARK_SUSPECTED`
- `WATERMARK_HIGH_CONFIDENCE`

命中规则：

- `java_heap_mb / java_heap_max_mb >= leak_java_watch_ratio` => `WATERMARK_SUSPECTED`
- `java_heap_mb / java_heap_max_mb >= leak_java_dump_ratio` => `WATERMARK_HIGH_CONFIDENCE`

如果无法获取最大 Java Heap，水位规则不参与判定。

## 6. Dump 决策

满足任一条件即可触发自动 dump：

1. `WATERMARK_HIGH_CONFIDENCE`
2. `STRUCT_SUSPECTED` 且 `WATERMARK_SUSPECTED`
3. `STRUCT_HIGH_CONFIDENCE` 且 `total_pss_mb >= leak_dump_threshold_mb`

第 3 条是结构规则的 Total PSS 兜底项，用于 Java Heap 水位不明显但整体内存和 Activity 结构都异常的情况。

不触发 HPROF 的情况：

- `native_heap_mb` 持续增长，但 `java_heap_mb` 与结构规则都正常
- `total_pss_mb` 很高，但 `java_heap_mb`、`Activities/ViewRootImpl` 均无异常

## 7. 状态机

整体状态机如下：

```text
NORMAL
  -> WATCHING
  -> LEAK_SUSPECTED
  -> DUMP_TRIGGERED
  -> COOLDOWN
  -> NORMAL
```

说明：

- `NORMAL -> WATCHING`：结构规则或水位规则达到 suspected
- `WATCHING -> LEAK_SUSPECTED`：结构规则或水位规则达到 high confidence
- `LEAK_SUSPECTED -> DUMP_TRIGGERED`：命中 dump 决策
- `DUMP_TRIGGERED -> COOLDOWN`：dump 完成或失败
- `COOLDOWN -> NORMAL`：冷却期结束

## 8. 防误报保护

Monkey/压测场景必须有保护机制：

- `warmup_sec`：启动后先采样，不做泄漏判定
- `cooldown_sec`：一次 dump 后一段时间内不再重复 dump
- `max_dumps_per_pid`：限制单个 pid 的自动 dump 次数
- `max_dumps_per_session`：限制单次会话的自动 dump 次数

若检测到 `pid` 变化：

- 清空结构计数
- 重新进入 `warmup`

## 9. Dump 与文件拉取

工具产出一个本地事件目录：

```text
captures/
  <package>/
    <timestamp>_pid<pid>/
      <package>_<timestamp>_pid<pid>.hprof
      <package>_<timestamp>_pid<pid>.json
```

dump 行为：

- 在设备侧通过 `am dumpheap -g <pid> <remote_path>` 生成 HPROF
- 等待远端文件稳定
- 通过 `adb pull` 拉回本地
- 删除设备侧临时文件

## 10. Manifest 内容

`manifest.json` 保留最小必要信息：

```json
{
  "package": "com.example.app",
  "pid": 12345,
  "timestamp": "2026-06-03T15:30:12+08:00",
  "dump_type": "leak",
  "primary_dump_trigger_rule": "watermark",
  "primary_dump_trigger_label": "watermark-rule",
  "reasons": [
    "java_heap_ratio=0.812",
    "java_heap_max_mb=512.0",
    "watermark-high-confidence"
  ],
  "leak_rule_types": ["watermark"],
  "leak_struct_state": "struct-normal",
  "leak_watermark_state": "watermark-high-confidence",
  "java_heap_mb": 416.0,
  "native_heap_mb": 72.0,
  "total_pss_mb": 680.0,
  "activities": 1,
  "view_root_impl": 1,
  "activity_gap": 0,
  "remote_hprof_size": 123456789,
  "local_hprof_path": "/abs/path/to/heap.hprof"
}
```

## 11. 最小配置

```yaml
warmup_sec: 10

java_heap_max_mb: 0
java_heap_watch_ratio: 0.70
java_heap_dump_ratio: 0.80
dump_threshold_mb: 256

struct_gap_suspect: 2
struct_gap_high: 3
struct_suspect_hits: 2
struct_high_hits: 6
struct_high_gap_hits: 3
struct_recover_hits: 3

cooldown_sec: 900
max_dumps_per_pid: 2
max_dumps_per_session: 3
```

## 12. 默认推荐决策表

| 条件 | 结果 |
| --- | --- |
| `activity_gap <= 1` 且水位正常 | `NOT_LEAKING` |
| `activity_gap >= 2` 连续短时出现 | `WATCHING` |
| `WATERMARK_SUSPECTED` | `WATCHING` |
| `WATERMARK_HIGH_CONFIDENCE` | `DUMP_TRIGGERED` |
| `STRUCT_SUSPECTED + WATERMARK_SUSPECTED` | `DUMP_TRIGGERED` |
| `STRUCT_HIGH_CONFIDENCE` 且 `total_pss_mb >= dump_threshold_mb` | `DUMP_TRIGGERED` |
| 仅 `native_heap_mb` 异常 | `NON_JAVA_MEMORY_PRESSURE` |

## 13. 一句话版本

在 Monkey/压测场景中，工具以 `Activities - ViewRootImpl` 的持续异常作为结构信号，以当前 `Java Heap` 接近最大 Java Heap 作为水位信号；当高置信规则成立时，自动 dump HPROF 并把文件拉回本地。
