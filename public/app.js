import {
  cellKey, dateOf, parseHours, formatHours, rowTotal, dayCells, setCell, fillRest, splitDay,
  copyPrevious, applyRules, ensureIssue, summarize, mergeDays, resetDraft
} from './logic.js';

const app = document.getElementById('app');
const drawer = document.getElementById('drawer');
const dialog = document.getElementById('dialog');

const state = {
  status: null,
  config: { positions: {}, snippets: {} },
  sheets: [],
  draft: null,
  assigned: null,
  findResults: null
};

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = m => formatHours(m) || '0';
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const weekday = (month, day) => new Date(`${dateOf(month, day)}T12:00:00`).getDay();

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

const position = () => {
  const name = state.draft.sheet;
  state.config.positions[name] ||= { pinned: [], rules: [] };
  return state.config.positions[name];
};

let saveTimer;
const writeDraft = draft => api(`/api/draft?id=${encodeURIComponent(draft.id)}`, { method: 'PUT', body: JSON.stringify(draft), keepalive: true });
function saveDraft() {
  clearTimeout(saveTimer);
  const draft = state.draft;
  saveTimer = setTimeout(() => writeDraft(draft).catch(e => toast(`Saving draft failed: ${e.message}`)), 300);
}
/** Saves immediately; used after each posted worklog so a closed tab can never cause duplicate posts. */
async function saveDraftNow() {
  clearTimeout(saveTimer);
  await writeDraft(state.draft);
}
window.addEventListener('pagehide', () => { if (state.draft) { clearTimeout(saveTimer); writeDraft(state.draft).catch(() => {}); } });
const saveConfig = () => api('/api/config', { method: 'PUT', body: JSON.stringify(state.config) })
  .catch(e => toast(`Saving settings failed: ${e.message}`));

function changed() { saveDraft(); render(); }

// ---------- load screen ----------
function renderLoad() {
  document.getElementById('context').textContent = '';
  app.innerHTML = `
    <div class="panel">
      <h2>1. Load your JaTT export</h2>
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".xlsx" hidden>
        Drop the monthly JaTT <b>.xlsx</b> export here, or click to choose it.
      </label>
      <div class="sheets">${state.sheets.map((s, idx) => `
        <div class="sheet">
          <div style="flex:1"><b>${esc(s.name)}</b><br>
            <span class="muted">${esc(s.customer)} ${s.contractNumber ? '· ' + esc(s.contractNumber) : ''}</span></div>
          <span>${s.days.length} days · ${h(s.totalMinutes)} h</span>
          <input type="month" value="${esc(s.month || '')}" data-month="${idx}" title="Month of this sheet">
          <button class="primary" data-open="${idx}">Open</button>
        </div>`).join('')}
      </div>
    </div>`;
  const input = document.getElementById('file');
  const drop = document.getElementById('drop');
  input.onchange = () => input.files[0] && loadFile(input.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]); };
  app.querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => {
    const idx = Number(btn.dataset.open);
    const month = app.querySelector(`[data-month="${idx}"]`).value;
    if (!month) return toast('Please set the month of this sheet first.');
    openSheet(state.sheets[idx], month);
  });
}

async function loadFile(file) {
  try {
    state.sheets = await api('/api/timesheet', { method: 'POST', body: await file.arrayBuffer() });
    if (state.sheets.length === 0) toast('No day table found in this file.');
    render();
  } catch (e) { toast(`Could not read the file: ${e.message}`); }
}

async function openSheet(sheet, month) {
  const id = `${month}__${sheet.name}`;
  const saved = await api(`/api/draft?id=${encodeURIComponent(id)}`);
  if (saved) {
    state.draft = mergeDays(saved, sheet.days);
  } else {
    state.draft = { id, month, sheet: sheet.name, days: [], issues: [], cells: {} };
    state.draft = mergeDays(state.draft, sheet.days);
    position().pinned.forEach(i => ensureIssue(state.draft, i));
    const filled = applyRules(state.draft, position().rules);
    if (filled) toast(`Rules pre-filled ${filled} day(s).`);
  }
  saveDraft();
  render();
  loadAssigned();
}

