// Shared-state API for the Relify dashboard.
// GET  /api/state        -> { state: <object|null> }   reads the shared dashboard state
// POST /api/state {state} -> { ok: true }                saves the shared dashboard state
//
// Backed by an Upstash Redis store provisioned through Vercel (Storage tab).
// The Vercel integration injects the REST URL + token as env vars; we read the
// common names so this works whichever integration variant was chosen.
// The token stays server-side (never shipped to the browser).

module.exports = async function handler(req, res) {
  var BASE  = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL;
  var TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  var KEY = 'relify_dashboard_state';

  res.setHeader('Cache-Control', 'no-store');

  // Storage not wired up yet -> tell the client gracefully so it falls back to localStorage.
  if (!BASE || !TOKEN) {
    res.status(200).json({ state: null, warning: 'storage-not-configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      var r = await fetch(BASE + '/get/' + KEY, { headers: { Authorization: 'Bearer ' + TOKEN } });
      var j = await r.json();
      var val = (j && j.result) ? JSON.parse(j.result) : null;
      res.status(200).json({ state: val });
      return;
    }

    if (req.method === 'POST') {
      var body = req.body;
      if (!body) {
        body = await new Promise(function (resolve) {
          var d = ''; req.on('data', function (c) { d += c; }); req.on('end', function () { resolve(d); });
        });
      }
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      var state = (body && body.state !== undefined) ? body.state : body;

      var r2 = await fetch(BASE + '/set/' + KEY, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'text/plain' },
        body: JSON.stringify(state)
      });
      var j2 = await r2.json();
      res.status(200).json({ ok: true, result: j2 });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
