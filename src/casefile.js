// The Case of the Communal Tin: a daily enquiry dispatch on each door, plus an evidence board.
// Everything is gated by the reader's released day, exactly like the doors.
const { q } = require('./db');
const T = require('./time');
const { esc, paras } = require('./views');

async function entry(editionId, day) {
  return (await q('select * from case_entry where edition_id=$1 and day=$2', [editionId, day])).rows[0];
}

// Section shown on a front-page door.
async function enquirySection(editionId, day) {
  const e = await entry(editionId, day);
  if (!e) return '';
  const newClues = (await q('select count(*)::int n from case_clue where edition_id=$1 and day=$2', [editionId, day])).rows[0].n;
  return `<section class="enquiry" id="enquiry" aria-labelledby="enq-h">
    <p class="kicker">The Case of the Communal Tin · day ${day}</p>
    <h2 id="enq-h">${esc(e.title)}</h2>
    ${paras(e.body)}
    ${e.theory ? `<p class="theory"><span>The Senior Investigating Officer’s working theory:</span> ${esc(e.theory)}</p>` : ''}
    <p><a class="btn" href="/case">Evidence board${newClues ? ` · ${newClues} new` : ''}</a></p>
  </section>`;
}

async function headline(editionId, day) {
  const e = day ? await entry(editionId, day) : null;
  return e ? e.title : null;
}

function mount(app) {
  app.get('/case', async (req, res, next) => {
    try {
      const ed = req.edition, n = req.released;
      if (!n) {
        return res.page('The Case', `<section class="lead"><p class="kicker">The Case</p><h1>Nothing has gone missing</h1>
          <p class="standfirst">Yet. The newsroom is quiet, the biscuits are accounted for, and the editor is very much in control of the situation. Check back on 1 December.</p></section>`);
      }
      const [clues, sus, entries] = await Promise.all([
        q('select * from case_clue where edition_id=$1 and day <= $2 order by seq', [ed.id, n]),
        q('select * from case_suspect where edition_id=$1 and day <= $2 order by seq', [ed.id, n]),
        q('select day, title, theory from case_entry where edition_id=$1 and day <= $2 order by day', [ed.id, n]),
      ]);
      // Latest status per suspect, kept in order of first appearance.
      const order = [], latest = new Map();
      for (const s of sus.rows) {
        if (!latest.has(s.suspect)) order.push(s.suspect);
        latest.set(s.suspect, s);
      }
      const theoryRow = [...entries.rows].reverse().find(e => e.theory);
      const closed = n === 24;
      const stampClass = st => /cleared|released|cushion|thanked/i.test(st) ? 'cleared' : /eaten/i.test(st) ? 'gone' : /identified|prime/i.test(st) ? 'prime' : '';
      res.page('The Case', `<section class="lead">
          <p class="kicker">${closed ? 'Case closed' : `Ongoing enquiry · day ${n}`}</p>
          <h1>The Case of the Communal Tin</h1>
          <p class="standfirst">Every clue so far, as logged by the Senior Investigating Officer. Readers may notice things he hasn’t.</p>
        </section>
        ${theoryRow ? `<aside class="theory-box"><p class="kicker">Working theory, day ${theoryRow.day}</p><p class="theory-big">${esc(theoryRow.theory)}</p></aside>` : ''}
        <section aria-labelledby="sus-h"><h2 id="sus-h">Suspects</h2>
          <ul class="suspects">${order.map(name => {
            const s = latest.get(name);
            return `<li class="suspect"><h3>${esc(name)}</h3><p class="stamp ${stampClass(s.status)}">${esc(s.status)}</p>${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}</li>`;
          }).join('')}</ul></section>
        <section aria-labelledby="ev-h"><h2 id="ev-h">Evidence board</h2>
          <ol class="evidence">${clues.rows.map((c, i) => `<li class="exhibit${c.day === n && !closed ? ' fresh' : ''}">
              <p class="ex-no">Exhibit ${i + 1}<span class="small"> · logged on door ${c.day}${c.day === n && !closed ? ' · new today' : ''}</span></p>
              <p>${esc(c.clue)}</p>
              ${c.note ? `<p class="sio"><span class="visually-hidden">Investigating officer’s note: </span>${esc(c.note)}</p>` : ''}
            </li>`).join('')}</ol></section>
        <section aria-labelledby="dia-h"><h2 id="dia-h">Case diary</h2>
          <ol class="diary">${entries.rows.map(e => `<li><a href="/door/${e.day}#enquiry"><span class="num">${e.day}</span> ${esc(e.title)}</a></li>`).join('')}</ol>
          ${closed ? '' : `<p class="small">The next development is filed with tomorrow’s door, at 07:00 your time.</p>`}</section>`);
    } catch (e) { next(e); }
  });
}

module.exports = { mount, enquirySection, headline };
