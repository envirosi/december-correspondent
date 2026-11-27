const T = require('./time');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const paras = s => String(s || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

function safeHttpsUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(String(u).trim());
    if (url.protocol !== 'https:' || u.length > 500 || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

// Always show the destination before someone opens a link.
function mediaLink(url, desc) {
  const safe = safeHttpsUrl(url);
  if (!safe) return '';
  const host = new URL(safe).hostname.replace(/^www\./, '');
  return `<p class="media">${desc ? `<span class="media-desc">${esc(desc)}</span> ` : ''}<a href="${esc(safe)}" rel="noopener noreferrer nofollow" target="_blank">Open link <span class="host">(${esc(host)})</span><span class="visually-hidden"> opens in a new tab</span></a></p>`;
}


// ---- Festive artwork (inline SVG, decorative) ----
// One string of lights works in every hemisphere; the garland mixes holly (UK),
// a parol star lantern (Cebu) and frangipani (Sydney summer).
const BULBS = ['#f6c453', '#e0566d', '#7cc58a', '#fff0c2', '#5fb3c9'];
function lights() {
  const n = 22, w = 1200, out = [];
  for (let i = 0; i < n; i++) {
    const x = 30 + i * ((w - 60) / (n - 1));
    const y = 10 + 9 * Math.sin((i / (n - 1)) * Math.PI * 4) ** 2;
    out.push(`<g class="bulb b${i % 5}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${i % 2 ? 8 : -8})"><rect x="-2.6" y="-1" width="5.2" height="4" rx="1" fill="#6b5a3a"/><ellipse cx="0" cy="9" rx="4.6" ry="7" fill="${BULBS[i % 5]}"/></g>`);
  }
  return `<svg class="lights" viewBox="0 0 ${w} 36" preserveAspectRatio="xMidYMin slice" aria-hidden="true" focusable="false"><path d="M0 8 Q 150 26 300 10 T 600 10 T 900 10 T 1200 8" fill="none" stroke="#2c4a38" stroke-width="1.6"/>${out.join('')}</svg>`;
}
const holly = x => `<g transform="translate(${x} 20)"><path d="M-14 0 q4 -7 7 -3 q3 -7 7 -2 q4 -5 6 2 q-3 3 0 6 q-6 3 -8 -1 q-3 5 -7 1 q-5 3 -5 -3z" fill="#2f6b45"/><path d="M14 0 q-4 -7 -7 -3 q-3 -7 -7 -2 q-4 -5 -6 2 q3 3 0 6 q6 3 8 -1 q3 5 7 1 q5 3 5 -3z" fill="#3c8256"/><circle cx="-2" cy="-1" r="3" fill="#c8243f"/><circle cx="3" cy="1" r="3" fill="#d83a52"/><circle cx="0" cy="-5" r="2.6" fill="#b51d37"/></g>`;
const star5 = (r, inner) => { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? inner : r; p.push(`${(rr * Math.cos(a)).toFixed(1)},${(rr * Math.sin(a)).toFixed(1)}`); } return p.join(' '); };
const parol = x => `<g transform="translate(${x} 17)"><polygon points="${star5(13, 5.5)}" fill="#f2b632" stroke="#b07a12" stroke-width="1"/><polygon points="${star5(6, 2.6)}" fill="#e0566d"/><path d="M-4 9 l-3 13 M4 9 l3 13" stroke="#e0566d" stroke-width="1.6" fill="none"/><circle cx="-7" cy="22" r="1.6" fill="#f2b632"/><circle cx="7" cy="22" r="1.6" fill="#f2b632"/></g>`;
const frangipani = x => { let p = ''; for (let i = 0; i < 5; i++) p += `<ellipse cx="0" cy="-7" rx="4.6" ry="8" fill="#fffaf0" stroke="#e9d6b0" stroke-width=".8" transform="rotate(${i * 72 + 12})"/>`; return `<g transform="translate(${x} 20)">${p}<circle r="3.6" fill="#f6c453"/></g>`; };
const bauble = (x, c) => `<g transform="translate(${x} 16)"><rect x="-2.5" y="-4" width="5" height="3" fill="#b9975b"/><circle cy="7" r="7.5" fill="${c}"/><path d="M-5 5 q5 -3 10 0" stroke="#fff" stroke-opacity=".5" stroke-width="1.2" fill="none"/></g>`;
function garland(cls = '') {
  return `<div class="garland ${cls}" aria-hidden="true"><svg viewBox="0 0 360 44" focusable="false">
    <path d="M6 18 Q 90 34 180 18 T 354 18" fill="none" stroke="#3c8256" stroke-width="2.2" stroke-dasharray="1 4" stroke-linecap="round"/>
    ${holly(26)}${bauble(68, '#e0566d')}${parol(112)}${bauble(146, '#5fb3c9')}${frangipani(180)}${bauble(214, '#f6c453')}${parol(248)}${bauble(292, '#7cc58a')}${holly(334)}
  </svg></div>`;
}
const smallStar = cls => `<svg class="${cls}" viewBox="-14 -14 28 28" aria-hidden="true" focusable="false"><polygon points="${star5(13, 5.5)}" fill="#f2b632"/></svg>`;

const hidden = csrf => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

function masthead(now, chain) {
  const clocks = T.ZONES.map(z => `<span class="desk"><span class="desk-name">${z.label}</span> <time>${T.fmtTime(now, z.key)}</time></span>`).join('<span class="dot" aria-hidden="true">·</span>');
  return `<header class="masthead">${lights()}
    <a class="title" href="/">${smallStar('tstar')}<span><span class="the">The</span> December Correspondent</span>${smallStar('tstar')}</a>
    <p class="strap">ETN Christmas edition · December 2026</p>
    <p class="desks" aria-label="Local times at our three desks">${clocks}</p>
    ${chain || ''}
  </header>`;
}

function layout({ title, body, reader, now, csrf, banner, chain }) {
  const nav = reader ? `<nav class="nav" aria-label="Main">
      <a href="/">Front page</a>
      <a href="/pigeonhole" class="pigeonhole-link"><span class="handle" aria-hidden="true"></span>My pigeonhole</a>
      <a href="/pouch">Diplomatic Pouch</a>
      <a href="/case">The Case</a>
      ${reader.role === 'editor' ? '<a href="/editor">Editor’s desk</a>' : ''}
    </nav>` : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title ? title + ' · ' : '')}The December Correspondent</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<a class="skip" href="#main">Skip to content</a>
