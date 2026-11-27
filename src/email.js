// Email nudges.
// - Post digest: at most one email per reader per local day, only for items already visible to them,
//   only in their daytime (08:00-20:00), and never saying what the item is or who sent it.
// - Monday reminder: one short email at 07:30 local on Mondays in December.
// Provider is chosen by EMAIL_PROVIDER: log (default: nothing is sent), resend, brevo, memory (tests).
const { q, pool } = require('./db');
const T = require('./time');
const { esc, layout, hidden } = require('./views');
const A = require('./auth');

const outbox = []; // memory provider, for tests
const provider = () => (process.env.EMAIL_PROVIDER || 'log').toLowerCase();
const fromAddress = () => process.env.EMAIL_FROM || 'The December Correspondent <correspondent@example.invalid>';
const configured = () => provider() === 'memory' || (['resend', 'brevo'].includes(provider()) && !!process.env.EMAIL_API_KEY && !!process.env.EMAIL_FROM);

function parseFrom(f) {
  const m = String(f).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: 'The December Correspondent', email: String(f).trim() };
}

async function send({ to, subject, text, html, unsubUrl }) {
  const headers = unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
  const p = provider();
  if (p === 'memory') { outbox.push({ to, subject, text, html, headers }); return true; }
  if (!configured()) { console.log(`email (test mode, not sent): "${subject}"`); return true; }
  try {
    let r;
    if (p === 'resend') {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromAddress(), to: [to], subject, text, html, headers }),
      });
    } else {
      const from = parseFrom(fromAddress());
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.EMAIL_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, htmlContent: html, headers }),
      });
    }
    if (!r.ok) console.error('email send failed:', r.status);
    return r.ok;
  } catch (e) {
    console.error('email send error:', e.message);
    return false;
  }
}

const site = path => `${A.publicOrigin()}${path}`;

