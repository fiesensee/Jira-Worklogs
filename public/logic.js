// Pure month-grid logic, shared by the browser UI and the Node tests.
// A draft is { id, month, sheet, days: [{day, minutes, description}], issues: [{key, summary}],
//              cells: { 'day|KEY': { minutes, comment, worklogId?, error? } } }.

export const cellKey = (day, key) => `${day}|${key}`;

export const dateOf = (month, day) => `${month}-${String(day).padStart(2, '0')}`;

/** Parses `1.5`, `1,5`, `1:30`, `90m` or `1h 30m` into minutes; empty means 0, garbage means null. */
export function parseHours(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return 0;
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2])) return Math.round(parseFloat((m[1] || '0').replace(',', '.')) * 60) + Number(m[2] || 0);
  m = s.match(/^\d+(?:[.,]\d+)?$/);
  if (m) return Math.round(parseFloat(s.replace(',', '.')) * 60);
  return null;
}

/** Formats minutes as decimal hours (`1.5`, `0.75`); 0 becomes an empty string. */
export function formatHours(minutes) {
  if (!minutes) return '';
  return String(Math.round((minutes / 60) * 100) / 100);
}

/** Splits `total` minutes into `n` parts rounded to `step`; the last part takes the remainder. */
export function splitEvenly(total, n, step = 5) {
  if (n <= 0) return [];
  const part = Math.floor(total / n / step) * step;
  const parts = Array(n).fill(part);
  parts[n - 1] = total - part * (n - 1);
  return parts;
}

export const dayCells = (draft, day) =>
  draft.issues.map(i => ({ key: i.key, cell: draft.cells[cellKey(day, i.key)] })).filter(c => c.cell?.minutes > 0);

export const rowTotal = (draft, day) => dayCells(draft, day).reduce((s, c) => s + c.cell.minutes, 0);

/** Splits a JaTT description into its parts (JaTT joins merged blocks with `, `). */
export const descriptionParts = description =>
  String(description || '').split(/\s*[,;]\s+|\s*;\s*/).map(p => p.trim()).filter(Boolean);

/** A rule pattern is one or more `|`-separated words or phrases; a part matches if it contains any of them. */
export function ruleMatches(pattern, text) {
  const t = text.toLowerCase();
  return pattern.split('|').map(p => p.trim().toLowerCase()).filter(Boolean).some(p => t.includes(p));
}

/** Groups the parts of a description by the first rule that matches each part. */
export function matchRules(description, rules) {
  const groups = new Map();
  const unmatched = [];
  for (const part of descriptionParts(description)) {
    const rule = rules.find(r => ruleMatches(r.pattern, part));
    if (!rule) { unmatched.push(part); continue; }
    if (!groups.has(rule.issue)) groups.set(rule.issue, { issue: rule.issue, summary: rule.summary || '', parts: [] });
    groups.get(rule.issue).parts.push(part);
  }
  return { groups: [...groups.values()], unmatched };
}

/**
 * Fills days that have no hours yet, or only recurring bookings, from the rules; returns how many days were filled.
 * Only the time left after recurring bookings is split, and rules pointing at an issue that already has a
 * recurring booking that day are skipped (the recurring booking already covers that part).
 */
export function applyRules(draft, rules) {
  let filled = 0;
  for (const d of draft.days) {
    const cells = dayCells(draft, d.day);
    if (cells.some(c => !c.cell.recurring)) continue;
    const remaining = d.minutes - rowTotal(draft, d.day);
    if (remaining <= 0) continue;
    const recurringKeys = new Set(cells.map(c => c.key));
    const groups = matchRules(d.description, rules).groups.filter(g => !recurringKeys.has(g.issue));
    if (groups.length === 0) continue;
    const parts = splitEvenly(remaining, groups.length);
    groups.forEach((g, idx) => {
      ensureIssue(draft, { key: g.issue, summary: g.summary });
      draft.cells[cellKey(d.day, g.issue)] = { minutes: parts[idx], comment: g.parts.join(', ') };
    });
    filled++;
  }
  return filled;
}

/** Day of week (0 = Sunday … 6 = Saturday) of a day in a YYYY-MM month, independent of the time zone. */
export function weekdayOf(month, day) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

/**
 * Books each recurring entry ({ issue, summary, minutes, comment, weekdays }) on every matching weekday that
 * has JaTT hours. Cells that already have hours or are posted are left alone, and a booking never exceeds the
 * time still free that day. Returns how many cells were booked.
 */
