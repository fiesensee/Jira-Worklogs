// Local web app: serves the UI, proxies Jira calls (so the PAT never leaves this machine and CORS is no issue)
// and stores drafts and mapping rules as JSON files under data/.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJira, formatStarted } from './lib/jira.js';
import { readTimesheet } from './lib/timesheet.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT || 5199);
const startTime = process.env.WORKLOG_START || '09:00';

const jira = createJira({
  url: process.env.JIRA_URL,
  pat: process.env.JIRA_PAT,
  mock: process.env.JIRA_MOCK === '1',
  assignedJql: process.env.JIRA_ASSIGNED_JQL
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const safeName = id => id.replace(/[^\w.-]+/g, '_');

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

const draftFile = id => join(dataDir, 'drafts', `${safeName(id)}.json`);
const configFile = join(dataDir, 'config.json');

const routes = {
  'GET /api/status': async () => ({ mock: jira.mock, user: await jira.myself(), startTime }),
  'GET /api/issues/assigned': () => jira.assigned(),
  'GET /api/issues/find': (_req, url) => jira.find(url.searchParams.get('q') || ''),
  'GET /api/config': () => readJson(configFile, { positions: {}, snippets: {} }),
  'PUT /api/config': async req => { await writeJson(configFile, JSON.parse(await readBody(req))); return { ok: true }; },
  'GET /api/draft': (_req, url) => readJson(draftFile(url.searchParams.get('id')), null),
  'PUT /api/draft': async (req, url) => {
    await writeJson(draftFile(url.searchParams.get('id')), JSON.parse(await readBody(req)));
    return { ok: true };
  },
  'POST /api/timesheet': async req => readTimesheet(await readBody(req)),
  'POST /api/worklog': async req => {
    const { key, date, minutes, comment } = JSON.parse(await readBody(req));
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(minutes > 0)) throw new Error('key, date and minutes are required');
    return jira.addWorklog(key, { started: formatStarted(date, startTime), minutes, comment: comment || '' });
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      send(res, 200, await handler(req, url));
    } catch (e) {
      send(res, 502, { error: e.message });
    }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (file.includes('..')) return send(res, 400, { error: 'Bad path' });
  try {
    const body = await readFile(join(root, 'public', file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Jira worklogs: http://localhost:${port}${jira.mock ? '  (mock Jira, nothing is sent anywhere)' : ''}`);
});
