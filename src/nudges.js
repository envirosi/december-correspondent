// Small, optional nudges: paper chain, desk polls, crackers, gold stars, an offline nudge, paper hat day.
// Nothing here records or shows who read what; polls show totals by desk only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { q, tx } = require('./db');
const T = require('./time');
const { esc, paras, hidden } = require('./views');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nudges.json'), 'utf8'));
const CHAIN_PRINT_DAY = 23;
const PER_DAY_LIMIT = 3;

async function seedNudges(edition) {
  await tx(async c => {
    await c.query('delete from nudge where edition_id=$1', [edition.id]);
    for (const n of DATA.nudges) {
      await c.query('insert into nudge(edition_id, day, kind, title, body, options) values ($1,$2,$3,$4,$5,$6)',
        [edition.id, n.day, n.kind, n.title, n.body, n.options ? JSON.stringify(n.options) : null]);
    }
  });
  return DATA.nudges.length;
}

const getNudge = async (editionId, day) => (await q('select * from nudge where edition_id=$1 and day=$2', [editionId, day])).rows[0];

async function chainCounts(editionId) {
  const r = await q(`select zone, count(*)::int n from chain_link where edition_id=$1 and state <> 'hidden' group by zone`, [editionId]);
  const by = Object.fromEntries(r.rows.map(x => [x.zone, x.n]));
  return T.ZONES.map(z => ({ label: z.label, n: by[z.key] || 0 }));
}

// Strip along the bottom of the masthead: one paper chain per desk.
function chainStrip(counts) {
  if (!counts) return '';
  const total = counts.reduce((a, c) => a + c.n, 0);
  const row = c => {
    const shown = Math.min(c.n, 24);
    let loops = '';
    for (let i = 0; i < shown; i++) loops += `<span class="lk l${i % 4}"></span>`;
    return `<span class="strand"><span class="sdesk">${c.label}</span>${loops}${c.n > shown ? `<span class="more">+${c.n - shown}</span>` : ''}${c.n === 0 ? '<span class="more">waiting for a first link</span>' : ''}</span>`;
  };
  return `<a class="chain-strip" href="/chain" aria-label="Paper chain: ${counts.map(c => `${c.label} ${c.n}`).join(', ')} links. Add yours.">
    <span class="chain-title">Paper chain · ${total} link${total === 1 ? '' : 's'}</span>${counts.map(row).join('')}</a>`;
}

async function colleagues(req) {
  return (await q('select id, name from reader where edition_id=$1 and active and id<>$2 order by name', [req.edition.id, req.reader.id])).rows;
}
const pickList = (rows, name) => `<select id="${name}" name="${name}" required><option value="">Choose a colleague</option>${rows.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`;
const sentToday = async (req, kind, day) => (await q(`select count(*)::int n from personal_item where edition_id=$1 and author_id=$2 and kind=$3 and day=$4`, [req.edition.id, req.reader.id, kind, day])).rows[0].n;

async function pollResults(editionId, day, options) {
  const r = await q(`select r.zone, v.choice, count(*)::int n from poll_vote v join reader r on r.id=v.reader_id
      where v.edition_id=$1 and v.day=$2 group by r.zone, v.choice`, [editionId, day]);
  return T.ZONES.map(z => {
    const counts = options.map((_, i) => (r.rows.find(x => x.zone === z.key && x.choice === i) || { n: 0 }).n);
    const total = counts.reduce((a, b) => a + b, 0);
    return `<div class="desk-result"><h4>${z.label} desk</h4>${total ? options.map((o, i) => {
      const pct = Math.round(100 * counts[i] / total);
      return `<div class="bar"><span class="bl">${esc(o)}</span><span class="bt"><span class="bf w${Math.round(pct / 5) * 5}"></span></span><span class="bp">${pct}%</span></div>`;
    }).join('') : '<p class="small">No votes yet.</p>'}</div>`;
  }).join('');
}

