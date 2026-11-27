const express = require('express');
const path = require('path');
const { q } = require('./db');
const T = require('./time');
const V = require('./views');
const A = require('./auth');
const { esc, paras, hidden, layout, doorGrid, mediaLink, safeHttpsUrl } = V;
const CASE = require('./casefile');
const NUDGE = require('./nudges');

const RELAY_DAYS = new Set([3, 17, 21]);
const LETTER_DAY = 14;
const PREVIEW_COOKIE = 'dc_preview';
const readCookie = (req, name) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', setHeaders: r => r.set('Cache-Control', 'public, max-age=3600') }));

  app.get('/favicon.ico', (req, res) => res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#183a2a"/><text x="16" y="23" font-size="18" text-anchor="middle" fill="#fbf6ea" font-family="Georgia">D</text></svg>'));

  app.get('/healthz', async (req, res) => {
    try { await q('select 1'); res.set('Cache-Control', 'no-store').json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // Everything below is personal: never cache.
  app.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(A.loadSession);

  // Context for each request.
  app.use(async (req, res, next) => {
    try {
      req.now = T.now(req);
      req.edition = (await q('select * from edition where year=$1', [T.YEAR])).rows[0];
      if (req.reader) req.released = T.releasedDay(req.now, req.reader.zone);
      // Editor-only preview: see the paper as a reader would on a chosen day. Never applies to readers.
      let previewBanner = null;
      if (req.reader && req.reader.role === 'editor') {
        const pv = Number(readCookie(req, PREVIEW_COOKIE));
        if (Number.isInteger(pv) && pv >= 1 && pv <= 24) {
          req.previewDay = pv;
          req.released = pv;
          previewBanner = `Preview mode: you’re seeing the paper as it looks on door ${pv}. Nobody else is affected, but anything you send is real.
            <form method="post" action="/editor/preview-mode/exit" class="inline">${hidden(req.csrf)}<button class="linkish">Leave preview</button></form>`;
        }
      }
      const chain = req.reader && req.released > 0 ? NUDGE.chainStrip(await NUDGE.chainCounts(req.edition.id)) : '';
      res.page = (title, body, opts = {}) => res.send(layout({ title, body, reader: req.reader, now: req.now, csrf: req.csrf, banner: previewBanner, chain, ...opts }));
      next();
    } catch (e) { next(e); }
  });

  // Closed after 31 January.
  app.use((req, res, next) => {
    if (req.now >= T.CLOSE_AT) {
      return res.status(410).send(layout({ title: 'Closed', now: req.now, body: `<article class="story"><h1>The presses have stopped</h1><p>The December Correspondent has closed for the year and everything in it has been deleted. Thank you for reading.</p></article>` }));
    }
    next();
  });

  // POST protection.
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path === '/welcome') return next();
    if (!A.csrfOk(req)) return res.status(403).page('Expired form', '<article class="story"><h1>That form had gone stale</h1><p>Please go back, refresh the page and try again.</p></article>');
    next();
  });

  // ---------- Invitations ----------
  app.get('/welcome', (req, res) => {
    res.page('Your invitation', `<article class="story narrow">
      <p class="kicker">Hand-delivered</p>
      <h1>Your copy is waiting</h1>
      <p class="hello">The December Correspondent is a small, silly Christmas paper for our UK, Cebu and Sydney desks. A door a day, a mystery, and a pigeonhole with your name on it.</p>
      <p>No password, no app and nothing to install. Press the button and you’re in.</p>
      <form method="post" action="/welcome" id="redeem">
        <input type="hidden" name="token" id="token">
        <div class="nojs-token"><label for="token-paste">Invitation code</label>
        <input id="token-paste" name="token_paste" autocomplete="off" spellcheck="false"></div>
        <button class="btn primary">Collect my copy</button>
      </form>
      <p class="small">This link works once and remembers this device. Want it on your phone as well? Ask the editor for a second link.</p>
    </article><script src="/static/invite.js"></script>`);
  });

  app.post('/welcome', async (req, res, next) => {
    try {
      if (!A.checkOrigin(req)) return res.status(403).page('Invitation', '<article class="story narrow"><h1>Please open your invitation link directly</h1><p>Copy the whole link from your email into the address bar and try again.</p></article>');
      const token = String(req.body.token || req.body.token_paste || '').trim().replace(/^.*#/, '');
      const s = await A.redeemInvite(token);
      if (!s) {
        return res.status(400).page('Invitation', `<article class="story narrow"><h1>That invitation has already been used</h1>
          <p>Or it has expired, or been replaced with a newer one. Ask the editor for a fresh link and it will be with you shortly.</p></article>`);
      }
      A.setSessionCookie(res, s);
      res.redirect(303, '/how?first=1');
    } catch (e) { next(e); }
  });

  app.post('/signout', async (req, res, next) => {
    try {
      await q('update session set revoked_at=now() where digest=$1', [req.sessionDigest]);
      res.clearCookie(A.COOKIE, { path: '/' });
      res.redirect(303, '/');
    } catch (e) { next(e); }
  });

  // Logged-out front.
  app.use((req, res, next) => {
    if (req.reader) return next();
    if (req.path === '/') {
      return res.page(null, `<article class="story narrow"><h1>Delivered by personal invitation</h1>
        <p>The December Correspondent is a small Christmas paper for colleagues at our UK, Cebu and Sydney desks. If you’re one of them, your invitation link will sign you in.</p></article>`);
    }
    res.status(404).page('Not found', '<article class="story narrow"><h1>Nothing here</h1><p>Perhaps it was the reindeer.</p></article>');
  });

  // ---------- Reader pages ----------
  const getDoor = async (ed, day) => (await q('select * from door where edition_id=$1 and day=$2', [ed.id, day])).rows[0];
  const titlesUpTo = async (ed, n, col) => {
    const r = await q(`select day, ${col} as t from door where edition_id=$1 and day <= $2`, [ed.id, n]);
    return Object.fromEntries(r.rows.map(x => [x.day, x.t]));
  };
  const notYet = (res, day, zone) => res.status(404).page(`Door ${day}`, `<article class="story narrow"><p class="kicker">Door ${day}</p>
    <h1>Not open yet</h1><p>This door opens at 07:00 on ${esc(T.fmtDay(day))}, your time. No peeking: even the editor can’t see through it from here.</p>
    <p><a class="btn" href="/">Back to the front page</a></p></article>`);
  const parseDay = s => { const n = Number(s); return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null; };

  app.get('/', async (req, res, next) => {
    try {
      const ed = req.edition, n = req.released, zone = req.reader.zone;
      if (n === 0) {
        const opens = T.releaseInstant(1, zone);
        return res.page('Welcome', `<section class="lead">
          <p class="kicker">Welcome edition</p>
          <h1>Stop the presses (gently)</h1>
          <p class="standfirst">Each morning in December there’ll be a door on the front page and another in your own pigeonhole. The first ones open on ${esc(T.fmtFull(opens, zone))}, your time.</p>
          <p class="actions"><a class="btn primary" href="/pouch">Join the Diplomatic Pouch</a> <a class="btn" href="/pigeonhole">My pigeonhole</a></p>
          <p>Read when you fancy. Miss a week and the back issues will still be there. If all that occurs to you is tea, that’s a perfectly sound editorial decision.</p>
        </section>
        <section><h2>The edition</h2>${doorGrid({ released: 0, today: 0, hrefFor: d => `/door/${d}`, label: 'Front-page doors' })}</section>`);
      }
      const door = await getDoor(ed, n);
      const titles = await titlesUpTo(ed, n, 'shared_title');
      const caseLine = await CASE.headline(ed.id, n);
      const complete = n === 24 && T.releasedDay(new Date(req.now.getTime() - 86400000), zone) === 24;
      const nudgeLine = complete ? null : await NUDGE.headline(ed.id, n);
      res.page(null, `<section class="lead">
        <p class="kicker">${complete ? 'The complete edition' : `Door ${n} · ${esc(T.fmtDay(n))}`}</p>
        <h1>${esc(door.shared_title)}</h1>
        <p class="actions"><a class="btn primary" href="/door/${n}">Open today’s door</a> <a class="btn" href="/pigeonhole/${n}">My pigeonhole</a></p>
        ${caseLine ? `<p class="also">Also in today’s paper: <a href="/door/${n}#enquiry">The Case of the Communal Tin, day ${n}: ${esc(caseLine)}</a></p>` : ''}
        ${nudgeLine ? `<p class="also nudge-line">One-minute extra: <a href="/door/${n}#nudge">${esc(nudgeLine)}</a></p>` : ''}
      </section>
      <section><h2>${complete ? 'Every edition' : 'Past editions'}</h2>
      ${doorGrid({ released: n, today: complete ? 0 : n, titles, hrefFor: d => `/door/${d}`, label: 'Front-page doors' })}</section>`);
    } catch (e) { next(e); }
  });

  // ---------- How it works (shown once after first sign-in, linked from the footer) ----------
  app.get('/how', (req, res) => {
    const zone = req.reader.zone, ed = req.edition, now = req.now;
    const first = req.query.first === '1';
    const firstDoor = T.releaseInstant(1, zone);
    const started = req.released > 0;
    const pouchOpen = now < ed.enrol_close && !ed.drawn_at;
    const star = V.smallStar('');
    const item = (h, p) => `<li>${star}<h2>${h}</h2><p>${p}</p></li>`;
    res.page('How the paper works', `<section class="lead">
      <p class="kicker">${first ? `Welcome to the ${esc(T.zoneLabel(zone))} desk` : 'How the paper works'}</p>
      <h1>${first ? `Hello, ${esc(req.reader.name.split(' ')[0])}` : 'The short version'}</h1>
      <p class="standfirst">Whether you’re reading this in a jumper, in shorts or somewhere in between, here’s the whole thing in under a minute.</p></section>
      <ol class="how">
        ${item('Two doors every morning', `At 07:00 your time, a door opens on the front page for everyone, and another opens in <strong>your pigeonhole</strong>, just for you. ${started ? 'Some are already open.' : `The first ones open on ${esc(T.fmtFull(firstDoor, zone))}.`}`)}
        ${item('Something has gone missing', 'Every door carries the latest instalment of <strong>The Case</strong>. There’s an evidence board if you’d like to play detective. The investigating officer is not, it’s fair to say, a natural.')}
        ${item('Join in, or don’t', 'Some doors invite a line, a photo link or a song. Everything is optional. Nobody keeps score, there are no streaks, and nobody can see who has read what.')}
        ${item('The Diplomatic Pouch', `An optional Secret Santa with a budget of exactly zero: a few kind words and a link to something free, like a song or a GIF. ${pouchOpen ? `Join by ${esc(T.fmtFull(ed.enrol_close, zone))}, your time.` : 'Gifts arrive in pigeonholes on 18 December.'}`)}
        ${item('Post for you', 'Now and then your pigeonhole will have a letter in it. On door 14 you can send a private thank-you to a colleague, too.')}
        ${item('No catching up required', 'Miss a week? Every door you’ve opened stays open. The paper closes on 31 January, and then everything in it, letters included, is deleted.')}
      </ol>
      <p class="actions"><a class="btn primary" href="/">${first ? 'Open the paper' : 'Back to the front page'}</a></p>
      <p class="small">Stuck, or want it on another device? Just ask the editor. He’s a bit busy with an enquiry, but he’ll answer.</p>`);
  });

  app.get('/door/today', (req, res) => res.redirect(302, req.released ? `/door/${req.released}` : '/'));

  app.get('/door/:day', async (req, res, next) => {
    try {
      const day = parseDay(req.params.day);
      if (!day) return res.status(404).page('Not found', '<article class="story"><h1>No such door</h1></article>');
      if (day > req.released) return notYet(res, day, req.reader.zone);
      const ed = req.edition;
      const door = await getDoor(ed, day);
      const contribs = (await q(`select * from contribution where edition_id=$1 and display_day=$2 and state='approved' order by created_at`, [ed.id, day])).rows;
      const flash = req.query.sent ? `<p class="flash" role="status">${req.query.sent === 'relay' ? 'Filed. Your line is in the paper.' : req.query.sent === 'letter' ? 'Thank you. The editor will give it a quick read and pop it in their pigeonhole.' : 'Thank you. It’s with the editor.'}</p>` : '';
      let prompt = '';
      if (day === 18) {
        prompt = `<aside class="prompt"><p>${esc(door.optional_prompt || '')}</p><p><a class="btn primary" href="/pigeonhole/18">Go to my pigeonhole</a></p></aside>`;
      } else if (day === LETTER_DAY) {
        const others = (await q('select id, name from reader where edition_id=$1 and active and id<>$2 order by name', [ed.id, req.reader.id])).rows;
        prompt = `<aside class="prompt"><h2>Write a private thank-you</h2><p>${esc(door.optional_prompt || '')}</p>
          <form method="post" action="/door/14/letter">${hidden(req.csrf)}
            <label for="to">Who is it for?</label>
            <select id="to" name="recipient" required><option value="">Choose a colleague</option>${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
            <label for="lt">Your note</label>
            <textarea id="lt" name="body" rows="5" maxlength="1200" required></textarea>
            <fieldset><legend>How would you like to sign it?</legend>
              <label class="choice"><input type="radio" name="sig" value="name" checked> ${esc(req.reader.name)}</label>
              <label class="choice"><input type="radio" name="sig" value="anon"> A colleague</label>
              <label class="choice"><input type="radio" name="sig" value="custom"> Something else: <input name="sig_custom" maxlength="60" aria-label="Custom signature"></label>
            </fieldset>
            <button class="btn primary">Send privately</button>
          </form></aside>`;
      } else if (door.optional_prompt) {
        const relay = RELAY_DAYS.has(day);
        prompt = `<aside class="prompt"><h2>${relay ? 'The relay' : 'Letters to the editor'}</h2><p>${esc(door.optional_prompt)}</p>
          <details><summary>Send something in</summary>
          <form method="post" action="/door/${day}/contribute">${hidden(req.csrf)}
            <label for="cb">${relay ? 'Your line' : 'Your contribution'} <span class="small">(a sentence or two is perfect)</span></label>
            <textarea id="cb" name="body" rows="3" maxlength="600" required></textarea>
            <label for="mu">Link to a song, photo, audio or GIF <span class="small">(optional, must start https://)</span></label>
            <input id="mu" name="media_url" type="url" inputmode="url" maxlength="500" placeholder="https://">
            <label for="md">Describe what’s at the link <span class="small">(so everyone can enjoy it)</span></label>
            <input id="md" name="media_desc" maxlength="200">
            <fieldset><legend>Credit</legend>
              <label class="choice"><input type="radio" name="byline" value="name" checked> ${esc(req.reader.name)}</label>
              <label class="choice"><input type="radio" name="byline" value="anon"> A reader</label>
            </fieldset>
            <label class="choice"><input type="checkbox" name="consent" value="1"> The newsroom may print this${relay ? ' (relay lines go straight into the paper)' : ''}</label>
            <button class="btn primary">Send to the desk</button>
          </form></details></aside>`;
      }
      const list = contribs.length ? `<section class="postbag"><h2>From the postbag</h2>${contribs.map(c => `<blockquote>${paras(c.body)}${mediaLink(c.media_url, c.media_desc)}<footer>${esc(c.byline)}</footer></blockquote>`).join('')}</section>` : '';
      res.page(door.shared_title, `${flash}<article class="story">
        <p class="kicker">Door ${day} · ${esc(T.fmtDay(day))}</p>
        <h1>${esc(door.shared_title)}</h1>${paras(door.shared_body)}</article>
        ${await CASE.enquirySection(ed.id, day)}
        ${await NUDGE.card(req, day)}
        ${day === NUDGE.CHAIN_PRINT_DAY ? await NUDGE.chainPrint(ed.id) : ''}
        ${prompt}${list}
        <nav class="pager" aria-label="Other doors">${day > 1 ? `<a href="/door/${day - 1}">← Door ${day - 1}</a>` : '<span></span>'}
        <a href="/pigeonhole/${day}">Your pigeonhole for today</a>
        ${day < req.released ? `<a href="/door/${day + 1}">Door ${day + 1} →</a>` : '<span></span>'}</nav>`);
    } catch (e) { next(e); }
  });

  app.post('/door/:day/contribute', async (req, res, next) => {
    try {
      const day = parseDay(req.params.day);
      if (!day || day > req.released || day === LETTER_DAY || day === 18) return res.status(404).end();
      const door = await getDoor(req.edition, day);
      if (!door.optional_prompt) return res.status(404).end();
      const body = String(req.body.body || '').trim().slice(0, 600);
      if (!body) return res.redirect(303, `/door/${day}`);
      const rawUrl = String(req.body.media_url || '').trim();
      const url = rawUrl ? safeHttpsUrl(rawUrl) : null;
      if (rawUrl && !url) return res.status(400).page('Link', `<article class="story narrow"><h1>That link didn’t look right</h1><p>Links need to start with https://. Please go back and try again.</p></article>`);
      const consent = req.body.consent === '1';
      const byline = req.body.byline === 'anon' ? 'A reader' : req.reader.name;
      const relay = RELAY_DAYS.has(day) && consent;
      await q(`insert into contribution(edition_id, author_id, source_day, display_day, body, media_url, media_desc, consent, byline, state, reviewed_at)
        values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.edition.id, req.reader.id, day, body, url, String(req.body.media_desc || '').trim().slice(0, 200) || null, consent, byline,
          relay ? 'approved' : 'pending', relay ? new Date() : null]);
      res.redirect(303, `/door/${day}?sent=${relay ? 'relay' : '1'}`);
    } catch (e) { next(e); }
  });

  app.post('/door/14/letter', async (req, res, next) => {
    try {
      if (req.released < LETTER_DAY) return res.status(404).end();
      const rid = Number(req.body.recipient);
      const rec = (await q('select id from reader where id=$1 and edition_id=$2 and active and id<>$3', [rid, req.edition.id, req.reader.id])).rows[0];
      const body = String(req.body.body || '').trim().slice(0, 1200);
      if (!rec || !body) return res.redirect(303, '/door/14');
      let byline = req.reader.name;
      if (req.body.sig === 'anon') byline = 'A colleague';
      if (req.body.sig === 'custom' && String(req.body.sig_custom || '').trim()) byline = String(req.body.sig_custom).trim().slice(0, 60);
      await q(`insert into personal_item(edition_id, recipient_id, day, body, byline, author_id, status) values ($1,$2,$3,$4,$5,$6,'pending')`,
        [req.edition.id, rec.id, Math.max(LETTER_DAY, req.released), body, byline, req.reader.id]);
      res.redirect(303, '/door/14?sent=letter');
    } catch (e) { next(e); }
  });

  // ---------- Pigeonhole ----------
  app.get('/pigeonhole', async (req, res, next) => {
    try {
      const n = req.released;
      const titles = await titlesUpTo(req.edition, n, 'private_title');
      const post = (await q(`select distinct day from personal_item where recipient_id=$1 and status='approved' and day <= $2`, [req.reader.id, n])).rows.map(r => r.day);
      res.page('My pigeonhole', `<section class="lead">
        <p class="kicker">For ${esc(req.reader.name)} only</p><h1>My pigeonhole</h1>
        <p class="standfirst">Your own 24 doors. ${n ? 'Revisit any you’ve opened whenever you like.' : 'The first opens on 1 December.'}${post.length ? ' Some of them have post inside.' : ''}</p></section>
        ${doorGrid({ released: n, today: n, titles, hrefFor: d => `/pigeonhole/${d}`, label: 'My pigeonhole doors' })}`);
    } catch (e) { next(e); }
  });

  app.get('/pigeonhole/:day', async (req, res, next) => {
    try {
      const day = parseDay(req.params.day);
      if (!day) return res.status(404).page('Not found', '<article class="story"><h1>No such door</h1></article>');
      if (day > req.released) return notYet(res, day, req.reader.zone);
      const door = await getDoor(req.edition, day);
      const items = (await q(`select * from personal_item where recipient_id=$1 and day=$2 and status='approved' order by created_at`, [req.reader.id, day])).rows;
      let parcels = [];
      if (day === T.GIFT_DAY) parcels = (await q(`select * from parcel where recipient_id=$1 and sealed_at is not null order by sealed_at`, [req.reader.id])).rows;
      const KIND = { letter: 'Personal post', cracker: 'Crackers', star: 'Gold stars' };
      const letters = ['letter', 'cracker', 'star'].map(k => {
        const mine = items.filter(i => i.kind === k);
        if (!mine.length) return '';
        return `<section class="envelope env-${k}"><h2>${KIND[k]}</h2>${mine.map(i => `<div class="letter ${k}">${k === 'letter' ? `<a class="small" href="/post/${i.id}">Open on its own</a>` : ''}${k === 'cracker' ? crackerHtml(i.body) : paras(i.body)}${mediaLink(i.url)}${k === 'letter' ? `<p class="sig">${esc(i.byline)}</p>` : ''}</div>`).join('')}</section>`;
      }).join('');
      const gifts = parcels.length ? `<section class="envelope parcel"><h2>From the Diplomatic Pouch</h2>${parcels.map(p => parcelHtml(p, req.csrf)).join('')}</section>` : '';
      res.page(door.private_title, `<article class="story private">
        <p class="kicker">Pigeonhole · door ${day}</p><h1>${esc(door.private_title)}</h1>${paras(door.private_body)}</article>
        ${letters}${gifts}
        <nav class="pager" aria-label="Other doors">${day > 1 ? `<a href="/pigeonhole/${day - 1}">← ${day - 1}</a>` : '<span></span>'}<a href="/pigeonhole">All my doors</a>${day < req.released ? `<a href="/pigeonhole/${day + 1}">${day + 1} →</a>` : '<span></span>'}</nav>`);
    } catch (e) { next(e); }
  });

  // Cracker body: intro paragraph, then "question\nanswer". The answer is a tap-to-reveal.
  function crackerHtml(body) {
    const parts = String(body).split(/\n\s*\n/);
    const joke = (parts.pop() || '').split('\n');
    return `${paras(parts.join('\n\n'))}<p class="joke-q">${esc(joke[0] || '')}</p><details class="joke"><summary>Pull the other end</summary><p>${esc(joke.slice(1).join(' '))}</p></details>`;
  }

  function parcelHtml(p, csrf) {
    return `<div class="letter"><p class="small">${p.reserve ? 'Prepared by the editor' : 'From a colleague, sealed with wax'} · <a href="/parcel/${p.id}">Open on its own</a></p>${paras(p.body)}${mediaLink(p.url)}
      ${p.publish_request ? '<p class="small">You’ve asked the editor about printing this one.</p>' : `<form method="post" action="/parcel/${p.id}/share" class="inline">${hidden(csrf)}<button class="linkish">I’d like this shared in the paper</button></form>`}</div>`;
  }

  app.get('/post/:id', async (req, res, next) => {
    try {
      const i = (await q(`select * from personal_item where id=$1 and recipient_id=$2 and status='approved' and day <= $3`, [Number(req.params.id) || 0, req.reader.id, req.released])).rows[0];
      if (!i) return res.status(404).page('Not found', '<article class="story narrow"><h1>Nothing here</h1><p>This post isn’t addressed to you, or hasn’t arrived yet.</p></article>');
      res.page('Personal post', `<article class="story private"><p class="kicker">Personal post · door ${i.day}</p>${paras(i.body)}${mediaLink(i.url)}<p class="sig">${esc(i.byline)}</p></article>`);
    } catch (e) { next(e); }
  });

  const myParcel = async (req, id) => (await q(`select * from parcel where id=$1 and recipient_id=$2 and sealed_at is not null`, [Number(id) || 0, req.reader.id])).rows[0];

  app.get('/parcel/:id', async (req, res, next) => {
    try {
      const p = req.released >= T.GIFT_DAY ? await myParcel(req, req.params.id) : null;
      if (!p) return res.status(404).page('Not found', '<article class="story narrow"><h1>Nothing here</h1><p>This parcel isn’t addressed to you, or hasn’t arrived yet.</p></article>');
      res.page('Your parcel', `<article class="story private"><p class="kicker">Diplomatic Pouch</p>${parcelHtml(p, req.csrf)}</article>`);
    } catch (e) { next(e); }
  });

  app.post('/parcel/:id/share', async (req, res, next) => {
    try {
      const p = req.released >= T.GIFT_DAY ? await myParcel(req, req.params.id) : null;
      if (!p) return res.status(404).end();
      await q('update parcel set publish_request=true where id=$1', [p.id]);
      res.redirect(303, '/pigeonhole/18');
    } catch (e) { next(e); }
  });

  require('./pouch').mount(app);
  NUDGE.mount(app);
  CASE.mount(app);
  require('./editor').mount(app);

  app.use((req, res) => res.status(404).page('Not found', '<article class="story narrow"><h1>Nothing here</h1><p>Perhaps it was the reindeer.</p></article>'));
  app.use((err, req, res, next) => {
    console.error('error:', err && err.message);
    res.status(500).send('Something went wrong at the printworks. Please try again in a moment.');
  });
  return app;
}

module.exports = { createApp };
