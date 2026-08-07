// Slack approval notifier for the Relify dashboard.
//
//   GET /api/notify           -> dry run: returns what WOULD be sent, sends nothing
//   GET /api/notify?send=1    -> posts the digest to Slack (used by the cron)
//
// Reads the same shared state as /api/state, counts anything waiting on the client,
// and posts a digest to a Slack Incoming Webhook.
//
// Setup (needs a Slack admin, one time):
//   1. api.slack.com/apps -> Create New App -> From scratch -> pick the workspace
//   2. Incoming Webhooks -> On -> Add New Webhook to Workspace -> choose the channel
//   3. Copy the webhook URL (https://hooks.slack.com/services/...)
//   4. Vercel -> Project -> Settings -> Environment Variables -> add SLACK_WEBHOOK_URL
//   5. Redeploy
//
// The webhook URL is a secret: it lives ONLY in Vercel env vars, never in this repo.
// If SLACK_WEBHOOK_URL is not set the endpoint degrades gracefully and tells you so.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var BASE  = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL;
  var TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  var HOOK  = process.env.SLACK_WEBHOOK_URL;
  var KEY   = 'relify_dashboard_state';
  var APP   = 'https://relify-dashboard.vercel.app';

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
        lines.push('• *' + (a.name || 'Unknown') + '*' + (a.company ? ' (' + a.company + ')' : '') + ' — “' + String(a.text || '').slice(0, 110) + '”');
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
      text: total + ' item' + (total > 1 ? 's' : '') + ' waiting for Relify approval',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔔 ' + total + ' item' + (total > 1 ? 's' : '') + ' waiting for your approval' } },
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        { type: 'actions', elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Review in dashboard' }, url: APP }
        ] }
      ]
    };

    // Dry run unless explicitly told to send, so hitting the URL in a browser is safe.
    if (req.query && (req.query.send === '1' || req.query.send === 'true')) {
      if (!HOOK) {
        res.status(200).json({ ok: false, reason: 'slack-not-configured', hint: 'set SLACK_WEBHOOK_URL in Vercel env vars', would_send: payload });
        return;
      }
      var s = await fetch(HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var body = await s.text();
      res.status(200).json({ ok: s.ok, sent: s.ok, slack_status: s.status, slack_body: body, pending: total });
      return;
    }

    res.status(200).json({ ok: true, sent: false, dry_run: true, pending: total, slack_configured: !!HOOK, would_send: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