export function applyRecurring(draft, recurring = []) {
  let booked = 0;
  for (const r of recurring) {
    if (!r.issue || !(r.minutes > 0)) continue;
    for (const d of draft.days) {
      if (!r.weekdays?.includes(weekdayOf(draft.month, d.day))) continue;
      const existing = draft.cells[cellKey(d.day, r.issue)];
      if (existing?.minutes > 0 || isPosted(existing)) continue;
      const minutes = Math.min(r.minutes, d.minutes - rowTotal(draft, d.day));
      if (minutes <= 0) continue;
      ensureIssue(draft, { key: r.issue, summary: r.summary });
      draft.cells[cellKey(d.day, r.issue)] = { minutes, comment: r.comment || '', recurring: true };
      booked++;
    }
  }
  return booked;
}

/** What a month starts with: pinned issues, then recurring bookings, then rules on the remaining time. */
export function prefill(draft, { pinned = [], recurring = [], rules = [] } = {}) {
  pinned.forEach(i => ensureIssue(draft, i));
  const recurringCells = applyRecurring(draft, recurring);
  const filled = applyRules(draft, rules);
  return { recurringCells, filled };
}

export function ensureIssue(draft, issue) {
  if (!draft.issues.some(i => i.key === issue.key)) draft.issues.push({ key: issue.key, summary: issue.summary || '' });
}

const isPosted = cell => Boolean(cell?.worklogId);

/**
 * Default worklog text for a cell: the description parts the rules map to this issue; otherwise the parts no
 * rule maps anywhere; otherwise the whole JaTT description.
 */
export function defaultComment(draft, day, key, rules = []) {
  const description = draft.days.find(d => d.day === day)?.description || '';
  const { groups, unmatched } = matchRules(description, rules);
  const mine = groups.find(g => g.issue === key);
  if (mine) return mine.parts.join(', ');
  if (groups.length && unmatched.length) return unmatched.join(', ');
  return description;
}

/** Sets a cell's hours, defaulting its text via defaultComment. Posted cells are left alone. */
export function setCell(draft, day, key, minutes, rules = []) {
  const k = cellKey(day, key);
  const cell = draft.cells[k];
  if (isPosted(cell)) return;
  if (!minutes) {
    if (cell) draft.cells[k] = { ...cell, minutes: 0 };
    return;
  }
  draft.cells[k] = { ...cell, minutes, comment: cell?.comment || defaultComment(draft, day, key, rules) };
}

/** Puts whatever is not yet booked on that day onto one issue. */
export function fillRest(draft, day, key, rules = []) {
  const d = draft.days.find(x => x.day === day);
  const current = draft.cells[cellKey(day, key)]?.minutes || 0;
  const rest = d.minutes - (rowTotal(draft, day) - current);
  if (rest > 0) setCell(draft, day, key, rest, rules);
}

/** Splits the day evenly across the given issues, replacing unposted hours. */
export function splitDay(draft, day, keys, rules = []) {
  const d = draft.days.find(x => x.day === day);
  const parts = splitEvenly(d.minutes, keys.length);
  keys.forEach((key, idx) => setCell(draft, day, key, parts[idx], rules));
}

/** Copies the split of the closest earlier day with hours, scaled to this day's total. */
export function copyPrevious(draft, day, rules = []) {
  const d = draft.days.find(x => x.day === day);
  const prev = [...draft.days].reverse().find(x => x.day < day && rowTotal(draft, x.day) > 0);
  if (!d || !prev) return false;
  const source = dayCells(draft, prev.day);
  const sourceTotal = rowTotal(draft, prev.day);
  let assigned = 0;
  source.forEach(({ key, cell }, idx) => {
    const minutes = idx === source.length - 1
      ? d.minutes - assigned
      : Math.round((cell.minutes / sourceTotal) * d.minutes / 5) * 5;
    assigned += minutes;
    setCell(draft, day, key, minutes, rules);
  });
  return true;
}

/** Summary used for review before posting. */
export function summarize(draft) {
  const perIssue = new Map();
  const toPost = [];
  for (const d of draft.days) {
    for (const { key, cell } of dayCells(draft, d.day)) {
      const entry = perIssue.get(key) || { key, minutes: 0, count: 0, posted: 0 };
      entry.minutes += cell.minutes;
      entry.count++;
      if (isPosted(cell)) entry.posted++;
      else toPost.push({ day: d.day, key, date: dateOf(draft.month, d.day), minutes: cell.minutes, comment: cell.comment || '' });
      perIssue.set(key, entry);
    }
  }
  const mismatches = draft.days
    .map(d => ({ day: d.day, jatt: d.minutes, booked: rowTotal(draft, d.day) }))
    .filter(x => x.jatt !== x.booked);
  const jattTotal = draft.days.reduce((s, d) => s + d.minutes, 0);
  const bookedTotal = [...perIssue.values()].reduce((s, e) => s + e.minutes, 0);
  return { perIssue: [...perIssue.values()], toPost, mismatches, jattTotal, bookedTotal };
}

