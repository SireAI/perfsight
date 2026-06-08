import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { renderLivePage } from './templates.js';

export function startWebServer({ host, port, state }) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
        send(response, 200, 'text/html; charset=utf-8', renderLivePage());
        return;
      }
      if (request.method === 'GET' && request.url === '/api/state') {
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(state.payload()));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/dump') {
        try {
          const dump = await state.triggerManualDump();
          send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, dump }));
        } catch (error) {
          send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(error.message || error) }));
        }
        return;
      }
      if (request.method === 'POST' && request.url === '/api/cpu-profile/start') {
        try {
          const capture = await state.startCpuProfile();
          send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, capture }));
        } catch (error) {
          send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(error.message || error) }));
        }
        return;
      }
      if (request.method === 'POST' && request.url === '/api/cpu-profile/stop') {
        try {
          const capture = await state.stopCpuProfile();
          send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, capture }));
        } catch (error) {
          send(response, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(error.message || error) }));
        }
        return;
      }
      const downloadMatch = request.url.match(/^\/downloads\/(\d+)\/(hprof|manifest)$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && downloadMatch) {
        const event = state.findDump(Number(downloadMatch[1]));
        const artifact = downloadMatch[2];
        const filePath = artifact === 'hprof' ? event?.dump_hprof_path : event?.dump_manifest_path;
        if (!filePath) {
          send(response, 404, 'text/plain; charset=utf-8', 'dump not found');
          return;
        }
        await sendFile(response, filePath, {
          headOnly: request.method === 'HEAD'
        });
        return;
      }
      const cpuProfileMatch = request.url.match(/^\/downloads\/cpu-profile\/(\d+)\/(perf-data|gecko-profile)$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && cpuProfileMatch) {
        const event = state.findCpuProfile(Number(cpuProfileMatch[1]));
        const artifact = cpuProfileMatch[2];
        const filePath = artifact === 'gecko-profile' ? event?.gecko_profile_path : event?.perf_data_path;
        if (!filePath) {
          send(response, 404, 'text/plain; charset=utf-8', 'cpu profile not found');
          return;
        }
        await sendFile(response, filePath, {
          contentType: artifact === 'gecko-profile' ? 'application/json; charset=utf-8' : 'application/octet-stream',
          attachmentName: path.basename(filePath),
          cors: true,
          headOnly: request.method === 'HEAD'
        });
        return;
      }
      send(response, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', String(error.stack || error));
    }
  });
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve(server);
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function sendFile(response, filePath, options = {}) {
  const info = await stat(filePath);
  response.writeHead(200, {
    'content-type': options.contentType || 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename="${options.attachmentName || path.basename(filePath)}"`,
    'cache-control': 'no-store',
    ...(options.cors ? { 'access-control-allow-origin': '*' } : {})
  });
  if (options.headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}
