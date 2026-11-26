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

async function upsertReader(edition, { name, email, zone, role = 'reader' }) {
  const r = await q(`insert into reader(edition_id, public_id, name, email, zone, role)
      values ($1,$2,$3,lower($4),$5,$6)
      on conflict (edition_id, email) do update set name=excluded.name, zone=excluded.zone, role=excluded.role, active=true
      returning *`, [edition.id, crypto.randomBytes(9).toString('base64url'), name, email, zone, role]);
  return r.rows[0];
}

async function seed({ overwrite = false } = {}) {
  const edition = await ensureEdition();
  const doors = await seedDoors(edition, { overwrite });
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
  return { edition, doors };
}

module.exports = { seed, ensureEdition, seedDoors, upsertReader };
