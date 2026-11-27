// All release logic is evaluated on the server from the reader's zone.
const ZONES = [
  { key: 'Europe/London', label: 'UK' },
  { key: 'Asia/Manila', label: 'Cebu' },
  { key: 'Australia/Sydney', label: 'Sydney' },
];
const YEAR = 2026;
const RELEASE_HOUR = 7;
const ENROL_CLOSE = new Date('2026-12-08T09:00:00Z');
const GIFT_DAY = 18;
const CLOSE_AT = new Date(process.env.CLOSE_AT || '2027-02-01T00:00:00Z');

// Forgiving: accepts desk names, countries, cities, abbreviations and IANA names.
function zoneFrom(input) {
  const s = String(input || '').trim().toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const tokens = s.split(/[\s,;]+/);
  // Short codes (uk, au, ph, gmt…) must be whole words, so "Paula" never means Australia.
  const has = words => words.some(w => s === w || (w.length <= 4 || w.includes('+') ? tokens.includes(w) : s.includes(w)));
  if (has(['europe/london', 'uk', 'united kingdom', 'england', 'scotland', 'wales', 'britain', 'london', 'gb', 'gmt', 'bst'])) return 'Europe/London';
  if (has(['asia/manila', 'cebu', 'manila', 'philippines', 'ph', 'pht', 'utc+8', 'gmt+8'])) return 'Asia/Manila';
  if (has(['australia/sydney', 'sydney', 'australia', 'au', 'nsw', 'aedt', 'aest', 'utc+11', 'gmt+11', 'utc+10', 'gmt+10'])) return 'Australia/Sydney';
  return null;
}
const zoneLabel = z => (ZONES.find(x => x.key === z) || {}).label || z;

function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

// The door number a reader in `tz` may open at `now`. 0 = welcome edition.
function releasedDay(now, tz) {
  const p = parts(now, tz);
  let d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  if (p.h < RELEASE_HOUR) d = new Date(d.getTime() - 86400000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  if (y < YEAR || (y === YEAR && m < 12)) return 0;
  if (y === YEAR && m === 12) return Math.min(day, 24);
  return 24;
}

// UTC instant when door `day` opens in `tz`.
function releaseInstant(day, tz) {
  const target = Date.UTC(YEAR, 11, day, RELEASE_HOUR, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    guess += target - asUtc;
  }
  return new Date(guess);
}

const fmt = (date, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(date);
const fmtTime = (date, tz) => fmt(date, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtFull = (date, tz) => fmt(date, tz, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDay = (day) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(YEAR, 11, day)));

function clockOverrideAllowed() {
  return process.env.ALLOW_CLOCK_OVERRIDE === '1' && process.env.NODE_ENV !== 'production';
}
function now(req) {
  if (clockOverrideAllowed()) {
    const h = req && req.get && req.get('x-test-now');
    if (h) return new Date(h);
    if (process.env.FAKE_NOW) return new Date(process.env.FAKE_NOW);
  }
  return new Date();
}

module.exports = {
  ZONES, YEAR, ENROL_CLOSE, GIFT_DAY, CLOSE_AT, zoneFrom, zoneLabel, parts,
  releasedDay, releaseInstant, fmtTime, fmtFull, fmtDay, now, clockOverrideAllowed,
};