// The card shown on a front-page door (and on the front page itself, for today).
async function card(req, day) {
  const n = await getNudge(req.edition.id, day);
  if (!n) return '';
  const flash = req.query.nudged ? `<p class="flash" role="status">${esc({ chain: 'Link added. Look up: the chain just got longer.', cracker: 'Bang! Cracker pulled. It’s waiting in their pigeonhole.', star: 'Gold star sent.', starcheck: 'Gold star sent. The editor will glance at your note, then deliver it.', hat: 'Splendid hat. You’re in the parade.', vote: 'Vote counted.', limit: 'That’s plenty for today. Save some for another door!' }[req.query.nudged] || '')}</p>` : '';
  let inner = '';
  if (n.kind === 'chain') {
    inner = chainForm(req);
  } else if (n.kind === 'poll') {
    const opts = n.options || [];
    const mine = (await q('select choice from poll_vote where edition_id=$1 and day=$2 and reader_id=$3', [req.edition.id, day, req.reader.id])).rows[0];
    const form = `<form method="post" action="/nudge/${day}/vote" class="poll">${hidden(req.csrf)}<fieldset><legend>${esc(n.body)}</legend>
      ${opts.map((o, i) => `<label class="choice"><input type="radio" name="choice" value="${i}" ${mine && mine.choice === i ? 'checked' : ''} required> ${esc(o)}</label>`).join('')}
      </fieldset><button class="btn primary">${mine ? 'Change my vote' : 'Vote'}</button></form>`;
    inner = mine ? `<p class="poll-q">${esc(n.body)}</p><div class="results">${await pollResults(req.edition.id, day, opts)}</div><details><summary>Change my vote</summary>${form}</details>`
      : `${form}<p class="small">Results by desk appear once you’ve voted.</p>`;
  } else if (n.kind === 'cracker') {
    inner = `<form method="post" action="/nudge/${day}/cracker">${hidden(req.csrf)}<label for="cr-${day}">Pull a cracker with</label>${pickList(await colleagues(req), `cr-${day}`).replace(`name="cr-${day}"`, 'name="to"')}
      <button class="btn primary cracker-btn">Pull!</button></form>`;
  } else if (n.kind === 'star') {
    inner = `<form method="post" action="/nudge/${day}/star">${hidden(req.csrf)}<label for="st-${day}">Gold star for</label>${pickList(await colleagues(req), `st-${day}`).replace(`name="st-${day}"`, 'name="to"')}
      <label for="sr-${day}">Because they…</label><select id="sr-${day}" name="reason" required>${DATA.star_reasons.map((r, i) => `<option value="${i}">${esc(r)}</option>`).join('')}</select>
      <label for="sn-${day}">A few words of your own <span class="small">(optional; the editor gives these a quick look first)</span></label><input id="sn-${day}" name="note" maxlength="120">
      <button class="btn primary">Send the star</button></form>`;
  } else if (n.kind === 'hat') {
    const hats = (await q(`select r.name, r.zone, h.reader_id from hat h join reader r on r.id=h.reader_id where h.edition_id=$1 and h.day=$2 order by h.created_at`, [req.edition.id, day])).rows;
    const mine = hats.some(h => h.reader_id === req.reader.id);
    inner = `${mine ? '<p><strong>You’re in the hat parade.</strong></p>' : `<form method="post" action="/nudge/${day}/hat">${hidden(req.csrf)}<button class="btn primary">I wore a paper hat</button></form>`}
      <h3 class="parade-h">The hat parade</h3>${hats.length ? `<ul class="parade">${hats.map(h => `<li><span class="phat" aria-hidden="true"></span>${esc(h.name)} <span class="small">(${esc(T.zoneLabel(h.zone))})</span></li>`).join('')}</ul>` : '<p class="small">No hats yet. Somebody has to go first.</p>'}`;
  }
  return `<section class="nudge nudge-${n.kind}" id="nudge" aria-labelledby="ng-h-${day}">
    ${flash}<p class="kicker">${n.kind === 'offline' ? 'A quiet one' : 'One-minute extra'}</p><h2 id="ng-h-${day}">${esc(n.title)}</h2>
    ${n.kind === 'poll' ? '' : paras(n.body)}${inner}</section>`;
}

function chainForm(req) {
  return `<form method="post" action="/chain">${hidden(req.csrf)}<input type="hidden" name="back" value="${esc(req.path)}">
    <label for="cl">My link <span class="small">(a small good thing from your year, up to 80 characters)</span></label>
    <input id="cl" name="body" maxlength="80" required placeholder="e.g. Finally understood the new job system">
    <button class="btn primary">Add my link</button></form>
    <p class="small">No names are printed. Add as many links as you like.</p>`;
}

async function headline(editionId, day) {
  const n = await getNudge(editionId, day);
  return n ? n.title : null;
}

// Door 23: the chain printed in full.
async function chainPrint(editionId) {
  const rows = (await q(`select zone, body from chain_link where edition_id=$1 and state='approved' order by created_at`, [editionId])).rows;
  if (!rows.length) return '';
  return `<section class="chain-print" aria-labelledby="cp-h"><p class="kicker">The paper chain, printed in full</p><h2 id="cp-h">Good things from our year</h2>
    ${T.ZONES.map(z => { const mine = rows.filter(r => r.zone === z.key); return mine.length ? `<h3>${z.label} desk</h3><ul class="links">${mine.map(r => `<li>${esc(r.body)}</li>`).join('')}</ul>` : ''; }).join('')}</section>`;
}

