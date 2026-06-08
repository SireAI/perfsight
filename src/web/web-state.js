import path from 'node:path';
import { sampleToJson } from '../sampling/sample.js';
import { buildFirefoxProfilerUrl } from '../capture/simpleperf-capture.js';

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
    logger,
    dumpHook,
    simpleperfCapture,
    webBaseUrl,
    cpuProfileExportDir
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
    this.dumpHook = dumpHook || null;
    this.simpleperfCapture = simpleperfCapture || null;
    this.webBaseUrl = webBaseUrl || '';
    this.cpuProfileExportDir = cpuProfileExportDir || '';
    this.startedAt = new Date().toISOString();
    this.connectionStatus = 'connected';
    this.connectionNote = '';
    this.dumpHistory = [];
    this.nextDumpId = 1;
    this.cpuProfileHistory = [];
    this.nextCpuProfileId = 1;
    this.dumpInProgress = false;
    this.dumpInProgressType = '';
    this.dumpInProgressMessage = '';
    this.cpuProfileInProgress = false;
    this.cpuProfileInProgressMessage = '';
    this.cpuProfileInProgressStartedAt = '';
    this.cpuProfileInProgressPid = null;
    this.cpuProfileActiveSample = null;
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
      manual_cpu_profile_enabled: Boolean(this.simpleperfCapture) && Boolean(this.capabilities.profileable || this.capabilities.rooted),
      manual_cpu_profile_reason: this.resolveCpuProfileReason(),
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
      cpu_profile_in_progress: this.cpuProfileInProgress,
      cpu_profile_in_progress_message: this.cpuProfileInProgressMessage,
      cpu_profile_in_progress_started_at: this.cpuProfileInProgressStartedAt,
      cpu_profile_in_progress_pid: this.cpuProfileInProgressPid,
      cpu_profile_export_dir: this.cpuProfileExportDir,
      dump_history: [...this.dumpHistory].reverse(),
      last_dump_event: this.dumpHistory.at(-1) || null,
      cpu_profile_history: [...this.cpuProfileHistory].reverse(),
      last_cpu_profile_event: this.cpuProfileHistory.at(-1) || null
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
      await this.runDumpHook({
        event: 'dump_completed',
        status: 'completed',
        sample,
        dumpType: 'manual',
        result,
        reasons: ['manual-trigger']
      });
      return this.recordDump(sample, 'manual', result);
    } catch (error) {
      await this.logger?.error('手动 HPROF dump 失败', {
        package: this.packageName,
        error: String(error?.message || error)
      });
      await this.runDumpHook({
        event: 'dump_failed',
        status: 'failed',
        sample,
        dumpType: 'manual',
        reasons: ['manual-trigger'],
        errorMessage: String(error?.message || error)
      }).catch(() => {});
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

  async startCpuProfile() {
    if (!this.simpleperfCapture) {
      throw new Error(this.resolveCpuProfileReason());
    }
    if (this.cpuProfileInProgress) {
      throw new Error('simpleperf recording already in progress');
    }
    if (!this.capabilities.profileable && !this.capabilities.rooted) {
      throw new Error(this.resolveCpuProfileReason());
    }
    const sample = this.sampleStore.latest();
    if (!sample || sample.pids.length === 0) {
      throw new Error('no running main process available');
    }
    this.cpuProfileInProgress = true;
    this.cpuProfileInProgressMessage = 'simpleperf recording in progress';
    this.cpuProfileInProgressStartedAt = sample.timestampIso;
    this.cpuProfileInProgressPid = sample.pids[0] || null;
    this.cpuProfileActiveSample = {
      timestamp: sample.timestamp,
      timestampIso: sample.timestampIso,
      package: sample.package,
      pids: [...sample.pids]
    };
    await this.logger?.info('开始录制 simpleperf CPU profile', {
      package: this.packageName,
      pid: sample.pids[0] || null
    });
    try {
      return await this.simpleperfCapture.start(sample);
    } catch (error) {
      this.cpuProfileInProgress = false;
      this.cpuProfileInProgressMessage = '';
      this.cpuProfileInProgressStartedAt = '';
      this.cpuProfileInProgressPid = null;
      this.cpuProfileActiveSample = null;
      throw error;
    }
  }

  async stopCpuProfile() {
    if (!this.simpleperfCapture || !this.cpuProfileInProgress) {
      throw new Error('no simpleperf recording in progress');
    }
    const sample = this.cpuProfileActiveSample;
    this.cpuProfileInProgressMessage = 'finalizing simpleperf profile';
    try {
      const result = await this.simpleperfCapture.stop();
      const event = this.recordCpuProfile(sample, result);
      await this.logger?.info('simpleperf CPU profile 已保存', {
        package: this.packageName,
        perf_data_path: result.perfDataPath,
        gecko_profile_path: result.geckoProfilePath || ''
      });
      return event;
    } finally {
      this.cpuProfileInProgress = false;
      this.cpuProfileInProgressMessage = '';
      this.cpuProfileInProgressStartedAt = '';
      this.cpuProfileInProgressPid = null;
      this.cpuProfileActiveSample = null;
    }
  }

  recordCpuProfile(sample, result) {
    const event = {
      id: this.nextCpuProfileId++,
      timestamp: result.startedAt ?? sample?.timestamp ?? 0,
      timestamp_iso: result.startedAtIso || sample?.timestampIso || '',
      started_at_iso: result.startedAtIso || sample?.timestampIso || '',
      ended_at_iso: result.stoppedAtIso || '',
      package: sample?.package || this.packageName,
      pid: result.pid || sample?.pids?.[0] || null,
      perf_data_path: result.perfDataPath,
      perf_data_name: path.basename(result.perfDataPath),
      gecko_profile_path: result.geckoProfilePath || '',
      gecko_profile_name: result.geckoProfilePath ? path.basename(result.geckoProfilePath) : '',
      gecko_profile_error: result.geckoProfileError || '',
      duration_sec: result.durationSec,
      perf_data_download_url: `/downloads/cpu-profile/${this.nextCpuProfileId - 1}/perf-data`,
      gecko_profile_download_url: result.geckoProfilePath
        ? `/downloads/cpu-profile/${this.nextCpuProfileId - 1}/gecko-profile`
        : '',
      firefox_profiler_url: this.webBaseUrl
        && result.geckoProfilePath
        ? buildFirefoxProfilerUrl(`${this.webBaseUrl}/downloads/cpu-profile/${this.nextCpuProfileId - 1}/gecko-profile`)
        : ''
    };
    this.cpuProfileHistory.push(event);
    if (this.logger) {
      void this.logger.info('CPU profile 导出记录已登记', {
        package: event.package,
        pid: event.pid,
        perf_data_path: event.perf_data_path,
        gecko_profile_path: event.gecko_profile_path || '',
        export_dir: this.cpuProfileExportDir || '',
        perf_data_download_url: event.perf_data_download_url,
        gecko_profile_download_url: event.gecko_profile_download_url || '',
        firefox_profiler_url: event.firefox_profiler_url || '',
        gecko_profile_error: event.gecko_profile_error || ''
      });
    }
    return event;
  }

  findCpuProfile(id) {
    return this.cpuProfileHistory.find((event) => event.id === id) || null;
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

  updateRuntime({ capture, dumpReason, capabilities, deviceInfo, appMaxJavaHeapMb, simpleperfCapture, cpuProfileExportDir }) {
    this.capture = capture;
    this.dumpReason = dumpReason;
    this.capabilities = capabilities;
    this.deviceInfo = deviceInfo;
    this.appMaxJavaHeapMb = appMaxJavaHeapMb || null;
    if (simpleperfCapture !== undefined) {
      this.simpleperfCapture = simpleperfCapture;
    }
    if (cpuProfileExportDir !== undefined) {
      this.cpuProfileExportDir = cpuProfileExportDir || '';
    }
    if (this.logger) {
      void this.logger.info('运行时能力已刷新', {
        debuggable: Boolean(capabilities?.debuggable),
        profileable: Boolean(capabilities?.profileable),
        rooted: Boolean(capabilities?.rooted),
        device_model: deviceInfo?.model || '',
        cpu_profile_export_dir: this.cpuProfileExportDir || ''
      });
    }
  }

  resolveCpuProfileReason() {
    if (!this.simpleperfCapture) {
      return 'simpleperf not available on device';
    }
    if (this.capabilities.profileable || this.capabilities.rooted) {
      return '';
    }
    return 'app is not profileable and device is not rooted for CPU recording';
  }

  resetForDeviceChange(note = '') {
    this.sampleStore.clear();
    this.dumpHistory = [];
    this.nextDumpId = 1;
    this.cpuProfileHistory = [];
    this.nextCpuProfileId = 1;
    this.cpuProfileInProgress = false;
    this.cpuProfileInProgressMessage = '';
    this.cpuProfileInProgressStartedAt = '';
    this.cpuProfileInProgressPid = null;
    this.cpuProfileActiveSample = null;
    this.connectionNote = note;
    if (this.logger) {
      void this.logger.warn('检测到设备切换，已重置会话缓存', {
        note
      });
    }
    if (this.simpleperfCapture && typeof this.simpleperfCapture.abort === 'function') {
      void this.simpleperfCapture.abort().catch(() => {});
    }
  }

  async runDumpHook({ event, status, sample, dumpType, result, reasons, errorMessage }) {
    if (!this.dumpHook || !sample) return;
    await this.dumpHook.run({
      event,
      status,
      packageName: sample.package || this.packageName,
      pid: sample.pids?.[0] || null,
      dumpType,
      timestampIso: sample.timestampIso,
      manifestPath: result?.manifestPath || '',
      hprofPath: result?.hprofPath || '',
      reasons: reasons || [],
      errorMessage: errorMessage || ''
    });
  }
}

function joinNote(current, note) {
  return current ? `${current} | ${note}` : note;
}
