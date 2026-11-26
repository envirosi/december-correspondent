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

const hidden = csrf => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

function masthead(now) {
  const clocks = T.ZONES.map(z => `<span class="desk"><span class="desk-name">${z.label}</span> <time>${T.fmtTime(now, z.key)}</time></span>`).join('<span class="dot" aria-hidden="true">·</span>');
  return `<header class="masthead">
    <a class="title" href="/"><span class="the">The</span> December Correspondent</a>
    <p class="strap">ETN Christmas edition · December 2026</p>
    <p class="desks" aria-label="Local times at our three desks">${clocks}</p>
  </header>`;
}

function layout({ title, body, reader, now, csrf, banner }) {
  const nav = reader ? `<nav class="nav" aria-label="Main">
      <a href="/">Front page</a>
      <a href="/pigeonhole" class="pigeonhole-link"><span class="handle" aria-hidden="true"></span>My pigeonhole</a>
      <a href="/pouch">Diplomatic Pouch</a>
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
${masthead(now || new Date())}
${nav}
<main id="main" tabindex="-1">${body}</main>
<footer class="foot"><p>Printed with love and very little budget. The paper closes on 31 January and everything in it is deleted.</p>
${reader ? `<form method="post" action="/signout" class="inline">${hidden(csrf)}<button class="linkish">Sign out on this device</button></form>` : ''}</footer>
</body></html>`;
}

// 24-door grid. `hrefFor(day)` gives the link for an opened door.
function doorGrid({ released, today, titles = {}, hrefFor, label }) {
  const cells = [];
  for (let d = 1; d <= 24; d++) {
    if (d <= released) {
      cells.push(`<li><a class="door open${d === today ? ' today' : ''}" href="${hrefFor(d)}">
        <span class="num">${d}</span>${titles[d] ? `<span class="dt">${esc(titles[d])}</span>` : ''}
        <span class="visually-hidden">${d === today ? ' (today)' : ''}</span></a></li>`);
    } else {
      cells.push(`<li><span class="door sealed" aria-label="Door ${d}, opens ${esc(T.fmtDay(d))}"><span class="num">${d}</span></span></li>`);
    }
  }
  return `<ol class="grid" aria-label="${esc(label)}">${cells.join('')}</ol>`;
}

module.exports = { esc, paras, safeHttpsUrl, mediaLink, hidden, layout, doorGrid };
