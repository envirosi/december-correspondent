const crypto = require('crypto');
const { q, tx } = require('./db');
const T = require('./time');
const { esc, paras, hidden, mediaLink, safeHttpsUrl } = require('./views');

const clip = (s, n) => String(s || '').trim().slice(0, n) || null;

// Secure ring draw. Idempotent: a repeat press returns the existing draw.
async function runDraw(editionId, now) {
  return tx(async c => {
    const ed = (await c.query('select * from edition where id=$1 for update', [editionId])).rows[0];
    if (ed.drawn_at) {
      const n = (await c.query('select count(*)::int n from assignment where edition_id=$1', [editionId])).rows[0].n;
      return { status: 'already', count: n };
    }
    if (now < ed.enrol_close) return { status: 'open' };
    const ids = (await c.query(`select e.reader_id from enrolment e join reader r on r.id=e.reader_id
        where e.edition_id=$1 and e.withdrawn_at is null and r.active`, [editionId])).rows.map(r => r.reader_id);
    if (ids.length < 2) return { status: 'deferred', count: ids.length };
    for (let i = ids.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (let i = 0; i < ids.length; i++) {
      const giver = ids[i], recipient = ids[(i + 1) % ids.length];
      const a = await c.query('insert into assignment(edition_id, giver_id, recipient_id) values ($1,$2,$3) returning id', [editionId, giver, recipient]);
      await c.query('insert into parcel(edition_id, assignment_id, recipient_id) values ($1,$2,$3)', [editionId, a.rows[0].id, recipient]);
    }
    await c.query('update edition set drawn_at=$2 where id=$1', [editionId, now]);
    return { status: 'drawn', count: ids.length };
  });
}

function deliveryText(recipientZone, now) {
  if (T.releasedDay(now, recipientZone) >= T.GIFT_DAY) return 'It’s in their pigeonhole now.';
  return `It arrives in their pigeonhole on Friday 18 December at 07:00 their time (${esc(T.fmtFull(T.releaseInstant(T.GIFT_DAY, recipientZone), recipientZone))}).`;
}

function mount(app) {
  app.get('/pouch', async (req, res, next) => {
    try {
      const ed = req.edition, me = req.reader, now = req.now;
      const enr = (await q('select * from enrolment where edition_id=$1 and reader_id=$2', [ed.id, me.id])).rows[0];
      const active = enr && !enr.withdrawn_at;
      const closeLocal = T.fmtFull(ed.enrol_close, me.zone);
      const open = now < ed.enrol_close;
      let body = `<section class="lead"><p class="kicker">Voluntary Secret Santa</p><h1>The Diplomatic Pouch</h1>
        <p class="standfirst">Fancy sending one person a virtual present? A song and a sentence explaining why you picked it make a complete parcel. The spending limit is zero.</p></section>`;

      if (!ed.drawn_at) {
        if (active) {
          body += `<section class="card"><h2>You’re in</h2><p>Names are drawn after enrolment closes on ${esc(closeLocal)}, your time. You can change your wish slip or step out until then.</p>
            ${wishForm(req, enr, 'Update my wish slip')}
            <form method="post" action="/pouch/withdraw">${hidden(req.csrf)}<button class="btn">Step out of the draw</button></form></section>`;
        } else if (open) {
          body += `<section class="card"><h2>Join the Diplomatic Pouch</h2><p>Enrol by ${esc(closeLocal)}, your time. You can change your mind until names are drawn.</p>${wishForm(req, null, 'Join the Diplomatic Pouch')}</section>`;
        } else {
          body += `<section class="card"><p>Enrolment has closed. Your calendars are all yours, and nobody is keeping count.</p></section>`;
        }
        return res.page('Diplomatic Pouch', body);
      }

      const a = (await q(`select a.*, r.name rname, r.zone rzone, e.wish_like, e.wish_laugh, e.wish_discover
          from assignment a join reader r on r.id=a.recipient_id
          left join enrolment e on e.edition_id=a.edition_id and e.reader_id=a.recipient_id
          where a.edition_id=$1 and a.giver_id=$2`, [ed.id, me.id])).rows[0];
      if (!a || !active) {
        body += `<section class="card"><p>${a ? 'You’ve stepped out of sending this year, and that’s fine. The editor has it covered.' : 'You’re not in the draw this year. Your calendars are all yours, and nobody is keeping count.'}</p></section>`;
        return res.page('Diplomatic Pouch', body);
      }
      const p = (await q('select * from parcel where assignment_id=$1', [a.id])).rows[0];
      const wishes = [['Something I like', a.wish_like], ['Something that makes me laugh', a.wish_laugh], ['Something I’d enjoy discovering', a.wish_discover]]
        .filter(w => w[1]).map(w => `<dt>${w[0]}</dt><dd>${esc(w[1])}</dd>`).join('');
      body += `<section class="card"><h2>You’re sending a little post to ${esc(a.rname)}</h2>
        ${wishes ? `<h3>Their wish slip</h3><dl class="wishes">${wishes}</dl>` : '<p>They left the wish slip blank, so surprise them.</p>'}</section>`;
      if (p.sealed_at) {
        body += `<section class="card sealed-card"><h2>Sealed</h2><p>Wax applied. Thumb briefly attached. Your parcel is ready.</p><p>${deliveryText(a.rzone, now)}</p>
          <div class="letter">${paras(p.body)}${mediaLink(p.url)}</div></section>`;
      } else {
        const preview = req.query.preview === '1' && p.body ? `<section class="card"><h2>Preview</h2><p class="small">This is how it will look to ${esc(a.rname)}.</p><div class="letter">${paras(p.body)}${mediaLink(p.url)}</div>
            <form method="post" action="/pouch/seal">${hidden(req.csrf)}<button class="btn primary">Seal it</button></form></section>` : '';
        body += `${preview}<section class="card"><h2>Your parcel</h2><p>Aim to seal it by 17 December so it arrives on the 18th. Text on its own is a complete parcel.</p>
          <form method="post" action="/pouch/parcel">${hidden(req.csrf)}
            <label for="pb">Your message</label><textarea id="pb" name="body" rows="6" maxlength="1500" required>${esc(p.body)}</textarea>
            <label for="pu">Link <span class="small">(optional: a song, GIF or photo, starting https://)</span></label>
            <input id="pu" name="url" type="url" maxlength="500" value="${esc(p.url || '')}" placeholder="https://">
            <button class="btn">Save draft and preview</button>
          </form>
          <form method="post" action="/pouch/withdraw" class="spaced">${hidden(req.csrf)}<button class="linkish">I can’t send a parcel after all</button></form></section>`;
      }
      res.page('Diplomatic Pouch', body);
    } catch (e) { next(e); }
  });

  function wishForm(req, e, label) {
    return `<form method="post" action="/pouch/join">${hidden(req.csrf)}
      <p class="small">My wish slip. Fill in whichever you fancy.</p>
      <label for="w1">Something I like</label><input id="w1" name="like" maxlength="200" value="${esc(e && e.wish_like || '')}">
      <label for="w2">Something that makes me laugh</label><input id="w2" name="laugh" maxlength="200" value="${esc(e && e.wish_laugh || '')}">
      <label for="w3">Something I’d enjoy discovering</label><input id="w3" name="discover" maxlength="200" value="${esc(e && e.wish_discover || '')}">
      <button class="btn primary">${label}</button></form>`;
  }

  app.post('/pouch/join', async (req, res, next) => {
    try {
      const ed = req.edition;
      if (ed.drawn_at) return res.redirect(303, '/pouch');
      const existing = (await q('select withdrawn_at from enrolment where edition_id=$1 and reader_id=$2', [ed.id, req.reader.id])).rows[0];
      const isActive = existing && !existing.withdrawn_at;
      if (!isActive && req.now >= ed.enrol_close) return res.redirect(303, '/pouch');
      await q(`insert into enrolment(edition_id, reader_id, wish_like, wish_laugh, wish_discover) values ($1,$2,$3,$4,$5)
        on conflict (edition_id, reader_id) do update set wish_like=excluded.wish_like, wish_laugh=excluded.wish_laugh, wish_discover=excluded.wish_discover, withdrawn_at=null`,
        [ed.id, req.reader.id, clip(req.body.like, 200), clip(req.body.laugh, 200), clip(req.body.discover, 200)]);
      res.redirect(303, '/pouch');
    } catch (e) { next(e); }
  });

  app.post('/pouch/withdraw', async (req, res, next) => {
    try {
      await q('update enrolment set withdrawn_at=now() where edition_id=$1 and reader_id=$2 and withdrawn_at is null', [req.edition.id, req.reader.id]);
      res.redirect(303, '/pouch');
    } catch (e) { next(e); }
  });

  async function myDraftParcel(req) {
    return (await q(`select p.* from parcel p join assignment a on a.id=p.assignment_id
        join enrolment e on e.edition_id=a.edition_id and e.reader_id=a.giver_id and e.withdrawn_at is null
        where a.edition_id=$1 and a.giver_id=$2 and p.sealed_at is null`, [req.edition.id, req.reader.id])).rows[0];
  }

  app.post('/pouch/parcel', async (req, res, next) => {
    try {
      const p = await myDraftParcel(req);
      if (!p) return res.redirect(303, '/pouch');
      const raw = String(req.body.url || '').trim();
      const url = raw ? safeHttpsUrl(raw) : null;
      if (raw && !url) return res.status(400).page('Link', '<article class="story narrow"><h1>That link didn’t look right</h1><p>Links need to start with https://. Please go back and try again.</p></article>');
      await q('update parcel set body=$2, url=$3, updated_at=now() where id=$1', [p.id, String(req.body.body || '').trim().slice(0, 1500), url]);
      res.redirect(303, '/pouch?preview=1');
    } catch (e) { next(e); }
  });

  app.post('/pouch/seal', async (req, res, next) => {
    try {
      const p = await myDraftParcel(req);
      if (p && p.body) await q('update parcel set sealed_at=now() where id=$1 and sealed_at is null', [p.id]);
      res.redirect(303, '/pouch');
    } catch (e) { next(e); }
  });
}

module.exports = { mount, runDraw };
