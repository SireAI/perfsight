import { readFile, writeFile } from 'node:fs/promises';

export async function exportReport({ csvPath, reportPath, packageName, startedAt, endedAt }) {
  let csv = '';
  try {
    csv = await readFile(csvPath, 'utf8');
  } catch {
    csv = '';
  }
  const rows = parseCsv(csv);
  const samples = rows.map((row) => ({
    timestamp: Number(row.timestamp_epoch),
    cpu: numberOrNull(row.app_cpu_pct),
    pss: numberOrNull(row.pss_mb),
    java: numberOrNull(row.java_heap_mb)
  })).filter((sample) => Number.isFinite(sample.timestamp));
  const html = renderReport({ packageName, startedAt, endedAt, samples, csvPath });
  await writeFile(reportPath, html, 'utf8');
}

function renderReport({ packageName, startedAt, endedAt, samples, csvPath }) {
  const embedded = JSON.stringify(samples);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PerfSight Report</title>
<style>body{margin:0;background:#0a0f18;color:#edf3ff;font-family:system-ui,sans-serif}main{width:min(1180px,calc(100vw - 32px));margin:20px auto;display:grid;gap:14px}section{background:#121a29;border:1px solid #263348;border-radius:8px;padding:16px}canvas{width:100%;height:300px;background:#090e17;border:1px solid #263348;border-radius:8px}.muted{color:#9fb0c7}</style></head>
<body><main><section><h1>PerfSight Report</h1><p class="muted">${escapeHtml(packageName)} / ${escapeHtml(startedAt)} - ${escapeHtml(endedAt)}</p><p class="muted">${escapeHtml(csvPath)}</p></section><section><canvas id="chart"></canvas></section></main>
<script>const samples=${embedded};const c=document.getElementById('chart');const ctx=c.getContext('2d');function resize(){const r=devicePixelRatio||1,b=c.getBoundingClientRect();c.width=b.width*r;c.height=b.height*r;ctx.setTransform(r,0,0,r,0,0);return b}function line(vals,color,max,l,t,w,h){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();vals.forEach((v,i)=>{if(v==null)return;const x=l+i/Math.max(vals.length-1,1)*w;const y=t+h-v/max*h;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke()}function draw(){const b=resize(),l=54,t=20,w=b.width-72,h=b.height-48,max=Math.max(1,...samples.flatMap(s=>[s.pss,s.java]).filter(Boolean))*1.08;ctx.clearRect(0,0,b.width,b.height);ctx.fillStyle='#9fb0c7';ctx.font='12px sans-serif';for(let i=0;i<=4;i++){const y=t+h-i/4*h;ctx.strokeStyle='rgba(255,255,255,.1)';ctx.beginPath();ctx.moveTo(l,y);ctx.lineTo(l+w,y);ctx.stroke();ctx.fillText((max*i/4).toFixed(0)+'MB',4,y+4)}line(samples.map(s=>s.pss),'#7ab7ff',max,l,t,w,h);line(samples.map(s=>s.java),'#40c4aa',max,l,t,w,h)}addEventListener('resize',draw);draw();</script></body></html>`;
}

function parseCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const header = splitCsvLine(lines.shift() || '');
  return lines.map((line) => Object.fromEntries(splitCsvLine(line).map((cell, index) => [header[index], cell])));
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
