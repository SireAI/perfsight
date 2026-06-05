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
      const downloadMatch = request.url.match(/^\/downloads\/(\d+)\/(hprof|manifest)$/);
      if (request.method === 'GET' && downloadMatch) {
        const event = state.findDump(Number(downloadMatch[1]));
        const artifact = downloadMatch[2];
        const filePath = artifact === 'hprof' ? event?.dump_hprof_path : event?.dump_manifest_path;
        if (!filePath) {
          send(response, 404, 'text/plain; charset=utf-8', 'dump not found');
          return;
        }
        await sendFile(response, filePath);
        return;
      }
      send(response, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', String(error.stack || error));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function sendFile(response, filePath) {
  const info = await stat(filePath);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename="${path.basename(filePath)}"`
  });
  createReadStream(filePath).pipe(response);
}
