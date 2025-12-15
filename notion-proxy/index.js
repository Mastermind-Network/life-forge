'use strict';

// Env & setup
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');

const PORT = Number((process.env.PORT || '5174').trim());
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:5173').trim();
const DB_ID = (process.env.NOTION_DATABASE_ID || '').trim();
const TOKEN = (process.env.NOTION_TOKEN || '').trim();

// Notion client & property names 
const notion = new Client({ auth: TOKEN, notionVersion: '2022-06-28' });
const DATE_PROP = 'Date & Time';
const LENGTH_PROP = 'Time Estimate';

// App & helpers 
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  err:  (...a) => console.error('[ERR ]', ...a),
};
const explain = (e) => ({ status: e?.status || 500, code: e?.code, message: e?.message || String(e), body: e?.body });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const getDates = (page) => {
  const d = page?.properties?.[DATE_PROP]?.date || null;
  return { startISO: d?.start || null, endISO: d?.end || null };
};
const isDateOnly = (iso) => typeof iso === 'string' && iso.length === 10;

// Parses labels like "1h 30m" into minutes
function parseDurationLabelToMinutes(label) {
  if (!label || typeof label !== "string") return null;
  const txt = label.replace(/[^\dhm\s]/gi, "").toLowerCase();
  const h = (txt.match(/(\d+)\s*h/) || [])[1];
  const m = (txt.match(/(\d+)\s*m/) || [])[1];
  const total = (h ? parseInt(h, 10) : 0) * 60 + (m ? parseInt(m, 10) : 0);
  return total > 0 ? total : null;
}

// Health/debug
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'notion-proxy', node: process.version, notionSdk: require('@notionhq/client/package.json').version });
});
app.get('/debug/env', (_req, res) => {
  res.json({ DB_ID, tokenPrefix: TOKEN.slice(0, 4), tokenLen: TOKEN.length, CORS_ORIGIN, PORT });
});
app.get('/debug/me', asyncRoute(async (_req, res) => {
  const me = await notion.users.me();
  res.json({ ok: true, me });
}));
app.get('/debug/schema', asyncRoute(async (_req, res) => {
  const db = await notion.request({ path: `databases/${DB_ID}`, method: 'GET' });
  res.json({ ok: true, object: db?.object, title: db?.title?.[0]?.plain_text || null, properties: Object.keys(db?.properties || {}) });
}));
app.get('/debug/search', asyncRoute(async (req, res) => {
  const q = (req.query.q || '').toString();
  const r = await notion.request({
    path: 'search', method: 'POST',
    body: { query: q, filter: { property: 'object', value: 'database' }, page_size: 25 },
  });
  const results = (r.results || []).map((d) => ({
    id_no_dashes: (d.id || '').replace(/-/g, ''),
    id: d.id,
    title: d.title?.[0]?.plain_text || '(untitled)',
    url: d.url || null,
    parent_type: d.parent?.type,
    is_inline: d.is_inline,
  }));
  res.json({ ok: true, count: results.length, results });
}));
app.get('/debug/next-raw', asyncRoute(async (_req, res) => {
  const nowISO = new Date().toISOString();
  const q = await notion.request({
    path: `databases/${DB_ID}/query`, method: 'POST',
    body: { filter: { property: DATE_PROP, date: { on_or_after: nowISO } }, sorts: [{ property: DATE_PROP, direction: 'ascending' }], page_size: 1 },
  });
  const sample = q.results?.[0] || null;
  res.json({ ok: true, count: q.results?.length || 0, samplePropertyKeys: sample?.properties ? Object.keys(sample.properties) : [], sample });
}));

// API: next task (consumed by the Pomodoro UI)
app.get('/tasks/next', asyncRoute(async (_req, res) => {
  const now = new Date();
  const nowISO = now.toISOString();

  let q = await notion.request({
    path: `databases/${DB_ID}/query`, method: 'POST',
    body: { filter: { property: DATE_PROP, date: { on_or_after: nowISO } }, sorts: [{ property: DATE_PROP, direction: 'ascending' }], page_size: 5 },
  });

  // If none >= now, pick the next one in the calendar sense (today or later)
  if (!q.results?.length) {
    const alt = await notion.request({
      path: `databases/${DB_ID}/query`, method: 'POST',
      body: { sorts: [{ property: DATE_PROP, direction: 'ascending' }], page_size: 10 },
    });
    const pick = (alt.results || []).find((p) => {
      const { startISO } = getDates(p);
      if (!startISO) return false;
      const s = new Date(startISO);
      if (isDateOnly(startISO)) {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sDay = new Date(s.getFullYear(), s.getMonth(), s.getDate());
        return sDay >= today;
      }
      return s >= now;
    });
    if (pick) q.results = [pick];
  }

  const page = q.results?.[0];
  if (!page) return res.json({ next: null });

  const title = page.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
  const { startISO, endISO } = getDates(page);

  // Pick minutes from number property or label like "30m" / "1h"
  let lengthMin = 25;
  const numVal = page.properties?.[LENGTH_PROP]?.number;
  if (typeof numVal === "number") lengthMin = Math.max(1, Math.round(numVal));
  const selName = page.properties?.[LENGTH_PROP]?.select?.name || page.properties?.[LENGTH_PROP]?.multi_select?.[0]?.name || null;
  const parsed = parseDurationLabelToMinutes(selName);
  if (parsed != null) lengthMin = parsed;

  const plannedEndISO = endISO || (startISO ? new Date(new Date(startISO).getTime() + lengthMin * 60000).toISOString() : null);

  res.json({ next: { id: page.id, title, plannedStartISO: startISO, plannedEndISO, lengthMin } });
}));

// Errors & boot
app.use((err, _req, res, _next) => {
  const out = explain(err);
  log.err('Unhandled error:', out);
  res.status(out.status).json(out);
});

(async () => {
  log.info('Booting notion-proxy …');
  log.info({
    node: process.version,
    notionSdk: require('@notionhq/client/package.json').version,
    DB_ID,
    tokenPrefix: TOKEN.slice(0, 4),
    tokenLen: TOKEN.length,
    CORS_ORIGIN,
    PORT,
  });

  if (!TOKEN) log.warn('NOTION_TOKEN is empty.');
  if (!DB_ID) log.warn('NOTION_DATABASE_ID is empty.');

  try {
    const me = await notion.users.me();
    log.info('Token OK. Bot user:', me?.name || me?.bot?.owner?.workspace_name || 'bot');
  } catch (e) {
    log.err('Token check failed:', explain(e));
  }

  try {
    const db = await notion.request({ path: `databases/${DB_ID}`, method: 'GET' });
    log.info('DB reachable:', db?.title?.[0]?.plain_text || '(untitled)');
    log.info('   Properties:', Object.keys(db?.properties || {}));
  } catch (e) {
    log.err('DB retrieve failed:', explain(e));
    log.warn('Hints: 403=DB not shared | 404=bad DB_ID | 400=Linked view id');
  }
})();

const server = app.listen(PORT, () => {
  log.info(`notion-proxy listening at http://localhost:${PORT}`);
});

const shutdown = (sig) => () => {
  log.info(`${sig} received, shutting down…`);
  server.close(() => {
    log.info('HTTP server closed.');
    process.exit(0);
  });
};
process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
