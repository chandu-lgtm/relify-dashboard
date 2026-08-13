// Slack approval notifier for the Relify dashboard.
//
//   GET /api/notify           -> dry run: returns what WOULD be sent, sends nothing
//   GET /api/notify?send=1    -> posts the digest to Slack (used by the cron)
//
// Reads the same shared state as /api/state, counts anything waiting on the client,
// and posts a digest to a Slack Incoming Webhook.
//
// Setup (needs a Slack admin, one time, ~3 minutes):
//   1. api.slack.com/apps -> Create New App -> From scratch -> pick the workspace
//   2. Incoming Webhooks -> On -> Add New Webhook to Workspace -> choose the channel
//   3. Copy the webhook URL (https://hooks.slack.com/services/...)
//   4. Vercel -> Project -> Settings -> Environment Variables -> add SLACK_WEBHOOK_URL
//   5. Redeploy
//
// Incoming Webhooks work on Slack's FREE plan - no paid tier needed. Free workspaces
// cap at 10 installed apps, and Slack allows 1 message/sec/channel. This sends one
// digest a day, so neither limit is anywhere near being hit.
//
// MULTI-CLIENT: this file is client-agnostic. Each client gets its own Vercel project,
// its own Redis key and its own webhook, so their data can never mix. Per-deployment
// env vars:
//   CLIENT_NAME              display name in the message      (default 'Relify')
//   APP_URL                  dashboard link in the button     (default the Relify URL)
//   STATE_KEY                Redis key                        (default relify_dashboard_state)
//   SLACK_WEBHOOK_URL        -> the client's own workspace
//   SLACK_WEBHOOK_URL_AGENCY -> our workspace (optional; one channel across all clients,
//                               each message prefixed with CLIENT_NAME)
//
// Webhook URLs are secrets: they live ONLY in Vercel env vars, never in this repo.
// With none set the endpoint degrades gracefully and tells you what is missing.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var BASE  = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL;
  var TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;

  // Multi-client: nothing here is hardcoded to one client. A new client deployment
  // sets CLIENT_NAME / APP_URL / STATE_KEY and its own webhook, no code changes.
  var CLIENT = process.env.CLIENT_NAME || 'Relify';
  var APP    = process.env.APP_URL     || 'https://relify-dashboard.vercel.app';
  var KEY    = process.env.STATE_KEY   || 'relify_dashboard_state';

  // Two independent destinations:
  //   SLACK_WEBHOOK_URL        -> the CLIENT's own workspace (they only ever see themselves)
  //   SLACK_WEBHOOK_URL_AGENCY -> our workspace (one channel, every client, labelled)
  var targets = [];
  if (process.env.SLACK_WEBHOOK_URL)        targets.push({ label: 'client', url: process.env.SLACK_WEBHOOK_URL });
  if (process.env.SLACK_WEBHOOK_URL_AGENCY) targets.push({ label: 'agency', url: process.env.SLACK_WEBHOOK_URL_AGENCY });

  if (!BASE || !TOKEN) {
    res.status(200).json({ ok: false, reason: 'storage-not-configured' });
    return;
  }

  try {
    var r = await fetch(BASE + '/get/' + KEY, { headers: { Authorization: 'Bearer ' + TOKEN } });
    var j = await r.json();
    var state = (j && j.result) ? JSON.parse(j.result) : null;
    if (!state) { res.status(200).json({ ok: false, reason: 'no-state' }); return; }

    var acts = state.activities || [];
    var pendingComments = acts.filter(function (a) { return a.type === 'comment' && a.status === 'pending'; });
    var connectNotes    = acts.filter(function (a) { return a.type !== 'comment'; });
    var people          = state.people || [];
    var pendingPeople   = people.filter(function (p) { return !p.approved; });

    var total = pendingComments.length + pendingPeople.length;

    // Nothing waiting -> stay quiet. Nobody wants a bot saying "nothing to do" twice a day.
    if (total === 0) {
      res.status(200).json({ ok: true, sent: false, reason: 'nothing-pending' });
      return;
    }

    var lines = [];
    if (pendingComments.length) {
      lines.push('*' + pendingComments.length + ' comment draft' + (pendingComments.length > 1 ? 's' : '') + ' awaiting your approval*');
      pendingComments.slice(0, 5).forEach(function (a) {
        lines.push('• *' + (a.name || 'Unknown') + '*' + (a.company ? ' (' + a.company + ')' : '') + ' - “' + String(a.text || '').slice(0, 110) + '”');
      });
      if (pendingComments.length > 5) lines.push('• …and ' + (pendingComments.length - 5) + ' more');
    }
    if (pendingPeople.length) {
      lines.push('*' + pendingPeople.length + ' prospect' + (pendingPeople.length > 1 ? 's' : '') + ' awaiting approval*');
    }
    if (connectNotes.length) {
      lines.push('_' + connectNotes.length + ' connection note' + (connectNotes.length > 1 ? 's' : '') + ' queued._');
    }
    lines.push('Nothing goes live on LinkedIn until you approve it.');

    var payload = {
      text: '[' + CLIENT + '] ' + total + ' item' + (total > 1 ? 's' : '') + ' waiting for approval',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔔 ' + CLIENT + ' - ' + total + ' item' + (total > 1 ? 's' : '') + ' waiting for approval' } },
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        { type: 'actions', elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Review in dashboard' }, url: APP }
        ] }
      ]
    };

    // Dry run unless explicitly told to send, so hitting the URL in a browser is safe.
    if (req.query && (req.query.send === '1' || req.query.send === 'true')) {
      if (!targets.length) {
        res.status(200).json({ ok: false, reason: 'slack-not-configured', hint: 'set SLACK_WEBHOOK_URL (and optionally SLACK_WEBHOOK_URL_AGENCY) in Vercel env vars', would_send: payload });
        return;
      }
      var results = [];
      for (var i = 0; i < targets.length; i++) {
        try {
          var s = await fetch(targets[i].url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          results.push({ target: targets[i].label, ok: s.ok, status: s.status, body: (await s.text()).slice(0, 120) });
        } catch (err) {
          // One bad webhook must not stop the other from being notified.
          results.push({ target: targets[i].label, ok: false, error: String((err && err.message) || err) });
        }
      }
      res.status(200).json({ ok: results.some(function (r) { return r.ok; }), client: CLIENT, pending: total, results: results });
      return;
    }

    res.status(200).json({ ok: true, sent: false, dry_run: true, client: CLIENT, pending: total, targets_configured: targets.map(function (t) { return t.label; }), would_send: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
