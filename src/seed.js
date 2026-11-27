const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { q } = require('./db');
const { parseCsv } = require('./csv');
const T = require('./time');

async function ensureEdition() {
  await q('insert into edition(year, enrol_close) values ($1,$2) on conflict (year) do nothing', [T.YEAR, T.ENROL_CLOSE]);
  return (await q('select * from edition where year=$1', [T.YEAR])).rows[0];
}

// Idempotent. Doors an editor has changed are only replaced with overwrite=true.
async function seedDoors(edition, { overwrite = false } = {}) {
  const file = path.join(__dirname, '..', 'data', 'calendar.csv');
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  let inserted = 0, updated = 0, kept = 0;
  for (const r of rows) {
    const day = parseInt(r.day, 10);
    if (!(day >= 1 && day <= 24)) throw new Error(`calendar.csv row ${r._row}: bad day`);
    const vals = [edition.id, day, r.shared_title, r.shared_body, r.optional_prompt || null, r.private_title, r.private_body];
    const ins = await q(`insert into door(edition_id, day, shared_title, shared_body, optional_prompt, private_title, private_body)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict (edition_id, day) do nothing`, vals);
    if (ins.rowCount) { inserted++; continue; }
    const up = await q(`update door set shared_title=$3, shared_body=$4, optional_prompt=$5, private_title=$6, private_body=$7,
        edited_at = case when $8 then null else edited_at end
        where edition_id=$1 and day=$2 and (edited_at is null or $8)`, [...vals, overwrite]);
    up.rowCount ? updated++ : kept++;
  }
  return { inserted, updated, keptEdited: kept };
}

// The case is authored in data/*.csv and always replaced wholesale from there.
async function seedCase(edition) {
  const { tx } = require('./db');
  const read = f => parseCsv(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
  const entries = read('case.csv'), clues = read('clues.csv'), suspects = read('suspects.csv');
  const day = (r, f) => {
    const d = parseInt(r.day, 10);
    if (!(d >= 1 && d <= 24)) throw new Error(`${f} row ${r._row}: bad day`);
    return d;
  };
  await tx(async c => {
    await c.query('delete from case_entry where edition_id=$1', [edition.id]);
    await c.query('delete from case_clue where edition_id=$1', [edition.id]);
    await c.query('delete from case_suspect where edition_id=$1', [edition.id]);
    for (const r of entries) await c.query('insert into case_entry(edition_id, day, title, body, theory) values ($1,$2,$3,$4,$5)', [edition.id, day(r, 'case.csv'), r.title, r.body, r.theory || null]);
    let i = 0;
    for (const r of clues) await c.query('insert into case_clue(edition_id, day, seq, clue, note) values ($1,$2,$3,$4,$5)', [edition.id, day(r, 'clues.csv'), ++i, r.clue, r.note || null]);
    i = 0;
    for (const r of suspects) await c.query('insert into case_suspect(edition_id, day, seq, suspect, status, note) values ($1,$2,$3,$4,$5,$6)', [edition.id, day(r, 'suspects.csv'), ++i, r.suspect, r.status, r.note || null]);
  });
  return { entries: entries.length, clues: clues.length, suspects: suspects.length };
}

async function upsertReader(edition, { name, email, zone, role = null }) {
  // Role only changes when one is given, so re-importing the editor never demotes him.
  const r = await q(`insert into reader(edition_id, public_id, name, email, zone, role, email_token)
      values ($1,$2,$3,lower($4),$5,coalesce($6,'reader'),$7)
      on conflict (edition_id, email) do update set name=excluded.name, zone=excluded.zone, role=coalesce($6, reader.role), active=true
      returning *`, [edition.id, crypto.randomBytes(9).toString('base64url'), name, email, zone, role, crypto.randomBytes(24).toString('base64url')]);
  return r.rows[0];
}

async function seed({ overwrite = false } = {}) {
  const edition = await ensureEdition();
  const doors = await seedDoors(edition, { overwrite });
  const caseFile = await seedCase(edition);
  // Every reader needs an unguessable token for their unsubscribe link.
  for (const r of (await q('select id from reader where email_token is null')).rows) {
    await q('update reader set email_token=$2 where id=$1', [r.id, crypto.randomBytes(24).toString('base64url')]);
  }
  const nudges = await require('./nudges').seedNudges(edition);
  if (process.env.EDITOR_EMAIL) {
    const zone = T.zoneFrom(process.env.EDITOR_ZONE || 'UK');
    const editor = await upsertReader(edition, { name: process.env.EDITOR_NAME || 'Si', email: process.env.EDITOR_EMAIL, zone, role: 'editor' });
    // One-time bootstrap: lets the editor sign in for the first time without shell access.
    // Only the digest is stored; once redeemed the token is spent, so the variable can be cleared.
    const boot = process.env.EDITOR_BOOTSTRAP_TOKEN;
    if (boot && boot.length >= 32) {
      const { digest } = require('./auth');
      await q(`insert into invitation(reader_id, digest, expires_at) values ($1,$2, now() + interval '7 days') on conflict (digest) do nothing`,
        [editor.id, digest(boot)]);
    }
  }
  return { edition, doors, caseFile, nudges };
}

module.exports = { seed, ensureEdition, seedDoors, seedCase, upsertReader };
