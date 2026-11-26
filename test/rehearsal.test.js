// Rehearsal checks from build.md, run against a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

const DB = 'dc_test';
execSync(`psql -h /tmp -U postgres -qc "drop database if exists ${DB}" -c "create database ${DB}"`);
process.env.DATABASE_URL = `postgres://postgres@localhost:5432/${DB}?host=/tmp`;
process.env.ALLOW_CLOCK_OVERRIDE = '1';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { pool, q, migrate } = require('../src/db');
const { seed, upsertReader } = require('../src/seed');
const { createApp } = require('../src/app');
const { runDraw } = require('../src/pouch');
const A = require('../src/auth');

let server, base, ed, P = {};

const tokenOf = link => link.split('#')[1];
async function req(path, { who, at, method = 'GET', form } = {}) {
  const headers = { 'x-test-now': at || '2026-12-02T12:00:00Z' };
  if (who) headers.cookie = `${A.COOKIE}=${who.cookie}`;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
async function signIn(reader) {
  const t = tokenOf(await A.issueInvite(reader.id));
  const r = await req('/welcome', { method: 'POST', form: { token: t } });
  assert.equal(r.status, 303);
  const c = r.headers.get('set-cookie').match(new RegExp(`${A.COOKIE}=([^;]+)`))[1];
  return { ...reader, cookie: decodeURIComponent(c) };
}
async function csrf(who, at) {
  const r = await req('/pigeonhole', { who, at });
  return r.text.match(/name="_csrf" value="([^"]+)"/)[1];
}
async function post(who, path, form, at) {
  return req(path, { who, at, method: 'POST', form: { _csrf: await csrf(who, at), ...form } });
}

before(async () => {
  await migrate();
  ({ edition: ed } = await seed());
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const mk = (name, email, zone, role) => upsertReader(ed, { name, email, zone, role });
  P.ada = await signIn(await mk('Ada (UK)', 'ada@t.test', 'Europe/London'));
  P.bea = await signIn(await mk('Bea (Cebu)', 'bea@t.test', 'Asia/Manila'));
  P.cal = await signIn(await mk('Cal (Sydney)', 'cal@t.test', 'Australia/Sydney'));
  P.ed = await signIn(await mk('Ed Itor', 'ed@t.test', 'Europe/London', 'editor'));
});
after(async () => { server.close(); await pool.end(); });

test('door 1 opens Sydney 20:00 UTC, Cebu 23:00 UTC, UK 07:00 UTC', async () => {
  const open = (who, at) => req('/door/1', { who, at }).then(r => r.status);
  assert.equal(await open(P.cal, '2026-11-30T19:59:00Z'), 404);
  assert.equal(await open(P.cal, '2026-11-30T20:00:00Z'), 200);
  assert.equal(await open(P.bea, '2026-11-30T20:00:00Z'), 404);
  assert.equal(await open(P.bea, '2026-11-30T23:00:00Z'), 200);
  assert.equal(await open(P.ada, '2026-11-30T23:00:00Z'), 404);
  assert.equal(await open(P.ada, '2026-12-01T07:00:00Z'), 200);
  const front = await req('/', { who: P.ada, at: '2026-11-30T20:00:00Z' });
  assert.match(front.text, /Welcome edition/);
});

test('future text is absent from every page', async () => {
  const at = '2026-11-30T20:00:00Z';
  for (const p of ['/', '/pigeonhole', '/pigeonhole/1', '/door/1', '/door/2', '/pigeonhole/2']) {
    const r = await req(p, { who: P.cal, at });
    assert.doesNotMatch(r.text, /The view from here|Window seat|man is attempting/, p);
  }
});

test('invitations: preview-safe, single use, replaceable', async () => {
  const r = await upsertReader(ed, { name: 'Dee', email: 'dee@t.test', zone: 'Europe/London' });
  const t1 = tokenOf(await A.issueInvite(r.id));
  assert.equal((await req('/welcome')).status, 200); // a link preview only GETs
  const t2 = tokenOf(await A.issueInvite(r.id)); // replacement
  assert.equal((await req('/welcome', { method: 'POST', form: { token: t1 } })).status, 400);
  assert.equal((await req('/welcome', { method: 'POST', form: { token: t2 } })).status, 303);
  assert.equal((await req('/welcome', { method: 'POST', form: { token: t2 } })).status, 400);
});

test('letters belong to their recipient', async () => {
  const i = (await q(`insert into personal_item(edition_id, recipient_id, day, body, byline) values ($1,$2,2,'For Ada only','Bea') returning id`, [ed.id, P.ada.id])).rows[0];
  assert.equal((await req(`/post/${i.id}`, { who: P.ada, at: '2026-12-01T12:00:00Z' })).status, 404, 'not before its door');
  assert.equal((await req(`/post/${i.id}`, { who: P.ada })).status, 200);
  const other = await req(`/post/${i.id}`, { who: P.bea });
  assert.equal(other.status, 404);
  assert.doesNotMatch(other.text, /For Ada only/);
  assert.match((await req('/pigeonhole/2', { who: P.ada })).text, /For Ada only/);
});