async function loadAssigned() {
  try { state.assigned = await api('/api/issues/assigned'); } catch (e) { state.assigned = []; toast(e.message); }
  if (state.draft) renderIssues();
}

// ---------- grid screen ----------
function renderGrid() {
  const d = state.draft;
  const sum = summarize(d);
  document.getElementById('context').textContent = `${d.sheet} · ${d.month}`;
  app.innerHTML = `
    <div class="panel" id="issues"></div>
    <div class="panel row">
      <button id="back">← Other file</button>
      <button id="rules">Mapping rules (${position().rules.length})</button>
      <button id="applyRules">Apply rules to empty days</button>
      <button id="reset" title="Start this month over: removes all unposted hours, texts and issue columns">Reset grid</button>
      <span class="row">Fill empty days with
        <select id="fillWith"><option value="">issue…</option>${d.issues.map(i => `<option>${esc(i.key)}</option>`).join('')}</select>
      </span>
      <span class="spacer"></span>
      <span>${h(sum.bookedTotal)} / ${h(sum.jattTotal)} h booked
        ${sum.mismatches.length ? `<span class="badge warn">${sum.mismatches.length} day(s) off</span>` : '<span class="badge">all days match</span>'}</span>
      <button class="primary" id="review">Review &amp; post (${sum.toPost.length})</button>
    </div>
    <div class="gridwrap">${gridTable(d)}</div>`;

  renderIssues();
  document.getElementById('back').onclick = () => { state.draft = null; render(); };
  document.getElementById('rules').onclick = openRules;
  document.getElementById('review').onclick = openReview;
  document.getElementById('applyRules').onclick = () => {
    const n = applyRules(d, position().rules);
    toast(n ? `Filled ${n} day(s) from rules.` : 'No empty day matched a rule.');
    changed();
  };
  document.getElementById('reset').onclick = () => {
    const posted = Object.values(d.cells).filter(c => c.worklogId).length;
    const message = 'Reset this month? All unposted hours, texts and issue columns are removed; '
      + 'pinned issues and mapping rules are applied again.'
      + (posted ? `\n\n${posted} worklog(s) already posted to Jira are kept.` : '');
    if (!confirm(message)) return;
    const result = resetDraft(d, position());
    state.draft = result.draft;
    drawer.hidden = true;
    toast(`Grid reset${result.filled ? `, rules pre-filled ${result.filled} day(s)` : ''}.`);
    changed();
  };
  document.getElementById('fillWith').onchange = e => {
    const key = e.target.value;
    if (!key) return;
    d.days.filter(x => rowTotal(d, x.day) === 0).forEach(x => fillRest(d, x.day, key));
    changed();
  };

  app.querySelectorAll('.cell input').forEach(input => {
    const { day, key } = input.dataset;
    input.onchange = () => {
      const minutes = parseHours(input.value);
      if (minutes === null) { toast('Use hours like 1.5, 1:30 or 1h 30m'); input.value = ''; return; }
      setCell(d, Number(day), key, minutes);
      changed();
    };
    input.onkeydown = e => {
      if (e.key === 'Enter' && !input.value.trim()) { e.preventDefault(); fillRest(d, Number(day), key); changed(); }
    };
  });
  app.querySelectorAll('[data-rest]').forEach(b => b.onclick = () => {
    const [day, key] = b.dataset.rest.split('|');
    fillRest(d, Number(day), key); changed();
  });
  app.querySelectorAll('[data-note]').forEach(b => b.onclick = () => {
    const [day, key] = b.dataset.note.split('|');
    openCell(Number(day), key);
  });
  app.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    if (!copyPrevious(d, Number(b.dataset.copy))) toast('No earlier day with hours.');
    changed();
  });
  app.querySelectorAll('[data-split]').forEach(b => b.onclick = () => {
    const day = Number(b.dataset.split);
    const keys = dayCells(d, day).map(c => c.key);
    if (keys.length < 2) return toast('Put some hours on two or more issues first, then split.');
    splitDay(d, day, keys); changed();
  });
  app.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => {
    const day = Number(b.dataset.clear);
    d.issues.forEach(i => setCell(d, day, i.key, 0)); changed();
  });
}

