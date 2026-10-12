// xlsx.js — đọc file Excel (.xlsx) và CSV ở máy chủ, không cần thư viện ngoài: giải nén ZIP bằng node:zlib, đọc XML của từng sheet.
// Trả về { sheets: [{ name, rows: [[ô, …], …] }] }. Ô ngày (định dạng ngày trong Excel) trả về chuỗi 'YYYY-MM-DD' hoặc 'YYYY-MM-DD HH:MM'.
// Giới hạn để một file lỗi hoặc cố ý phá không làm treo máy chủ: tối đa 40 sheet, 20.000 dòng mỗi sheet, 200 cột, 60 MB sau giải nén.
import { inflateRawSync } from 'node:zlib';

const MAX_SHEETS = 40, MAX_ROWS = 20000, MAX_COLS = 200, MAX_UNZIP = 60 * 1024 * 1024;

class SheetError extends Error {}
const bad = (msg) => { throw new SheetError(msg); };

/** Đọc mục lục ZIP (central directory) và trả về hàm lấy nội dung một tệp theo tên. */
function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) bad('File không phải Excel (.xlsx) hợp lệ.');
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) bad('File Excel bị hỏng (mục lục ZIP).');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, usize, loc });
    p += 46 + nlen + xlen + clen;
  }
  let total = 0;
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.loc + 30 > buf.length || buf.readUInt32LE(e.loc) !== 0x04034b50) bad('File Excel bị hỏng (tệp con).');
    const start = e.loc + 30 + buf.readUInt16LE(e.loc + 26) + buf.readUInt16LE(e.loc + 28);
    const raw = buf.subarray(start, start + e.csize);
    total += e.usize;
    if (total > MAX_UNZIP) bad('File quá lớn sau khi giải nén.');
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = inflateRawSync(raw, { maxOutputLength: MAX_UNZIP });
    else bad('File Excel dùng kiểu nén chưa hỗ trợ.');
    return out.toString('utf8');
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e]));
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
/** Ghép mọi đoạn <t> trong một khối (chuỗi có định dạng chia thành nhiều đoạn). Bỏ phần phiên âm <rPh>. */
const textOf = (xml) => { let s = ''; const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''); for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += m[1] ? unxml(m[1]) : ''; return s; };
const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
/** Định dạng số có phải ngày giờ không: có d, m, y, h hoặc s ngoài phần trong ngoặc kép / ngoặc vuông. */
const isDateFmt = (code) => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
function serialToDate(v) {
  const ms = Math.round((v - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return v;
  const iso = d.toISOString();
  return Math.abs(v % 1) > 1e-9 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

export function parseXlsx(buf) {
  const get = openZip(buf);
  const wb = get('xl/workbook.xml') || bad('Không tìm thấy danh sách sheet trong file.');
  const relsXml = get('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
  // Kiểu ô → có phải ngày không.
  const dateXf = [];
  const st = get('xl/styles.xml');
  if (st) {
    const custom = new Map();
    for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) custom.set(+attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || '');
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
    if (xfs) for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) { const id = +(attr(m[0], 'numFmtId') || 0); dateXf.push(DATE_IDS.has(id) || (custom.has(id) && isDateFmt(custom.get(id)))); }
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    if (sheets.length >= MAX_SHEETS) break;
    const name = attr(m[0], 'name') || `Sheet${sheets.length + 1}`;
    const state = attr(m[0], 'state');
    let target = rels.get(attr(m[0], 'r:id')) || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      if (rows.length >= MAX_ROWS) break;
      const rn = r[1] ? +(attr(`<x ${r[1]}>`, 'r') || 0) : 0;
      const row = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c ${c[1]}>`, body = c[2] || '';
        const ref = attr(tag, 'r');
        const ci = ref ? colIndex(ref) : row.length;
        if (ci < 0 || ci >= MAX_COLS) continue;
        const t = attr(tag, 't'), s = +(attr(tag, 's') || 0);
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        let v = null;
        if (t === 's') v = vm ? shared[+vm[1]] ?? '' : '';
        else if (t === 'inlineStr') v = textOf(body);
        else if (t === 'str' || t === 'e') v = vm ? unxml(vm[1]) : '';
        else if (t === 'b') v = vm ? vm[1] === '1' : null;
        else if (t === 'd') v = vm ? unxml(vm[1]).slice(0, 16).replace('T', ' ') : null;
        else if (vm) { const n = Number(vm[1]); v = Number.isFinite(n) ? (dateXf[s] ? serialToDate(n) : n) : unxml(vm[1]); }
        while (row.length < ci) row.push(null);
        row[ci] = v;
      }
      // Dòng trống ở giữa vẫn giữ chỗ để số dòng khớp với Excel (người dùng đối chiếu theo số dòng).
      if (rn && rn - 1 > rows.length) while (rows.length < Math.min(rn - 1, MAX_ROWS)) rows.push([]);
      rows.push(row);
    }
    sheets.push({ name, hidden: state === 'hidden' || state === 'veryHidden', rows });
  }
  if (!sheets.length) bad('File không có sheet nào đọc được.');
  return { sheets };
}

/** CSV (UTF-8, có hoặc không có BOM; dấu phẩy hoặc chấm phẩy). */
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; if (rows.length >= MAX_ROWS) break; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return { sheets: [{ name: 'CSV', hidden: false, rows: rows.map((r) => r.slice(0, MAX_COLS).map((x) => (x === '' ? null : x))) }] };
}

/** Nhận dạng theo chữ ký tệp: ZIP (xlsx) hoặc văn bản (csv). */
export function parseSheet(bytes, name = '') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return parseXlsx(buf);
    if (/\.xls$/i.test(name) || (buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0)) bad('File .xls (Excel 97-2003) chưa hỗ trợ. Mở bằng Excel rồi lưu thành .xlsx.');
    return parseCsv(buf.toString('utf8'));
  } catch (e) {
    if (e instanceof SheetError) { const err = new Error(e.message); err.userMessage = e.message; throw err; }
    const err = new Error('Không đọc được file: ' + (e && e.message)); err.userMessage = 'Không đọc được file. Kiểm tra file có mở được bằng Excel không.'; throw err;
  }
}