test('captions: pending hidden, approved shown, unpublish hides, relay instant', async () => {
  const at = '2026-12-04T12:00:00Z';
  await post(P.bea, '/door/4/contribute', { body: 'A spoon. Label: retired.', consent: '1', byline: 'name' }, at);
  assert.doesNotMatch((await req('/door/4', { who: P.ada, at })).text, /retired/);
  const c = (await q(`select id from contribution where body like 'A spoon%'`)).rows[0];
  assert.equal((await req('/editor/contributions', { who: P.ada, at })).status, 404, 'readers cannot reach the desk');
  await post(P.ed, `/editor/contributions/${c.id}`, { act: 'approve' }, at);
  assert.match((await req('/door/4', { who: P.ada, at })).text, /retired/);
  await post(P.ed, `/editor/contributions/${c.id}`, { act: 'unpublish' }, at);
  assert.doesNotMatch((await req('/door/4', { who: P.ada, at })).text, /retired/);
  await post(P.cal, '/door/3/contribute', { body: 'The ceiling hired a lawyer.', consent: '1', byline: 'anon' }, at);
  assert.match((await req('/door/3', { who: P.bea, at })).text, /ceiling hired a lawyer[\s\S]*A reader/);
  await post(P.cal, '/door/3/contribute', { body: 'Private aside.', byline: 'anon' }, at);
  assert.doesNotMatch((await req('/door/3', { who: P.bea, at })).text, /Private aside/);
  assert.equal((await req('/door/4/contribute', { who: P.bea, at, method: 'POST', form: { body: 'x' } })).status, 403, 'CSRF');
});

test('contributed text is escaped and only https links accepted', async () => {
  const at = '2026-12-07T12:00:00Z';
  await post(P.bea, '/door/7/contribute', { body: '<script>alert(1)</script>', consent: '1', byline: 'name' }, at);
  const bad = await post(P.bea, '/door/7/contribute', { body: 'x', media_url: 'javascript:alert(1)', consent: '1' }, at);
  assert.equal(bad.status, 400);
  const c = (await q(`select id from contribution where body like '<script>%'`)).rows[0];
  await post(P.ed, `/editor/contributions/${c.id}`, { act: 'approve' }, at);
  const page = (await req('/door/7', { who: P.ada, at })).text;
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<script>alert/);
});

test('day 14 letters wait for the editor', async () => {
  const at = '2026-12-14T12:00:00Z';
  await post(P.bea, '/door/14/letter', { recipient: String(P.cal.id), body: 'You always tell me which attachment to open.', sig: 'anon' }, at);
  assert.doesNotMatch((await req('/pigeonhole/14', { who: P.cal, at })).text, /attachment to open/);
  assert.doesNotMatch((await req('/editor/contributions', { who: P.ed, at })).text, /attachment to open/, 'not in public moderation feed');
  const i = (await q(`select id from personal_item where body like 'You always%'`)).rows[0];
  await post(P.ed, `/editor/letters/${i.id}/review`, { act: 'approve' }, at);
  const page = (await req('/pigeonhole/14', { who: P.cal, at })).text;
  assert.match(page, /attachment to open[\s\S]*A colleague/);
});

test('draw: 0, 1, 2 and 5 entrants, concurrent presses, no self-match', async () => {
  const close = new Date('2026-12-08T09:00:00Z');
  for (const [k, year] of [[0, 3000], [1, 3001], [2, 3002], [5, 3005]]) {
    const e = (await q('insert into edition(year, enrol_close) values ($1,$2) returning *', [year, close])).rows[0];
    for (let i = 0; i < k; i++) {
      const r = await upsertReader(e, { name: `R${i}`, email: `r${i}-${year}@t.test`, zone: 'Europe/London' });
      await q('insert into enrolment(edition_id, reader_id) values ($1,$2)', [e.id, r.id]);
    }
    assert.equal((await runDraw(e.id, new Date('2026-12-08T08:59:00Z'))).status, 'open');
    const [a, b] = await Promise.all([runDraw(e.id, close), runDraw(e.id, close)]);
    if (k < 2) { assert.equal(a.status, 'deferred'); continue; }
    assert.deepEqual([a.status, b.status].sort(), ['already', 'drawn']);
    const rows = (await q('select * from assignment where edition_id=$1', [e.id])).rows;
    assert.equal(rows.length, k);
    assert.ok(rows.every(r => r.giver_id !== r.recipient_id));
    assert.equal(new Set(rows.map(r => r.recipient_id)).size, k);
    // single ring: following giver→recipient visits everyone
    const next = new Map(rows.map(r => [r.giver_id, r.recipient_id]));
    let cur = rows[0].giver_id, seen = 0;
    do { cur = next.get(cur); seen++; } while (cur !== rows[0].giver_id && seen <= k);
    assert.equal(seen, k);
  }
});

