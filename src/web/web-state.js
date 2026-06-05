import path from 'node:path';
import { sampleToJson } from '../sampling/sample.js';

export class WebState {
  constructor({
    packageName,
    intervalSec,
    csvPath,
    metaPath,
    sampleStore,
    capture,
    dumpReason,
    capabilities,
    deviceInfo,
    appMaxJavaHeapMb,
    logger
  }) {
    this.packageName = packageName;
    this.intervalSec = intervalSec;
    this.csvPath = csvPath;
    this.metaPath = metaPath;
    this.sampleStore = sampleStore;
    this.capture = capture;
    this.dumpReason = dumpReason;
    this.capabilities = capabilities;
    this.deviceInfo = deviceInfo;
    this.appMaxJavaHeapMb = appMaxJavaHeapMb || null;
    this.logger = logger || null;
    this.startedAt = new Date().toISOString();
    this.connectionStatus = 'connected';
    this.connectionNote = '';
    this.dumpHistory = [];
    this.nextDumpId = 1;
    this.dumpInProgress = false;
    this.dumpInProgressType = '';
    this.dumpInProgressMessage = '';
  }

  payload() {
    const samples = this.sampleStore.snapshot();
    return {
      package: this.packageName,
      interval_sec: this.intervalSec,
      started_at: this.startedAt,
      csv_path: this.csvPath,
      meta_path: this.metaPath,
      latest: samples.length ? sampleToJson(samples.at(-1)) : null,
      samples: samples.map(sampleToJson),
      manual_dump_enabled: Boolean(this.capture),
      manual_dump_reason: this.dumpReason,
      debuggable: Boolean(this.capabilities.debuggable),
      profileable: Boolean(this.capabilities.profileable),
      rooted: Boolean(this.capabilities.rooted),
      device_info: this.deviceInfo,
      app_max_java_heap_mb: this.appMaxJavaHeapMb,
      connection_status: this.connectionStatus,
      connection_note: this.connectionNote,
      dump_in_progress: this.dumpInProgress,
      dump_in_progress_type: this.dumpInProgressType,
      dump_in_progress_message: this.dumpInProgressMessage,
      dump_history: [...this.dumpHistory].reverse(),
      last_dump_event: this.dumpHistory.at(-1) || null
    };
  }

  async triggerManualDump() {
    if (!this.capture) {
      throw new Error(this.dumpReason || 'manual dump unavailable');
    }
    const sample = this.sampleStore.latest();
    if (!sample || sample.pids.length === 0) {
      throw new Error('no running main process available');
    }
    this.dumpInProgress = true;
    this.dumpInProgressType = 'manual';
    this.dumpInProgressMessage = 'manual HPROF capture in progress';
    await this.logger?.info('开始手动触发 HPROF dump', {
      package: this.packageName,
      pid: sample.pids[0] || null
    });
    try {
      const result = await this.capture.capture(sample, ['manual-trigger'], 'manual');
      sample.dumpHprofPath = result.hprofPath;
      sample.dumpManifestPath = result.manifestPath;
      sample.dumpType = 'manual';
      sample.note = joinNote(sample.note, `manual hprof dumped: ${path.basename(result.hprofPath)}`);
      await this.logger?.info('手动 HPROF dump 成功', {
        package: this.packageName,
        hprof_path: result.hprofPath,
        manifest_path: result.manifestPath
      });
      return this.recordDump(sample, 'manual', result);
    } catch (error) {
      await this.logger?.error('手动 HPROF dump 失败', {
        package: this.packageName,
        error: String(error?.message || error)
      });
      throw error;
    } finally {
      this.dumpInProgress = false;
      this.dumpInProgressType = '';
      this.dumpInProgressMessage = '';
    }
  }

  recordDumpFromSample(sample) {
    if (!sample.dumpHprofPath || !sample.dumpManifestPath) return null;
    return this.recordDump(sample, sample.dumpType || 'leak', {
      hprofPath: sample.dumpHprofPath,
      manifestPath: sample.dumpManifestPath
    });
  }

  recordDump(sample, dumpType, result) {
    const existing = this.dumpHistory.find((event) => event.dump_manifest_path === result.manifestPath);
    if (existing) return existing;
    const event = {
      id: this.nextDumpId++,
      timestamp: sample.timestamp,
      timestamp_iso: sample.timestampIso,
      package: sample.package,
      pid: sample.pids[0] || null,
      dump_type: dumpType,
      dump_hprof_path: result.hprofPath,
      dump_manifest_path: result.manifestPath,
      dump_hprof_name: path.basename(result.hprofPath),
      dump_manifest_name: path.basename(result.manifestPath),
      pss_mb: sample.pssMb ?? null,
      java_heap_mb: sample.javaHeapMb ?? null,
      native_heap_mb: sample.nativeHeapMb ?? null,
      hprof_download_url: `/downloads/${this.nextDumpId - 1}/hprof`,
      manifest_download_url: `/downloads/${this.nextDumpId - 1}/manifest`
    };
    this.dumpHistory.push(event);
    return event;
  }

  findDump(id) {
    return this.dumpHistory.find((event) => event.id === id) || null;
  }

  setConnectionState(status, note = '') {
    this.connectionStatus = status;
    this.connectionNote = note;
    if (this.logger) {
      void this.logger.info('连接状态变更', {
        status,
        note
      });
    }
  }

  updateRuntime({ capture, dumpReason, capabilities, deviceInfo, appMaxJavaHeapMb }) {
    this.capture = capture;
    this.dumpReason = dumpReason;
    this.capabilities = capabilities;
    this.deviceInfo = deviceInfo;
    this.appMaxJavaHeapMb = appMaxJavaHeapMb || null;
    if (this.logger) {
      void this.logger.info('运行时能力已刷新', {
        debuggable: Boolean(capabilities?.debuggable),
        profileable: Boolean(capabilities?.profileable),
        rooted: Boolean(capabilities?.rooted),
        device_model: deviceInfo?.model || ''
      });
    }
  }

  resetForDeviceChange(note = '') {
    this.sampleStore.clear();
    this.dumpHistory = [];
    this.nextDumpId = 1;
    this.connectionNote = note;
    if (this.logger) {
      void this.logger.warn('检测到设备切换，已重置会话缓存', {
        note
      });
    }
  }
}

function joinNote(current, note) {
  return current ? `${current} | ${note}` : note;
}