function gridTable(d) {
  const head = d.issues.map(i => `<th class="issue">${esc(i.key)}<span class="sum" title="${esc(i.summary)}">${esc(i.summary)}</span></th>`).join('');
  const rows = d.days.map(day => {
    const wd = weekday(d.month, day.day);
    const total = rowTotal(d, day.day);
    const cls = [total === day.minutes ? 'ok' : 'bad', wd === 1 ? 'weekstart' : ''].join(' ');
    const cells = d.issues.map(i => {
      const k = cellKey(day.day, i.key);
      const c = d.cells[k];
      const posted = Boolean(c?.worklogId);
      const filled = c?.minutes > 0;
      const custom = filled && c.comment && c.comment !== day.description;
      const inputCls = posted ? 'posted' : c?.error ? 'error' : filled ? 'filled' : '';
      return `<td><div class="cell">
        <input data-day="${day.day}" data-key="${esc(i.key)}" value="${formatHours(c?.minutes)}" class="${inputCls}"
          ${posted ? 'disabled title="Already posted to Jira"' : c?.error ? `title="${esc(c.error)}"` : ''}>
        ${filled ? `<button class="note ${custom ? 'has' : 'default'}" data-note="${k}" title="${esc(c.comment || 'no text')}">✎</button>`
                 : `<button class="rest" data-rest="${k}" title="Book the rest of the day here (or press Enter in an empty cell)">⇥</button>`}
      </div></td>`;
    }).join('');
    return `<tr class="${cls}">
      <td class="num">${WEEKDAYS[wd]} ${day.day}.</td>
      <td class="num">${h(day.minutes)}</td>
      <td class="desc">${esc(day.description)}</td>
      ${cells}
      <td class="num total">${h(total)}</td>
      <td class="actions">
        <button class="small" data-copy="${day.day}" title="Same split as the previous day">↑ copy</button>
        <button class="small" data-split="${day.day}" title="Split evenly across the issues that have hours">÷</button>
        <button class="small" data-clear="${day.day}" title="Clear unposted hours">×</button>
      </td>
    </tr>`;
  }).join('');
  return `<table class="grid">
    <thead><tr><th>Day</th><th>JaTT h</th><th>JaTT description</th>${head}<th>Booked</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderIssues() {
  const el = document.getElementById('issues');
  if (!el) return;
  const d = state.draft;
  const pinned = new Set(position().pinned.map(p => p.key));
  const inGrid = new Set(d.issues.map(i => i.key));
  const resultRow = i => `<div class="result"><b>${esc(i.key)}</b><span class="sum">${esc(i.summary)}</span>
      <span class="muted">${esc(i.status)}</span>
      ${inGrid.has(i.key) ? '<span class="muted">added</span>' : `<button class="small" data-add="${esc(i.key)}">+ add</button>`}</div>`;
  el.innerHTML = `
    <h2>2. Issues for this month</h2>
    <div class="chips">${d.issues.map(i => `<span class="chip" title="${esc(i.summary)}"><b>${esc(i.key)}</b>
        <span class="muted">${esc(i.summary.slice(0, 40))}</span>
        <button class="icon ${pinned.has(i.key) ? 'on' : ''}" data-pin="${esc(i.key)}" title="Pin: add automatically every month">★</button>
        <button class="icon" data-remove="${esc(i.key)}" title="Remove column">×</button></span>`).join('') || '<span class="muted">No issues yet. Add some below.</span>'}
    </div>
    <div class="row" style="margin-top:10px">
      <input id="find" placeholder="Add by key (ABC-123) or search text…" style="flex:1;min-width:240px">
      <button id="findBtn">Find</button>
      <button id="showAssigned">${state.showAssigned ? 'Hide' : 'Show'} assigned to me ${state.assigned ? `(${state.assigned.length})` : '…'}</button>
    </div>
    ${state.findResults ? `<div class="results">${state.findResults.map(resultRow).join('') || '<span class="muted">Nothing found.</span>'}</div>` : ''}
    ${state.showAssigned && state.assigned ? `<div class="results">${state.assigned.map(resultRow).join('')}</div>` : ''}`;

  const findInput = document.getElementById('find');
  findInput.value = state.findQuery || '';
  findInput.oninput = () => { state.findQuery = findInput.value; };
  const find = async () => {
    const q = findInput.value.trim();
    if (!q) { state.findResults = null; return renderIssues(); }
    try { state.findResults = await api(`/api/issues/find?q=${encodeURIComponent(q)}`); }
    catch (e) { toast(e.message); state.findResults = []; }
    renderIssues();
    document.getElementById('find').focus();
  };
  document.getElementById('findBtn').onclick = find;
  // Not `e.key === 'Enter' && find()`: returning false from onkeydown cancels every other keystroke.
  findInput.onkeydown = e => { if (e.key === 'Enter') find(); };
  document.getElementById('showAssigned').onclick = () => { state.showAssigned = !state.showAssigned; renderIssues(); };
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const issue = [...(state.findResults || []), ...(state.assigned || [])].find(i => i.key === b.dataset.add);
    ensureIssue(d, issue);
    changed();
  });
  el.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => {
    const pos = position();
    const key = b.dataset.pin;
    pos.pinned = pinned.has(key) ? pos.pinned.filter(p => p.key !== key) : [...pos.pinned, d.issues.find(i => i.key === key)];
    saveConfig(); renderIssues();
  });
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
    const key = b.dataset.remove;
    const used = d.days.some(day => d.cells[cellKey(day.day, key)]?.minutes > 0);
    if (used && !confirm(`${key} has hours booked. Remove the column and its hours?`)) return;
    if (d.days.some(day => d.cells[cellKey(day.day, key)]?.worklogId)) return toast('This issue has posted worklogs and cannot be removed.');
    d.issues = d.issues.filter(i => i.key !== key);
    Object.keys(d.cells).filter(k => k.endsWith(`|${key}`)).forEach(k => delete d.cells[k]);
    changed();
  });
}

// ---------- cell editor ----------
function openCell(day, key) {
  const d = state.draft;
  const dayInfo = d.days.find(x => x.day === day);
  const issue = d.issues.find(i => i.key === key);
  const c = d.cells[cellKey(day, key)];
  const posted = Boolean(c?.worklogId);
  const snippets = state.config.snippets[key] || [];
  const firstWord = (c?.comment || dayInfo.description).split(/[,;]/)[0].trim().slice(0, 40);
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="row"><h3>${esc(key)} · ${WEEKDAYS[weekday(d.month, day)]} ${day}.${d.month.slice(5)}.</h3><span class="spacer"></span><button id="close">Close</button></div>
    <div class="muted">${esc(issue?.summary)}</div>
    ${posted ? `<p class="badge">Posted to Jira (worklog ${esc(c.worklogId)})</p>` : ''}
    ${c?.error ? `<p style="color:var(--err)">Last post failed: ${esc(c.error)}</p>` : ''}
    <label>JaTT description (${h(dayInfo.minutes)} h)</label>
    <div class="jatt">${esc(dayInfo.description) || '<span class="muted">empty</span>'}</div>
    <label for="hours">Hours</label>
    <input id="hours" value="${formatHours(c?.minutes)}" ${posted ? 'disabled' : ''} style="width:90px">
    <label for="comment">Worklog text for Jira</label>
    <textarea id="comment" ${posted ? 'disabled' : ''}>${esc(c?.comment)}</textarea>
    <div class="row" style="margin-top:6px">
      <button id="save" class="primary" ${posted ? 'disabled' : ''}>Save</button>
      <button id="addSnippet">Save text as snippet</button>
    </div>
    <label>Snippets for ${esc(key)}</label>
    ${snippets.map((s, idx) => `<div class="snippet"><span>${esc(s)}</span>
        <button class="small" data-insert="${idx}" ${posted ? 'disabled' : ''}>insert</button>
        <button class="small" data-delsnip="${idx}">×</button></div>`).join('') || '<div class="muted">None yet.</div>'}
    <label>Remember for next time</label>
    <div class="row">
      <span>Text contains</span><input id="rulePattern" value="${esc(firstWord)}" style="flex:1">
      <span>→ ${esc(key)}</span><button id="addRule">Add rule</button>
    </div>
    <div class="muted" style="font-size:12px;margin-top:4px">Use | for alternatives, e.g. <code>daily|standup|planning</code>.</div>`;

  const close = () => { drawer.hidden = true; };
  document.getElementById('close').onclick = close;
  const textarea = document.getElementById('comment');
  textarea.focus();
  document.getElementById('save').onclick = () => {
    const minutes = parseHours(document.getElementById('hours').value);
    if (minutes === null) return toast('Use hours like 1.5, 1:30 or 1h 30m');
    setCell(d, day, key, minutes);
    const cell = d.cells[cellKey(day, key)];
    if (cell) { cell.comment = textarea.value.trim(); delete cell.error; }
    close(); changed();
  };
  document.getElementById('addSnippet').onclick = () => {
    const text = textarea.value.trim();
    if (!text) return;
    state.config.snippets[key] = [...snippets.filter(s => s !== text), text];
    saveConfig(); openCell(day, key);
  };
  drawer.querySelectorAll('[data-insert]').forEach(b => b.onclick = () => {
    const s = snippets[Number(b.dataset.insert)];
    textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n${s}` : s;
  });
  drawer.querySelectorAll('[data-delsnip]').forEach(b => b.onclick = () => {
    state.config.snippets[key] = snippets.filter((_, i) => i !== Number(b.dataset.delsnip));
    saveConfig(); openCell(day, key);
  });
  document.getElementById('addRule').onclick = () => {
    const pattern = document.getElementById('rulePattern').value.trim();
    if (!pattern) return;
    position().rules.push({ pattern, issue: key, summary: issue?.summary || '' });
    saveConfig(); toast(`Rule added: “${pattern}” → ${key}`); render();
  };
}

// ---------- rules dialog ----------
function openRules() {
  const pos = position();
  dialog.innerHTML = `
    <h3 style="margin-top:0">Mapping rules for ${esc(state.draft.sheet)}</h3>
    <p class="muted">Each part of a day's JaTT description (parts are separated by commas) goes to the first rule it matches.
      Days matching several issues are split evenly. Rules only fill days that have no hours yet.</p>
    <table><thead><tr><th>Text contains</th><th>Issue</th><th></th></tr></thead><tbody>
      ${pos.rules.map((r, idx) => `<tr><td><input data-pattern="${idx}" value="${esc(r.pattern)}" style="width:100%"></td>
        <td>${esc(r.issue)}</td>
        <td><button class="small" data-up="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="small" data-del="${idx}">×</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No rules yet. Add them from a cell (✎).</td></tr>'}
    </tbody></table>
    <div class="row"><span class="spacer"></span><button id="closeRules" class="primary">Done</button></div>`;
  dialog.showModal();
  dialog.querySelectorAll('[data-pattern]').forEach(inp => inp.onchange = () => { pos.rules[Number(inp.dataset.pattern)].pattern = inp.value.trim(); saveConfig(); });
  dialog.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { pos.rules.splice(Number(b.dataset.del), 1); saveConfig(); openRules(); });
  dialog.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.up);
    [pos.rules[i - 1], pos.rules[i]] = [pos.rules[i], pos.rules[i - 1]];
    saveConfig(); openRules();
  });
  document.getElementById('closeRules').onclick = () => { dialog.close(); render(); };
}