/**
 * Starts the month over as if it was opened for the first time: pinned issues, rules applied.
 * Worklogs already posted to Jira are kept (with their issues) so they are never posted twice.
 */
export function resetDraft(draft, position = {}) {
  const postedCells = Object.fromEntries(Object.entries(draft.cells).filter(([, c]) => isPosted(c)));
  const kept = Object.keys(postedCells).length;
  const postedKeys = new Set(Object.keys(postedCells).map(k => k.split('|')[1]));
  const fresh = { ...draft, reviewed: {}, issues: draft.issues.filter(i => postedKeys.has(i.key)), cells: postedCells };
  return { draft: fresh, kept, ...prefill(fresh, position) };
}

/** Refreshes days from a newly loaded export while keeping all booked cells. */
export function mergeDays(draft, days) {
  return { ...draft, days: days.map(d => ({ day: d.day, minutes: d.minutes, description: d.description })) };
}

// ---------- day-by-day wizard ----------

const covers = (comment, part) => String(comment || '').toLowerCase().includes(part.toLowerCase());

/**
 * Editable booking rows for one day in the wizard: { issue, minutes, comment, posted, part?, matched? }.
 * Existing cells come first. On days not reviewed yet, every description part that no cell's text covers is
 * added as its own row, with the issue its rule points to (if any) and an even share of the unbooked time.
 * Parts mapped to the same issue share one row.
 */
export function dayRows(draft, day, rules = []) {
  const d = draft.days.find(x => x.day === day);
  const rows = dayCells(draft, day).map(({ key, cell }) => ({
    issue: key, minutes: cell.minutes, comment: cell.comment || '', posted: isPosted(cell)
  }));
  if (draft.reviewed?.[day]) return rows;

  const open = descriptionParts(d.description).filter(part => !rows.some(r => covers(r.comment, part)));
  const added = [];
  for (const part of open) {
    const rule = rules.find(r => ruleMatches(r.pattern, part));
    const existing = rule && (rows.find(r => r.issue === rule.issue && !r.posted) || added.find(r => r.issue === rule.issue));
    if (existing) {
      existing.comment = existing.comment ? `${existing.comment}, ${part}` : part;
      continue;
    }
    added.push({ issue: rule?.issue || '', summary: rule?.summary || '', minutes: 0, comment: part, posted: false, part, matched: Boolean(rule) });
  }
  const free = d.minutes - rows.reduce((s, r) => s + r.minutes, 0);
  if (free > 0 && added.length) splitEvenly(free, added.length).forEach((m, i) => { added[i].minutes = m; });
  return [...rows, ...added];
}

/**
 * Writes the wizard rows of a day back into the draft: rows with the same issue are merged, unposted cells of
 * issues no longer listed are removed, posted cells stay untouched. Returns an error message or null.
 */
export function saveDayRows(draft, day, rows) {
  const editable = rows.filter(r => !r.posted && r.minutes > 0);
  if (editable.some(r => !r.issue)) return 'Pick an issue for every row with hours (or set its hours to 0).';
  const merged = new Map();
  for (const r of editable) {
    const m = merged.get(r.issue) || { minutes: 0, comments: [] };
    m.minutes += r.minutes;
    if (r.comment.trim()) m.comments.push(r.comment.trim());
    merged.set(r.issue, m);
  }
  const blocked = [...merged.keys()].find(issue => isPosted(draft.cells[cellKey(day, issue)]));
  if (blocked) return `${blocked} is already posted for this day; book on another issue.`;
  for (const key of Object.keys(draft.cells)) {
    const [cellDay, issue] = key.split('|');
    if (Number(cellDay) !== day || isPosted(draft.cells[key])) continue;
    if (!merged.has(issue)) delete draft.cells[key];
  }
  for (const [issue, m] of merged) {
    draft.cells[cellKey(day, issue)] = { minutes: m.minutes, comment: m.comments.join('\n') };
  }
  draft.reviewed = { ...draft.reviewed, [day]: true };
  return null;
}