${banner ? `<div class="banner" role="status">${banner}</div>` : ''}
${masthead(now || new Date(), chain)}
${nav}
${garland('top')}
<main id="main" tabindex="-1">${body}</main>
<footer class="foot">${garland()}<p class="small">Holly for the UK desk, a parol star for Cebu, frangipani for Sydney.</p>
<p>Printed with love and very little budget. The paper closes on 31 January and everything in it is deleted.${reader ? ' <a href="/how">How the paper works</a>' : ''}</p>
${reader ? `<form method="post" action="/signout" class="inline">${hidden(csrf)}<button class="linkish">Sign out on this device</button></form>` : ''}</footer>
</body></html>`;
}

// 24-door grid. `hrefFor(day)` gives the link for an opened door.
function doorGrid({ released, today, titles = {}, hrefFor, label }) {
  const cells = [];
  for (let d = 1; d <= 24; d++) {
    if (d <= released) {
      cells.push(`<li><a class="door open${d === today ? ' today' : ''}" href="${hrefFor(d)}">
        <span class="num">${d}</span>${smallStar('dstar')}${titles[d] ? `<span class="dt">${esc(titles[d])}</span>` : ''}
        <span class="visually-hidden">${d === today ? ' (today)' : ''}</span></a></li>`);
    } else {
      cells.push(`<li><span class="door sealed p${d % 4}" aria-label="Door ${d}, opens ${esc(T.fmtDay(d))}"><span class="bow" aria-hidden="true"></span><span class="num">${d}</span></span></li>`);
    }
  }
  return `<ol class="grid" aria-label="${esc(label)}">${cells.join('')}</ol>`;
}

module.exports = { esc, paras, safeHttpsUrl, mediaLink, hidden, layout, doorGrid, garland, smallStar };
