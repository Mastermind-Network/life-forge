'use strict';

// Load env from local .env next to this file
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Core deps
const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');

// ENV
const PORT = Number((process.env.PORT || '5174').trim()); //Proxy port
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:5173').trim(); //Allow your Vite app
const DB_ID = (process.env.NOTION_DATABASE_ID || '').trim(); //SOURCE Notion DB id (not a linked view)
const TOKEN = (process.env.NOTION_TOKEN || '').trim(); //ntn_... token

// NOTION CLIENT 
// Use generic request() + pinned API version for max compatibility
const notion = new Client({
  auth: TOKEN,
  notionVersion: '2022-06-28', //Stable version
});

// Property names in your DB (MUST MATCH EXACTLY; case-sensitive)
const DATE_PROP = 'Date & Time';     //Date property
const LENGTH_PROP = 'Time Estimate'; //Number (assumed HOURS → minutes)

// APP, LOGGING, HELPERS
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN })); //CORS for your Vite origin

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  err:  (...a) => console.error('[ERR ]', ...a),
};

// Normalize Notion errors into a small consistent object
const explain = (e) => ({
  status: e?.status || 500,
  code: e?.code,
  message: e?.message || String(e),
  body: e?.body,
});

// Wrapper for async routes (so thrown errors hit the handler)
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Pull start/end from a page’s date property
const getDates = (page) => {
  const d = page?.properties?.[DATE_PROP]?.date || null;
  return { startISO: d?.start || null, endISO: d?.end || null };
};

// Detect all-day dates (YYYY-MM-DD)
const isDateOnly = (iso) => typeof iso === 'string' && iso.length === 10;

// HEALTH & DEBUG
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'notion-proxy',
    node: process.version,
    notionSdk: require('@notionhq/client/package.json').version,
  });
});

app.get('/debug/env', (_req, res) => {
  res.json({
    DB_ID,
    tokenPrefix: TOKEN.slice(0, 4), //'ntn_'
    tokenLen: TOKEN.length,
    CORS_ORIGIN,
    PORT,
  });
});

app.get('/debug/me', asyncRoute(async (_req, res) => {
  const me = await notion.users.me(); //Validates token independently of DB
  res.json({ ok: true, me });
}));

app.get('/debug/schema', asyncRoute(async (_req, res) => {
  const db = await notion.request({ path: `databases/${DB_ID}`, method: 'GET' }); //Fails if DB not shared or wrong id
  res.json({
    ok: true,
    object: db?.object,
    title: db?.title?.[0]?.plain_text || null,
    properties: Object.keys(db?.properties || {}),
  });
}));

app.get('/debug/search', asyncRoute(async (req, res) => {
  // Lists databases this bot can access (useful to find the SOURCE DB id)
  const q = (req.query.q || '').toString();
  const r = await notion.request({
    path: 'search',
    method: 'POST',
    body: {
      query: q,
      filter: { property: 'object', value: 'database' },
      page_size: 25,
    },
  });
  const results = (r.results || []).map((d) => ({
    id_no_dashes: (d.id || '').replace(/-/g, ''), //Paste this into .env
    id: d.id,
    title: d.title?.[0]?.plain_text || '(untitled)',
    url: d.url || null,
    parent_type: d.parent?.type,
    is_inline: d.is_inline,
  }));
  res.json({ ok: true, count: results.length, results });
}));

app.get('/debug/next-raw', asyncRoute(async (_req, res) => {
  // Raw query used by /tasks/next (helps debug filters and property names)
  const nowISO = new Date().toISOString();
  const q = await notion.request({
    path: `databases/${DB_ID}/query`,
    method: 'POST',
    body: {
      filter: { property: DATE_PROP, date: { on_or_after: nowISO } }, //Future or now
      sorts: [{ property: DATE_PROP, direction: 'ascending' }],       //Soonest first
      page_size: 1,
    },
  });
  const sample = q.results?.[0] || null;
  res.json({
    ok: true,
    count: q.results?.length || 0,
    samplePropertyKeys: sample?.properties ? Object.keys(sample.properties) : [],
    sample,
  });
}));

// Next task for Pomodoro
app.get('/tasks/next', asyncRoute(async (_req, res) => {
  const now = new Date();
  const nowISO = now.toISOString();

  // Primary: items with Date & Time on/after now (UTC)
  let q = await notion.request({
    path: `databases/${DB_ID}/query`,
    method: 'POST',
    body: {
      filter: { property: DATE_PROP, date: { on_or_after: nowISO } },
      sorts: [{ property: DATE_PROP, direction: 'ascending' }],
      page_size: 5,
    },
  });

  // Fallback: handle all-day items (no time) by filtering locally
  if (!q.results?.length) {
    const alt = await notion.request({
      path: `databases/${DB_ID}/query`,
      method: 'POST',
      body: {
        sorts: [{ property: DATE_PROP, direction: 'ascending' }],
        page_size: 10,
      },
    });

    const pick = (alt.results || []).find((p) => {
      const { startISO } = getDates(p);
      if (!startISO) return false;
      const s = new Date(startISO);

      if (isDateOnly(startISO)) {
        // All-day: allow today or later
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sDay = new Date(s.getFullYear(), s.getMonth(), s.getDate());
        return sDay >= today;
      }
      return s >= now; //Timed event in the future
    });

    if (pick) q.results = [pick];
  }

  const page = q.results?.[0];
  if (!page) return res.json({ next: null }); //Nothing upcoming

  // Title + dates
  const title = page.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
  const { startISO, endISO } = getDates(page);

  // Duration: prefer Time Estimate; else compute from end-start; else default 25
  let lengthMin = 25;
  const n = page.properties?.[LENGTH_PROP]?.number;
  if (typeof n === 'number') {
    lengthMin = Math.round(n * 60); //If DB stores minutes, change to Math.round(n)
  } else if (startISO && endISO) {
    lengthMin = Math.max(1, Math.round((new Date(endISO) - new Date(startISO)) / 60000));
  }

  // If Notion has no end, synthesize one from start + length
  const plannedEndISO =
    endISO ||
    (startISO
      ? new Date(new Date(startISO).getTime() + lengthMin * 60000).toISOString()
      : null);

  res.json({
    next: {
      id: page.id,
      title,
      plannedStartISO: startISO,
      plannedEndISO,
      lengthMin,
    },
  });
}));

// ----- Error handler (last) ----- //
app.use((err, _req, res, _next) => {
  const out = explain(err);
  log.err('Unhandled error:', out); // // Centralized logging
  res.status(out.status).json(out);
});

// ----- Startup self-checks & server ----- //
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

  if (!TOKEN) log.warn('NOTION_TOKEN is empty.');       //Must be set
  if (!DB_ID) log.warn('NOTION_DATABASE_ID is empty.'); //Must be SOURCE DB

  try {
    const me = await notion.users.me();
    log.info('Token OK. Bot user:', me?.name || me?.bot?.owner?.workspace_name || 'bot');
  } catch (e) {
    log.err('Token check failed:', explain(e));
  }

  try {
    const db = await notion.request({ path: `databases/${DB_ID}`, method: 'GET' });
    log.info('DB reachable:', db?.title?.[0]?.plain_text || '(untitled)'); //Confirms sharing + id
    log.info('   Properties:', Object.keys(db?.properties || {}));          //Check names here
  } catch (e) {
    log.err('DB retrieve failed:', explain(e));
    log.warn('Hints: 403=DB not shared | 404=bad DB_ID | 400=Linked view id'); //Common causes
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
