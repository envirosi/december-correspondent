// Usage:
//   node src/cli.js invite <email>         print a fresh invitation link
//   node src/cli.js seed [--overwrite]     reload calendar.csv (edited doors kept unless --overwrite)
//   node src/cli.js rehearsal              add three fictional readers, an editor and a sample letter
//   node src/cli.js purge --yes            delete every reader, letter, parcel and contribution
const { q, pool, migrate } = require('./db');
const { seed, upsertReader } = require('./seed');
const A = require('./auth');

(async () => {
  await migrate();
  const [cmd, arg] = process.argv.slice(2);
  const { edition, doors } = await seed({ overwrite: process.argv.includes('--overwrite') });
  if (cmd === 'seed') console.log(doors);
  else if (cmd === 'invite') {
    const r = (await q('select * from reader where edition_id=$1 and email=lower($2)', [edition.id, arg || ''])).rows[0];
    if (!r) throw new Error('No reader with that email');
    console.log(`${r.name}: ${await A.issueInvite(r.id)}`);
  } else if (cmd === 'rehearsal') {
    const people = [
      { name: 'Ada Larch (UK)', email: 'ada@rehearsal.test', zone: 'Europe/London' },
      { name: 'Bea Molave (Cebu)', email: 'bea@rehearsal.test', zone: 'Asia/Manila' },
      { name: 'Cal Banksia (Sydney)', email: 'cal@rehearsal.test', zone: 'Australia/Sydney' },
      { name: 'Ed Itor', email: 'editor@rehearsal.test', zone: 'Europe/London', role: 'editor' },
    ];
    for (const p of people) {
      const r = await upsertReader(edition, p);
      console.log(`${r.name}: ${await A.issueInvite(r.id)}`);
    }
    const ada = (await q("select id from reader where email='ada@rehearsal.test'")).rows[0];
    const has = await q('select 1 from personal_item where recipient_id=$1', [ada.id]);
    if (!has.rowCount) await q(`insert into personal_item(edition_id, recipient_id, day, body, byline) values ($1,$2,1,$3,$4)`,
      [edition.id, ada.id, 'Thank you for the Tuesday you rescued the spreadsheet and pretended it was nothing.', 'Bea']);
  } else if (cmd === 'purge') {
    if (arg !== '--yes') throw new Error('Add --yes to confirm. This deletes all personal data.');
    await q('delete from reader where edition_id=$1', [edition.id]);
    await q('delete from parcel where edition_id=$1', [edition.id]);
    console.log('Purged readers, sessions, letters, contributions, enrolments, assignments and parcels.');
  } else {
    console.log('Commands: invite <email> | seed [--overwrite] | rehearsal | purge --yes');
  }
  await pool.end();
})().catch(async e => { console.error(e.message); await pool.end(); process.exit(1); });