test('pouch end to end: gift day, late gift, privacy, skipper keeps calendar', async () => {
  const enrolAt = '2026-12-03T12:00:00Z';
  for (const p of [P.ada, P.cal, P.ed]) await post(p, '/pouch/join', {}, enrolAt);
  await post(P.ed, '/editor/pouch/draw', {}, '2026-12-08T09:00:00Z');
  const again = await post(P.ed, '/editor/pouch/draw', {}, '2026-12-08T09:01:00Z');
  assert.match(again.headers.get('location'), /already/);
  const as = Object.fromEntries((await q('select giver_id, recipient_id from assignment where edition_id=$1', [ed.id])).rows.map(r => [r.giver_id, r.recipient_id]));
  const byId = Object.fromEntries(Object.values(P).map(p => [p.id, p]));
  // Ada seals early, recipient's giver seals late.
  const adaTo = byId[as[P.ada.id]];
  await post(P.ada, '/pouch/parcel', { body: 'A song for the drive home.', url: 'https://example.com/song' }, '2026-12-10T10:00:00Z');
  await post(P.ada, '/pouch/seal', {}, '2026-12-10T10:01:00Z');
  const sealedPage = (await req('/pouch', { who: P.ada, at: '2026-12-10T10:02:00Z' })).text;
  assert.match(sealedPage, /Wax applied[\s\S]*18 December/);
  const p = (await q('select id from parcel where body like $1', ['A song%'])).rows[0];
  const gift = new Date(require('../src/time').releaseInstant(18, adaTo.zone));
  const justBefore = new Date(gift.getTime() - 60000).toISOString();
  assert.doesNotMatch((await req('/pigeonhole/17', { who: adaTo, at: justBefore })).text, /drive home/);
  assert.equal((await req(`/parcel/${p.id}`, { who: adaTo, at: justBefore })).status, 404);
  assert.match((await req('/pigeonhole/18', { who: adaTo, at: gift.toISOString() })).text, /drive home[\s\S]*example\.com/);
  assert.equal((await req(`/parcel/${p.id}`, { who: P.bea, at: '2026-12-20T12:00:00Z' })).status, 404, 'others denied');
  // Late gift after the 18th appears immediately.
  const late = byId[Object.keys(as).find(g => Number(g) !== P.ada.id)];
  const lateTo = byId[as[late.id]];
  await post(late, '/pouch/parcel', { body: 'Late but heartfelt.' }, '2026-12-20T12:00:00Z');
  await post(late, '/pouch/seal', {}, '2026-12-20T12:00:00Z');
  assert.match((await req('/pigeonhole/18', { who: lateTo, at: '2026-12-20T12:05:00Z' })).text, /Late but heartfelt/);
  // Bea skipped: calendar intact, polite pouch page.
  assert.equal((await req('/pigeonhole/18', { who: P.bea, at: '2026-12-20T12:00:00Z' })).status, 200);
  assert.match((await req('/pouch', { who: P.bea, at: '2026-12-20T12:00:00Z' })).text, /not in the draw/);
  // Giver sees their recipient, gift ideas and the zero budget; no wish list.
  const mine = (await req('/pouch', { who: late, at: '2026-12-09T12:00:00Z' })).text;
  assert.match(mine, /spending limit is zero/);
  assert.match(mine, /Need an idea\?/);
  assert.doesNotMatch(mine, /wish slip/i);
});

test('withdrawal after draw flags a reserve without redrawing', async () => {
  const at = '2026-12-17T12:00:00Z';
  const before = (await q('select count(*)::int n from assignment where edition_id=$1', [ed.id])).rows[0].n;
  const giver = (await q('select a.giver_id from assignment a join parcel p on p.assignment_id=a.id where a.edition_id=$1 and p.sealed_at is null', [ed.id])).rows[0];
  if (giver) {
    const who = Object.values(P).find(p => p.id === giver.giver_id);
    await post(who, '/pouch/withdraw', {}, at);
  }
  assert.equal((await q('select count(*)::int n from assignment where edition_id=$1', [ed.id])).rows[0].n, before);
  const desk = (await req('/editor/pouch', { who: P.ed, at })).text;
  assert.match(desk, /Need a reserve parcel \(\d+\)/);
});

