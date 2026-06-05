const FAVICON_DATA_URL = (
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E" +
  "%3Crect width='64' height='64' rx='16' fill='%2309101c'/%3E" +
  "%3Cpath d='M16 44h8V28h-8zm12 0h8V18h-8zm12 0h8V34h-8z' fill='%238fb8ff'/%3E" +
  "%3Cpath d='M14 38c6-10 10-10 16-2s10 8 20-8' fill='none' stroke='%2340c4aa' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E" +
  "%3C/svg%3E"
);

const BREAKDOWN_LABELS = {
  java_heap: 'Java Heap',
  native_heap: 'Native Heap',
  graphics: 'Graphics',
  stack: 'Stack',
  code: 'Code',
  private_other: 'Private Other',
  system: 'System',
  unknown: 'Unknown',
  dalvik_heap: 'Dalvik Heap',
  dalvik_other: 'Dalvik Other',
  egl_mtrack: 'EGL mtrack',
  gl_mtrack: 'GL mtrack'
};

const BREAKDOWN_ORDER = [
  'java_heap',
  'native_heap',
  'graphics',
  'stack',
  'code',
  'private_other',
  'system',
  'unknown',
  'dalvik_heap',
  'dalvik_other',
  'egl_mtrack',
  'gl_mtrack'
];

