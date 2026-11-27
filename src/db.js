const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // keep DATE columns as 'YYYY-MM-DD' strings

const url = process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/dc?host=/tmp';
const ssl = /sslmode=require/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: url, ssl, max: 10 });

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function migrate() {
  await q('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await q('select 1 from schema_migrations where name=$1', [f]);
    if (done.rowCount) continue;
    await tx(async c => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('insert into schema_migrations(name) values ($1)', [f]);
    });
    console.log('migrated', f);
  }
}

module.exports = { pool, q, tx, migrate };
