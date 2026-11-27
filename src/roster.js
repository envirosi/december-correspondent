// Reads a pasted team list: from a spreadsheet (tabs), a CSV (commas or semicolons) or typed lines.
// Headings are optional and loosely matched. Columns can be in any order.
const T = require('./time');
const { parseCsv } = require('./csv');

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const HEAD = {
  name: /^(display[\s_]*name|full[\s_]*name|name|reader|colleague|person|first[\s_]*name)$/i,
  email: /^((work[\s_]*)?e-?mail([\s_]*address)?|address)$/i,
  zone: /^(time[\s_-]*zone|timezone|zone|desk|office|location|region|country|city|tz)$/i,
  role: /^role$/i,
};

function splitter(text) {
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  if (first.includes('\t')) return '\t';
  if (!first.includes(',') && first.includes(';')) return ';';
  return ',';
}

function parseRoster(text) {
  text = String(text || '').replace(/^﻿/, '');
  const sep = splitter(text);
  // Reuse the CSV parser (handles quotes) by normalising the separator to commas.
  const normalised = sep === ',' ? text : text.split(/\r?\n/).map(line => line.split(sep).map(c => {
    c = c.trim(); return /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  }).join(',')).join('\n');
  const lines = normalised.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const raw = lines.map(l => (parseCsv('a,b,c,d,e,f,g,h\n' + l)[0]) || {}).map(o => ['a','b','c','d','e','f','g','h'].map(k => (o[k] || '').trim()));
  const header = raw[0];
  const looksLikeHeader = !header.some(c => c.includes('@')) && header.some(c => HEAD.name.test(c) || HEAD.email.test(c) || HEAD.zone.test(c));
  let map = null;
  if (looksLikeHeader) {
    map = {};
    header.forEach((c, i) => { for (const k of Object.keys(HEAD)) if (map[k] === undefined && HEAD[k].test(c)) map[k] = i; });
  }
  const body = looksLikeHeader ? raw.slice(1) : raw;
  return body.map((cells, idx) => {
    const row = looksLikeHeader ? idx + 2 : idx + 1;
    let name, email, zoneRaw, role;
    if (map && map.email !== undefined) {
      name = cells[map.name] || ''; email = cells[map.email] || ''; zoneRaw = cells[map.zone] || ''; role = map.role !== undefined ? cells[map.role] : '';
    } else {
      let filled = cells.filter(Boolean);
      // A typed line with no separators: "Jo Bloggs jo@x.uk UK"
      if (filled.length === 1 && filled[0].includes('@') && /\s/.test(filled[0])) {
        const words = filled[0].split(/\s+/);
        const e = words.find(w => w.includes('@'));
        const rest = words.filter(w => w !== e);
        const z = rest.length > 1 && T.zoneFrom(rest[rest.length - 1]) ? rest.pop() : '';
        filled = [rest.join(' '), e, z].filter(Boolean);
      }
      email = filled.find(c => c.includes('@')) || '';
      role = filled.find(c => /^(reader|editor)$/i.test(c)) || '';
      const others = filled.filter(c => c !== email && c !== role);
      name = others[0] || '';
      const after = others.slice(1);
      zoneRaw = [...after].reverse().find(c => T.zoneFrom(c)) || after[0] || '';
    }
    return { row, name: name.trim(), email: email.trim().toLowerCase(), zoneRaw: zoneRaw.trim(), zone: T.zoneFrom(zoneRaw), role: role ? role.trim().toLowerCase() : null };
  });
}

function check(rows) {
  const seen = new Set();
  return rows.map(r => {
    let err = null;
    if (!r.name) err = 'no name found';
    else if (!EMAIL_RE.test(r.email)) err = r.email ? 'that email doesn’t look right' : 'no email found';
    else if (!r.zone) err = r.zoneRaw ? `don’t recognise “${r.zoneRaw}”: use UK, Cebu or Sydney` : 'no time zone: add UK, Cebu or Sydney';
    else if (r.role && !['reader', 'editor'].includes(r.role)) err = 'role must be reader or editor';
    else if (seen.has(r.email)) err = 'this email appears twice';
    seen.add(r.email);
    return { ...r, err };
  });
}

module.exports = { parseRoster, check, EMAIL_RE };
