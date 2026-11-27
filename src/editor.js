const { q } = require('./db');
const T = require('./time');
const A = require('./auth');
const { parseCsv } = require('./csv');
const { upsertReader } = require('./seed');
const ROSTER = require('./roster');
const { runDraw } = require('./pouch');
const { esc, paras, hidden, mediaLink, safeHttpsUrl } = require('./views');

const STARTERS = require('./starters');
const PLACEHOLDER = /\[[^\]]*\]/;
const RESERVE_COPY = 'A Christmas gift from the picture desk. Your imaginary memoir has been commissioned under the title “I Was Muted for the Interesting Bit”. The paperback will include a foreword by a man still trying to share his screen. With affection from the December desk.';
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function mount(app) {
  app.use('/editor', (req, res, next) => {
    if (req.reader.role !== 'editor') return res.status(404).page('Not found', '<article class="story narrow"><h1>Nothing here</h1></article>');
    next();
  });
  const desk = (res, title, body) => res.page(title, `<div class="desk-wrap"><nav class="subnav" aria-label="Editor’s desk">
      <a href="/editor">Overview</a><a href="/editor/readers">Readers &amp; invites</a><a href="/editor/doors">Doors</a>
      <a href="/editor/letters">Letters</a><a href="/editor/contributions">Contributions</a><a href="/editor/chain">Paper chain</a><a href="/editor/songs">Songs</a><a href="/editor/email">Email</a><a href="/editor/pouch">Pouch</a></nav>${body}</div>`,
    { banner: 'Editor’s desk · readers never see this page' });
  const readersOf = async ed => (await q('select * from reader where edition_id=$1 order by name', [ed.id])).rows;
  const sel = (rows, name, selected, extra = '') => `<select name="${name}" id="${name}" ${extra}><option value="">Choose…</option>${rows.map(r => `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`;

  async function coverage(ed) {
    return (await q(`select r.id, r.name from reader r where r.edition_id=$1 and r.active
        and not exists (select 1 from personal_item i where i.recipient_id=r.id and i.status='approved' and i.kind='letter') order by r.name`, [ed.id])).rows;
  }
  async function reservesNeeded(ed) {
    return (await q(`select r.id, r.name, (e.withdrawn_at is not null) as giver_out
        from assignment a join reader r on r.id=a.recipient_id
        join parcel p on p.assignment_id=a.id
        left join enrolment e on e.edition_id=a.edition_id and e.reader_id=a.giver_id
        where a.edition_id=$1 and (p.sealed_at is null or e.withdrawn_at is not null)
          and not exists (select 1 from parcel rp where rp.recipient_id=a.recipient_id and rp.reserve)
        order by r.name`, [ed.id])).rows;
  }

  // ---------- Overview ----------
  app.get('/editor', async (req, res, next) => {
    try {
      const ed = req.edition;
      const [readers, pend, notes, cov, enr, chainPend, songs] = await Promise.all([
        q('select count(*)::int n from reader where edition_id=$1 and active', [ed.id]),
        q(`select count(*)::int n from contribution where edition_id=$1 and state='pending' and consent`, [ed.id]),
        q(`select count(*)::int n from personal_item where edition_id=$1 and status='pending'`, [ed.id]),
        coverage(ed),
        q('select count(*)::int n from enrolment where edition_id=$1 and withdrawn_at is null', [ed.id]),
        q(`select count(*)::int n from chain_link where edition_id=$1 and state='pending'`, [ed.id]),
        q('select count(*)::int n from song_request where edition_id=$1', [ed.id]),
      ]);
      desk(res, 'Editor’s desk', `<h1>Editor’s desk</h1>
        <ul class="stats">
          <li><a href="/editor/readers"><strong>${readers.rows[0].n}</strong> readers</a></li>
          <li><a href="/editor/contributions"><strong>${pend.rows[0].n}</strong> contributions to review</a></li>
          <li><a href="/editor/songs"><strong>${songs.rows[0].n}</strong> song requests${req.edition.playlist_url ? ' · playlist link set' : ' · playlist link needed by door 24'}</a></li>
          <li><a href="/editor/chain"><strong>${chainPend.rows[0].n}</strong> paper chain links to check before door 23</a></li>
          <li><a href="/editor/letters#coverage"><strong>${cov.length}</strong> readers still need a letter</a></li>
          <li><a href="/editor/pouch"><strong>${enr.rows[0].n}</strong> in the Pouch${ed.drawn_at ? ' · drawn' : ''}</a></li>
        </ul>
        <h2>Try it as a reader</h2>
        <form method="post" action="/editor/preview-mode">${hidden(req.csrf)}
          <label for="pvday">Show me the paper as it looks on door</label>
          <input id="pvday" name="day" type="number" min="1" max="24" value="${req.previewDay || 24}" required>
          <button class="btn primary">Start preview</button></form>
        <p class="small">Only you see this. Door 24 opens everything. Leave preview from the banner at the top.</p>
        <p class="small">Nobody’s reading habits are recorded, so there’s nothing to see about who opened what.</p>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/preview-mode', (req, res) => {
    const d = Number(req.body.day);
    if (!(Number.isInteger(d) && d >= 1 && d <= 24)) return res.redirect(303, '/editor');
    res.cookie('dc_preview', String(d), { httpOnly: true, sameSite: 'lax', secure: A.publicOrigin().startsWith('https://'), path: '/' });
    res.redirect(303, '/');
  });
  app.post('/editor/preview-mode/exit', (req, res) => {
    res.clearCookie('dc_preview', { path: '/' });
    res.redirect(303, '/editor');
  });

  // ---------- Readers ----------
  app.get('/editor/readers', async (req, res, next) => {
    try {
      const rows = await readersOf(req.edition);
      desk(res, 'Readers', `<h1>Readers &amp; invitations</h1>${req.query.imported ? `<p class="flash" role="status">Added ${Number(req.query.imported) || 0}. Nobody has been invited yet.</p>` : ''}
        <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Desk</th><th>Role</th><th>Invitation</th></tr></thead><tbody>
        ${rows.map(r => `<tr${r.active ? '' : ' class="muted"'}><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(T.zoneLabel(r.zone))}</td><td>${esc(r.role)}</td>
          <td><form method="post" action="/editor/readers/${r.id}/invite" class="inline">${hidden(req.csrf)}<button class="btn small">New link</button></form>
          <form method="post" action="/editor/readers/${r.id}/revoke" class="inline">${hidden(req.csrf)}<button class="linkish">Sign out everywhere</button></form></td></tr>`).join('')}
        </tbody></table>
        <p class="small">A new link replaces any unused one and leaves existing devices signed in. “Sign out everywhere” ends all sessions and unused links.</p>
        <h2>Add your team</h2>
        <form method="post" action="/editor/readers/import">${hidden(req.csrf)}
          <label for="csv">Paste from a spreadsheet, or type one person per line: name, email, desk</label>
          <p class="small">Desk can be UK, Cebu or Sydney (London, Philippines, Australia and so on also work). Headings and column order don’t matter. Nobody is invited until you create their link.</p>
          <textarea id="csv" name="csv" rows="8" required placeholder="Jo Bloggs, jo@envirotrees.uk, UK&#10;Maria Santos, maria@envirotrees.uk, Cebu&#10;Sam Lee, sam@envirotrees.uk, Sydney"></textarea>
          <button class="btn primary" name="go" value="preview">Check the list</button></form>
        <h2>Or add one person</h2>
        <form method="post" action="/editor/readers/add" class="add-one">${hidden(req.csrf)}
          <label for="a-n">Name</label><input id="a-n" name="name" required>
          <label for="a-e">Work email</label><input id="a-e" name="email" type="email" required>
          <label for="a-z">Desk</label><select id="a-z" name="zone" required><option value="">Choose…</option>${T.ZONES.map(z => `<option value="${z.label}">${z.label}</option>`).join('')}</select>
          <button class="btn">Add</button></form>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/readers/import', async (req, res, next) => {
    try {
      const checked = ROSTER.check(ROSTER.parseRoster(req.body.csv));
      const bad = checked.filter(r => r.err);
      if (!checked.length) return desk(res, 'Check the list', '<h1>Nothing to import</h1><p>The box looked empty. <a href="/editor/readers">Back</a></p>');
      if (req.body.go === 'commit' && !bad.length) {
        for (const r of checked) await upsertReader(req.edition, { name: r.name, email: r.email, zone: r.zone, role: r.role });
        return res.redirect(303, `/editor/readers?imported=${checked.length}`);
      }
      desk(res, 'Check the list', `<h1>Check the list</h1>
        <table class="tbl"><thead><tr><th>Line</th><th>Name</th><th>Email</th><th>Desk</th><th>Check</th></tr></thead><tbody>
        ${checked.map(r => `<tr${r.err ? ' class="err"' : ''}><td>${r.row}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.zone ? T.zoneLabel(r.zone) : r.zoneRaw)}</td><td>${r.err ? esc(r.err) : 'OK'}</td></tr>`).join('')}
        </tbody></table>
        ${bad.length ? `<p class="flash err">${bad.length} line(s) need fixing. Nothing has been saved yet.</p>
          <form method="post" action="/editor/readers/import">${hidden(req.csrf)}<label for="csv2">Fix the list here and check again</label><textarea id="csv2" name="csv" rows="8">${esc(req.body.csv)}</textarea><button class="btn primary" name="go" value="preview">Check again</button></form>` :
          `<form method="post" action="/editor/readers/import">${hidden(req.csrf)}<textarea name="csv" hidden>${esc(req.body.csv)}</textarea>
           <button class="btn primary" name="go" value="commit">Add ${checked.length} ${checked.length === 1 ? 'person' : 'people'}</button> <a href="/editor/readers">Cancel</a></form>`}`);
    } catch (e) { next(e); }
  });

  app.post('/editor/readers/add', async (req, res, next) => {
    try {
      const [r] = ROSTER.check([{ row: 1, name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase(), zoneRaw: String(req.body.zone || ''), zone: T.zoneFrom(req.body.zone), role: null }]);
      if (r.err) return res.status(400).page('Add a reader', `<article class="story narrow"><h1>Not quite</h1><p>${esc(r.err)}. Go back and try again.</p></article>`);
      await upsertReader(req.edition, { name: r.name, email: r.email, zone: r.zone });
      res.redirect(303, '/editor/readers?imported=1');
    } catch (e) { next(e); }
  });

  const readerById = async (req, id) => (await q('select * from reader where id=$1 and edition_id=$2', [Number(id) || 0, req.edition.id])).rows[0];

  app.post('/editor/readers/:id/invite', async (req, res, next) => {
    try {
      const r = await readerById(req, req.params.id);
      if (!r) return res.status(404).end();
      const link = await A.issueInvite(r.id);
      desk(res, 'Invitation', `<h1>Invitation for ${esc(r.name)}</h1>
        <p>Copy this now: it’s shown once and works once. Send it to ${esc(r.email)} on its own.</p>
        <p><input class="copy" readonly value="${esc(link)}" aria-label="Invitation link"></p>
        <p><a class="btn" href="/editor/readers">Back to readers</a></p>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/readers/:id/revoke', async (req, res, next) => {
    try {
      const r = await readerById(req, req.params.id);
      if (!r) return res.status(404).end();
      await q('update session set revoked_at=now() where reader_id=$1 and revoked_at is null', [r.id]);
      await q('update invitation set revoked_at=now() where reader_id=$1 and used_at is null and revoked_at is null', [r.id]);
      res.redirect(303, '/editor/readers');
    } catch (e) { next(e); }
  });

  // ---------- Doors ----------
  app.get('/editor/doors', async (req, res, next) => {
    try {
      const doors = (await q('select day, shared_title, private_title, edited_at from door where edition_id=$1 order by day', [req.edition.id])).rows;
      desk(res, 'Doors', `<h1>Doors</h1><table class="tbl"><thead><tr><th>Day</th><th>Front page</th><th>Pigeonhole</th><th></th></tr></thead><tbody>
        ${doors.map(d => `<tr><td>${d.day}</td><td>${esc(d.shared_title)}</td><td>${esc(d.private_title)}</td>
          <td><a href="/editor/doors/${d.day}">Edit</a> · <a href="/editor/preview?day=${d.day}">Preview</a>${d.edited_at ? ' · <span class="small">edited</span>' : ''}</td></tr>`).join('')}
        </tbody></table>`);
    } catch (e) { next(e); }
  });

  app.get('/editor/doors/:day', async (req, res, next) => {
    try {
      const d = (await q('select * from door where edition_id=$1 and day=$2', [req.edition.id, Number(req.params.day) || 0])).rows[0];
      if (!d) return res.status(404).end();
      const f = (n, l, v, rows) => `<label for="${n}">${l}</label>${rows ? `<textarea id="${n}" name="${n}" rows="${rows}">${esc(v || '')}</textarea>` : `<input id="${n}" name="${n}" value="${esc(v || '')}">`}`;
      desk(res, `Edit door ${d.day}`, `<h1>Door ${d.day} · ${esc(T.fmtDay(d.day))}</h1>
        <form method="post" action="/editor/doors/${d.day}">${hidden(req.csrf)}
        <h2>Front page</h2>${f('shared_title', 'Headline', d.shared_title)}${f('shared_body', 'Story', d.shared_body, 6)}${f('optional_prompt', 'Optional prompt (leave empty for reading only)', d.optional_prompt, 2)}
        <h2>Pigeonhole</h2>${f('private_title', 'Title', d.private_title)}${f('private_body', 'Text', d.private_body, 5)}
        <button class="btn primary">Save door</button> <a href="/editor/preview?day=${d.day}">Preview</a></form>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/doors/:day', async (req, res, next) => {
    try {
      const b = req.body, t = s => String(s || '').trim();
      if (!t(b.shared_title) || !t(b.shared_body) || !t(b.private_title) || !t(b.private_body)) return res.status(400).send('All fields except the prompt are required.');
      await q(`update door set shared_title=$3, shared_body=$4, optional_prompt=$5, private_title=$6, private_body=$7, edited_at=now() where edition_id=$1 and day=$2`,
        [req.edition.id, Number(req.params.day) || 0, t(b.shared_title), t(b.shared_body), t(b.optional_prompt) || null, t(b.private_title), t(b.private_body)]);
      res.redirect(303, `/editor/preview?day=${Number(req.params.day)}`);
    } catch (e) { next(e); }
  });

  app.get('/editor/preview', async (req, res, next) => {
    try {
      const day = Math.min(24, Math.max(1, Number(req.query.day) || 1));
      const zone = T.zoneFrom(req.query.zone) || req.reader.zone;
      const d = (await q('select * from door where edition_id=$1 and day=$2', [req.edition.id, day])).rows[0];
      const opens = T.releaseInstant(day, zone);
      const zones = T.ZONES.map(z => `<a href="/editor/preview?day=${day}&zone=${encodeURIComponent(z.label)}"${z.key === zone ? ' aria-current="true"' : ''}>${z.label}</a>`).join(' · ');
      res.page(`Preview door ${day}`, `<p class="small">Desk: ${zones} · Opens ${esc(T.fmtFull(opens, zone))} ${esc(T.zoneLabel(zone))} time ·
          ${day > 1 ? `<a href="/editor/preview?day=${day - 1}&zone=${encodeURIComponent(T.zoneLabel(zone))}">← ${day - 1}</a>` : ''} ${day < 24 ? `<a href="/editor/preview?day=${day + 1}&zone=${encodeURIComponent(T.zoneLabel(zone))}">${day + 1} →</a>` : ''} · <a href="/editor/doors/${day}">Edit</a></p>
        <article class="story"><p class="kicker">Front page · door ${day}</p><h1>${esc(d.shared_title)}</h1>${paras(d.shared_body)}</article>
        ${await require('./casefile').enquirySection(req.edition.id, day)}
        ${day === 24 ? require('./nudges').playlistSection(req.edition) : ''}
        ${d.optional_prompt ? `<aside class="prompt"><p>${esc(d.optional_prompt)}</p></aside>` : '<p class="small">Reading only today.</p>'}
        <article class="story private"><p class="kicker">Pigeonhole · door ${day}</p><h1>${esc(d.private_title)}</h1>${paras(d.private_body)}</article>`,
      { banner: 'Editor preview · this is not what readers can see yet' });
    } catch (e) { next(e); }
  });

  // ---------- Letters ----------
  app.get('/editor/letters', async (req, res, next) => {
    try {
      const ed = req.edition;
      const rs = await readersOf(ed);
      const cov = await coverage(ed);
      const pending = (await q(`select i.*, r.name rname, a.name aname from personal_item i join reader r on r.id=i.recipient_id left join reader a on a.id=i.author_id
          where i.edition_id=$1 and i.status='pending' order by i.created_at`, [ed.id])).rows;
      const letters = (await q(`select i.*, r.name rname from personal_item i join reader r on r.id=i.recipient_id
          where i.edition_id=$1 and i.status='approved' and i.kind='letter' order by r.name, i.day`, [ed.id])).rows;
      desk(res, 'Letters', `<h1>Letters</h1>
        <section id="coverage"><h2>Still need a letter (${cov.length})</h2>${cov.length ? `<p>${cov.map(c => esc(c.name)).join(', ')}</p>` : '<p>Everyone has post. Lovely.</p>'}</section>
        ${pending.length ? `<section id="notes"><h2>Waiting for a check (${pending.length})</h2>`: ''}
        ${pending.map(i => `<div class="card"><p class="small">To <strong>${esc(i.rname)}</strong> from ${esc(i.aname || 'someone')} · ${i.kind === 'star' ? 'gold star' : `signed “${esc(i.byline)}”`} · door ${i.day}</p>${paras(i.body)}
          <form method="post" action="/editor/letters/${i.id}/review" class="inline">${hidden(req.csrf)}<button class="btn small primary" name="act" value="approve">Deliver</button> <button class="btn small" name="act" value="decline">Hold back</button></form></div>`).join('')}${pending.length ? '</section>' : ''}
        <section><h2>Add a letter</h2>
        <form method="post" action="/editor/letters">${hidden(req.csrf)}
          <label for="recipient">For</label>${sel(rs, 'recipient', null, 'required')}
          <label for="starter">Start from an idea <span class="small">(optional)</span></label>
          <select id="starter"><option value="">Write my own</option>${STARTERS.map((t, i) => `<option value="${i}">${esc(t.title)}</option>`).join('')}</select>
          <p class="small">Replace every [square bracket] with the real moment. The desk won’t save a letter with a bracket left in. To switch starters, clear the letter box first.</p>
          <label for="day">Behind door</label><input id="day" name="day" type="number" min="1" max="24" value="14" required>
          <label for="body">Letter</label><textarea id="body" name="body" rows="5" required></textarea>
          <label for="byline">Signed</label><input id="byline" name="byline" required>
          <label for="url">Link (optional, https)</label><input id="url" name="url" type="url">
          <button class="btn primary">Add letter</button></form>
          <script type="application/json" id="starter-data">${JSON.stringify(STARTERS).replace(/</g, '\\u003c')}</script>
          <script src="/static/starters.js"></script></section>
        <section><h2>Import letters.csv</h2>
        <form method="post" action="/editor/letters/import">${hidden(req.csrf)}
          <label for="lcsv">Paste letters.csv (recipient_email, day, byline, letter_text)</label><textarea id="lcsv" name="csv" rows="6" required></textarea>
          <button class="btn" name="go" value="preview">Preview import</button></form></section>
        <section><h2>Letters on file (${letters.length})</h2>
        ${letters.map(i => `<details class="card"><summary>${esc(i.rname)} · door ${i.day} · ${esc(i.byline)}</summary>${paras(i.body)}${mediaLink(i.url)}
          <form method="post" action="/editor/letters/${i.id}/review" class="inline">${hidden(req.csrf)}<button class="linkish" name="act" value="decline">Remove</button></form></details>`).join('')}</section>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/letters', async (req, res, next) => {
    try {
      const r = await readerById(req, req.body.recipient);
      const day = Number(req.body.day);
      const raw = String(req.body.url || '').trim();
      const url = raw ? safeHttpsUrl(raw) : null;
      if (!r || !(day >= 1 && day <= 24) || !String(req.body.body || '').trim() || !String(req.body.byline || '').trim() || (raw && !url)) return res.status(400).send('Please check the recipient, door, letter, signature and link.');
      if (PLACEHOLDER.test(req.body.body)) return res.status(400).page('Letter', `<article class="story narrow"><h1>There’s still a [gap] to fill</h1><p>Swap each square bracket for the real moment, then save again. Use your browser’s back button: your text will still be there.</p><blockquote>${esc(String(req.body.body).match(PLACEHOLDER)[0])}</blockquote></article>`);
      await q(`insert into personal_item(edition_id, recipient_id, day, body, url, byline) values ($1,$2,$3,$4,$5,$6)`,
        [req.edition.id, r.id, day, String(req.body.body).trim(), url, String(req.body.byline).trim()]);
      res.redirect(303, '/editor/letters');
    } catch (e) { next(e); }
  });

  app.post('/editor/letters/import', async (req, res, next) => {
    try {
      const rows = parseCsv(req.body.csv);
      const rs = await readersOf(req.edition);
      const checked = rows.map(r => {
        const matches = rs.filter(x => x.email === (r.recipient_email || '').toLowerCase());
        const day = Number(r.day);
        let err = null;
        if (matches.length === 0) err = 'no reader with that email';
        else if (matches.length > 1) err = 'ambiguous email';
        else if (!(Number.isInteger(day) && day >= 1 && day <= 24)) err = 'day must be 1–24';
        else if (!r.letter_text) err = 'empty letter';
        else if (!r.byline) err = 'missing signature';
        else if (PLACEHOLDER.test(r.letter_text)) err = 'still has a [gap] to fill';
        return { ...r, day, reader: matches[0], err };
      });
      const bad = checked.filter(r => r.err);
      if (req.body.go === 'commit' && !bad.length) {
        for (const r of checked) await q('insert into personal_item(edition_id, recipient_id, day, body, byline) values ($1,$2,$3,$4,$5)', [req.edition.id, r.reader.id, r.day, r.letter_text, r.byline]);
        return res.redirect(303, '/editor/letters');
      }
      desk(res, 'Letter import', `<h1>Letter import preview</h1><table class="tbl"><thead><tr><th>Row</th><th>For</th><th>Door</th><th>Signed</th><th>Check</th></tr></thead><tbody>
        ${checked.map(r => `<tr${r.err ? ' class="err"' : ''}><td>${r._row}</td><td>${esc(r.reader ? r.reader.name : r.recipient_email)}</td><td>${esc(r.day)}</td><td>${esc(r.byline)}</td><td>${r.err ? esc(r.err) : 'OK'}</td></tr>`).join('')}</tbody></table>
        ${bad.length ? `<p class="flash err">Fix ${bad.length} row(s) first. Nothing has been saved.</p>` : `<form method="post" action="/editor/letters/import">${hidden(req.csrf)}<textarea name="csv" hidden>${esc(req.body.csv)}</textarea><button class="btn primary" name="go" value="commit">Import ${checked.length} letters</button></form>`}
        <p><a href="/editor/letters">Back</a></p>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/letters/:id/review', async (req, res, next) => {
    try {
      const st = req.body.act === 'approve' ? 'approved' : 'declined';
      await q('update personal_item set status=$3 where id=$1 and edition_id=$2', [Number(req.params.id) || 0, req.edition.id, st]);
      res.redirect(303, '/editor/letters');
    } catch (e) { next(e); }
  });

  // ---------- Contributions ----------
  app.get('/editor/contributions', async (req, res, next) => {
    try {
      const rows = (await q(`select c.*, r.name aname from contribution c join reader r on r.id=c.author_id where c.edition_id=$1
          order by case c.state when 'pending' then 0 when 'approved' then 1 else 2 end, c.created_at desc`, [req.edition.id])).rows;
      const card = c => `<div class="card state-${c.state}"><p class="small">Door ${c.source_day}${c.display_day !== c.source_day ? ` → shown on ${c.display_day}` : ''} · ${esc(c.aname)} · credit “${esc(c.byline)}” · <strong>${c.state}</strong>${c.consent ? '' : ' · <em>private to the desk (no consent to print)</em>'}</p>
        ${paras(c.body)}${mediaLink(c.media_url, c.media_desc)}
        <form method="post" action="/editor/contributions/${c.id}" class="inline">${hidden(req.csrf)}
          ${c.consent && c.state !== 'approved' ? '<button class="btn small primary" name="act" value="approve">Publish</button>' : ''}
          ${c.state === 'approved' ? '<button class="btn small" name="act" value="unpublish">Unpublish</button>' : ''}
          ${c.state === 'pending' ? '<button class="btn small" name="act" value="decline">Decline</button>' : ''}
          ${c.consent ? `<label class="inline-label">Show on door <input name="display_day" type="number" min="1" max="24" value="${c.display_day}"></label><button class="btn small" name="act" value="move">Move</button>` : ''}
        </form></div>`;
      desk(res, 'Contributions', `<h1>Contributions</h1><p class="small">Relay lines on doors 3, 17 and 21 publish straight away when the writer agrees. You can unpublish anything.</p>${rows.map(card).join('') || '<p>Nothing yet. A quiet day needs no editorial intervention.</p>'}`);
    } catch (e) { next(e); }
  });

  app.post('/editor/contributions/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0, ed = req.edition.id;
      const act = req.body.act;
      if (act === 'approve') await q(`update contribution set state='approved', reviewed_at=now() where id=$1 and edition_id=$2 and consent`, [id, ed]);
      else if (act === 'decline') await q(`update contribution set state='declined', reviewed_at=now() where id=$1 and edition_id=$2`, [id, ed]);
      else if (act === 'unpublish') await q(`update contribution set state='unpublished', reviewed_at=now() where id=$1 and edition_id=$2`, [id, ed]);
      else if (act === 'move') {
        const d = Number(req.body.display_day);
        if (d >= 1 && d <= 24) await q(`update contribution set display_day=$3 where id=$1 and edition_id=$2 and consent`, [id, ed, d]);
      }
      res.redirect(303, '/editor/contributions');
    } catch (e) { next(e); }
  });

  // ---------- Paper chain ----------
  // Links count towards the masthead straight away; their words are only printed on door 23, once approved.
  app.get('/editor/chain', async (req, res, next) => {
    try {
      const rows = (await q(`select * from chain_link where edition_id=$1 order by case state when 'pending' then 0 when 'approved' then 1 else 2 end, created_at`, [req.edition.id])).rows;
      const pend = rows.filter(r => r.state === 'pending').length;
      desk(res, 'Paper chain', `<h1>Paper chain</h1>
        <p class="small">Every link lengthens the masthead chain straight away. The words only appear on door 23, without names, and only once you’ve approved them.</p>
        ${pend ? `<form method="post" action="/editor/chain/approve-all">${hidden(req.csrf)}<button class="btn primary">Approve all ${pend} pending</button></form>` : ''}
        <table class="tbl"><thead><tr><th>Desk</th><th>Link</th><th>State</th><th></th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(T.zoneLabel(r.zone))}</td><td>${esc(r.body)}</td><td>${r.state}</td><td>
          <form method="post" action="/editor/chain/${r.id}" class="inline">${hidden(req.csrf)}${r.state !== 'approved' ? '<button class="btn small" name="act" value="approve">Approve</button>' : ''} ${r.state !== 'hidden' ? '<button class="linkish" name="act" value="hide">Hide</button>' : ''}</form></td></tr>`).join('')}
        </tbody></table>`);
    } catch (e) { next(e); }
  });
  app.post('/editor/chain/approve-all', async (req, res, next) => {
    try { await q(`update chain_link set state='approved' where edition_id=$1 and state='pending'`, [req.edition.id]); res.redirect(303, '/editor/chain'); }
    catch (e) { next(e); }
  });
  app.post('/editor/chain/:id', async (req, res, next) => {
    try {
      const st = req.body.act === 'approve' ? 'approved' : 'hidden';
      await q('update chain_link set state=$3 where id=$1 and edition_id=$2', [Number(req.params.id) || 0, req.edition.id, st]);
      res.redirect(303, '/editor/chain');
    } catch (e) { next(e); }
  });

  // ---------- Songs ----------
  app.get('/editor/songs', async (req, res, next) => {
    try {
      const rows = (await q('select title, artist, zone from song_request where edition_id=$1 order by lower(title)', [req.edition.id])).rows;
      const plain = rows.map(r => `${r.title}${r.artist ? ` — ${r.artist}` : ''}`).join('\n');
      desk(res, 'Songs', `<h1>Christmas request box</h1>
        <p>${rows.length} request${rows.length === 1 ? '' : 's'} so far. The box is open from door 14 to door 22. Names aren’t shown here, just the songs and desks.</p>
        ${rows.length ? `<label for="plain">All requests as plain text, ready to copy into your music app</label><textarea id="plain" rows="${Math.min(14, rows.length + 1)}" readonly>${esc(plain)}</textarea>
        <table class="tbl"><thead><tr><th>Song</th><th>Artist</th><th>Desk</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.title)}</td><td>${esc(r.artist || '')}</td><td>${esc(T.zoneLabel(r.zone))}</td></tr>`).join('')}</tbody></table>` : ''}
        <h2>The playlist link</h2>
        <form method="post" action="/editor/songs/playlist">${hidden(req.csrf)}
          <label for="pl">Playlist link (https). It appears on door 24 for everyone.</label>
          <input id="pl" name="url" type="url" value="${esc(req.edition.playlist_url || '')}" placeholder="https://">
          <button class="btn primary">Save link</button></form>
        <p><a href="/editor/preview?day=24">Preview door 24</a></p>`);
    } catch (e) { next(e); }
  });
  app.post('/editor/songs/playlist', async (req, res, next) => {
    try {
      const raw = String(req.body.url || '').trim();
      const url = raw ? safeHttpsUrl(raw) : null;
      if (raw && !url) return res.status(400).send('The playlist link needs to start with https://');
      await q('update edition set playlist_url=$2 where id=$1', [req.edition.id, url]);
      res.redirect(303, '/editor/songs');
    } catch (e) { next(e); }
  });

  // ---------- Email ----------
  app.get('/editor/email', async (req, res, next) => {
    try {
      const EMAIL = require('./email');
      const stats = (await q(`select kind, count(*) filter (where ok)::int ok, count(*) filter (where not ok)::int failed from email_log where edition_id=$1 group by kind`, [req.edition.id])).rows;
      const opt = (await q(`select count(*) filter (where not notify_post)::int nopost, count(*) filter (where not notify_weekly)::int noweekly, count(*)::int n from reader where edition_id=$1 and active`, [req.edition.id])).rows[0];
      const s = k => stats.find(x => x.kind === k) || { ok: 0, failed: 0 };
      desk(res, 'Email', `<h1>Email</h1>
        ${EMAIL.configured() ? `<p class="flash">Sending is on, via ${esc(EMAIL.provider())}.</p>` : '<p class="flash err">Test mode: emails are prepared on schedule but not sent. Sending switches on once the email service details are added in Railway.</p>'}
        <ul class="stats">
          <li><span><strong>${s('post').ok}</strong> “something has arrived” emails sent${s('post').failed ? ` · ${s('post').failed} failed` : ''}</span></li>
          <li><span><strong>${s('weekly').ok}</strong> Monday reminders sent${s('weekly').failed ? ` · ${s('weekly').failed} failed` : ''}</span></li>
          <li><span><strong>${opt.nopost}</strong> of ${opt.n} readers have turned off post alerts; <strong>${opt.noweekly}</strong> have turned off Monday reminders</span></li>
        </ul>
        <p class="small">Post alerts go out at most once a day per person, between 08:00 and 20:00 their time, only once the item is visible to them, and never say what it is or who sent it. Monday reminders go at 07:30 their time on 7, 14 and 21 December.</p>
        <form method="post" action="/editor/email/test">${hidden(req.csrf)}<button class="btn">Send a test email to ${esc(req.reader.email)}</button></form>
        ${req.query.test ? `<p class="flash" role="status">${req.query.test === 'ok' ? (EMAIL.configured() ? 'Test email sent. Check your inbox (and junk folder).' : 'Test mode: the email was prepared but not sent.') : 'The test email failed. Check the email settings in Railway.'}</p>` : ''}`);
    } catch (e) { next(e); }
  });
  app.post('/editor/email/test', async (req, res, next) => {
    try {
      const EMAIL = require('./email');
      const unsubUrl = EMAIL.site(`/email/stop/${req.reader.email_token}`);
      const { html, text } = EMAIL.wrap({ heading: 'Testing, testing', lines: ['If you can read this, The December Correspondent can reach your inbox.', 'The editor would like it noted that this is the first thing in the enquiry to work first time.'], button: 'Open the paper', buttonUrl: EMAIL.site('/'), unsubUrl });
      const ok = await EMAIL.send({ to: req.reader.email, subject: 'Test from The December Correspondent', text, html, unsubUrl });
      res.redirect(303, `/editor/email?test=${ok ? 'ok' : 'fail'}`);
    } catch (e) { next(e); }
  });

  // ---------- Pouch ----------
  app.get('/editor/pouch', async (req, res, next) => {
    try {
      const ed = req.edition;
      const n = (await q('select count(*)::int n from enrolment where edition_id=$1 and withdrawn_at is null', [ed.id])).rows[0].n;
      const rs = await readersOf(ed);
      const need = ed.drawn_at ? await reservesNeeded(ed) : [];
      const sealed = ed.drawn_at ? (await q(`select count(*) filter (where sealed_at is not null)::int s, count(*)::int t from parcel where edition_id=$1 and not reserve`, [ed.id])).rows[0] : null;
      const shares = (await q(`select p.*, r.name rname from parcel p join reader r on r.id=p.recipient_id where p.edition_id=$1 and p.publish_request`, [ed.id])).rows;
      const msg = { deferred: 'Fewer than two people have enrolled, so the draw is deferred. Nothing has been drawn.', open: 'Enrolment is still open, so names can’t be drawn yet.', drawn: 'Names drawn. Each giver can now see their recipient in their Pouch.', already: 'Names had already been drawn. Nothing changed.' }[req.query.m] || '';
      desk(res, 'Pouch', `<h1>Diplomatic Pouch</h1>${msg ? `<p class="flash" role="status">${esc(msg)}</p>` : ''}
        <p><strong>${n}</strong> enrolled. Enrolment closes ${esc(T.fmtFull(ed.enrol_close, req.reader.zone))} (${esc(T.zoneLabel(req.reader.zone))}).</p>
        ${ed.drawn_at ? `<p>Drawn on ${esc(T.fmtFull(ed.drawn_at, req.reader.zone))}. ${sealed.s} of ${sealed.t} parcels sealed.</p>` : `<p><a class="btn primary" href="/editor/pouch/draw">Draw names…</a></p>`}
        ${ed.drawn_at ? `<h2>Need a reserve parcel (${need.length})</h2><p class="small">Recipients whose parcel isn’t sealed yet, or whose giver has stepped out. Worth acting on from 17 December.</p>
          <ul>${need.map(r => `<li>${esc(r.name)}${r.giver_out ? ' · giver stepped out' : ' · not sealed yet'}</li>`).join('')}</ul>
          <h2>Add a reserve parcel</h2>
          <form method="post" action="/editor/pouch/reserve">${hidden(req.csrf)}
            <label for="recipient">For</label>${sel(rs, 'recipient', null, 'required')}
            <label for="rb">Message</label><textarea id="rb" name="body" rows="5" required>${esc(RESERVE_COPY)}</textarea>
            <label for="ru">Link (optional, https)</label><input id="ru" name="url" type="url">
            <button class="btn primary">Seal reserve parcel</button></form>` : ''}
        ${shares.length ? `<h2>Readers who’d like their parcel printed</h2><ul>${shares.map(p => `<li>${esc(p.rname)}: ${esc(p.body.slice(0, 120))}${p.body.length > 120 ? '…' : ''}</li>`).join('')}</ul><p class="small">Check with the sender and anyone named before printing.</p>` : ''}`);
    } catch (e) { next(e); }
  });

  app.get('/editor/pouch/draw', async (req, res, next) => {
    try {
      const n = (await q('select count(*)::int n from enrolment where edition_id=$1 and withdrawn_at is null', [req.edition.id])).rows[0].n;
      desk(res, 'Draw names', `<h1>Draw names now?</h1><p>${n} people are enrolled. The draw happens once and can’t be redone. Each giver will see their recipient straight away.</p>
        <form method="post" action="/editor/pouch/draw">${hidden(req.csrf)}<button class="btn primary">Yes, draw names now</button> <a href="/editor/pouch">Not yet</a></form>`);
    } catch (e) { next(e); }
  });

  app.post('/editor/pouch/draw', async (req, res, next) => {
    try {
      const out = await runDraw(req.edition.id, req.now);
      res.redirect(303, `/editor/pouch?m=${out.status}`);
    } catch (e) { next(e); }
  });

  app.post('/editor/pouch/reserve', async (req, res, next) => {
    try {
      const r = await readerById(req, req.body.recipient);
      const raw = String(req.body.url || '').trim();
      const url = raw ? safeHttpsUrl(raw) : null;
      if (!r || !String(req.body.body || '').trim() || (raw && !url)) return res.status(400).send('Please choose a recipient, write a message and check any link.');
      await q('insert into parcel(edition_id, recipient_id, body, url, sealed_at, reserve) values ($1,$2,$3,$4,now(),true)', [req.edition.id, r.id, String(req.body.body).trim().slice(0, 1500), url]);
      res.redirect(303, '/editor/pouch');
    } catch (e) { next(e); }
  });
}

module.exports = { mount };