// ---------- review & post ----------
function openReview() {
  const d = state.draft;
  const sum = summarize(d);
  const summaries = new Map(d.issues.map(i => [i.key, i.summary]));
  const emptyText = sum.toPost.filter(p => !p.comment.trim()).length;
  dialog.innerHTML = `
    <h3 style="margin-top:0">Review ${esc(d.sheet)} · ${esc(d.month)}</h3>
    <table><thead><tr><th>Issue</th><th>Worklogs</th><th>Hours</th><th>Posted</th></tr></thead><tbody>
      ${sum.perIssue.map(e => `<tr><td><b>${esc(e.key)}</b> <span class="muted">${esc(summaries.get(e.key))}</span></td>
        <td>${e.count}</td><td>${h(e.minutes)}</td><td>${e.posted}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td></td><td><b>${h(sum.bookedTotal)}</b> of ${h(sum.jattTotal)} in JaTT</td><td></td></tr>
    </tbody></table>
    ${sum.mismatches.length ? `<p class="badge warn">Days that don't match JaTT: ${sum.mismatches.map(m => `${m.day}. (${h(m.booked)}/${h(m.jatt)} h)`).join(', ')}</p>` : '<p class="badge">Every day matches JaTT.</p>'}
    ${emptyText ? `<p class="badge warn">${emptyText} worklog(s) have no text.</p>` : ''}
    <p>${sum.toPost.length} worklog(s) will be created in Jira${state.status?.mock ? ' <b>(mock Jira — nothing leaves your machine)</b>' : ''}, each starting at ${esc(state.status?.startTime)} on its day.</p>
    <div class="log" id="log" hidden></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span>
      <button id="cancel">Close</button>
      <button id="post" class="primary" ${sum.toPost.length ? '' : 'disabled'}>Post ${sum.toPost.length} worklog(s)</button>
    </div>`;
  dialog.showModal();
  document.getElementById('cancel').onclick = () => { dialog.close(); render(); };
  document.getElementById('post').onclick = async e => {
    if (sum.mismatches.length && !confirm('Some days do not match the JaTT hours. Post anyway?')) return;
    e.target.disabled = true;
    const log = document.getElementById('log');
    log.hidden = false;
    let ok = 0, failed = 0;
    for (const item of sum.toPost) {
      const cell = d.cells[cellKey(item.day, item.key)];
      try {
        const { id } = await api('/api/worklog', { method: 'POST', body: JSON.stringify(item) });
        cell.worklogId = id;
        delete cell.error;
        ok++;
        log.insertAdjacentHTML('beforeend', `<div class="ok">✓ ${esc(item.date)} ${esc(item.key)} ${h(item.minutes)} h</div>`);
      } catch (err) {
        cell.error = err.message;
        failed++;
        log.insertAdjacentHTML('beforeend', `<div class="err">✗ ${esc(item.date)} ${esc(item.key)}: ${esc(err.message)}</div>`);
      }
      try { await saveDraftNow(); } catch (err) {
        log.insertAdjacentHTML('beforeend', `<div class="err">Could not save progress (${esc(err.message)}). Stopped to avoid duplicates.</div>`);
        break;
      }
      log.scrollTop = log.scrollHeight;
    }
    log.insertAdjacentHTML('beforeend', `<div><b>${ok} posted, ${failed} failed.</b>${failed ? ' Fix the red cells and post again; posted ones are skipped.' : ''}</div>`);
  };
}

// ---------- boot ----------
function render() {
  if (state.draft) renderGrid(); else renderLoad();
}

async function boot() {
  try {
    [state.status, state.config] = await Promise.all([api('/api/status'), api('/api/config')]);
    state.config.positions ||= {};
    state.config.snippets ||= {};
    document.getElementById('user').innerHTML = `${esc(state.status.user.displayName)} ${state.status.mock ? '<span class="badge warn">mock Jira</span>' : ''}`;
  } catch (e) {
    document.getElementById('user').textContent = `Jira not reachable: ${e.message}`;
  }
  render();
}
boot();