function mount(app) {
  const dayOk = (req, d) => Number.isInteger(d) && d >= 1 && d <= 24 && d <= req.released;
  const back = (req, day, flag) => `/door/${day}?nudged=${flag}#nudge`;

  app.get('/chain', async (req, res, next) => {
    try {
      const counts = await chainCounts(req.edition.id);
      const mine = (await q(`select body from chain_link where edition_id=$1 and reader_id=$2 and state <> 'hidden' order by created_at`, [req.edition.id, req.reader.id])).rows;
      res.page('Paper chain', `<section class="lead"><p class="kicker">All month</p><h1>The paper chain</h1>
        <p class="standfirst">One link for each small good thing from our year. The chain grows across the masthead, a strand for each desk. On door 23 it’s printed in full, with no names attached.</p></section>
        ${req.query.added ? '<p class="flash" role="status">Link added. Look up: the chain just got longer.</p>' : ''}
        <div class="chain-big">${chainStrip(counts)}</div>
        ${req.released ? chainForm(req) : '<p>The chain opens on 1 December.</p>'}
        ${mine.length ? `<h2>Your links so far</h2><ul class="links">${mine.map(m => `<li>${esc(m.body)}</li>`).join('')}</ul><p class="small">Only you can see this list until door 23.</p>` : ''}`);
    } catch (e) { next(e); }
  });

  app.post('/chain', async (req, res, next) => {
    try {
      if (!req.released || req.released >= CHAIN_PRINT_DAY + 1) return res.redirect(303, '/chain');
      const body = String(req.body.body || '').trim().slice(0, 80);
      if (body) await q('insert into chain_link(edition_id, reader_id, zone, body) values ($1,$2,$3,$4)', [req.edition.id, req.reader.id, req.reader.zone, body]);
      const b = String(req.body.back || '');
      res.redirect(303, /^\/door\/\d+$/.test(b) ? `${b}?nudged=chain#nudge` : '/chain?added=1');
    } catch (e) { next(e); }
  });

  app.post('/nudge/:day/:action', async (req, res, next) => {
    try {
      const day = Number(req.params.day);
      if (!dayOk(req, day)) return res.status(404).end();
      const n = await getNudge(req.edition.id, day);
      const act = req.params.action;
      if (!n) return res.status(404).end();
      const ed = req.edition.id, me = req.reader;

      if (act === 'vote' && n.kind === 'poll') {
        const c = Number(req.body.choice);
        if (!(Number.isInteger(c) && c >= 0 && c < (n.options || []).length)) return res.redirect(303, `/door/${day}#nudge`);
        await q(`insert into poll_vote(edition_id, day, reader_id, choice) values ($1,$2,$3,$4)
          on conflict (edition_id, day, reader_id) do update set choice=excluded.choice`, [ed, day, me.id, c]);
        return res.redirect(303, back(req, day, 'vote'));
      }
      if ((act === 'cracker' && n.kind === 'cracker') || (act === 'star' && n.kind === 'star')) {
        const to = (await q('select id from reader where id=$1 and edition_id=$2 and active and id<>$3', [Number(req.body.to) || 0, ed, me.id])).rows[0];
        if (!to) return res.redirect(303, `/door/${day}#nudge`);
        const kind = act;
        if (await sentToday(req, kind, day) >= PER_DAY_LIMIT) return res.redirect(303, back(req, day, 'limit'));
        let body, status = 'approved';
        if (kind === 'cracker') {
          const [qn, an] = DATA.cracker_jokes[crypto.randomInt(DATA.cracker_jokes.length)];
          const prize = DATA.cracker_prizes[crypto.randomInt(DATA.cracker_prizes.length)];
          body = `${me.name} pulled a cracker with you. You won ${prize}, and the paper hat, obviously.\n\n${qn}\n${an}`;
        } else {
          const reason = DATA.star_reasons[Number(req.body.reason)] || DATA.star_reasons[0];
          const note = String(req.body.note || '').trim().slice(0, 120);
          body = `A gold star from ${me.name}: ${reason}.${note ? `\n\n“${note}”` : ''}`;
          if (note) status = 'pending';
        }
        await q(`insert into personal_item(edition_id, recipient_id, day, body, byline, author_id, status, kind) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ed, to.id, Math.max(day, req.released), body, me.name, me.id, status, kind]);
        return res.redirect(303, back(req, day, kind === 'star' && status === 'pending' ? 'starcheck' : kind));
      }
      if (act === 'hat' && n.kind === 'hat') {
        await q('insert into hat(edition_id, day, reader_id) values ($1,$2,$3) on conflict do nothing', [ed, day, me.id]);
        return res.redirect(303, back(req, day, 'hat'));
      }
      res.status(404).end();
    } catch (e) { next(e); }
  });
}

module.exports = { mount, card, headline, seedNudges, chainCounts, chainStrip, chainPrint, CHAIN_PRINT_DAY };