// Simple, friendly email wrapper. Inline styles are fine in email.
function wrap({ heading, lines, button, buttonUrl, unsubUrl }) {
  const html = `<!doctype html><html><body style="margin:0;background:#fbf6ea;font-family:Georgia,serif;color:#1d1b16">
  <div style="max-width:560px;margin:0 auto;padding:0 0 24px">
    <div style="background:#183a2a;color:#fbf6ea;text-align:center;padding:22px 16px 16px;border-bottom:4px double #a9814a">
      <div style="font-size:12px;letter-spacing:3px;color:#d8b87f">★ ★ ★</div>
      <div style="font-size:24px;font-weight:bold"><i style="font-weight:normal">The</i> December Correspondent</div>
    </div>
    <div style="background:#fffdf7;border:1px solid #d9cfb8;margin:16px;padding:18px 20px;border-radius:6px">
      <h1 style="font-size:21px;margin:0 0 12px">${esc(heading)}</h1>
      ${lines.map(l => `<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${esc(l)}</p>`).join('')}
      <p style="margin:18px 0 6px"><a href="${esc(buttonUrl)}" style="background:#183a2a;color:#fbf6ea;text-decoration:none;padding:12px 18px;border-radius:6px;font-family:Arial,sans-serif;font-weight:bold;display:inline-block">${esc(button)}</a></p>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#5d574b;margin:14px 0 0">Open it on the device you signed in on. If the link asks for an invitation, ask Si for a fresh one.</p>
    </div>
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#5d574b;text-align:center;margin:0 16px">You’re getting this because you’re a reader of The December Correspondent. <a href="${esc(unsubUrl)}" style="color:#24523c">Change or stop these emails</a>.</p>
  </div></body></html>`;
  const text = `${heading}\n\n${lines.join('\n\n')}\n\n${button}: ${buttonUrl}\n\nOpen it on the device you signed in on.\n\nChange or stop these emails: ${unsubUrl}\n`;
  return { html, text };
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
const localDate = (now, zone) => { const p = T.parts(now, zone); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const daytime = (now, zone) => { const h = T.parts(now, zone).h; return h >= 8 && h < 20; };

// ---------- Post digest ----------
async function runDigest(now = new Date()) {
  const ed = (await q('select * from edition where year=$1', [T.YEAR])).rows[0];
  if (!ed || now >= T.CLOSE_AT) return 0;
  const readers = (await q('select * from reader where edition_id=$1 and active and notify_post', [ed.id])).rows;
  let sent = 0;
  for (const r of readers) {
    const released = T.releasedDay(now, r.zone);
    if (!released || !daytime(now, r.zone)) continue;
    const today = localDate(now, r.zone);
    if (r.last_post_email_on === today) continue;
    const items = (await q(`select id, kind from personal_item where recipient_id=$1 and status='approved' and day <= $2 and notified_at is null`, [r.id, released])).rows;
    const parcels = released >= T.GIFT_DAY
      ? (await q(`select id from parcel where recipient_id=$1 and sealed_at is not null and notified_at is null`, [r.id])).rows : [];
    if (!items.length && !parcels.length) continue;
    const count = k => items.filter(i => i.kind === k).length;
    const bits = [];
    if (count('letter')) bits.push(plural(count('letter'), 'letter', 'letters'));
    if (count('cracker')) bits.push(plural(count('cracker'), 'cracker', 'crackers'));
    if (count('star')) bits.push(plural(count('star'), 'gold star', 'gold stars'));
    if (parcels.length) bits.push(plural(parcels.length, 'parcel from the Diplomatic Pouch', 'parcels from the Diplomatic Pouch'));
    const what = bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0];
    const unsubUrl = site(`/email/stop/${r.email_token}`);
    const { html, text } = wrap({
      heading: `Something has arrived for you, ${r.name.split(' ')[0]}`,
      lines: [`Your pigeonhole has ${what} waiting.`, 'We won’t spoil it here. It takes about thirty seconds to open.'],
      button: 'Open my pigeonhole', buttonUrl: site('/pigeonhole'), unsubUrl,
    });
    const ok = await send({ to: r.email, subject: 'Something has arrived in your pigeonhole', text, html, unsubUrl });
    await q('insert into email_log(edition_id, kind, ok) values ($1,$2,$3)', [ed.id, 'post', ok]);
    if (!ok) continue;
    if (items.length) await q('update personal_item set notified_at=now() where id = any($1)', [items.map(i => i.id)]);
    if (parcels.length) await q('update parcel set notified_at=now() where id = any($1)', [parcels.map(p => p.id)]);
    await q('update reader set last_post_email_on=$2 where id=$1', [r.id, today]);
    sent++;
  }
  return sent;
}

// ---------- Monday reminder ----------
async function runWeekly(now = new Date()) {
  const ed = (await q('select * from edition where year=$1', [T.YEAR])).rows[0];
  if (!ed) return 0;
  const readers = (await q('select * from reader where edition_id=$1 and active and notify_weekly', [ed.id])).rows;
  let sent = 0;
  for (const r of readers) {
    const p = T.parts(now, r.zone);
    const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    if (!(p.y === T.YEAR && p.m === 12 && p.d <= 24 && weekday === 1)) continue;
    if (p.h * 60 + p.min < 7 * 60 + 30 || p.h >= 20) continue;
    const week = localDate(now, r.zone);
    const already = await q('select 1 from weekly_sent where edition_id=$1 and reader_id=$2 and week=$3', [ed.id, r.id, week]);
    if (already.rowCount) continue;
    const day = p.d;
    const door = (await q('select shared_title from door where edition_id=$1 and day=$2', [ed.id, day])).rows[0];
    const caseEntry = (await q('select title from case_entry where edition_id=$1 and day=$2', [ed.id, day])).rows[0];
    const extras = (await q('select title from nudge where edition_id=$1 and day between $2 and $3 order by day', [ed.id, day, day + 4])).rows.map(x => x.title);
    const lines = [`Today’s front page: “${door ? door.shared_title : 'a new door'}”.`];
    if (caseEntry) lines.push(`The Case of the Communal Tin, day ${day}: “${caseEntry.title}”. The editor remains confident.`);
    if (extras.length) lines.push(`One-minute extras this week: ${extras.join(', ')}.`);
    if (now < ed.enrol_close && !ed.drawn_at) lines.push(`The Diplomatic Pouch closes ${T.fmtFull(ed.enrol_close, r.zone)}, your time. Budget: zero. Effort: one kind thing.`);
    if (day >= 21) lines.push('This is the last week. Door 24 brings the end of the Case and everyone’s Christmas playlist.');
    lines.push('Read as much or as little as you like. Every door you’ve missed is still open.');
    const unsubUrl = site(`/email/stop/${r.email_token}`);
    const { html, text } = wrap({ heading: 'This week in the paper', lines, button: 'Open the paper', buttonUrl: site('/'), unsubUrl });
    const ok = await send({ to: r.email, subject: 'This week in The December Correspondent', text, html, unsubUrl });
    await q('insert into email_log(edition_id, kind, ok) values ($1,$2,$3)', [ed.id, 'weekly', ok]);
    if (!ok) continue;
    await q('insert into weekly_sent(edition_id, reader_id, week) values ($1,$2,$3) on conflict do nothing', [ed.id, r.id, week]);
    sent++;
  }
  return sent;
}

// One instance at a time, even if Railway ever runs two.
async function tick(now = new Date()) {
  const c = await pool.connect();
  try {
    const got = (await c.query('select pg_try_advisory_lock(726201) ok')).rows[0].ok;
    if (!got) return;
    try { await runDigest(now); await runWeekly(now); }
    finally { await c.query('select pg_advisory_unlock(726201)'); }
  } catch (e) { console.error('email tick error:', e.message); }
  finally { c.release(); }
}

function startScheduler() {
  if (process.env.EMAIL_SCHEDULER === 'off') return;
  setTimeout(() => tick(), 30_000);
  setInterval(() => tick(), 5 * 60_000);
  console.log(`email scheduler on (${configured() ? provider() : 'test mode, nothing sent'})`);
}

// ---------- Routes: unsubscribe (no sign-in needed) and settings ----------
function mountPublic(app) {
  const byToken = async t => (t && t.length < 100) ? (await q('select * from reader where email_token=$1', [t])).rows[0] : null;
  const page = (req, res, title, body) => res.send(layout({ title, body, now: req.now }));

  app.get('/email/stop/:token', async (req, res, next) => {
    try {
      const r = await byToken(req.params.token);
      if (!r) return res.status(404).send(layout({ title: 'Not found', now: req.now, body: '<article class="story narrow"><h1>That link has expired</h1></article>' }));
      page(req, res, 'Email settings', `<article class="story narrow"><h1>Email settings</h1>
        <p>Hello ${esc(r.name.split(' ')[0])}. Choose what you’d like to hear about. Nothing else in the paper changes.</p>
        <form method="post" action="/email/stop/${esc(req.params.token)}">
          <label class="choice"><input type="checkbox" name="post" value="1" ${r.notify_post ? 'checked' : ''}> When something arrives in my pigeonhole (at most once a day)</label>
          <label class="choice"><input type="checkbox" name="weekly" value="1" ${r.notify_weekly ? 'checked' : ''}> A short Monday reminder in December</label>
          <input type="hidden" name="form" value="1">
          <button class="btn primary">Save</button></form>
        ${req.query.saved ? '<p class="flash" role="status">Saved.</p>' : ''}</article>`);
    } catch (e) { next(e); }
  });

  // Handles our own form and one-click unsubscribe from mail apps (which turns everything off).
  app.post('/email/stop/:token', async (req, res, next) => {
    try {
      const r = await byToken(req.params.token);
      if (!r) return res.status(404).end();
      const fromForm = req.body && req.body.form === '1';
      const post = fromForm ? req.body.post === '1' : false;
      const weekly = fromForm ? req.body.weekly === '1' : false;
      await q('update reader set notify_post=$2, notify_weekly=$3 where id=$1', [r.id, post, weekly]);
      if (!fromForm) return res.status(200).send('Unsubscribed');
      res.redirect(303, `/email/stop/${encodeURIComponent(req.params.token)}?saved=1`);
    } catch (e) { next(e); }
  });
}

function mountReader(app) {
  app.get('/settings', (req, res) => {
    const r = req.reader;
    res.page('Email settings', `<article class="story narrow"><h1>Email settings</h1>
      <p>Emails go to ${esc(r.email)}. They never say what’s in your pigeonhole or who sent it.</p>
      <form method="post" action="/settings">${hidden(req.csrf)}
        <label class="choice"><input type="checkbox" name="post" value="1" ${r.notify_post ? 'checked' : ''}> When something arrives in my pigeonhole (at most once a day, in your daytime)</label>
        <label class="choice"><input type="checkbox" name="weekly" value="1" ${r.notify_weekly ? 'checked' : ''}> A short Monday reminder in December</label>
        <button class="btn primary">Save</button></form>
      ${req.query.saved ? '<p class="flash" role="status">Saved.</p>' : ''}</article>`);
  });
  app.post('/settings', async (req, res, next) => {
    try {
      await q('update reader set notify_post=$2, notify_weekly=$3 where id=$1', [req.reader.id, req.body.post === '1', req.body.weekly === '1']);
      res.redirect(303, '/settings?saved=1');
    } catch (e) { next(e); }
  });
}

module.exports = { send, runDigest, runWeekly, tick, startScheduler, mountPublic, mountReader, outbox, configured, provider, wrap, site };
