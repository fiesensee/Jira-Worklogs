// Reads a JaTT monthly timesheet export (one sheet per position, a `Datum` day table) into plain days.
// Ported from JaTT's src/utils/excelImport.ts so this tool works without the JaTT code base.
import XLSX from 'xlsx';

const DEFAULT_COLUMNS = { hours: 2, arrived: 4, left: 5, break: 6, description: 7 };

const cellText = val => (val === null || val === undefined ? '' : String(val).replace(/\s+/g, ' ').trim());

const toNumber = val => {
  if (typeof val === 'number' && isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val.trim().replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  return null;
};

/** Converts an Excel time cell (day fraction or `HH:MM` text) into minutes since midnight. */
const timeCellMinutes = val => {
  if (typeof val === 'number' && isFinite(val)) {
    return Math.round((val - Math.floor(val)) * 24 * 60) % (24 * 60);
  }
  const match = cellText(val).match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60) return Number(match[1]) * 60 + Number(match[2]);
  return null;
};

const parseMonthCell = val => {
  if (typeof val === 'number' && val > 0) {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed?.y && parsed?.m) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}`;
  }
  const str = cellText(val);
  const iso = str.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const dotted = str.match(/^\d{1,2}\.(\d{1,2})\.(\d{4})$/);
  if (dotted) return `${dotted[2]}-${dotted[1].padStart(2, '0')}`;
  return null;
};

const resolveColumns = header => {
  const cols = { ...DEFAULT_COLUMNS };
  header.forEach((cell, idx) => {
    const text = cellText(cell).toLowerCase();
    if (text.includes('dauer')) cols.hours = idx;
    else if (text.includes('kommt')) cols.arrived = idx;
    else if (text.includes('geht')) cols.left = idx;
    else if (text.includes('pause')) cols.break = idx;
    else if (text.includes('tätigkeit')) cols.description = idx;
  });
  return cols;
};

const readHeaderMeta = (rows, headerIdx) => {
  const meta = {};
  for (let r = 0; r < headerIdx; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const label = cellText(row[c]).toLowerCase();
      if (!label || meta[label] !== undefined) continue;
      const value = row.slice(c + 1).find(v => cellText(v) !== '');
      if (value !== undefined) meta[label] = value;
    }
  }
  return meta;
};

function parseSheet(name, sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: true });
  const headerIdx = rows.findIndex(r => cellText(r?.[0]).toLowerCase() === 'datum');
  if (headerIdx === -1) return null;

  const cols = resolveColumns(rows[headerIdx]);
  const meta = readHeaderMeta(rows, headerIdx);
  const days = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (cellText(row[0]).toLowerCase() === 'total') break;
    const day = toNumber(row[0]);
    if (day === null || !Number.isInteger(day) || day < 1 || day > 31) continue;

    let minutes = Math.round((toNumber(row[cols.hours]) ?? 0) * 60);
    if (minutes <= 0) {
      // JaTT writes the duration as a formula; fall back to arrival/departure minus break.
      const arrived = timeCellMinutes(row[cols.arrived]);
      const left = timeCellMinutes(row[cols.left]);
      if (arrived !== null && left !== null) {
        let span = left - arrived;
        if (span < 0) span += 24 * 60;
        minutes = span - Math.max(0, Math.round((toNumber(row[cols.break]) ?? 0) * 60));
      }
    }
    if (minutes <= 0) continue;
    days.push({ day, minutes, description: cellText(row[cols.description]) });
  }

  if (days.length === 0) return null;
  return {
    name,
    month: parseMonthCell(meta['monat']),
    customer: cellText(meta['kunde']),
    contractNumber: cellText(meta['vertragsnummer']),
    totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
    days
  };
}

/** Returns every sheet of the workbook that holds a filled day table. */
export function readTimesheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return workbook.SheetNames.map(name => parseSheet(name, workbook.Sheets[name])).filter(Boolean);
}
