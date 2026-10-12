// xlsx-build.mjs — dựng file .xlsx tối thiểu trong kiểm thử (không cần thư viện): mỗi sheet là mảng dòng, ô ngày dùng kiểu ngày của Excel.
import { deflateRawSync, crc32 } from 'node:zlib';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
/** Giá trị ô: chuỗi, số, { date: 'YYYY-MM-DD' } (lưu dạng số ngày của Excel, định dạng ngày), null = ô trống. */
function cellXml(v, ref) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
  if (v && v.date) { const serial = Date.parse(v.date + 'T00:00:00Z') / 86400000 + 25569; return `<c r="${ref}" s="1"><v>${serial}</v></c>`; }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8'), data = deflateRawSync(raw), nameB = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(nameB.length, 26);
    parts.push(loc, nameB, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(off, 42);
    central.push(cd, nameB);
    off += loc.length + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
/** sheets: [{ name, rows: [[...], ...] }] → Buffer của file .xlsx. */
export function buildXlsx(sheets) {
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'],
  ];
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cellXml(v, col(ci) + (ri + 1))).join('')}</row>`).join('');
    files.push([`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`]);
  });
  return zip(files);
}