export function renderLivePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PerfSight</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URL}">
  <style>
    :root {
      --bg: #09111f;
      --panel: rgba(14, 25, 44, 0.88);
      --border: rgba(128, 167, 255, 0.18);
      --text: #e8f0ff;
      --muted: #9fb0cf;
      --cpu: #ff7a59;
      --pss: #8fb8ff;
      --java: #40c4aa;
      --grid: rgba(255, 255, 255, 0.08);
      --warn: #ffd166;
      --ok: #40c4aa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(85, 153, 255, 0.24), transparent 32%),
        radial-gradient(circle at bottom right, rgba(64, 196, 170, 0.18), transparent 28%),
        linear-gradient(180deg, #07101d 0%, #0b1629 100%);
    }
    .page {
      width: min(1520px, calc(100vw - 32px));
      margin: 18px auto;
      display: grid;
      gap: 16px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
    }
    .hero {
      padding: 20px 22px;
      display: grid;
      gap: 10px;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .title {
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1;
      font-weight: 650;
      letter-spacing: 0;
      margin: 0;
    }
    .sub {
      color: var(--muted);
      font-size: 14px;
      margin-top: 8px;
    }
    .hero-meta {
      display: grid;
      gap: 6px;
      justify-items: end;
      text-align: right;
    }
    .hero-meta-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .hero-meta-value {
      color: var(--muted);
      font-size: 13px;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .hero-meta-value a {
      color: #b9d2ff;
      text-decoration: none;
    }
    .hero-meta-value a:hover {
      text-decoration: underline;
    }
    .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(272px, 296px);
      gap: 16px;
      align-items: start;
    }
    .summary-panel {
      padding: 18px;
      display: grid;
      gap: 16px;
    }
    .connection-banner {
      display: none;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      color: var(--text);
    }
    .connection-banner.visible {
      display: inline-flex;
    }
    .connection-banner.disconnected {
      border-color: rgba(255, 122, 89, 0.26);
      background: rgba(255, 122, 89, 0.10);
    }
    .connection-banner.connected {
      border-color: rgba(64, 196, 170, 0.22);
      background: rgba(64, 196, 170, 0.10);
    }
    .connection-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--ok);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.18);
      flex: 0 0 auto;
    }
    .connection-banner.disconnected .connection-dot {
      background: var(--cpu);
    }
    .connection-copy {
      display: grid;
      gap: 2px;
    }
    .connection-copy strong {
      font-size: 13px;
      font-weight: 600;
    }
    .connection-copy span {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.85fr);
      gap: 18px;
      align-items: start;
    }
    .summary-block {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .summary-block h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.02em;
    }
    .info-card {
      padding: 16px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: grid;
      gap: 12px;
    }
    .device-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px 18px;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px 16px;
    }
    .config-item {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .config-item span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .config-item strong {
      color: var(--text);
      font-weight: 600;
      font-size: 15px;
      overflow-wrap: anywhere;
    }
    .state-card {
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: grid;
      gap: 12px;
    }
    .state-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px 16px;
    }
    .state-item {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .state-item.hidden {
      display: none;
    }
    .state-item span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .state-item strong {
      color: var(--text);
      font-weight: 600;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .state-block {
      display: grid;
      gap: 14px;
    }
    .state-section {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .state-section + .state-section {
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .state-section-title {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .chart-wrap {
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .chart-wrap h2, .side h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.02em;
    }
    .control-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 2px;
    }
    .control-bar {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      align-items: center;
    }
    .control-group {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .control-label {
      min-width: 72px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .segmented {
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .chip {
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 7px 12px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      line-height: 1;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
    }
    .chip.active {
      color: #09111f;
      border-color: rgba(143, 184, 255, 0.86);
      background: linear-gradient(180deg, #b9d2ff 0%, #8fb8ff 100%);
      box-shadow: 0 6px 18px rgba(143, 184, 255, 0.28);
    }
    .chart-grid {
      display: grid;
      gap: 12px;
    }
    .mini-chart {
      padding: 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .mini-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 13px;
      flex-wrap: wrap;
    }
    .mini-head strong {
      color: var(--text);
      font-weight: 600;
    }
    .mini-head-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .recording-timer {
      color: var(--warn);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .action-button {
      border: 1px solid rgba(64, 196, 170, 0.32);
      background: rgba(64, 196, 170, 0.10);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .action-button:disabled {
      opacity: 0.5;
      cursor: wait;
    }
    .inline-status {
      color: var(--muted);
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .hidden { display: none !important; }
    .spinner {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: #40c4aa;
      animation: spin 0.8s linear infinite;
    }
    .capability-hint {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      color: var(--warn);
      background: rgba(255, 209, 102, 0.08);
      border: 1px solid rgba(255, 209, 102, 0.16);
      font-size: 12px;
      line-height: 1.4;
    }
    canvas {
      width: 100%;
      height: 180px;
      border-radius: 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.00)),
        rgba(6, 11, 22, 0.88);
      display: block;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }
    .legend-item strong {
      color: var(--text);
      font-weight: 500;
    }
    .legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.18);
    }
    .side {
      padding: 18px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .kv {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .kv strong {
      color: var(--text);
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 999px;
      width: fit-content;
      background: rgba(255, 255, 255, 0.04);
    }
    .pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cpu);
      box-shadow: 0 0 0 0 rgba(255, 122, 89, 0.5);
      animation: pulse 1.5s infinite;
    }
    .dump-summary {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-top: -4px;
    }
    .dump-list {
      display: grid;
      gap: 6px;
      max-height: 320px;
      overflow: auto;
      padding-right: 4px;
    }
    .dump-list::-webkit-scrollbar { width: 8px; }
    .dump-list::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 999px;
    }
    .dump-list::-webkit-scrollbar-thumb {
      background: rgba(143, 184, 255, 0.28);
      border-radius: 999px;
    }
    .dump-entry {
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      display: grid;
      gap: 6px;
    }
    .dump-entry-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }
    .dump-entry-sub {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .dump-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .dump-link {
      color: #b9d2ff;
      font-size: 11px;
      text-decoration: none;
    }
    .dump-link:hover { text-decoration: underline; }
    .dump-tag {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(143, 184, 255, 0.12);
      color: #c9dcff;
      font-size: 11px;
      line-height: 1;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(255, 122, 89, 0.5); }
      70% { box-shadow: 0 0 0 12px rgba(255, 122, 89, 0); }
      100% { box-shadow: 0 0 0 0 rgba(255, 122, 89, 0); }
    }
    @media (max-width: 960px) {
      .summary-grid { grid-template-columns: 1fr; }
      .device-grid { grid-template-columns: 1fr; }
      .config-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .state-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .content { grid-template-columns: 1fr; }
      canvas { height: 160px; }
    }
    @media (max-width: 640px) {
      .config-grid { grid-template-columns: 1fr; }
      .state-grid { grid-template-columns: 1fr; }
      .hero-meta {
        justify-items: start;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1 class="title">PerfSight</h1>
          <div class="sub">Performance and leak monitoring for Android endurance runs</div>
        </div>
        <div class="hero-meta">
          <div class="hero-meta-label">Support</div>
          <div class="hero-meta-value"><a href="mailto:wangkai39@xiaomi.com">wangkai39@xiaomi.com</a></div>
        </div>
      </div>
    </section>
    <section class="panel summary-panel">
      <div class="connection-banner" id="connectionBanner">
        <span class="connection-dot"></span>
        <div class="connection-copy">
          <strong id="connectionBannerTitle">设备连接正常</strong>
          <span id="connectionBannerNote">正在持续采样中</span>
        </div>
      </div>
      <div class="summary-grid">
        <div class="summary-block">
          <h2>Device Info</h2>
          <div class="info-card">
            <div class="device-grid">
              <div class="config-item"><span>Device</span><strong id="deviceModelText">-</strong></div>
              <div class="config-item"><span>Android</span><strong id="androidVersionText">-</strong></div>
              <div class="config-item"><span>Serial</span><strong id="serialText">-</strong></div>
              <div class="config-item"><span>Root Access</span><strong id="rootedText">-</strong></div>
              <div class="config-item"><span>CPU Cores</span><strong id="cpuCoresText">-</strong></div>
              <div class="config-item"><span>CPU Frequency</span><strong id="cpuFrequencyText">-</strong></div>
            </div>
          </div>
        </div>
        <div class="summary-block">
          <h2>Current State</h2>
          <div class="state-card">
            <div class="state-block">
              <div class="status"><span class="pulse"></span><span id="statusText">waiting</span></div>
              <div class="state-section">
                <div class="state-section-title">Runtime</div>
                <div class="state-grid">
                  <div class="state-item"><span>App</span><strong id="packageText">-</strong></div>
                  <div class="state-item"><span>Last</span><strong id="lastTs">-</strong></div>
                  <div class="state-item"><span>PIDs</span><strong id="pidText">-</strong></div>
                  <div class="state-item"><span>CPU Source</span><strong id="sourceText">-</strong></div>
                  <div class="state-item" id="noteItem"><span>Note</span><strong id="noteText">-</strong></div>
                </div>
              </div>
              <div class="state-section">
                <div class="state-section-title">Session</div>
                <div class="state-grid">
                  <div class="state-item"><span>Max Java Heap</span><strong id="appMaxHeapText">-</strong></div>
                  <div class="state-item"><span>Debuggable</span><strong id="debuggableText">-</strong></div>
                  <div class="state-item"><span>Profileable</span><strong id="profileableText">-</strong></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section class="content">
      <div class="panel chart-wrap">
        <h2>Realtime Trends</h2>
        <div class="control-row control-bar">
          <div class="control-group">
            <span class="control-label">Window</span>
            <div class="segmented" id="windowControls">
              <button class="chip" data-window="15" type="button">15s</button>
              <button class="chip active" data-window="60" type="button">1m</button>
              <button class="chip" data-window="180" type="button">3m</button>
              <button class="chip" data-window="600" type="button">10m</button>
              <button class="chip" data-window="all" type="button">All</button>
            </div>
          </div>
          <div class="control-group">
            <span class="control-label">CPU Scale</span>
            <div class="segmented" id="cpuScaleControls">
              <button class="chip active" data-cpu-scale="focus" type="button">Focus</button>
              <button class="chip" data-cpu-scale="full" type="button">Full</button>
            </div>
          </div>
        </div>
        <div class="chart-grid">
          <div class="mini-chart">
            <div class="mini-head">
              <span>App CPU</span>
              <strong id="cpuChartLabel">-</strong>
              <div class="mini-head-actions">
                <span class="recording-timer hidden" id="cpuProfileTimer">Recording 00:00</span>
                <button class="action-button" id="cpuProfileButton" type="button">Start Recording</button>
              </div>
            </div>
            <canvas id="cpuCanvas"></canvas>
            <div class="capability-hint hidden" id="cpuProfileCapabilityHint"></div>
          </div>
          <div class="mini-chart">
            <div class="mini-head">
              <span>Total PSS &amp; Composition</span>
              <strong id="pssChartLabel">-</strong>
              <div class="mini-head-actions">
                <button class="action-button" id="manualDumpButton" type="button">Dump Memory</button>
                <span class="inline-status hidden" id="manualDumpStatus"><span class="spinner"></span><span>Dumping HPROF...</span></span>
              </div>
            </div>
            <canvas id="pssCanvas"></canvas>
            <div class="legend" id="pssLegend"></div>
            <div class="capability-hint hidden" id="dumpCapabilityHint"></div>
          </div>
        </div>
      </div>
      <div class="panel side">
        <h2>Leak Snapshot</h2>
        <div class="kv">
          <span>Leak Status</span><strong id="leakText">-</strong>
          <span>Activities</span><strong id="activitiesText">-</strong>
          <span>ViewRootImpl</span><strong id="viewRootText">-</strong>
        </div>
        <h2>Dump Info</h2>
        <div class="kv">
          <span>Status</span><strong id="dumpStatusText">idle</strong>
          <span>Type</span><strong id="dumpTypeText">-</strong>
          <span>Last Dump</span><strong id="dumpTimeText">-</strong>
          <span>HPROF</span><strong id="dumpPathText">-</strong>
          <span>Manifest</span><strong id="manifestPathText">-</strong>
          <span>Message</span><strong id="dumpMessageText">-</strong>
        </div>
        <h2>Dump History</h2>
        <div class="dump-summary" id="dumpSummaryText"></div>
        <div class="dump-list" id="dumpHistoryList"></div>
      </div>
    </section>
  </div>
  <script>
    const BREAKDOWN_LABELS = ${JSON.stringify(BREAKDOWN_LABELS)};
    const BREAKDOWN_ORDER = ${JSON.stringify(BREAKDOWN_ORDER)};
    const cpuCanvas = document.getElementById('cpuCanvas');
    const pssCanvas = document.getElementById('pssCanvas');
    const cpuCtx = cpuCanvas.getContext('2d');
    const pssCtx = pssCanvas.getContext('2d');
    const pssLegend = document.getElementById('pssLegend');
    const manualDumpButton = document.getElementById('manualDumpButton');
    const dumpCapabilityHint = document.getElementById('dumpCapabilityHint');
    const cpuChartLabel = document.getElementById('cpuChartLabel');
    const pssChartLabel = document.getElementById('pssChartLabel');
    const windowControls = document.getElementById('windowControls');
    const cpuScaleControls = document.getElementById('cpuScaleControls');
    const connectionBanner = document.getElementById('connectionBanner');
    const noteItem = document.getElementById('noteItem');
    const cpuProfileTimer = document.getElementById('cpuProfileTimer');
    const dumpButtonDefaultText = 'Dump Memory';
    const cpuProfileButtonStartText = 'Start Recording';
    const cpuProfileButtonStopText = 'Stop Recording';

    let currentPayload = null;
    let currentSamples = [];
    let currentVisibleSamples = [];
    let activeWindow = '60';
    let cpuScaleMode = 'focus';
    let hoverSampleIndex = null;
    let pollTimer = null;
    let dumpInFlight = false;
    let manualDumpMessage = '';
    let cpuProfileInFlight = false;
    let cpuProfileMessage = '';
    let cpuProfileTimerHandle = null;
    let notificationsReady = false;
    let lastSeenDumpKey = null;
    let lastSeenDumpReady = false;
    let lastNotificationError = '';
    let lastNotificationSentAt = '';
    function setText(id, value) {
      document.getElementById(id).textContent = value === null || value === undefined || value === '' ? '-' : String(value);
    }

    function updateNote(value) {
      const normalized = value === null || value === undefined ? '' : String(value).trim();
      const visible = normalized !== '' && normalized !== '-';
      if (noteItem) {
        noteItem.classList.toggle('hidden', !visible);
      }
      setText('noteText', visible ? normalized : '-');
    }

    function formatNumber(value, suffix) {
      return value === null || value === undefined ? '-' : Number(value).toFixed(2) + (suffix || '');
    }

    function formatClock(secondsOrIso) {
      if (secondsOrIso === null || secondsOrIso === undefined || secondsOrIso === '') return '-';
      const date = typeof secondsOrIso === 'number' ? new Date(secondsOrIso * 1000) : new Date(secondsOrIso);
      if (Number.isNaN(date.getTime())) return '-';
      return date.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function basename(filePath) {
      if (!filePath) return '-';
      const parts = String(filePath).split('/');
      return parts[parts.length - 1] || filePath;
    }

    function dumpCapabilitySummary(payload) {
      if (!payload || payload.manual_dump_enabled) return '';
      if (payload.manual_dump_reason === 'leak capture disabled') return '';
      return 'Leak monitoring stays on, but HPROF dump is unavailable for this app. Enable debuggable support or use a rooted device to capture heap dumps.';
    }

    function cpuProfileCapabilitySummary(payload) {
      if (!payload || payload.manual_cpu_profile_enabled) return '';
      return payload.manual_cpu_profile_reason || 'CPU recording unavailable';
    }

    function updateConnectionBanner(payload) {
      const status = payload && payload.connection_status ? payload.connection_status : 'connected';
      if (!connectionBanner) return;
      if (status === 'disconnected') {
        connectionBanner.classList.add('visible', 'disconnected');
        connectionBanner.classList.remove('connected');
        setText('connectionBannerTitle', '设备已断开');
        setText('connectionBannerNote', payload && payload.connection_note ? payload.connection_note : '等待重新连接设备');
        return;
      }
      if (payload && payload.connection_note) {
        connectionBanner.classList.add('visible', 'connected');
        connectionBanner.classList.remove('disconnected');
        setText('connectionBannerTitle', '设备已重新连接');
        setText('connectionBannerNote', payload.connection_note);
        return;
      }
      connectionBanner.classList.remove('visible', 'connected', 'disconnected');
      setText('connectionBannerTitle', '设备连接正常');
      setText('connectionBannerNote', '正在持续采样中');
    }

    function ensureNotificationPermission() {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') {
        notificationsReady = true;
        lastNotificationError = '';
        return;
      }
      if (Notification.permission !== 'default') {
        notificationsReady = false;
        return;
      }
      Notification.requestPermission().then(function (permission) {
        notificationsReady = permission === 'granted';
        if (notificationsReady) lastNotificationError = '';
      }).catch(function () {
        notificationsReady = false;
        lastNotificationError = 'request failed';
      });
    }

    async function requestNotificationPermissionFromGesture() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') {
        notificationsReady = true;
        lastNotificationError = '';
        return true;
      }
      if (Notification.permission === 'denied') {
        notificationsReady = false;
        lastNotificationError = 'permission denied';
        return false;
      }
      try {
        const permission = await Notification.requestPermission();
        notificationsReady = permission === 'granted';
        lastNotificationError = notificationsReady ? '' : 'permission ' + permission;
        return notificationsReady;
      } catch (error) {
        notificationsReady = false;
        lastNotificationError = String(error && error.message ? error.message : error);
        return false;
      }
    }

    async function clearLegacyServiceWorkers() {
      if (!('serviceWorker' in navigator)) return;
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(function (registration) {
          return registration.unregister();
        }));
      } catch (error) {
        console.warn('PerfSight service worker cleanup failed:', error);
      }
    }

    function notificationStatusText() {
      if (!('Notification' in window)) return 'unsupported';
      const permission = Notification.permission || 'default';
      if (permission === 'granted') {
        if (lastNotificationError) return 'granted(error)';
        if (lastNotificationSentAt) return 'granted(sent)';
        return 'granted';
      }
      if (permission === 'denied') return 'denied';
      return 'default';
    }

    function makeDumpKey(sample) {
      if (!sample) return null;
      return sample.dump_manifest_path || sample.dump_hprof_path || (sample.timestamp ? 'dump-' + sample.timestamp : null);
    }

    async function notifyDump(sample) {
      if (!sample || !notificationsReady || !('Notification' in window)) return;
      const dumpType = sample.dump_type || 'leak';
      const body = [
        sample.package || 'unknown package',
        'Total ' + (sample.pss_mb !== null && sample.pss_mb !== undefined ? sample.pss_mb.toFixed(2) : '-') + 'MB',
        'Java ' + (sample.java_heap_mb !== null && sample.java_heap_mb !== undefined ? sample.java_heap_mb.toFixed(2) : '-') + 'MB',
        'Native ' + (sample.native_heap_mb !== null && sample.native_heap_mb !== undefined ? sample.native_heap_mb.toFixed(2) : '-') + 'MB'
      ].join(' · ');
      const title = 'PerfSight HPROF Dumped (' + dumpType + ')';
      const tag = makeDumpKey(sample) || undefined;
      try {
        const notification = new Notification(title, {
          body: body,
          tag: tag,
          requireInteraction: true,
          renotify: true,
          silent: false
        });
        lastNotificationError = '';
        lastNotificationSentAt = new Date().toISOString();
        console.info('PerfSight notification created:', {
          title: title,
          tag: tag,
          at: lastNotificationSentAt
        });
        notification.onclick = function () {
          window.focus();
          if (sample.hprof_download_url) {
            window.open(sample.hprof_download_url, '_blank', 'noopener,noreferrer');
          }
          document.querySelector('.side')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
      } catch (error) {
        lastNotificationError = String(error && error.message ? error.message : error);
        console.error('PerfSight notification failed:', error);
      }
    }

    function preferredBreakdownEntries(breakdown) {
      return Object.entries(breakdown || {}).sort(function (left, right) {
        const leftIndex = BREAKDOWN_ORDER.indexOf(left[0]);
        const rightIndex = BREAKDOWN_ORDER.indexOf(right[0]);
        const leftOrder = leftIndex === -1 ? BREAKDOWN_ORDER.length : leftIndex;
        const rightOrder = rightIndex === -1 ? BREAKDOWN_ORDER.length : rightIndex;
        return leftOrder - rightOrder || left[0].localeCompare(right[0]);
      }).map(function (entry) {
        return [entry[0], BREAKDOWN_LABELS[entry[0]] || entry[0], entry[1]];
      });
    }

    function resizeCanvas(canvas, ctx) {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function niceStep(rawStep) {
      if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
      const exponent = Math.floor(Math.log10(rawStep));
      const fraction = rawStep / Math.pow(10, exponent);
      let niceFraction = 1;
      if (fraction <= 1) niceFraction = 1;
      else if (fraction <= 2) niceFraction = 2;
      else if (fraction <= 5) niceFraction = 5;
      else niceFraction = 10;
      return niceFraction * Math.pow(10, exponent);
    }

    function buildTicks(minValue, maxValue, tickCount) {
      const safeCount = Math.max(2, tickCount);
      const step = niceStep((maxValue - minValue) / (safeCount - 1));
      const niceMin = Math.floor(minValue / step) * step;
      const niceMax = Math.ceil(maxValue / step) * step;
      const ticks = [];
      for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {
        ticks.push(Number(value.toFixed(6)));
      }
      return { min: niceMin, max: niceMax, ticks: ticks };
    }

    function computeScale(values, mode) {
      const valid = values.filter(function (value) { return value !== null && value !== undefined; });
      if (!valid.length) return { min: 0, max: mode === 'cpu' ? 100 : 1, ticks: [0, mode === 'cpu' ? 50 : 1] };
      if (mode === 'cpu') {
        if (cpuScaleMode === 'full') return buildTicks(0, Math.max(100, Math.max.apply(null, valid) * 1.08), 5);
        const minRaw = Math.min.apply(null, valid);
        const maxRaw = Math.max.apply(null, valid);
        const padding = Math.max(2, (maxRaw - minRaw) * 0.2, maxRaw * 0.1);
        return buildTicks(Math.max(0, minRaw - padding), maxRaw + padding, 5);
      }
      return buildTicks(0, Math.max.apply(null, valid) * 1.08 || 1, 6);
    }

    function drawYGrid(ctx, left, top, width, height, ticks, minValue, maxValue, suffix) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.fillStyle = 'rgba(159,176,207,0.92)';
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      ticks.forEach(function (tick) {
        const ratio = (tick - minValue) / Math.max(maxValue - minValue, 1e-6);
        const y = top + height - ratio * height;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.fillText(tick.toFixed(0) + suffix, 4, y + 4);
      });
    }

    function drawTimeAxis(ctx, left, top, width, height, samples) {
      if (!samples.length) return;
      const tickCount = Math.min(5, samples.length);
      ctx.fillStyle = 'rgba(159,176,207,0.92)';
      ctx.font = '12px "IBM Plex Sans", sans-serif';
      for (let index = 0; index < tickCount; index += 1) {
        const sampleIndex = Math.round((index / Math.max(tickCount - 1, 1)) * (samples.length - 1));
        const x = left + (sampleIndex / Math.max(samples.length - 1, 1)) * width;
        const text = formatClock(samples[sampleIndex].timestamp);
        const metrics = ctx.measureText(text);
        ctx.fillText(text, Math.max(left, Math.min(left + width - metrics.width, x - metrics.width / 2)), top + height + 24);
      }
    }

    function drawHover(ctx, sample, index, total, left, top, width, height) {
      if (!sample || total <= 0) return;
      const x = left + (index / Math.max(total - 1, 1)) * width;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
      ctx.stroke();
    }

    function drawLine(ctx, values, color, minValue, maxValue, left, top, width, height) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let drawn = false;
      values.forEach(function (value, index) {
        if (value === null || value === undefined) return;
        const x = left + (index / Math.max(values.length - 1, 1)) * width;
        const y = top + height - ((value - minValue) / Math.max(maxValue - minValue, 1e-6)) * height;
        if (!drawn) {
          ctx.moveTo(x, y);
          drawn = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      if (drawn) ctx.stroke();
    }

    function sampleIndexFromEvent(event, canvas, total) {
      if (!total) return null;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / Math.max(rect.width, 1)));
      return Math.round(ratio * Math.max(total - 1, 0));
    }

    function attachHoverHandlers(canvas) {
      canvas.addEventListener('mousemove', function (event) {
        hoverSampleIndex = sampleIndexFromEvent(event, canvas, currentVisibleSamples.length);
        drawCharts(currentSamples);
        updateDetails();
      });
      canvas.addEventListener('mouseleave', function () {
        hoverSampleIndex = null;
        drawCharts(currentSamples);
        updateDetails();
      });
    }

    function sliceByWindow(samples) {
      if (activeWindow === 'all' || samples.length <= 1) return samples.slice();
      const seconds = Number(activeWindow);
      if (!Number.isFinite(seconds) || seconds <= 0) return samples.slice();
      const latest = samples[samples.length - 1];
      return samples.filter(function (sample) {
        return latest.timestamp - sample.timestamp <= seconds;
      });
    }

    function syncButtons(container, key, value) {
      Array.from(container.querySelectorAll('button')).forEach(function (button) {
        button.classList.toggle('active', button.dataset[key] === value);
      });
    }

    function cpuProfileRanges(samples) {
      const payload = currentPayload || {};
      const history = Array.isArray(payload.cpu_profile_history) ? payload.cpu_profile_history : [];
      const completed = history.slice(0, 4).map(function (entry) {
        return {
          start: isoToUnix(entry.started_at_iso || entry.timestamp_iso),
          end: isoToUnix(entry.ended_at_iso),
          active: false
        };
      }).filter(function (entry) {
        return entry.start > 0 && entry.end > entry.start;
      });
      if (payload.cpu_profile_in_progress) {
        completed.push({
          start: isoToUnix(payload.cpu_profile_in_progress_started_at),
          end: samples.length ? samples[samples.length - 1].timestamp : (Date.now() / 1000),
          active: true
        });
      }
      if (!samples.length) return completed;
      const minTs = samples[0].timestamp;
      const maxTs = samples[samples.length - 1].timestamp;
      return completed.filter(function (entry) {
        return entry.end >= minTs && entry.start <= maxTs;
      });
    }

    function drawProfileRanges(ctx, samples, left, top, width, height) {
      if (!samples.length) return;
      const ranges = cpuProfileRanges(samples);
      if (!ranges.length) return;
      const minTs = samples[0].timestamp;
      const maxTs = samples[samples.length - 1].timestamp;
      const span = Math.max(maxTs - minTs, 1e-6);
      ranges.forEach(function (range) {
        const startRatio = Math.max(0, Math.min(1, (range.start - minTs) / span));
        const endRatio = Math.max(0, Math.min(1, (range.end - minTs) / span));
        const x = left + startRatio * width;
        const w = Math.max(2, (endRatio - startRatio) * width);
        ctx.fillStyle = range.active ? 'rgba(255, 209, 102, 0.20)' : 'rgba(143, 184, 255, 0.12)';
        ctx.fillRect(x, top, w, height);
        ctx.strokeStyle = range.active ? 'rgba(255, 209, 102, 0.58)' : 'rgba(143, 184, 255, 0.32)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, top + 0.5, Math.max(1, w - 1), Math.max(1, height - 1));
      });
    }

    function drawSingleChart(canvas, ctx, samples, selector, color, formatter, labelNode, mode, suffix) {
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const values = samples.map(selector);
      const scale = computeScale(values, mode);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, suffix);
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, samples);
      if (mode === 'cpu') {
        drawProfileRanges(ctx, samples, left, top, plotWidth, plotHeight);
      }
      drawLine(ctx, values, color, scale.min, scale.max, left, top, plotWidth, plotHeight);
      const focusIndex = hoverSampleIndex === null ? samples.length - 1 : Math.min(hoverSampleIndex, samples.length - 1);
      const focusSample = samples[focusIndex];
      drawHover(ctx, focusSample, focusIndex, samples.length, left, top, plotWidth, plotHeight);
      labelNode.textContent = focusSample ? formatter(selector(focusSample)) : '-';
    }

    function breakdownColor(index) {
      const palette = ['#6ca0ff', '#2ec4a6', '#ff8c61', '#ffd166', '#9be564', '#ff9db0', '#b79cff', '#72ddf7', '#f7b267', '#7bd389', '#bfc7d5', '#8d99ae'];
      return palette[index % palette.length];
    }

    function collectBreakdownCategories(samples) {
      const categories = [];
      samples.forEach(function (sample) {
        preferredBreakdownEntries(sample.pss_breakdown_mb || {}).forEach(function (entry) {
          if (!categories.includes(entry[0])) categories.push(entry[0]);
        });
      });
      return categories;
    }

    function sumBreakdown(breakdown) {
      return Object.values(breakdown || {}).reduce(function (sum, value) {
        return sum + (Number(value) || 0);
      }, 0);
    }

    function renderBreakdownLegend(categories, focusSample) {
      const breakdown = focusSample && focusSample.pss_breakdown_mb ? focusSample.pss_breakdown_mb : {};
      const entries = categories.map(function (key, index) {
        return {
          key: key,
          label: BREAKDOWN_LABELS[key] || key,
          value: breakdown[key] || 0,
          color: breakdownColor(index)
        };
      }).filter(function (entry) {
        return entry.value > 0;
      }).sort(function (left, right) {
        return right.value - left.value;
      });
      pssLegend.innerHTML = entries.length
        ? entries.map(function (entry) {
            return '<span class="legend-item"><span class="legend-swatch" style="background:' + entry.color + '"></span><span>' + entry.label + '</span><strong>' + entry.value.toFixed(1) + 'MB</strong></span>';
          }).join('')
        : '<span class="legend-item">No breakdown</span>';
    }

    function drawBreakdownChart(canvas, ctx, samples, labelNode) {
      resizeCanvas(canvas, ctx);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      const left = 62;
      const top = 18;
      const plotWidth = width - 86;
      const plotHeight = height - 62;
      const categories = collectBreakdownCategories(samples);
      const totals = samples.map(function (sample) {
        return sample.pss_mb !== null && sample.pss_mb !== undefined ? sample.pss_mb : sumBreakdown(sample.pss_breakdown_mb || {});
      });
      const scale = buildTicks(0, Math.max.apply(null, totals.concat([1])) * 1.08, 6);
      drawYGrid(ctx, left, top, plotWidth, plotHeight, scale.ticks, scale.min, scale.max, ' MB');
      drawTimeAxis(ctx, left, top, plotWidth, plotHeight, samples);
      const barWidth = Math.max(3, Math.min(18, plotWidth / Math.max(samples.length, 1) * 0.72));
      const focusIndex = hoverSampleIndex === null ? null : Math.min(hoverSampleIndex, samples.length - 1);
      samples.forEach(function (sample, sampleIndex) {
        let base = 0;
        const centerX = left + (sampleIndex / Math.max(samples.length - 1, 1)) * plotWidth;
        const barX = centerX - barWidth / 2;
        categories.forEach(function (key, categoryIndex) {
          const value = (sample.pss_breakdown_mb || {})[key] || 0;
          if (value <= 0) return;
          const topValue = base + value;
          const yTop = top + plotHeight - (topValue / Math.max(scale.max, 1e-6)) * plotHeight;
          const yBottom = top + plotHeight - (base / Math.max(scale.max, 1e-6)) * plotHeight;
          ctx.fillStyle = breakdownColor(categoryIndex) + (focusIndex === null || focusIndex === sampleIndex ? 'dd' : '70');
          ctx.fillRect(barX, yTop, barWidth, Math.max(1, yBottom - yTop));
          base = topValue;
        });
      });
      drawLine(ctx, totals, 'rgba(237,243,255,0.92)', 0, scale.max, left, top, plotWidth, plotHeight);
      const focusIndexFinal = hoverSampleIndex === null ? samples.length - 1 : Math.min(hoverSampleIndex, samples.length - 1);
      const focusSample = samples[focusIndexFinal];
      drawHover(ctx, focusSample, focusIndexFinal, samples.length, left, top, plotWidth, plotHeight);
      const totalText = focusSample ? ((focusSample.pss_mb !== null && focusSample.pss_mb !== undefined ? focusSample.pss_mb : sumBreakdown(focusSample.pss_breakdown_mb || {})).toFixed(2) + ' MB') : '-';
      const javaText = focusSample && focusSample.java_heap_mb !== null && focusSample.java_heap_mb !== undefined ? focusSample.java_heap_mb.toFixed(2) + ' MB' : '-';
      const nativeText = focusSample && focusSample.native_heap_mb !== null && focusSample.native_heap_mb !== undefined ? focusSample.native_heap_mb.toFixed(2) + ' MB' : '-';
      labelNode.textContent = 'Total ' + totalText + ' · Java ' + javaText + ' · Native ' + nativeText;
      renderBreakdownLegend(categories, focusSample);
    }

    function drawCharts(samples) {
      currentVisibleSamples = sliceByWindow(samples);
      syncButtons(windowControls, 'window', activeWindow);
      syncButtons(cpuScaleControls, 'cpuScale', cpuScaleMode);
      drawSingleChart(cpuCanvas, cpuCtx, currentVisibleSamples, function (sample) {
        return sample.app_cpu_pct;
      }, '#ff7a59', function (value) {
        return value === null || value === undefined ? '-' : value.toFixed(2) + '%';
      }, cpuChartLabel, 'cpu', '%');
      drawBreakdownChart(pssCanvas, pssCtx, currentVisibleSamples, pssChartLabel);
    }

    function currentPayloadLastDumpSample() {
      const event = currentPayload && currentPayload.last_dump_event;
      if (!event) return null;
      return event;
    }

    function resolveDumpStatusText(payload) {
      if (payload && payload.dump_in_progress) {
        return payload.dump_in_progress_type === 'leak' ? 'auto dumping' : 'dumping';
      }
      const dumpSample = currentPayloadLastDumpSample();
      if (dumpSample) return 'ready';
      if (payload && payload.manual_dump_enabled === false && payload.manual_dump_reason !== 'leak capture disabled') return 'unsupported';
      return 'idle';
    }

    function setDumpLoading(active, status) {
      dumpInFlight = active;
      manualDumpButton.textContent = active ? 'Loading...' : dumpButtonDefaultText;
      manualDumpButton.disabled = active || !(currentPayload && currentPayload.manual_dump_enabled);
      document.getElementById('manualDumpStatus').classList.toggle('hidden', true);
      setText('dumpStatusText', status || 'idle');
    }

    function setCpuProfileLoading(active) {
      cpuProfileInFlight = active;
      const button = document.getElementById('cpuProfileButton');
      button.textContent = active
        ? 'Loading...'
        : (currentPayload && currentPayload.cpu_profile_in_progress ? cpuProfileButtonStopText : cpuProfileButtonStartText);
      button.disabled = active || !(currentPayload && currentPayload.manual_cpu_profile_enabled);
    }

    function formatElapsedDuration(totalSeconds) {
      const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
      const minutes = Math.floor(safe / 60);
      const seconds = safe % 60;
      return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function refreshCpuProfileTimer() {
      const startedAt = currentPayload && currentPayload.cpu_profile_in_progress_started_at;
      if (!(currentPayload && currentPayload.cpu_profile_in_progress && startedAt)) {
        cpuProfileTimer.textContent = 'Recording 00:00';
        cpuProfileTimer.classList.add('hidden');
        return;
      }
      const startedMs = new Date(startedAt).getTime();
      const elapsedSec = Number.isFinite(startedMs) ? (Date.now() - startedMs) / 1000 : 0;
      cpuProfileTimer.textContent = 'Recording ' + formatElapsedDuration(elapsedSec);
      cpuProfileTimer.classList.remove('hidden');
    }

    function ensureCpuProfileTimerLoop() {
      if (cpuProfileTimerHandle !== null) return;
      cpuProfileTimerHandle = window.setInterval(refreshCpuProfileTimer, 500);
    }

    function syncCpuProfileLoadingFromPayload(payload) {
      if (cpuProfileInFlight) return;
      setCpuProfileLoading(false);
    }

    function syncDumpLoadingFromPayload(payload) {
      if (payload && payload.dump_in_progress) {
        setDumpLoading(true, resolveDumpStatusText(payload));
        return;
      }
      if (dumpInFlight) {
        setDumpLoading(false, resolveDumpStatusText(payload));
      }
    }

    function renderDumpHistory(history) {
      const safeHistory = history || [];
      const manualCount = safeHistory.filter(function (entry) { return entry.dump_type === 'manual'; }).length;
      const leakCount = safeHistory.filter(function (entry) { return entry.dump_type === 'leak'; }).length;
      setText('dumpSummaryText', safeHistory.length ? 'Total ' + safeHistory.length + ' · Manual ' + manualCount + ' · Leak ' + leakCount : 'No dumps yet');
      if (!safeHistory.length) {
        document.getElementById('dumpHistoryList').innerHTML = '<div class="dump-entry"><div class="dump-entry-sub">No dumps yet</div></div>';
        return;
      }
      document.getElementById('dumpHistoryList').innerHTML = safeHistory.map(function (entry) {
        return '<div class="dump-entry">' +
          '<div class="dump-entry-head"><span>' + formatClock(entry.timestamp || entry.timestamp_iso) + '</span><span class="dump-tag">' + (entry.dump_type || '-') + '</span></div>' +
          '<div class="dump-entry-sub">PID ' + (entry.pid || '-') + ' · ' + (entry.dump_hprof_name || basename(entry.dump_hprof_path)) + '</div>' +
          '<div class="dump-actions"><a class="dump-link" href="' + entry.hprof_download_url + '" download>HPROF</a><a class="dump-link" href="' + entry.manifest_download_url + '" download>Manifest</a></div>' +
          '</div>';
      }).join('');
    }

    function updateDetails() {
      const samples = currentVisibleSamples;
      const focusIndex = hoverSampleIndex === null ? samples.length - 1 : Math.min(hoverSampleIndex, samples.length - 1);
      const focusSample = samples[focusIndex];
      const dumpSample = currentPayloadLastDumpSample();
      if (!dumpInFlight) setText('dumpStatusText', resolveDumpStatusText(currentPayload));
      setText('dumpTypeText', dumpSample && dumpSample.dump_type ? dumpSample.dump_type : '-');
      setText('dumpTimeText', dumpSample ? formatClock(dumpSample.timestamp || dumpSample.timestamp_iso) : '-');
      setText('dumpPathText', dumpSample ? (dumpSample.dump_hprof_name || basename(dumpSample.dump_hprof_path)) : '-');
      setText('manifestPathText', dumpSample ? (dumpSample.dump_manifest_name || basename(dumpSample.dump_manifest_path)) : '-');
      setText('dumpMessageText', currentPayload && currentPayload.dump_in_progress_message ? currentPayload.dump_in_progress_message : (manualDumpMessage || (currentPayload && currentPayload.manual_dump_reason) || '-'));
      renderDumpHistory(currentPayload ? currentPayload.dump_history : []);
      setText('leakText', focusSample ? focusSample.leak_status : '-');
      setText('activitiesText', focusSample && focusSample.activities !== null && focusSample.activities !== undefined ? focusSample.activities : '-');
      setText('viewRootText', focusSample && focusSample.view_root_impl !== null && focusSample.view_root_impl !== undefined ? focusSample.view_root_impl : '-');
    }

    function updateMetrics(payload) {
      currentPayload = payload;
      currentSamples = payload && Array.isArray(payload.samples) ? payload.samples : [];
      syncDumpLoadingFromPayload(payload);
      syncCpuProfileLoadingFromPayload(payload);
      updateConnectionBanner(payload);
      const latest = payload ? payload.latest : null;
      const deviceInfo = payload && payload.device_info ? payload.device_info : {};
      setText('packageText', payload ? payload.package : '-');
      setText('deviceModelText', deviceInfo.model || '-');
      setText('androidVersionText', deviceInfo.android || '-');
      setText('serialText', deviceInfo.serial || '-');
      setText('cpuCoresText', deviceInfo.cpu_cores ? String(deviceInfo.cpu_cores) : '-');
      setText('cpuFrequencyText', deviceInfo.cpu_frequency || '-');
      setText('appMaxHeapText', payload && payload.app_max_java_heap_mb !== null && payload.app_max_java_heap_mb !== undefined ? payload.app_max_java_heap_mb.toFixed(2) + ' MB' : '-');
      setText('debuggableText', payload && payload.debuggable ? 'supported' : 'unsupported');
      setText('profileableText', payload && payload.profileable ? 'supported' : 'unsupported');
      setText('rootedText', payload && payload.rooted ? 'supported' : 'unsupported');
      manualDumpButton.disabled = !(payload && payload.manual_dump_enabled) || dumpInFlight;
      const cpuProfileButton = document.getElementById('cpuProfileButton');
      cpuProfileButton.disabled = !(payload && payload.manual_cpu_profile_enabled) || cpuProfileInFlight;
      cpuProfileButton.textContent = payload && payload.cpu_profile_in_progress ? cpuProfileButtonStopText : cpuProfileButtonStartText;
      refreshCpuProfileTimer();
      const capabilityHint = dumpCapabilitySummary(payload);
      dumpCapabilityHint.textContent = capabilityHint;
      dumpCapabilityHint.classList.toggle('hidden', !capabilityHint);
      const cpuProfileHint = document.getElementById('cpuProfileCapabilityHint');
      const cpuProfileReason = cpuProfileCapabilitySummary(payload);
      cpuProfileHint.textContent = cpuProfileReason;
      cpuProfileHint.classList.toggle('hidden', !cpuProfileReason);
      if (payload && payload.connection_status === 'disconnected') {
        manualDumpButton.disabled = true;
        cpuProfileButton.disabled = true;
        setText('statusText', 'disconnected');
        setText('lastTs', '-');
        setText('pidText', '-');
        setText('sourceText', '-');
        updateNote(payload.connection_note || 'waiting for device reconnect');
        updateDetails();
        return;
      }
      if (!latest) {
        setText('statusText', 'waiting for first sample');
        setText('lastTs', '-');
        setText('pidText', '-');
        setText('sourceText', '-');
        updateNote(manualDumpMessage || '');
        updateDetails();
        drawCharts([]);
        return;
      }
      setText('statusText', latest.status || '-');
      setText('lastTs', formatClock(latest.timestamp || latest.timestamp_iso));
      setText('pidText', latest.pids && latest.pids.length ? latest.pids.join(', ') : '-');
      setText('sourceText', latest.cpu_source || '-');
      updateNote(manualDumpMessage || latest.note || '');
      drawCharts(currentSamples);
      updateDetails();
    }

    async function triggerManualDump() {
      if (manualDumpButton.disabled) return;
      await requestNotificationPermissionFromGesture();
      setDumpLoading(true, 'dumping');
      try {
        const response = await fetch('/api/dump', { method: 'POST', cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'manual dump failed');
        manualDumpMessage = 'manual dump saved: ' + (payload.dump.dump_hprof_name || basename(payload.dump.dump_hprof_path));
        const latestDumpKey = makeDumpKey(payload.dump);
        if (latestDumpKey) {
          lastSeenDumpKey = latestDumpKey;
          lastSeenDumpReady = true;
        }
        await notifyDump(payload.dump);
        await poll(true);
      } catch (error) {
        manualDumpMessage = 'manual dump failed: ' + String(error);
        setDumpLoading(false, 'failed');
        updateNote(manualDumpMessage);
      }
    }

    async function triggerCpuProfile() {
      const cpuProfileButton = document.getElementById('cpuProfileButton');
      if (cpuProfileButton.disabled) return;
      setCpuProfileLoading(true);
      try {
        const inProgress = Boolean(currentPayload && currentPayload.cpu_profile_in_progress);
        const response = await fetch(inProgress ? '/api/cpu-profile/stop' : '/api/cpu-profile/start', {
          method: 'POST',
          cache: 'no-store'
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'cpu profile failed');
        if (inProgress) {
          cpuProfileMessage = payload.capture.gecko_profile_name
            ? 'cpu profile ready: ' + payload.capture.gecko_profile_name
            : 'cpu profile saved: ' + (payload.capture.perf_data_name || basename(payload.capture.perf_data_path));
          await poll(true);
          if (payload.capture.firefox_profiler_url) {
            window.open(payload.capture.firefox_profiler_url, '_blank', 'noopener,noreferrer');
          } else if (payload.capture.gecko_profile_error) {
            cpuProfileMessage = 'cpu profile saved, but Firefox export failed: ' + payload.capture.gecko_profile_error;
          }
        } else {
          cpuProfileMessage = 'simpleperf recording started';
          await poll(true);
        }
      } catch (error) {
        cpuProfileMessage = 'cpu profile failed: ' + String(error);
      } finally {
        setCpuProfileLoading(false);
        cpuChartLabel.textContent = cpuProfileMessage || cpuChartLabel.textContent;
        drawCharts(currentSamples);
      }
    }

    function isoToUnix(value) {
      if (!value) return 0;
      const time = new Date(value).getTime();
      return Number.isFinite(time) ? time / 1000 : 0;
    }

    async function poll(skipSchedule) {
      try {
        const response = await fetch('/api/state', { cache: 'no-store' });
        const payload = await response.json();
        const latestDumpKey = makeDumpKey(payload && payload.last_dump_event);
        if (!lastSeenDumpReady) {
          lastSeenDumpKey = latestDumpKey;
          lastSeenDumpReady = true;
        } else if (latestDumpKey && latestDumpKey !== lastSeenDumpKey) {
          lastSeenDumpKey = latestDumpKey;
          await notifyDump(payload.last_dump_event);
        }
        updateMetrics(payload);
      } catch (error) {
        setText('statusText', 'reconnecting');
        updateNote('waiting for local watcher');
      } finally {
        if (!skipSchedule) {
          clearTimeout(pollTimer);
          pollTimer = window.setTimeout(poll, 800);
        }
      }
    }

    windowControls.addEventListener('click', function (event) {
      const button = event.target.closest('[data-window]');
      if (!button) return;
      activeWindow = button.dataset.window;
      hoverSampleIndex = null;
      drawCharts(currentSamples);
      updateDetails();
    });

    cpuScaleControls.addEventListener('click', function (event) {
      const button = event.target.closest('[data-cpu-scale]');
      if (!button) return;
      cpuScaleMode = button.dataset.cpuScale;
      drawCharts(currentSamples);
      updateDetails();
    });

    [cpuCanvas, pssCanvas].forEach(attachHoverHandlers);
    window.addEventListener('resize', function () {
      drawCharts(currentSamples);
      updateDetails();
    });
    manualDumpButton.addEventListener('click', triggerManualDump);
    document.getElementById('cpuProfileButton').addEventListener('click', triggerCpuProfile);
    clearLegacyServiceWorkers();
    ensureNotificationPermission();
    ensureCpuProfileTimerLoop();
    poll();
  </script>
</body>
</html>`;
}
