import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AdbClient, AdbError } from '../adb/adb-client.js';
import { HprofCapture } from '../capture/hprof-capture.js';
import { createDumpHookRunner } from '../capture/dump-hook.js';
import { createSimpleperfCapture } from '../capture/simpleperf-capture.js';
import { sleep, timestampStamp } from '../core/time.js';
import { buildLeakConfig, LeakJudge } from '../leak/leak-judge.js';
import { exportReport } from '../report/report-html.js';
import { PackageCollector } from '../sampling/package-collector.js';
import { buildSample } from '../sampling/sample.js';
import { createOutputLayout, ensureOutputLayout, resetPackageArtifacts } from '../storage/output-layout.js';
import { SampleWriter } from '../storage/sample-writer.js';
import { writeSessionMeta } from '../storage/session-meta.js';
import { createRuntimeLogger } from '../storage/runtime-logger.js';
import { SampleStore } from '../web/sample-store.js';
import { startWebServer } from '../web/server.js';
import { WebState } from '../web/web-state.js';

export async function run({ packageName, options }) {
  const outputDir = path.resolve(String(options['output-dir']));
  await mkdir(outputDir, { recursive: true });
  if (options['reset-output-dir']) {
    await resetPackageArtifacts({
      outputDir,
      packageName,
      leakDumpDir: String(options['leak-dump-dir'])
    });
  }
  const stamp = timestampStamp();
  const layout = createOutputLayout({
    outputDir,
    packageName,
    stamp,
    leakDumpDir: String(options['leak-dump-dir'])
  });
  await ensureOutputLayout(layout);
  const logger = await createRuntimeLogger({ outputDir, packageName });
  const adb = new AdbClient({ serial: options.serial });
  let writer = null;
  let server = null;
  const stop = createStopSignal();
  try {
    await logger.info('开始启动 PerfSight', {
      package: packageName,
      mode: options.mode,
      serial: options.serial || ''
    });
    await adb.ensureDevice();
    let deviceInfo = await adb.deviceInfo();
    let javaHeapMaxMb = await resolveJavaHeapMaxMb(adb, options);
    let leakConfig = buildLeakConfig(options, javaHeapMaxMb);
    const cpuProfileExportDir = layout.simpleperfPackageDir;
    const csvPath = layout.sessionCsvPath;
    const metaPath = layout.sessionMetaPath;
    const reportPath = layout.sessionReportPath;
    await writeSessionMeta(layout.sessionMetaPath, {
      package: packageName,
      interval_sec: Number(options.interval),
      pss_interval_sec: Number(options['pss-interval']),
      serial: options.serial || null,
      started_at: new Date().toISOString(),
      output_dir: outputDir,
      session_dir: layout.sessionDir,
      device: deviceInfo,
      leak_capture: leakConfig,
      runtime_log_path: logger.filePath
    });
    await logger.info('设备信息已同步', {
      model: deviceInfo.model,
      android: deviceInfo.android,
      serial: deviceInfo.serial
    });
    await logger.info('输出目录已配置', {
      artifacts_root_dir: outputDir,
      session_dir: layout.sessionDir,
      cpu_profile_export_dir: cpuProfileExportDir,
      hprof_export_dir: layout.capturesPackageDir,
      csv_path: csvPath,
      meta_path: metaPath,
      report_path: reportPath
    });

    writer = await SampleWriter.open(csvPath);
    const dumpHook = createDumpHookRunner({
      command: options['dump-hook'],
      logger,
      runtimeLogPath: logger.filePath
    });
    const collector = new PackageCollector({
      adb,
      packageName,
      pssIntervalSec: Number(options['pss-interval'])
    });
    const sampleStore = new SampleStore(Number(options['history-size']));
    const leakJudge = leakConfig.enabled ? new LeakJudge(leakConfig) : null;
    let capabilities = await adb.packageCapabilities(packageName);
    let simpleperfCapture = options.mode === 'web'
      ? await createOptionalSimpleperfCapture({
          adb,
          packageName,
          outputDir,
          logger,
          useRoot: !capabilities.profileable && capabilities.rooted
        })
      : null;
    let capture = createCapture({ adb, packageName, outputDir, leakConfig, capabilities });
    const webState = options.mode === 'web'
      ? new WebState({
          packageName,
          intervalSec: Number(options.interval),
          csvPath,
          metaPath,
          sampleStore,
          capture,
          dumpReason: leakConfig.enabled ? capabilities.dumpReason : 'leak capture disabled',
          capabilities,
          deviceInfo,
          appMaxJavaHeapMb: javaHeapMaxMb,
          logger,
          dumpHook,
          simpleperfCapture,
          webBaseUrl: webUrlBase(options),
          cpuProfileExportDir
        })
      : null;
    let activeDeviceIdentity = deviceIdentity(deviceInfo);
    let connectionStatus = 'connected';
    let webUrl = '';

    if (options.mode === 'web') {
      server = await startWebServer({
        host: String(options.host),
        port: Number(options.port),
        state: webState
      });
      webUrl = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`;
      await logger.info('Web UI 已启动', { url: webUrl });
      openBrowser(webUrl).catch(() => {});
    }
    printStartupPanel({
      packageName,
      deviceInfo,
      mode: options.mode,
      runtimeLogPath: logger.filePath,
      sessionDir: layout.sessionDir,
      webUrl,
      cpuProfileExportDir: cpuProfileExportDir
    });

    let prev = await collector.snapshot();
    webState?.setConnectionState('connected');
    await logger.info('首次采样快照已建立');
    while (!stop.stopped) {
      try {
        await sleep(Math.max(50, Number(options.interval) * 1000));
        if (connectionStatus !== 'connected') {
          await adb.ensureDevice();
          const nextDeviceInfo = await adb.deviceInfo();
          const nextIdentity = deviceIdentity(nextDeviceInfo);
          const deviceChanged = activeDeviceIdentity !== nextIdentity;
          deviceInfo = nextDeviceInfo;
          activeDeviceIdentity = nextIdentity;
          if (deviceChanged) {
            collector.resetRuntimeCache();
            webState?.resetForDeviceChange('已切换到另一台设备');
            await logger.warn('检测到设备切换，准备重建运行时能力', {
              device_model: deviceInfo.model,
              serial: deviceInfo.serial
            });
          }
          javaHeapMaxMb = await resolveJavaHeapMaxMb(adb, options);
          leakConfig = buildLeakConfig(options, javaHeapMaxMb);
          capabilities = await adb.packageCapabilities(packageName);
          simpleperfCapture = options.mode === 'web'
            ? await createOptionalSimpleperfCapture({
                adb,
          packageName,
          outputDir,
          logger,
          useRoot: !capabilities.profileable && capabilities.rooted
        })
            : null;
          capture = createCapture({ adb, packageName, outputDir, leakConfig, capabilities });
          webState?.updateRuntime({
            capture,
            dumpReason: leakConfig.enabled ? capabilities.dumpReason : 'leak capture disabled',
            capabilities,
            deviceInfo,
            appMaxJavaHeapMb: javaHeapMaxMb,
            simpleperfCapture,
            cpuProfileExportDir
          });
          connectionStatus = 'connected';
          webState?.setConnectionState('connected', deviceChanged ? '已切换到另一台设备' : '设备已重新连接，采样已恢复');
          await logger.info('设备重连成功，采样已恢复', {
            device_changed: deviceChanged,
            model: deviceInfo.model,
            serial: deviceInfo.serial
          });
          prev = await collector.snapshot();
          continue;
        }
        const curr = await collector.snapshot();
        let sample = buildSample(prev, curr, packageName);
        if (leakJudge) {
          sample = await processLeakSample(sample, leakJudge, capture, webState, dumpHook);
        }
        await writer.write(sample);
        sampleStore.add(sample);
        webState?.recordDumpFromSample(sample);
        if (sample.note) {
          await logger.info('采样备注', {
            status: sample.status,
            note: sample.note,
            pids: sample.pids
          });
        }
        if (options.mode !== 'web') {
          printSample(sample);
        }
        prev = curr;
      } catch (error) {
        if (AdbClient.isDeviceUnavailableError(error)) {
          collector.resetRuntimeCache();
          connectionStatus = 'disconnected';
          await logger.warn('检测到 adb 连接断开，进入等待重连状态', {
            error: String(error.message || error)
          });
          webState?.setConnectionState('disconnected', String(error.message || error));
          await sleep(Math.min(Math.max(Number(options.interval), 1), 3) * 1000);
          continue;
        }
        await logger.error('运行主循环发生未预期异常', {
          error: String(error?.stack || error?.message || error)
        });
        throw error;
      }
    }

    await exportReport({
      csvPath,
      reportPath,
      packageName,
      startedAt: stamp,
      endedAt: new Date().toISOString()
    });
    await logger.info('离线报告导出完成', {
      report_path: reportPath
    });
    console.log(`Report exported: ${reportPath}`);
  } catch (error) {
    await logger.error('运行失败', {
      error: String(error?.stack || error?.message || error)
    });
    if (AdbClient.isDeviceUnavailableError(error)) {
      throw new AdbError('adb device unavailable: please connect or reconnect a phone, then retry.');
    }
    throw error;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (writer) await writer.close();
    stop.dispose();
    await logger.info('PerfSight 已停止');
  }
}

function deviceIdentity(deviceInfo) {
  return [
    deviceInfo?.serial || '',
    deviceInfo?.model || '',
    deviceInfo?.device || '',
    deviceInfo?.android || ''
  ].join('|');
}

async function resolveJavaHeapMaxMb(adb, options) {
  const configured = Number(options['leak-java-max-heap-mb']);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return adb.javaHeapGrowthLimitMb();
}

function createCapture({ adb, packageName, outputDir, leakConfig, capabilities }) {
  if (!leakConfig.enabled) return null;
  if (!capabilities.debuggable && !capabilities.rooted) return null;
  return new HprofCapture({
    adb,
    packageName,
    captureDir: path.join(outputDir, leakConfig.dumpDir),
    useRoot: Boolean(capabilities.rooted) && !capabilities.debuggable
  });
}

async function processLeakSample(sample, leakJudge, capture, webState, dumpHook) {
  const decision = leakJudge.evaluate(sample);
  sample.leakStatus = decision.leakStatus;
  sample.leakReasons = decision.reasons;
  sample.leakStructState = decision.structState;
  sample.leakWatermarkState = decision.watermarkState;
  if (decision.dumpRequested && capture) {
    try {
      if (webState) {
        webState.dumpInProgress = true;
        webState.dumpInProgressType = 'leak';
        webState.dumpInProgressMessage = 'leak-triggered HPROF capture in progress';
      }
      const result = await capture.capture(sample, decision.reasons, 'leak');
      sample.dumpHprofPath = result.hprofPath;
      sample.dumpManifestPath = result.manifestPath;
      sample.dumpType = 'leak';
      sample.leakStatus = 'dump-triggered';
      sample.note = sample.note ? `${sample.note} | hprof dumped: ${path.basename(result.hprofPath)}` : `hprof dumped: ${path.basename(result.hprofPath)}`;
      leakJudge.markDumped(sample);
      await webState?.logger?.info('自动 HPROF dump 成功', {
        package: sample.package,
        reasons: decision.reasons,
        hprof_path: result.hprofPath,
        manifest_path: result.manifestPath
      });
      await runDumpHook(dumpHook, {
        event: 'dump_completed',
        status: 'completed',
        sample,
        dumpType: 'leak',
        result,
        reasons: decision.reasons
      });
    } catch (error) {
      sample.note = sample.note ? `${sample.note} | hprof dump failed: ${error.message}` : `hprof dump failed: ${error.message}`;
      await webState?.logger?.error('自动 HPROF dump 失败', {
        package: sample.package,
        reasons: decision.reasons,
        error: String(error?.message || error)
      });
      await runDumpHook(dumpHook, {
        event: 'dump_failed',
        status: 'failed',
        sample,
        dumpType: 'leak',
        reasons: decision.reasons,
        errorMessage: String(error?.message || error)
      }).catch(() => {});
    } finally {
      if (webState) {
        webState.dumpInProgress = false;
        webState.dumpInProgressType = '';
        webState.dumpInProgressMessage = '';
      }
    }
  }
  return sample;
}

function printSample(sample) {
  console.log([
    sample.timestampIso.slice(11, 19),
    `cpu=${fmt(sample.appCpuPct, '%')}`,
    `pss=${fmt(sample.pssMb, 'MB')}`,
    `java=${fmt(sample.javaHeapMb, 'MB')}`,
    `gap=${sample.activityGap ?? '-'}`,
    `leak=${sample.leakStatus}`,
    `pids=${sample.pids.join(',') || '-'}`,
    `cpu_src=${sample.cpuSource}`,
    `status=${sample.status}`,
    sample.note
  ].filter(Boolean).join(' '));
}

function fmt(value, suffix) {
  return value === null || value === undefined ? '-' : `${value.toFixed(2)}${suffix}`;
}

function createStopSignal() {
  const state = { stopped: false };
  const handler = () => {
    state.stopped = true;
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return {
    get stopped() {
      return state.stopped;
    },
    dispose() {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    }
  };
}

async function openBrowser(url) {
  const { spawn } = await import('node:child_process');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function runDumpHook(dumpHook, { event, status, sample, dumpType, result, reasons, errorMessage }) {
  if (!dumpHook || !sample) return;
  await dumpHook.run({
    event,
    status,
    packageName: sample.package,
    pid: sample.pids?.[0] || null,
    dumpType,
    timestampIso: sample.timestampIso,
    manifestPath: result?.manifestPath || '',
    hprofPath: result?.hprofPath || '',
    reasons: reasons || [],
    errorMessage: errorMessage || ''
  });
}

function printStartupPanel({ packageName, deviceInfo, mode, runtimeLogPath, sessionDir, webUrl, cpuProfileExportDir }) {
  console.log('PerfSight | Android endurance monitoring');
  console.log(`App: ${packageName}`);
  console.log(`Device: ${deviceInfo.model} / ${deviceInfo.android} / ${deviceInfo.serial}`);
  console.log(`Mode: ${mode}`);
  console.log(`Session: ${sessionDir}`);
  if (webUrl) {
    console.log(`UI: ${webUrl}`);
  }
  if (cpuProfileExportDir) {
    console.log(`CPU recordings: ${cpuProfileExportDir}`);
  }
  console.log(`Log: ${runtimeLogPath}`);
  console.log('Support: wangkai39@xiaomi.com');
  console.log('Press Ctrl-C to stop.');
}

async function createOptionalSimpleperfCapture({ adb, packageName, outputDir, logger, useRoot }) {
  try {
    return await createSimpleperfCapture({
      adb,
      packageName,
      outputDir,
      logger,
      useRoot
    });
  } catch (error) {
    await logger?.warn('simpleperf CPU 录制不可用', {
      error: String(error?.message || error)
    });
    return null;
  }
}

function webUrlBase(options) {
  return `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`;
}