test('editor overwrite rule for edited doors', async () => {
  await post(P.ed, '/editor/doors/9', { shared_title: 'Edited headline', shared_body: 'b', private_title: 'p', private_body: 'q' });
  const { doors } = await seed();
  assert.equal(doors.keptEdited, 1);
  assert.equal((await q('select shared_title from door where edition_id=$1 and day=9', [ed.id])).rows[0].shared_title, 'Edited headline');
  await seed({ overwrite: true });
  assert.notEqual((await q('select shared_title from door where edition_id=$1 and day=9', [ed.id])).rows[0].shared_title, 'Edited headline');
});

test('January archive, then closed in February; restart keeps sessions', async () => {
  const app2 = createApp().listen(0);
  const b2 = `http://localhost:${app2.address().port}`;
  const r = await fetch(`${b2}/door/12`, { headers: { cookie: `${A.COOKIE}=${P.ada.cookie}`, 'x-test-now': '2027-01-15T12:00:00Z' } });
  assert.equal(r.status, 200);
  const front = await (await fetch(`${b2}/`, { headers: { cookie: `${A.COOKIE}=${P.ada.cookie}`, 'x-test-now': '2027-01-15T12:00:00Z' } })).text();
  assert.match(front, /complete edition/i);
  const closed = await fetch(`${b2}/`, { headers: { cookie: `${A.COOKIE}=${P.ada.cookie}`, 'x-test-now': '2027-02-02T12:00:00Z' } });
  assert.equal(closed.status, 410);
  app2.close();
});

test('browser origin accepted, foreign origin rejected', async () => {
  const r = await upsertReader(ed, { name: 'Eve', email: 'eve@t.test', zone: 'Europe/London' });
  const post = (origin, token) => fetch(base + '/welcome', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + token });
  assert.equal((await post('https://evil.example', tokenOf(await A.issueInvite(r.id)))).status, 403);
  assert.equal((await post('http://localhost', tokenOf(await A.issueInvite(r.id)))).status, 303);
});

test('editor preview mode opens doors for the editor only', async () => {
  const at = '2026-11-26T14:00:00Z';
  assert.equal((await req('/door/24', { who: P.ed, at })).status, 404);
  const on = await post(P.ed, '/editor/preview-mode', { day: '24' }, at);
  const pv = on.headers.get('set-cookie').match(/dc_preview=([^;]+)/)[1];
  const withPv = who => ({ ...who, cookie: `${who.cookie}; dc_preview=${pv}` });
  const r = await req('/door/24', { who: withPv(P.ed), at });
  assert.equal(r.status, 200);
  assert.match(r.text, /Tin recovered/);
  assert.match(r.text, /Preview mode/);
  assert.equal((await req('/door/24', { who: withPv(P.ada), at })).status, 404, 'readers cannot use the preview cookie');
});

test('letters with [placeholders] are refused', async () => {
  const bad = await post(P.ed, '/editor/letters', { recipient: String(P.ada.id), day: '3', body: 'Thank you for [thing].', byline: 'Si' });
  assert.equal(bad.status, 400);
  const good = await post(P.ed, '/editor/letters', { recipient: String(P.ada.id), day: '3', body: 'Thank you for the Leeds survey.', byline: 'Si' });
  assert.equal(good.status, 303);
  assert.match((await req('/editor/letters', { who: P.ed })).text, /Start from an idea[\s\S]*Overnight elves/);
});

test('the case unfolds day by day and never leaks ahead', async () => {
  const day3 = '2026-12-03T12:00:00Z';
  const board = (await req('/case', { who: P.ada, at: day3 })).text;
  assert.match(board, /The Case of the Communal Tin/);
  assert.match(board, /paid in carrots/);           // day 3 clue
  assert.doesNotMatch(board, /turkey|shortbread finger|Lift the laptop|It was me|tartan stand/);
  assert.match(board, /Santa[\s\S]*Prime suspect/);
  const door = (await req('/door/3', { who: P.ada, at: day3 })).text;
  assert.match(door, /id="enquiry"[\s\S]*The reindeer is questioned/);
  assert.match((await req('/', { who: P.ada, at: day3 })).text, /Also in today’s paper/);
  assert.match((await req('/case', { who: P.ada, at: '2026-11-29T12:00:00Z' })).text, /Nothing has gone missing/);
  const end = (await req('/case', { who: P.ada, at: '2026-12-24T12:00:00Z' })).text;
  assert.match(end, /Case closed[\s\S]*It was me/);
  assert.match(end, /Identified: the editor/);
  assert.equal((end.match(/class="exhibit/g) || []).length, 31);
});

test('personal pages are never cached', async () => {
  const r = await req('/pigeonhole', { who: P.ada });
  assert.match(r.headers.get('cache-control'), /no-store/);
});
