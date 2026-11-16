// Local test app for the network capture: node test/fixtures/server.mjs  →  http://localhost:8787
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./api-playground.html', import.meta.url));
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const u = new URL(req.url, 'http://localhost');
    switch (u.pathname) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(page);
      case '/pgr-services/v2/request/_search':
        return json(res, 200, { ResponseInfo: { status: 'successful' }, ServiceWrappers: [{ service: { serviceRequestId: 'PGR-2026-11-14-000123', applicationStatus: 'PENDINGFORASSIGNMENT' } }] });
      case '/pgr-services/v2/request/_create':
        return json(res, 400, { ResponseInfo: null, Errors: [{ code: 'INVALID_TENANT_ID', message: 'Invalid tenant id: ke.bomet', description: null, params: null }] });
      case '/egov-mdms-service/v1/_search':
        return json(res, 200, { ResponseInfo: { status: 'failed' }, Errors: [{ code: 'MDMS_MASTER_NOT_FOUND', message: 'Master RAINMAKER-PGR.ServiceDefs not found' }] });
      case '/user/_details':
        res.writeHead(500, { 'content-type': 'text/html' });
        return res.end('<html><body><h1>Internal Server Error</h1></body></html>');
      case '/localization/messages/v1/_search':
        return json(res, 200, { messages: [{ code: 'CS_COMMON_SUBMIT', message: 'Submit', locale: 'en_IN' }] });
      default:
        res.writeHead(404);
        res.end('not found');
    }
  });
}).listen(8787, () => console.log('API playground on http://localhost:8787'));
