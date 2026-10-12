// importer.js — nhập dữ liệu ban đầu từ file Excel / CSV (BO, kit, thiết bị, thẻ, phụ kiện, lịch sử dung lượng, lịch sử sự cố, tài khoản).
// Quy trình 3 bước: đọc file → chọn loại dữ liệu và cột cho từng sheet (hệ thống đoán sẵn theo tên cột) → chạy thử → nhập thật.
// Nguyên tắc:
//  - Không tự sửa dữ liệu lệch. Bản ghi đã có: chỉ điền vào ô đang trống; giá trị khác nhau đưa vào Đối chiếu cho team liên quan.
//  - BO ghép theo mã, rồi số điện thoại, rồi tên (bỏ dấu); khớp nhiều BO thì không đoán, đưa vào Đối chiếu.
//  - Chạy thử dùng đúng đường nhập thật trong một giao dịch rồi hoàn tác, nên kết quả chạy thử là kết quả thật.
//  - Lịch sử dung lượng và sự cố được đánh dấu nguồn "import": vào số giờ quay và top sự cố, không tính điểm của ai.
import { cleanStr, cleanText, num, int, isDate, isHM, addDays, atTime, validCoord, boLabel } from '../util.js';
import { fail } from '../core.js';
import { KIT_KINDS, KIT_ST, DEV_COND as COND_LABEL, DEFAULT_LABELS, INCIDENT_RES } from './defs.js';

// ───────── Chuẩn hoá chuỗi để so khớp ─────────
export const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
const phoneOf = (v) => { let d = String(v ?? '').replace(/\D/g, ''); if (d.startsWith('84') && d.length >= 11) d = '0' + d.slice(2); if (d.length === 9) d = '0' + d; return d.length >= 9 ? d : ''; };
const str = (v, max = 200) => (v === null || v === undefined ? '' : cleanStr(String(typeof v === 'number' && Number.isInteger(v) ? v : v), max));

/** Ngày từ nhiều dạng: 2026-10-08, 08/10/2026, 8/10/26, số ngày kiểu Excel. */
export function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') { if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); return null; }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) { const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; return isDate(d) ? d : null; }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isDate(d) ? d : null; }
  return null;
}
/** Giờ: 08:00, 8h, 8h30, 8:00 SA, phần lẻ của ngày (0.3333). */
export function timeOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  const m = /^(\d{1,2})\s*(?:[:hg]\s*(\d{1,2})?)?\s*(sa|am|ch|pm)?$/i.exec(String(v).trim().toLowerCase().replace(/\s+/g, ' '));
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  if (m[3] && /ch|pm/.test(m[3]) && h < 12) h += 12;
  const out = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  return isHM(out) ? out : null;
}
/** Khung giờ "08:00-10:00", "8h - 10h", "8:00–10:00". */
function timeRange(v) {
  if (!v) return null;
  const parts = String(v).split(/\s*(?:-|–|—|~|đến|den|to)\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const a = timeOf(parts[0]), b = timeOf(parts[1]);
  return a && b && a < b ? { from: a, to: b } : null;
}
/** Ngày đổi thẻ: "T2, T4, T6", "2,4,6", "Thứ 2 - Thứ 6", "CN", "hằng ngày" → '1,3,5' (1 = Thứ Hai … 7 = Chủ nhật). */
export function weekdaysOf(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = norm(v);
  if (/^(hang ngay|moi ngay|ca tuan|daily|everyday|t2 cn|thu 2 chu nhat)$/.test(s)) return '1,2,3,4,5,6,7';
  const range = /^(?:t|thu)?\s*([2-7])\s+(?:t|thu)?\s*([2-7]|cn|chu nhat)$/.exec(s.replace(/\bden\b/g, ' '));
  const set = new Set();
  if (range && /-|–|đến|den/.test(String(v))) {
    const a = +range[1] - 1, b = /cn|chu/.test(range[2]) ? 7 : +range[2] - 1;
    for (let d = a; d <= b; d++) set.add(d);
  } else {
    for (const tok of s.split(' ')) {
      if (!tok || tok === 't' || tok === 'thu') continue;
      if (tok === 'cn' || tok === 'chu' || tok === 'nhat' || tok === 'sun' || tok === '8') { if (tok !== 'nhat') set.add(7); continue; }
      const n = /^t?([2-7])$/.exec(tok);
      if (n) { set.add(+n[1] - 1); continue; }
      const en = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[tok.slice(0, 3)];
      if (en) { set.add(en); continue; }
      return null; // không chắc chắn thì không đoán
    }
  }
  return [...set].sort().join(',');
}
/** Toạ độ từ link Google Maps hoặc chuỗi "lat, lon". Link rút gọn (maps.app.goo.gl) không đọc được khi không có mạng → null. */
export function coordOf(v) {
  if (!v) return null;
  const s = String(v);
  const pats = [/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /^\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*$/];
  for (const p of pats) { const m = p.exec(s); if (m) { const lat = +m[1], lon = +m[2]; if (validCoord(lat, lon)) return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) }; } }
  return null;
}
const pick = (map, v) => { const s = norm(v); if (!s) return null; for (const [k, list] of Object.entries(map)) if (list.some((x) => s === x || s.startsWith(x + ' ') || s.includes(' ' + x))) return k; return null; };

const OUTLET_STATUS = { live: ['dang quay', 'dang ghi hinh', 'active', 'live', 'hoat dong', 'dang hoat dong', 'dang chay', 'running'], planned: ['cho launch', 'chua launch', 'planned', 'cho active', 'sap launch', 'pending', 'moi'], paused: ['tam nghi', 'tam dung', 'pause', 'paused'], ending: ['dang thu hoi'], ended: ['ket thuc', 'da ket thuc', 'ended', 'dung quay', 'thu hoi xong', 'inactive', 'closed'] };
const KIT_STATUS = { at_bo: ['tai bo', 'dang quay', 'o bo', 'at bo', 'dang o bo', 'deploy', 'deployed', 'dang dung', 'live'], ready: ['san sang', 'ready', 'trong kho', 'kho', 'ton kho', 'available'], at_tech: ['dang sua', 'hong', 'tech', 'loi', 'bao hanh', 'sua', 'repair', 'faulty'], preparing: ['dang chuan bi', 'chuan bi', 'preparing'], retired: ['ngung dung', 'thanh ly', 'retired'] };
const KIT_KIND = { multicam: ['multicam', 'multi cam', 'mc', 'stereo'], iphone: ['iphone', 'mono', 'iphone mono', 'ip'], custom: ['custom', 'tuy chinh', 'khac'] };
const DEV_COND = { ok: ['tot', 'ok', 'binh thuong', 'hoat dong', 'good', 'dung duoc'], faulty: ['hong', 'loi', 'faulty', 'bad', 'error'], repairing: ['dang sua', 'sua', 'repairing'], retired: ['ngung dung', 'thanh ly', 'retired'], lost: ['mat', 'that lac', 'lost'] };
const CARD_STATUS = { office: ['van phong', 'vp', 'kho', 'san sang', 'office', 'trong', 'ready'], at_bo: ['tai bo', 'o bo', 'at bo', 'bo'], at_tech: ['tech', 'o tech'], bad: ['hong', 'loi', 'bad'], lost: ['mat', 'that lac', 'lost'] };
const ROLE_MAP = { admin: ['admin', 'quan tri'], tech_lead: ['tech lead', 'truong tech', 'truong ky thuat'], tech: ['tech executive', 'tech', 'ky thuat', 'technician'], lead: ['logistic lead', 'logistics lead', 'truong logistic'], logistic: ['logistic executive', 'logistics executive', 'logistic', 'logistics', 'kho van'], fo: ['field ops', 'field operation', 'fo', 'giao nhan', 'shipper'], sale_head: ['head of sale', 'sale head', 'truong sale', 'truong kinh doanh'], sale: ['sale lead', 'sale', 'kinh doanh', 'sales'] };
const INC_STATUS = { resolved: ['da xu ly', 'xong', 'resolved', 'done', 'dong', 'closed', 'hoan thanh'], cancelled: ['huy', 'cancel', 'cancelled'] };
const INC_RES = { no_recover: ['tai cho', 'xu ly tai cho', 'khong thu hoi', 'remote'], swap: ['doi may', 'doi kit', 'swap'], office_repair: ['mang ve', 've sua', 'sua tai van phong', 'office'], invalid: ['khong phai su co', 'invalid', 'bao nham'] };

// ───────── Loại dữ liệu nhập được và tên cột thường gặp (đã bỏ dấu) ─────────
const F = (key, label, aliases, req = false) => ({ key, label, aliases, required: req });
const BASE_TARGETS = {
  outlets: { label: 'BO (điểm ghi hình)', sheet: ['bo', 'outlet', 'cua hang', 'diem', 'tracker', 'danh sach bo'], fields: [
    F('code', 'Mã BO', ['ma bo', 'bo code', 'ma outlet', 'outlet code', 'id bo', 'ma diem', 'code']), F('name', 'Tên BO', ['ten bo', 'ten outlet', 'outlet', 'ten cua hang', 'cua hang', 'ten diem', 'bo', 'ten', 'name'], true),
    F('address', 'Địa chỉ', ['dia chi', 'address', 'dia chi bo']), F('contact', 'Người liên hệ', ['nguoi lien he', 'lien he', 'contact', 'chu bo', 'ten chu', 'chu cua hang']),
    F('phone', 'SĐT liên hệ', ['sdt', 'so dien thoai', 'dien thoai', 'phone', 'sdt lien he', 'sdt bo', 'sdt chu']), F('sale', 'Sale phụ trách', ['sale phu trach', 'sale', 'nguoi phu trach', 'sale lead', 'pic', 'phu trach', 'sale pic']),
    F('area', 'Khu vực', ['khu vuc', 'area', 'quan', 'quan huyen', 'tinh', 'thanh pho', 'region']), F('business', 'Ngành', ['nganh', 'loai hinh', 'business', 'nganh hang', 'loai hinh kinh doanh']),
    F('lat', 'Vĩ độ', ['lat', 'vi do', 'latitude']), F('lon', 'Kinh độ', ['lon', 'lng', 'long', 'kinh do', 'longitude']), F('map', 'Link Google Maps / toạ độ', ['link map', 'google map', 'google maps', 'maps', 'link google map', 'vi tri', 'toa do', 'link vi tri', 'location']),
    F('swap_days', 'Ngày đổi thẻ', ['ngay doi the', 'lich doi the', 'swap days', 'thu doi the']), F('swap_time', 'Khung giờ đổi thẻ', ['khung gio doi the', 'khung gio', 'gio doi the', 'swap time']),
    F('swap_from', 'Giờ bắt đầu đổi thẻ', ['gio bat dau doi the', 'tu gio']), F('swap_to', 'Giờ kết thúc đổi thẻ', ['gio ket thuc doi the', 'den gio']),
    F('launch_date', 'Ngày launch', ['ngay launch', 'launch', 'ngay bat dau', 'ngay lap dat', 'ngay setup', 'launch date']), F('end_date', 'Ngày kết thúc', ['ngay ket thuc', 'end date', 'ket thuc']),
    F('status', 'Trạng thái', ['trang thai', 'status', 'tinh trang']), F('quota_hours', 'Quota giờ quay', ['quota', 'quota hour', 'quota hours', 'quota gio', 'gio toi da', 'so gio toi da', 'max hour', 'max hours']),
    F('onboard_date', 'Ngày onboard', ['ngay onboard', 'onboard', 'onboard date']), F('note', 'Ghi chú', ['ghi chu', 'note', 'notes']),
  ] },
  kits: { label: 'Kit', sheet: ['kit', 'bo kit', 'multicam kit', 'iphone mono'], fields: [
    F('code', 'Mã kit', ['ma kit', 'kit', 'kit code', 'ma bo kit', 'kit id'], true), F('kind', 'Loại kit', ['loai kit', 'loai', 'kind', 'dong may', 'type']), F('status', 'Trạng thái', ['trang thai', 'status', 'tinh trang']),
    F('site', 'BO đang đặt kit', ['bo', 'ten bo', 'ma bo', 'outlet', 'dang o', 'vi tri', 'bo dang dat']), F('devices', 'Mã thiết bị (nhiều mã)', ['thiet bi', 'ma thiet bi', 'devices', 'danh sach thiet bi']),
    F('multicam', 'Mã Multicam', ['multicam', 'ma multicam', 'camera', 'ma camera']), F('cm5', 'Mã CM5', ['cm5', 'ma cm5']), F('iphone', 'Mã iPhone', ['iphone', 'ma iphone']), F('powerbank', 'Mã Powerbank', ['powerbank', 'ma powerbank', 'sac du phong', 'pin du phong']),
    F('note', 'Ghi chú', ['ghi chu', 'note']),
  ] },
  devices: { label: 'Thiết bị lẻ', sheet: ['thiet bi', 'device', 'inventory', 'kho thiet bi', 'tai san'], fields: [
    F('code', 'Mã thiết bị', ['ma thiet bi', 'ma tb', 'serial', 'so serial', 'ma', 'code', 'device code'], true), F('type', 'Loại thiết bị', ['loai thiet bi', 'loai', 'type', 'thiet bi']),
    F('cond', 'Tình trạng', ['tinh trang', 'trang thai', 'condition', 'status']), F('kit', 'Mã kit', ['ma kit', 'kit', 'thuoc kit']), F('health', 'Sức khoẻ pin', ['suc khoe', 'suc khoe pin', 'health', 'pin']), F('note', 'Ghi chú', ['ghi chu', 'note']),
  ] },
  cards: { label: 'Thẻ nhớ', sheet: ['the', 'the nho', 'card', 'sd'], fields: [
    F('code', 'Mã thẻ', ['ma the', 'the', 'card', 'ma the nho', 'sd', 'card code'], true), F('status', 'Trạng thái', ['trang thai', 'status', 'tinh trang']), F('site', 'BO đang giữ thẻ', ['bo', 'ten bo', 'ma bo', 'outlet', 'vi tri']), F('note', 'Ghi chú', ['ghi chu', 'note']),
  ] },
  acc: { label: 'Tồn phụ kiện', sheet: ['phu kien', 'accessory', 'accessories', 'ton phu kien'], fields: [
    F('type', 'Tên phụ kiện', ['phu kien', 'ten phu kien', 'loai', 'item', 'ten', 'hang muc'], true), F('total', 'Tổng số lượng', ['so luong', 'tong', 'sl', 'total', 'quantity', 'ton kho', 'tong so luong'], true),
  ] },
  records: { label: 'Dung lượng thẻ (lịch sử giờ quay)', sheet: ['dung luong', 'upload', 'capacity', 'gio quay', 'nhap the', 'raw', 'chi tiet'], fields: [
    F('card', 'Mã thẻ', ['ma the', 'the', 'card', 'ma the nho'], true), F('site', 'BO', ['bo', 'ten bo', 'ma bo', 'outlet'], true), F('date', 'Ngày quay', ['ngay quay', 'ngay', 'date', 'shoot date', 'ngay ghi hinh'], true),
    F('gb', 'Dung lượng (GB)', ['gb', 'dung luong', 'dung luong gb', 'size', 'size gb']), F('hours', 'Giờ quay', ['gio', 'so gio', 'gio quay', 'hours', 'raw hour', 'raw hours', 'gio raw']),
    F('zero_reason', 'Lý do 0 giờ', ['ly do', 'ly do 0 gio', 'ly do 0', 'nguyen nhan']), F('kit', 'Mã kit', ['ma kit', 'kit']),
  ] },
  incidents: { label: 'Sự cố (lịch sử)', sheet: ['su co', 'incident', 'loi', 'nhan loi', 'bao loi'], fields: [
    F('date', 'Ngày báo', ['ngay bao', 'ngay', 'thoi gian', 'date', 'ngay phat sinh'], true), F('site', 'BO', ['bo', 'ten bo', 'ma bo', 'outlet'], true), F('kit', 'Mã kit', ['ma kit', 'kit']),
    F('label', 'Nhãn lỗi', ['nhan loi', 'loai loi', 'loi', 'label', 'su co', 'ma loi'], true), F('text', 'Mô tả', ['mo ta', 'chi tiet', 'noi dung', 'description']),
    F('status', 'Trạng thái', ['trang thai', 'status', 'tinh trang']), F('resolution', 'Cách xử lý', ['cach xu ly', 'xu ly', 'resolution', 'huong xu ly']), F('resolved_date', 'Ngày xử lý', ['ngay xu ly', 'ngay hoan thanh', 'resolved']),
  ] },
  users: { label: 'Tài khoản người dùng', sheet: ['nguoi dung', 'user', 'tai khoan', 'nhan su', 'nhan vien', 'staff'], fields: [
    F('username', 'Tên đăng nhập', ['ten dang nhap', 'username', 'user', 'tai khoan']), F('name', 'Họ tên', ['ho ten', 'ho va ten', 'ten', 'name', 'nhan vien'], true), F('email', 'Email', ['email', 'mail']),
    F('phone', 'SĐT', ['sdt', 'so dien thoai', 'phone', 'dien thoai']), F('role', 'Vai trò', ['vai tro', 'role', 'chuc vu', 'vi tri', 'bo phan'], true),
  ] },
};
const ORDER = ['users', 'outlets', 'acc', 'devices', 'kits', 'cards', 'records', 'incidents'];
const TEAM_OF_TARGET = { outlets: 'sale', kits: 'logistics', devices: 'logistics', cards: 'logistics', acc: 'logistics', records: 'tech', incidents: 'tech', users: 'tech' };
// Loại dữ liệu chỉ team sở hữu nhập: tài khoản, dung lượng thẻ, sự cố là của Tech; tổng số phụ kiện là sổ kho của Logistics.
const ONLY = {
  users: [['admin', 'tech_lead'], 'Chỉ Quản trị hoặc Tech Lead nhập tài khoản.'],
  records: [['admin', 'tech_lead'], 'Chỉ Quản trị hoặc Tech Lead nhập dung lượng thẻ (giờ quay là số của Tech).'],
  incidents: [['admin', 'tech_lead'], 'Chỉ Quản trị hoặc Tech Lead nhập lịch sử sự cố.'],
  acc: [['admin', 'lead'], 'Chỉ Quản trị hoặc Logistic Lead nhập số lượng phụ kiện (sổ kho của Logistics).'],
};
// Dòng Đối chiếu theo mã / tên (chưa có số thứ tự) dùng tiền tố riêng (kitcode:, cardcode:, devcode:, boname:) để màn Đối chiếu không đọc mã thành số thứ tự.

export function installImporter(H) {
  const { K, store, now, off, today, log, changed } = H;
  const { R } = K;
  const cache = new Map(); // token → { uid, at, name, sheets }

  /** Danh sách loại dữ liệu kèm cột phụ kiện của kit (mỗi loại phụ kiện một cột số lượng). */
  function targets() {
    const out = JSON.parse(JSON.stringify(BASE_TARGETS));
    for (const t of store.dev_types.find({ kind: 'acc' }, { order: 'sort' })) out.kits.fields.push(F('acc:' + t.id, `Số ${t.name} trong kit`, [norm(t.name), norm(t.id)]));
    return out;
  }
  /** Dòng tiêu đề: trong 10 dòng đầu, dòng khớp nhiều tên cột quen thuộc nhất. */
  function guessSheet(sheet, T) {
    let best = { target: null, score: 0, header_row: 0, mapping: {} };
    const rows = sheet.rows.slice(0, 10);
    const sn = norm(sheet.name);
    for (const [tid, def] of Object.entries(T)) {
      rows.forEach((row, ri) => {
        const heads = row.map((c) => norm(c));
        const mapping = {}, used = new Set();
        let score = 0;
        for (const f of def.fields) {
          let at = -1;
          for (const a of f.aliases) { at = heads.findIndex((h, i) => !used.has(i) && h === a); if (at >= 0) break; }
          if (at < 0) for (const a of f.aliases) { if (a.length < 3) continue; at = heads.findIndex((h, i) => !used.has(i) && h && (h.startsWith(a + ' ') || h.endsWith(' ' + a))); if (at >= 0) break; }
          if (at >= 0) { mapping[f.key] = at; used.add(at); score += f.required ? 2 : 1; }
        }
        if (def.fields.filter((f) => f.required).some((f) => mapping[f.key] === undefined)) score -= 3;
        if (def.sheet.some((x) => sn === x || sn.includes(x))) score += 2;
        if (score > best.score) best = { target: tid, score, header_row: ri, mapping };
      });
    }
    return best.score >= 3 ? best : { target: null, score: best.score, header_row: best.header_row, mapping: {} };
  }

  // ───────────────────────── Bước 1: đọc file ─────────────────────────
  R('POST', '/api/hub/import/parse', ['admin', 'tech_lead', 'lead'], ({ user, b }) => {
    if (!K.deps.parseSheet) fail(501, 'not_available', 'Bản này chưa hỗ trợ đọc file. Dùng bản cài trên máy chủ.');
    const name = cleanStr(b.name, 120) || 'file';
    const m = /^(?:data:[^;,]*;base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(String(b.data || '').replace(/\s+/g, ''));
    if (!m) fail(400, 'bad_file', 'File không hợp lệ.');
    const bytes = Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0));
    if (bytes.length > 12 * 1024 * 1024) fail(413, 'too_large', 'File tối đa 12 MB.');
    let wb;
    try { wb = K.deps.parseSheet(bytes, name); } catch (e) { fail(400, 'bad_file', e.userMessage || 'Không đọc được file.'); }
    const T = targets();
    const token = K.deps.token(16);
    for (const [k, v] of cache) if (now() - v.at > 30 * 60000 || cache.size > 6) cache.delete(k);
    cache.set(token, { uid: user.id, at: now(), name, sheets: wb.sheets });
    return {
      token, name,
      sheets: wb.sheets.map((s, i) => {
        const g = guessSheet(s, T);
        const head = s.rows[g.header_row] || [];
        const width = Math.max(head.length, ...s.rows.slice(g.header_row, g.header_row + 30).map((r) => r.length));
        return { index: i, name: s.name, hidden: !!s.hidden, rows: s.rows.length, header_row: g.header_row, headers: Array.from({ length: width }, (_, c) => str(head[c], 80) || `Cột ${c + 1}`), sample: s.rows.slice(g.header_row + 1, g.header_row + 9).map((r) => Array.from({ length: width }, (_, c) => str(r[c], 60))), guess: { target: g.target, score: g.score, mapping: g.mapping } };
      }),
      targets: Object.entries(T).map(([id, d]) => ({ id, label: d.label, fields: d.fields.map((f) => ({ key: f.key, label: f.label, required: f.required })) })),
    };
  });

  // ───────────────────────── Bước 2: chạy thử / nhập thật ─────────────────────────
  class DryRun extends Error {}
  R('POST', '/api/hub/import/run', ['admin', 'tech_lead', 'lead'], async ({ user, b }) => {
    const c = cache.get(String(b.token || ''));
    if (!c || c.uid !== user.id) fail(410, 'expired', 'Phiên đọc file đã hết hạn. Tải file lên lại.');
    const T = targets();
    const plan = (Array.isArray(b.plan) ? b.plan : []).map((p) => {
      const sheet = c.sheets[int(p && p.sheet, 0, 100) ?? -1];
      if (!sheet) fail(400, 'bad_plan', 'Sheet không hợp lệ.');
      const def = T[p.target];
      if (!def) fail(400, 'bad_plan', `Chọn loại dữ liệu cho sheet "${sheet.name}".`);
      if (ONLY[p.target] && !ONLY[p.target][0].includes(user.role)) fail(403, 'forbidden', ONLY[p.target][1]);
      const mapping = {};
      for (const f of def.fields) { const ci = int(p.mapping && p.mapping[f.key], 0, 199); if (ci !== null) mapping[f.key] = ci; }
      for (const f of def.fields) if (f.required && mapping[f.key] === undefined && !(p.target === 'records' && f.key === 'site')) fail(400, 'bad_plan', `Sheet "${sheet.name}": chưa chọn cột "${f.label}".`);
      if (p.target === 'records' && mapping.gb === undefined && mapping.hours === undefined) fail(400, 'bad_plan', `Sheet "${sheet.name}": cần cột dung lượng (GB) hoặc giờ quay.`);
      const hr = int(p.header_row, 0, 50) ?? 0;
      return { sheet, target: p.target, mapping, header_row: hr, rows: sheet.rows.slice(hr + 1) };
    });
    if (!plan.length) fail(400, 'bad_plan', 'Chọn ít nhất một sheet để nhập.');
    plan.sort((a, b2) => ORDER.indexOf(a.target) - ORDER.indexOf(b2.target));
    const commit = b.commit === true;
    const ctx = makeCtx(user, commit);

    // Tài khoản tạo trước (băm mật khẩu là thao tác bất đồng bộ, không nằm trong giao dịch); chạy thử thì chỉ kiểm tra.
    for (const p of plan.filter((x) => x.target === 'users')) await importUsers(p, ctx);
    let report;
    try {
      store.tx(() => {
        for (const p of plan.filter((x) => x.target !== 'users')) RUN[p.target](p, ctx);
        afterChecks(ctx);
        if (!commit) throw new DryRun();
      });
    } catch (e) { if (!(e instanceof DryRun)) throw e; }
    report = plan.map((p) => ctx.rep(p));
    if (commit) {
      store.tx(() => { for (const j of ctx.afterJobs) H.jobs.ensure(j, null); });
      for (const r of ctx.reconRows) H.recon('import', r.team, r.level, r.entity, r.ref, r.text, r.data);
      const id = store.imports.insert({ name: c.name, by_id: user.id, at: now(), status: 'done', summary: report.map(({ errors, ...x }) => ({ ...x, errors: errors.length })), mapping: plan.map((p) => ({ sheet: p.sheet.name, target: p.target, header_row: p.header_row, mapping: p.mapping })) });
      log('import', id, 'run', `${user.name} nhập dữ liệu từ "${c.name}": ${report.map((r) => `${r.sheet} → ${r.label}: thêm ${r.created}, bổ sung ${r.updated}, đối chiếu ${r.conflicts}`).join('; ')}.`, user);
      changed('outlets', 'kits', 'devices', 'cards', 'acc', 'records', 'incidents', 'recon', 'overview', 'types');
      cache.delete(String(b.token));
    }
    return { dry: !commit, report, recon: ctx.reconRows.length, recon_sample: ctx.reconRows.slice(0, 40).map((r) => ({ team: r.team, level: r.level, text: r.text })), users_created: ctx.newUsers };
  });
  R('GET', '/api/hub/import/history', ['admin', 'tech_lead', 'lead'], () => ({ items: store.imports.find({}, { order: 'at', desc: true, limit: 50 }).map((x) => ({ ...x, by: H.userName(x.by_id) })) }));

  // ───────────────────────── Ngữ cảnh một lượt nhập ─────────────────────────
  function makeCtx(user, commit) {
    const stats = new Map();
    const ctx = {
      user, commit, reconRows: [], newUsers: [], virtualUsers: [], afterJobs: [],
      st(p) { if (!stats.has(p)) stats.set(p, { created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0, errors: [], notes: new Set() }); return stats.get(p); },
      rep(p) { const s = ctx.st(p); return { sheet: p.sheet.name, target: p.target, label: BASE_TARGETS[p.target].label, rows: p.rows.filter((r) => r.some((x) => x !== null && x !== '')).length, created: s.created, updated: s.updated, unchanged: s.unchanged, skipped: s.skipped, conflicts: s.conflicts, errors: s.errors.slice(0, 60), error_count: s.errors.length, notes: [...s.notes] }; },
      err(p, i, msg) { ctx.st(p).errors.push({ row: p.header_row + i + 2, msg }); ctx.st(p).skipped++; },
      recon(p, level, entity, ref, text, data, team) { ctx.st(p).conflicts++; ctx.reconRows.push({ team: team || TEAM_OF_TARGET[p.target], level, entity, ref: `imp:${ref}`, text: `[Nhập ${p.sheet.name}] ${text}`, data: data ?? null }); },
    };
    // Chỉ mục BO: mã, SĐT, tên bỏ dấu.
    ctx.sites = { byCode: new Map(), byPhone: new Map(), byName: new Map() };
    ctx.indexSite = (s) => {
      if (s.code) ctx.sites.byCode.set(s.code.toUpperCase(), s);
      const ph = phoneOf(s.phone); if (ph) { if (!ctx.sites.byPhone.has(ph)) ctx.sites.byPhone.set(ph, []); ctx.sites.byPhone.get(ph).push(s); }
      const nm = norm(s.name); if (nm) { if (!ctx.sites.byName.has(nm)) ctx.sites.byName.set(nm, []); ctx.sites.byName.get(nm).push(s); }
    };
    for (const s of store.sites.find({ active: 1, type: 'bo' })) ctx.indexSite(s);
    return ctx;
  }
  /** Tìm BO: mã → SĐT → tên. Trả về { site } hoặc { many } hoặc {}. */
  function findSite(ctx, { code, phone, name }) {
    if (code) { const s = ctx.sites.byCode.get(String(code).toUpperCase()); if (s) return { site: s, by: 'mã' }; }
    const ph = phoneOf(phone);
    if (ph && ctx.sites.byPhone.has(ph)) { const l = ctx.sites.byPhone.get(ph); if (l.length === 1) return { site: l[0], by: 'SĐT' }; if (name) { const n = l.filter((s) => norm(s.name) === norm(name)); if (n.length === 1) return { site: n[0], by: 'SĐT và tên' }; } return { many: l }; }
    if (name) { const l = ctx.sites.byName.get(norm(name)); if (l && l.length === 1) return { site: l[0], by: 'tên' }; if (l && l.length > 1) return { many: l }; }
    return {};
  }
  /** BO theo một ô (mã hoặc tên). */
  const siteByCell = (ctx, v) => { const s = str(v, 120); if (!s) return {}; const r = findSite(ctx, { code: s.toUpperCase().replace(/\s+/g, ''), name: s }); return r; };
  /** Người dùng theo tên đăng nhập, email, SĐT hoặc họ tên (cả tài khoản sắp tạo trong cùng lượt). */
  function userBy(ctx, v, roles) {
    const s = str(v, 120); if (!s) return null;
    const n = norm(s), ph = phoneOf(s);
    const all = store.users.find({ active: 1 }).concat(ctx.virtualUsers).filter((u) => !roles || roles.includes(u.role));
    const hit = all.filter((u) => u.username === s.toLowerCase() || (u.email && u.email === s.toLowerCase()) || (ph && phoneOf(u.phone) === ph) || norm(u.name) === n);
    return hit.length === 1 ? hit[0] : hit.length > 1 ? { many: hit } : null;
  }
  const cell = (row, mapping, k) => (mapping[k] === undefined ? null : row[mapping[k]] ?? null);
  const blank = (row) => !row || !row.some((x) => x !== null && x !== '' && x !== undefined);
  /** Điền ô trống của bản ghi đã có; ô đã có giá trị khác thì đưa vào Đối chiếu (không ghi đè). */
  function mergeInto(p, ctx, kind, cur, next, labels, refBase, teamOf) {
    const patch = {}, diffs = [];
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === undefined || v === '') continue;
      const old = cur[k];
      if (old === null || old === undefined || old === '') patch[k] = v;
      else if (String(old) !== String(v) && !(typeof v === 'number' && Math.abs(+old - v) < 1e-6)) diffs.push(k);
    }
    for (const k of diffs) ctx.recon(p, 'mid', kind, `${refBase}:${k}`, `${labels.title}: ${labels[k] || k} trên hệ thống "${cur[k]}", trong file "${next[k]}". Không ghi đè; chọn giá trị đúng rồi sửa tay.`, { field: k, current: cur[k], file: next[k] }, teamOf ? teamOf(k) : undefined);
    return patch;
  }

  // ───────────────────────── Từng loại dữ liệu ─────────────────────────
  const RUN = {};
  RUN.outlets = (p, ctx) => {
    const L = { title: '', code: 'Mã BO', name: 'Tên', address: 'Địa chỉ', contact: 'Người liên hệ', phone: 'SĐT', area: 'Khu vực', business: 'Ngành', lat: 'Vĩ độ', lon: 'Kinh độ', swap_days: 'Ngày đổi thẻ', swap_from: 'Giờ đổi thẻ từ', swap_to: 'Giờ đổi thẻ đến', launch_date: 'Ngày launch', end_date: 'Ngày kết thúc', ops_status: 'Trạng thái', quota_hours: 'Quota giờ', onboard_date: 'Ngày onboard', sale_id: 'Sale phụ trách' };
    const teamOf = (k) => (['lat', 'lon', 'swap_days', 'swap_from', 'swap_to', 'address'].includes(k) ? 'logistics' : 'sale');
    // Cùng luật chủ trường như sửa BO tay (outlets.js): ngày launch / kết thúc của BO đã có chỉ qua luồng riêng;
    // quota, Sale phụ trách, ngành, khu vực là số của Sale: qua file chỉ người chuyển dữ liệu (Quản trị, Tech Lead kiêm quản trị hệ thống) điền,
    // Logistic Lead không điền (sửa tay cũng bị chặn). Không điền thì đưa vào Đối chiếu cho Sale.
    const FLOW = { launch_date: 'Ngày launch đổi ở yêu cầu launch của BO (mục Yêu cầu).', end_date: 'Ngày kết thúc đặt bằng nút "Kết thúc ghi hình" của BO để hệ thống tạo việc thu hồi kit.' };
    const SALE_OWN = { quota_hours: 'Quota giờ quay do Sale chốt.', sale_id: 'Sale phụ trách BO do Head of Sale giao.', business: 'Ngành hàng do Sale ghi.', area: 'Khu vực do Sale ghi.' };
    const saleOk = ['admin', 'tech_lead'].includes(ctx.user.role);
    const shown = (k, v) => (k === 'sale_id' ? H.userName(v) || (ctx.virtualUsers.find((u) => u.id === v) || {}).name || v : v);
    const hold = (s, k, v, why) => ctx.recon(p, 'mid', 'outlet', `bo:${s.id}:${k}`, `${boLabel(s.name)}: ${L[k]} trong file "${shown(k, v)}", trên hệ thống ${s[k] === null || s[k] === undefined || s[k] === '' ? 'trống' : `"${shown(k, s[k])}"`}. Chưa điền: ${why}`, { field: k, current: s[k] ?? null, file: v }, 'sale');
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const name = str(g('name'), 80);
      if (!name) return ctx.err(p, i, 'Thiếu tên BO.');
      const rec = { name, code: str(g('code'), 30).toUpperCase().replace(/\s+/g, '') || null, address: str(g('address'), 200) || null, contact: str(g('contact'), 80) || null, phone: str(g('phone'), 20) || null, area: str(g('area'), 80) || null, business: str(g('business'), 80) || null, note: cleanText(String(g('note') ?? ''), 500) || null };
      // Toạ độ: cột vĩ độ / kinh độ, hoặc link bản đồ.
      const lat = num(g('lat')), lon = num(g('lon'));
      if (lat !== null && lon !== null) { if (validCoord(lat, lon)) { rec.lat = +lat.toFixed(6); rec.lon = +lon.toFixed(6); } else ctx.st(p).notes.add('Có toạ độ không hợp lệ, đã bỏ qua (BO vẫn nhập, cần bổ sung toạ độ).'); }
      else if (g('map')) { const cc = coordOf(g('map')); if (cc) Object.assign(rec, cc); else ctx.st(p).notes.add('Có link bản đồ rút gọn hoặc không đọc được toạ độ; BO vẫn nhập, cần mở link và dán toạ độ.'); }
      const wd = weekdaysOf(g('swap_days'));
      if (wd === null) ctx.st(p).notes.add('Có ô ngày đổi thẻ không đọc được (ví dụ "1"); đã để trống để Logistics nhập lại.'); else if (wd) rec.swap_days = wd;
      const tr = timeRange(g('swap_time'));
      if (tr) { rec.swap_from = tr.from; rec.swap_to = tr.to; } else { const a = timeOf(g('swap_from')), b2 = timeOf(g('swap_to')); if (a && b2 && a < b2) { rec.swap_from = a; rec.swap_to = b2; } }
      for (const k of ['launch_date', 'end_date', 'onboard_date']) { const d = dateOf(g(k)); if (d) rec[k] = d; else if (g(k)) ctx.st(p).notes.add(`Có ô "${L[k]}" không đọc được ngày; đã để trống.`); }
      const q = num(g('quota_hours')); if (q !== null && q > 0) rec.quota_hours = +q.toFixed(1);
      const stt = g('status') ? pick(OUTLET_STATUS, g('status')) : null;
      if (g('status') && !stt) ctx.st(p).notes.add(`Có trạng thái BO không nhận ra (ví dụ "${str(g('status'), 30)}"); BO mới để "Chờ launch".`);
      if (g('sale')) {
        const u = userBy(ctx, g('sale'), ['sale', 'sale_head']);
        if (u && !u.many) rec.sale_id = u.id;
        else ctx.st(p).notes.add('Có Sale phụ trách chưa có tài khoản hoặc trùng tên; BO để "Chưa giao Sale" và đưa vào Đối chiếu.');
        if (!u || u.many) rec._sale_raw = str(g('sale'), 80);
      }
      const hit = findSite(ctx, rec);
      if (hit.many) return ctx.recon(p, 'high', 'outlet', `boname:${norm(name)}:${phoneOf(rec.phone)}`, `"${boLabel(name)}" (SĐT ${rec.phone || 'trống'}) khớp ${hit.many.length} BO đang có (${hit.many.map((s) => s.name).slice(0, 3).join(', ')}). Không đoán; chọn BO đúng rồi bổ sung tay.`, { row: p.header_row + i + 2 });
      const saleRaw = rec._sale_raw; delete rec._sale_raw;
      if (hit.site) {
        const cur = hit.site;
        const next = { ...rec, ops_status: stt || undefined };
        delete next.name; // tên đã khớp
        const patch = mergeInto(p, ctx, 'outlet', cur, next, { ...L, title: `${boLabel(cur.name)}` }, `bo:${cur.id}`, teamOf);
        for (const k of Object.keys(patch)) {
          const why = FLOW[k] || (!saleOk && SALE_OWN[k]);
          if (why) { hold(cur, k, patch[k], why); delete patch[k]; }
        }
        if (Object.keys(patch).length) { store.sites.update(cur.id, { ...patch, updated_at: now() }); Object.assign(cur, patch); ctx.st(p).updated++; } else ctx.st(p).unchanged++;
      } else {
        const t = now();
        const row2 = { type: 'bo', radius: K.cfg.arriveRadiusM, active: 1, created_at: t, updated_at: t, ops_status: stt || 'planned', lat: null, lon: null, sale_id: null, ...rec };
        if (row2.ops_status === 'live' && !row2.onboard_date && row2.launch_date) row2.onboard_date = row2.launch_date;
        if (rec.code && store.sites.count({ code: rec.code, active: 1 })) return ctx.err(p, i, `Mã BO ${rec.code} đã có ở BO khác.`);
        // BO mới (chuyển BO đang chạy vào hệ thống): giữ ngày launch / kết thúc theo file; quota như thêm BO tay, Logistics không đặt.
        const quota = !saleOk && row2.quota_hours ? row2.quota_hours : null;
        if (quota) row2.quota_hours = null;
        row2.id = store.sites.insert(row2);
        if (quota) hold(row2, 'quota_hours', quota, SALE_OWN.quota_hours);
        ctx.indexSite(row2);
        ctx.st(p).created++;
        const miss = [];
        if (row2.ops_status === 'live') { if (row2.lat === null) miss.push('toạ độ'); if (!row2.swap_days) miss.push('ngày đổi thẻ'); if (!row2.swap_from) miss.push('khung giờ đổi thẻ'); }
        if (miss.length) ctx.recon(p, 'mid', 'outlet', `bo:${row2.id}:miss`, `${boLabel(row2.name)} đang ghi hình nhưng thiếu ${miss.join(', ')} — chưa tạo được việc đổi thẻ / chuyến FO cho BO này.`, null, 'logistics');
      }
      if (saleRaw) ctx.recon(p, 'mid', 'outlet', `boname:${norm(name)}:sale`, `${boLabel(name)}: Sale phụ trách "${saleRaw}" chưa có tài khoản (hoặc trùng tên). Giao Sale cho BO sau khi tạo tài khoản.`, null, 'sale');
    });
  };

  RUN.acc = (p, ctx) => {
    // Tổng số phụ kiện là sổ kho của Logistics: nhập sheet phụ kiện cũng là ghi sổ, chỉ Quản trị và Logistics.
    if (!H.G.LOGI.includes(ctx.user.role)) fail(403, 'forbidden', `Sheet "${p.sheet.name}": số lượng phụ kiện do Logistics ghi trong sổ kho. Bỏ chọn sheet này hoặc nhờ Logistic Lead nhập.`);
    const types = store.dev_types.find({ kind: 'acc' });
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const name = str(cell(row, p.mapping, 'type'), 60);
      const total = int(cell(row, p.mapping, 'total'), 0, 1e6);
      if (!name) return ctx.err(p, i, 'Thiếu tên phụ kiện.');
      if (total === null) return ctx.err(p, i, `${name}: số lượng phải là số nguyên từ 0.`);
      let t = types.find((x) => norm(x.name) === norm(name) || x.id === norm(name).replace(/ /g, '_'));
      if (!t) {
        const id = norm(name).replace(/ /g, '_').slice(0, 40);
        if (!id || store.dev_types.get(id)) return ctx.err(p, i, `Không tạo được loại phụ kiện "${name}".`);
        t = { id, name, kind: 'acc', core: 0, sort: (store.dev_types.count({}) + 1) * 10, active: 1, total: 0, created_at: now() };
        store.dev_types.insert(t); types.push(t);
        ctx.st(p).notes.add('Có loại phụ kiện mới được thêm vào danh mục.');
        ctx.st(p).created++;
      } else ctx.st(p)[t.total === total ? 'unchanged' : 'updated']++;
      const cur = store.dev_types.get(t.id).total || 0;
      if (total !== cur) H.stock.accMove(t.id, total - cur, total > cur ? 'import' : 'count', `Nhập từ file: tổng ${total}`, ctx.user);
    });
  };

  /**
   * Thiết bị có gắn được vào kit khi nhập không (rỗng = gắn được): kit ngừng dùng không giữ thiết bị; thiết bị thất lạc / ngừng dùng
   * không nằm trong kit; thiết bị hỏng / đang sửa không vào kit đã kiểm đạt. Không gắn thì đưa vào Đối chiếu, không tự sửa.
   */
  function joinBlock(kit, d) {
    if (kit.status === 'retired') return `kit ${kit.code} đã ngừng dùng`;
    if (['lost', 'retired'].includes(d.cond)) return `thiết bị đang "${COND_LABEL[d.cond]}"`;
    if (d.cond !== 'ok' && ['ready', 'reserved', 'wait_check', 'tech_done'].includes(kit.status)) return `thiết bị đang "${COND_LABEL[d.cond]}" mà kit ghi "${KIT_ST[kit.status]}"`;
    return '';
  }

  /** Loại thiết bị theo tên: multicam, cm5, iphone, powerbank hoặc loại trong danh mục. */
  function typeOf(v) {
    const n = norm(v); if (!n) return null;
    const list = store.dev_types.find({ kind: 'device' });
    const t = list.find((x) => x.id === n.replace(/ /g, '_') || norm(x.name) === n) || list.find((x) => n.includes(norm(x.name)) || n.includes(x.id));
    return t ? t.id : null;
  }
  RUN.devices = (p, ctx) => {
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const raw = str(g('code'), 40).toUpperCase().replace(/\s+/g, '');
      if (!raw) return ctx.err(p, i, 'Thiếu mã thiết bị.');
      if (!/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(raw)) return ctx.err(p, i, `Mã "${raw}" không hợp lệ.`);
      const type = typeOf(g('type'));
      const cond = g('cond') ? pick(DEV_COND, g('cond')) : 'ok';
      if (g('cond') && !cond) ctx.st(p).notes.add('Có tình trạng thiết bị không nhận ra; thiết bị đó ghi "Tốt" và đưa vào Đối chiếu.');
      const health = g('health') ? pick({ good: ['tot', 'good'], weak: ['yeu', 'weak'], bad: ['kem', 'bad', 'chai'] }, g('health')) : null;
      const ex = store.devices.find({ code: raw }, { limit: 1 })[0];
      if (ex) {
        const patch = mergeInto(p, ctx, 'device', ex, { type: type || undefined, health: health || undefined, note: str(g('note'), 300) || undefined }, { title: `Thiết bị ${raw}`, type: 'Loại', health: 'Sức khoẻ pin', note: 'Ghi chú' }, `dev:${ex.id}`);
        if (cond && cond !== ex.cond) ctx.recon(p, 'mid', 'device', `dev:${ex.id}:cond`, `Thiết bị ${raw}: tình trạng trên hệ thống "${ex.cond}", trong file "${cond}".`, null, 'tech');
        if (Object.keys(patch).length) { store.devices.update(ex.id, { ...patch, updated_at: now() }); ctx.st(p).updated++; } else ctx.st(p).unchanged++;
      } else {
        if (!type) { ctx.recon(p, 'mid', 'device', `devcode:${raw}:type`, `Thiết bị ${raw}: loại "${str(g('type'), 40) || 'trống'}" không có trong danh mục; chưa nhập. Thêm loại ở mục Danh mục rồi nhập lại.`, null, 'logistics'); ctx.st(p).skipped++; return; }
        if (store.cards.count({ code: raw })) return ctx.err(p, i, `Mã ${raw} đang là mã thẻ nhớ.`);
        store.devices.insert({ code: raw, type, cond: cond || 'ok', kit_id: null, health: health || (type === 'powerbank' ? 'good' : null), note: str(g('note'), 300), created_at: now(), updated_at: now() });
        if (g('cond') && !cond) ctx.recon(p, 'low', 'device', `devcode:${raw}:cond`, `Thiết bị ${raw}: tình trạng "${str(g('cond'), 30)}" không nhận ra, đã ghi "Tốt".`, null, 'tech');
        ctx.st(p).created++;
      }
      // Gắn vào kit nếu cột kit có và kit đã tồn tại (kit nhập sau trong cùng lượt sẽ gắn ở bước kit).
      const kc = str(g('kit'), 40).toUpperCase().replace(/\s+/g, '');
      if (kc) { const k = store.kits.find({ code: kc }, { limit: 1 })[0]; const d = store.devices.find({ code: raw }, { limit: 1 })[0]; const why = k && d && !d.kit_id ? joinBlock(k, d) : ''; if (why) ctx.recon(p, 'mid', 'device', `dev:${d.id}:join`, `Thiết bị ${raw} ghi thuộc kit ${kc} nhưng ${why}; chưa gắn.`, null, 'logistics'); else if (k && d && !d.kit_id) store.devices.update(d.id, { kit_id: k.id, updated_at: now() }); else if (k && d && d.kit_id && d.kit_id !== k.id) ctx.recon(p, 'high', 'device', `dev:${d.id}:kit`, `Thiết bị ${raw} ghi thuộc kit ${kc} nhưng hệ thống đang gắn ở kit khác.`, null, 'logistics'); else if (!k) ctx.pendingKit = (ctx.pendingKit || []).concat([[raw, kc]]); }
    });
  };

  RUN.kits = (p, ctx) => {
    const accCols = Object.keys(p.mapping).filter((k) => k.startsWith('acc:'));
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const code = str(g('code'), 40).toUpperCase().replace(/\s+/g, '');
      if (!code || !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(code)) return ctx.err(p, i, `Mã kit "${code}" không hợp lệ.`);
      // Mã thiết bị trong kit: cột riêng theo loại (biết loại) hoặc một cột nhiều mã (đoán loại theo thiết bị đã có).
      const codes = [];
      for (const tp of ['multicam', 'cm5', 'iphone', 'powerbank']) for (const x of String(g(tp) ?? '').split(/[\s,;]+/).filter(Boolean)) codes.push([x.toUpperCase(), tp]);
      for (const x of String(g('devices') ?? '').split(/[\s,;]+/).filter(Boolean)) codes.push([x.toUpperCase(), null]);
      let kind = g('kind') ? pick(KIT_KIND, g('kind')) : null;
      if (!kind) kind = codes.some(([, t]) => t === 'multicam' || t === 'cm5') ? 'multicam' : codes.some(([, t]) => t === 'iphone') ? 'iphone' : /^IP|MONO/.test(code) ? 'iphone' : /^MC|KIT/.test(code) ? 'multicam' : null;
      if (!kind) return ctx.err(p, i, `Kit ${code}: không rõ loại kit (Multicam hay iPhone Mono).`);
      let status = g('status') ? pick(KIT_STATUS, g('status')) : null;
      const sv = g('site');
      let site = null;
      if (sv) { const r = siteByCell(ctx, sv); if (r.site) site = r.site; else ctx.recon(p, 'high', 'kit', `kitcode:${code}:site`, `Kit ${code} ghi đặt tại "${str(sv, 60)}" nhưng không tìm thấy BO này${r.many ? ' (trùng nhiều BO)' : ''}.`, null, 'logistics'); }
      if (!status) status = site ? 'at_bo' : 'ready';
      if (status === 'at_bo' && !site) { ctx.recon(p, 'high', 'kit', `kitcode:${code}:nosite`, `Kit ${code} ghi "đang ở BO" nhưng không rõ BO nào; đã nhập ở trạng thái "Đã về VP, chờ Tech check-in". Xác minh vị trí thật của kit.`, null, 'logistics'); status = 'returned'; }
      if (site && status !== 'at_bo') { ctx.recon(p, 'mid', 'kit', `kitcode:${code}:siteok`, `Kit ${code} có ghi "${boLabel(site.name)}" nhưng trạng thái không phải "tại BO"; đã bỏ thông tin BO.`, null, 'logistics'); site = null; }
      const acc = {};
      for (const k of accCols) { const n = int(g(k), 0, 99); if (n) acc[k.slice(4)] = n; }
      let kit = store.kits.find({ code }, { limit: 1 })[0];
      const t = now();
      let fresh = false;
      if (kit) {
        if (kit.kind !== kind) ctx.recon(p, 'mid', 'kit', `kit:${kit.id}:kind`, `Kit ${code}: loại trên hệ thống "${KIT_KINDS[kit.kind]}", trong file "${KIT_KINDS[kind]}".`, null, 'logistics');
        if (kit.status !== status) ctx.recon(p, 'mid', 'kit', `kit:${kit.id}:status`, `Kit ${code}: trạng thái trên hệ thống "${kit.status}", trong file "${status}". Không đổi tự động.`, null, 'logistics');
        if (Object.keys(acc).length && JSON.stringify(kit.acc || {}) !== JSON.stringify(acc)) { if (!Object.keys(kit.acc || {}).length) store.kits.update(kit.id, { acc, updated_at: t }); else ctx.recon(p, 'low', 'kit', `kit:${kit.id}:acc`, `Kit ${code}: phụ kiện trong file khác trên hệ thống.`, { file: acc, current: kit.acc }, 'logistics'); }
        ctx.st(p).unchanged++;
      } else {
        kit = { code, kind, status, site_id: site ? site.id : null, request_id: null, acc, note: str(g('note'), 300), checked_at: status === 'ready' || status === 'at_bo' ? t : null, checked_by: null, created_at: t, updated_at: t, watch: null, fault: status === 'at_tech' ? 'Nhập từ file: đang sửa / hỏng' : null };
        kit.id = store.kits.insert(kit);
        fresh = true;
        ctx.st(p).created++;
        // Việc kéo theo (sửa, check-in) tạo sau khi nhập thật, để chạy thử không giao việc hay gửi thông báo cho ai.
        if (status === 'at_tech') ctx.afterJobs.push({ type: 'repair', kit_id: kit.id, title: `Sửa kit ${code}`, note: 'Nhập từ file ở trạng thái đang sửa / hỏng', dedupe: `repair:${kit.id}:open` });
        if (status === 'returned') ctx.afterJobs.push({ type: 'checkin', kit_id: kit.id, title: `Check-in kit ${code}`, dedupe: `checkin:${kit.id}:import` });
      }
      const offRetired = [];
      for (const [dc, tp] of codes) {
        if (!/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(dc)) { ctx.st(p).notes.add('Có mã thiết bị không hợp lệ trong kit, đã bỏ qua.'); continue; }
        if (kit.status === 'retired') { offRetired.push(dc); continue; }
        let d = store.devices.find({ code: dc }, { limit: 1 })[0];
        if (!d) {
          if (store.cards.count({ code: dc })) { ctx.recon(p, 'mid', 'device', `devcode:${dc}:card`, `Kit ${code} có thiết bị ${dc} trùng mã thẻ nhớ; chưa tạo.`, null, 'logistics'); continue; }
          if (!tp) { ctx.recon(p, 'mid', 'device', `devcode:${dc}:unknown`, `Kit ${code} có thiết bị ${dc} chưa có trong kho và không rõ loại; chưa gắn.`, null, 'logistics'); continue; }
          store.devices.insert({ code: dc, type: tp, cond: 'ok', kit_id: kit.id, health: tp === 'powerbank' ? 'good' : null, note: '', created_at: t, updated_at: t });
          ctx.st(p).notes.add('Thiết bị trong kit chưa có trong kho được tạo mới theo cột loại.');
          continue;
        }
        if (d.kit_id === kit.id) continue;
        if (d.kit_id) { const other = store.kits.get(d.kit_id); ctx.recon(p, 'high', 'device', `dev:${d.id}:twokits`, `Thiết bị ${dc} ghi trong kit ${code} nhưng đang thuộc kit ${other ? other.code : '?'}; không chuyển tự động.`, null, 'logistics'); continue; }
        const why = joinBlock(kit, d);
        if (why) { ctx.recon(p, 'mid', 'device', `dev:${d.id}:join`, `Thiết bị ${dc} ghi trong kit ${code} nhưng ${why}; chưa gắn.`, null, 'logistics'); continue; }
        if (d.cond !== 'ok') ctx.recon(p, 'mid', 'device', `dev:${d.id}:cond`, `Thiết bị ${dc} trong kit ${code} đang ở tình trạng "${d.cond}".`, null, 'tech');
        store.devices.update(d.id, { kit_id: kit.id, updated_at: t });
      }
      if (offRetired.length) ctx.recon(p, 'mid', 'kit', `kitcode:${code}:retired`, `Kit ${code} ngừng dùng nhưng file ghi có thiết bị ${offRetired.join(', ')}; chưa gắn (kit ngừng dùng không giữ thiết bị). Thiết bị còn dùng thì nhập ở sheet Thiết bị.`, null, 'logistics');
      // Thiết bị nhập trước với cột kit (kit chưa có lúc đó).
      for (const [dc, kc] of ctx.pendingKit || []) if (kc === code) {
        const d = store.devices.find({ code: dc }, { limit: 1 })[0];
        if (!d || d.kit_id) continue;
        const why = joinBlock(kit, d);
        if (why) ctx.recon(p, 'mid', 'device', `dev:${d.id}:join`, `Thiết bị ${dc} ghi thuộc kit ${code} nhưng ${why}; chưa gắn.`, null, 'logistics');
        else store.devices.update(d.id, { kit_id: kit.id, updated_at: t });
      }
      // Kit mới ghi "Sẵn sàng" (đã kiểm đạt) mà không đủ thiết bị dùng được: chưa coi là đã kiểm, nhập ở "Đang chuẩn bị" để bổ sung rồi gửi kiểm.
      if (fresh && kit.status === 'ready') {
        const c = H.stock.completeness(kit, H.stock.kitDevices(kit.id));
        if (!c.complete) {
          store.kits.update(kit.id, { status: 'preparing', checked_at: null, updated_at: t });
          ctx.recon(p, 'mid', 'kit', `kitcode:${code}:incomplete`, `Kit ${code} ghi "Sẵn sàng" nhưng ${c.missing.length ? `thiếu ${c.missing.join(', ')}` : 'có thiết bị chưa tốt'}; đã nhập ở trạng thái "Đang chuẩn bị". Bổ sung thiết bị rồi gửi kiểm.`, null, 'logistics');
        }
      }
    });
  };

  RUN.cards = (p, ctx) => {
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const code = str(g('code'), 40).toUpperCase().replace(/\s+/g, '');
      if (!code || !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(code)) return ctx.err(p, i, `Mã thẻ "${code}" không hợp lệ.`);
      let status = g('status') ? pick(CARD_STATUS, g('status')) : null;
      let site = null;
      if (g('site')) { const r = siteByCell(ctx, g('site')); if (r.site) site = r.site; else ctx.recon(p, 'mid', 'card', `cardcode:${code}:site`, `Thẻ ${code} ghi ở "${str(g('site'), 60)}" nhưng không tìm thấy BO này.`, null, 'logistics'); }
      if (!status) status = site ? 'at_bo' : 'office';
      if (status === 'at_bo' && !site) { ctx.recon(p, 'mid', 'card', `cardcode:${code}:nosite`, `Thẻ ${code} ghi "tại BO" nhưng không rõ BO; đã nhập ở trạng thái "Đã thu về VP".`, null, 'logistics'); status = 'returned'; }
      if (status !== 'at_bo') site = null;
      const ex = store.cards.find({ code }, { limit: 1 })[0];
      const t = now();
      if (ex) { if (ex.status !== status) ctx.recon(p, 'low', 'card', `card:${ex.id}:status`, `Thẻ ${code}: trạng thái trên hệ thống "${ex.status}", trong file "${status}".`, null, 'logistics'); ctx.st(p).unchanged++; return; }
      if (store.devices.count({ code })) return ctx.err(p, i, `Mã ${code} đang là mã thiết bị.`);
      store.cards.insert({ code, status, site_id: site ? site.id : null, kit_id: null, handover_id: null, task_id: null, since: t, note: str(g('note'), 200), created_at: t, updated_at: t, bo_in: status === 'at_bo' ? t : null, bo_out: null });
      ctx.st(p).created++;
    });
  };

  RUN.records = (p, ctx) => {
    const gbh = H.cfg().gbPerHour;
    const seen = new Set(), unknown = new Map(); // mã thẻ không có trong kho → số dòng
    let minD = null, maxD = null;
    const parsed = [];
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const code = str(g('card'), 40).toUpperCase().replace(/\s+/g, '');
      const date = dateOf(g('date'));
      if (!code) return ctx.err(p, i, 'Thiếu mã thẻ.');
      if (!date) return ctx.err(p, i, `Thẻ ${code}: ngày quay không đọc được.`);
      if (date > today()) return ctx.err(p, i, `Thẻ ${code}: ngày quay ở tương lai.`);
      let gb = num(g('gb')), hours = num(g('hours'));
      if (gb === null && hours === null) return ctx.err(p, i, `Thẻ ${code}: thiếu dung lượng hoặc giờ quay.`);
      if (gb === null) gb = +(hours * gbh).toFixed(2);
      if (hours === null) hours = +(gb / gbh).toFixed(2);
      if (gb < 0 || gb > 2048 || hours < 0 || hours > 48) return ctx.err(p, i, `Thẻ ${code}: dung lượng / giờ ngoài khoảng hợp lệ.`);
      const card = store.cards.find({ code }, { limit: 1 })[0];
      let site = null;
      if (g('site')) { const r = siteByCell(ctx, g('site')); site = r.site || null; if (!site) { ctx.recon(p, 'mid', 'record', `rec:${norm(g('site'))}`, `Lịch sử dung lượng: "${boLabel(str(g('site'), 60))}" không tìm thấy; các dòng của BO này chưa nhập.`, null, 'tech'); ctx.st(p).skipped++; return; } }
      else if (card && card.site_id) site = store.sites.get(card.site_id);
      if (!site) return ctx.err(p, i, `Thẻ ${code}: không rõ BO.`);
      const kc = str(g('kit'), 40).toUpperCase().replace(/\s+/g, '');
      const kit = kc ? store.kits.find({ code: kc }, { limit: 1 })[0] : null;
      const key = `${code}|${date}|${site.id}`;
      if (seen.has(key)) { ctx.st(p).unchanged++; return; }
      seen.add(key);
      parsed.push({ code, date, gb: +gb.toFixed(2), hours: +hours.toFixed(2), site, card, kit, zero: gb === 0 ? str(g('zero_reason'), 120) || 'Nhập từ file' : null });
      if (!minD || date < minD) minD = date; if (!maxD || date > maxD) maxD = date;
    });
    if (!parsed.length) return;
    const have = new Set(store.card_records.find({ shoot_date: { gte: minD, lte: maxD } }).map((r) => `${r.code}|${r.shoot_date}|${r.site_id}`));
    for (const r of parsed) {
      if (have.has(`${r.code}|${r.date}|${r.site.id}`)) { ctx.st(p).unchanged++; continue; }
      if (!r.card) unknown.set(r.code, (unknown.get(r.code) || 0) + 1);
      store.card_records.insert({ card_id: r.card ? r.card.id : null, code: r.code, site_id: r.site.id, kit_id: r.kit ? r.kit.id : null, handover_id: null, shoot_date: r.date, gb: r.gb, hours: r.hours, zero_reason: r.zero, photos: null, by_id: null, at: atTime(r.date, '12:00', off), edited_by: null, edited_at: null, src: 'import' });
      ctx.st(p).created++;
    }
    // Lịch sử chỉ có ngày quay: giờ của thẻ chia tới hôm trước lần đổi thẻ kế tiếp của BO (dòng cuối chưa rõ thì chỉ tính ngày quay, không xét chuẩn).
    const filled = H.outlets.fillCover([...new Set(parsed.map((r) => r.site.id))]);
    ctx.st(p).notes.add(`Lịch sử từ ${minD} đến ${maxD}: vào số giờ quay của BO, không tính điểm khối lượng của ai.`);
    // Mã thẻ không có trong kho: vẫn giữ lịch sử giờ quay (không tự tạo thẻ, không tự sửa mã); gom thành một dòng Đối chiếu cho Tech kiểm mã thẻ.
    if (unknown.size) {
      const codes = [...unknown.keys()].sort(), rows = [...unknown.values()].reduce((a, n) => a + n, 0);
      const list = codes.slice(0, 12).map((c) => (unknown.get(c) > 1 ? `${c} (${unknown.get(c)} dòng)` : c)).join(', ') + (codes.length > 12 ? `, … và ${codes.length - 12} thẻ khác` : '');
      ctx.recon(p, 'mid', 'record', `cardcode:${codes[0]}${codes.length > 1 ? `+${codes.length - 1}` : ''}:record`, `Lịch sử dung lượng: ${codes.length} mã thẻ không có trong kho, ${rows} dòng đã nhập vào giờ quay của BO: ${list}. Kiểm mã thẻ: thêm thẻ vào kho hoặc sửa bản ghi.`, { codes: codes.slice(0, 200), rows }, 'tech');
      ctx.st(p).notes.add('Có mã thẻ chưa có trong kho: lịch sử vẫn nhập, đã đưa vào Đối chiếu cho Tech.');
    }
    if (filled) ctx.st(p).notes.add(`Giờ của ${filled} thẻ chia cho các ngày tới lần đổi thẻ kế tiếp của BO; dòng chưa rõ lần đổi kế tiếp chỉ tính ngày quay và chưa dùng để xét chuẩn giờ quay.`);
  };

  RUN.incidents = (p, ctx) => {
    const L = H.labels(), all = [...new Set(Object.values(L).flat())];
    p.rows.forEach((row, i) => {
      if (blank(row)) return;
      const g = (k) => cell(row, p.mapping, k);
      const date = dateOf(g('date'));
      if (!date) return ctx.err(p, i, 'Ngày báo không đọc được.');
      const r = siteByCell(ctx, g('site'));
      if (!r.site) return ctx.err(p, i, `"${boLabel(str(g('site'), 60))}" không tìm thấy${r.many ? ' (trùng nhiều BO)' : ''}.`);
      const raw = str(g('label'), 60);
      if (!raw) return ctx.err(p, i, 'Thiếu nhãn lỗi.');
      const label = all.find((x) => norm(x) === norm(raw)) || raw;
      if (!all.includes(label)) ctx.st(p).notes.add('Có nhãn lỗi ngoài bộ nhãn hiện tại; giữ nguyên tên để thống kê, Tech chuẩn hoá sau ở Cài đặt.');
      const kc = str(g('kit'), 40).toUpperCase().replace(/\s+/g, '');
      const kit = kc ? store.kits.find({ code: kc }, { limit: 1 })[0] : null;
      const status = g('status') ? pick(INC_STATUS, g('status')) || 'open' : (g('resolution') || g('resolved_date') ? 'resolved' : 'open');
      const res = g('resolution') ? pick(INC_RES, g('resolution')) : null;
      const t0 = atTime(date, '12:00', off);
      if (store.incidents.count({ site_id: r.site.id, label, created_at: { gte: atTime(date, '00:00', off), lt: atTime(addDays(date, 1), '00:00', off) } })) { ctx.st(p).unchanged++; return; }
      const rd = dateOf(g('resolved_date'));
      store.incidents.insert({ code: H.nextCode('S' + date.slice(2, 4) + date.slice(5, 7) + '-', 'incidents', 3), site_id: r.site.id, kit_id: kit ? kit.id : null, device_id: null, label, text: cleanText(String(g('text') ?? ''), 500) || label, status: status === 'open' ? 'open' : status, raised_by: null, raised_role: 'import', resolution: status === 'resolved' ? res || 'no_recover' : null, resolve_note: status === 'resolved' ? 'Nhập từ file' : null, resolved_by: null, created_at: t0, ack_at: status === 'resolved' ? t0 : null, resolved_at: status === 'resolved' ? (rd ? atTime(rd, '12:00', off) : t0) : null, src: 'import' });
      if (status === 'open') ctx.recon(p, 'mid', 'incident', `inc:${r.site.id}:${norm(label)}:${date}`, `Sự cố "${label}" tại ${r.site.name} ngày ${date} trong file chưa đóng. Tech kiểm tra: còn lỗi thì báo sự cố mới để có việc xử lý, hết lỗi thì huỷ.`, null, 'tech');
      ctx.st(p).created++;
    });
  };

  async function importUsers(p, ctx) {
    const seen = new Set();
    for (const [i, row] of p.rows.entries()) {
      if (blank(row)) continue;
      const g = (k) => cell(row, p.mapping, k);
      const name = str(g('name'), 60);
      const role = g('role') ? pick(ROLE_MAP, g('role')) : null;
      if (!name) { ctx.err(p, i, 'Thiếu họ tên.'); continue; }
      if (!role) { ctx.err(p, i, `${name}: vai trò "${str(g('role'), 30)}" không nhận ra.`); continue; }
      const email = str(g('email'), 120).toLowerCase();
      let username = str(g('username'), 60).toLowerCase() || (email ? email.split('@')[0] : norm(name).split(' ').slice(-1)[0] + '.' + norm(name).split(' ')[0]);
      username = username.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9._@-]/g, '').slice(0, 40);
      const ex = userBy(ctx, email || username) || userBy(ctx, name);
      if (ex && !ex.many) { ctx.st(p).unchanged++; if (ex.role !== role) ctx.recon(p, 'low', 'user', `user:${ex.id}:role`, `Tài khoản ${ex.name}: vai trò trên hệ thống "${H.ROLE_LABEL[ex.role] || ex.role}", trong file "${H.ROLE_LABEL[role]}". Không đổi tự động.`, null, 'tech'); continue; }
      if (seen.has(username) || store.users.count({ username })) { ctx.err(p, i, `${name}: tên đăng nhập ${username} đã có.`); continue; }
      seen.add(username);
      if (!ctx.commit) { ctx.virtualUsers.push({ id: -(ctx.virtualUsers.length + 1), name, username, email, phone: str(g('phone'), 20), role }); ctx.st(p).created++; continue; }
      try {
        const r = await K.createUser({ name, username, email, phone: str(g('phone'), 20), role }, ctx.user);
        ctx.newUsers.push({ name, username, role_label: H.ROLE_LABEL[role], tempPassword: r.tempPassword });
        ctx.st(p).created++;
      } catch (e) { ctx.err(p, i, `${name}: ${e.msg || e.message}`); }
    }
  }

  /** Sau khi nhập: kiểm các chỗ có thể lệch giữa các bảng (đưa vào Đối chiếu, không sửa). */
  function afterChecks(ctx) {
    const p = { sheet: { name: 'kiểm tra chung' }, target: 'kits', header_row: 0, rows: [] };
    for (const a of H.stock.accSummary()) if (a.free < 0) ctx.recon(p, 'high', 'acc', `acc:${a.id}:neg`, `${a.name}: số trong kit (${a.in_kits}) nhiều hơn tổng kho (${a.total}). Kiểm kê lại tổng ở mục Phụ kiện.`, null, 'logistics');
    for (const s of store.sites.find({ active: 1, type: 'bo', ops_status: 'live' })) if (!store.kits.count({ site_id: s.id, status: 'at_bo' })) ctx.recon(p, 'mid', 'outlet', `bo:${s.id}:nokit`, `${boLabel(s.name)} đang ghi hình nhưng chưa có kit nào ghi ở BO này.`, null, 'logistics');
    for (const k of store.kits.find({ status: 'at_bo' })) { const s = store.sites.get(k.site_id); if (s && s.ops_status === 'planned') ctx.recon(p, 'mid', 'kit', `kit:${k.id}:planned`, `Kit ${k.code} ghi ở ${s.name} nhưng BO đang "Chờ launch". Kiểm tra trạng thái BO.`, null, 'sale'); }
    // Thống kê chung không thuộc sheet nào: tính vào sheet đầu tiên có trong báo cáo.
    ctx.st(p);
  }

  // ───────── Dòng Đối chiếu ghi trước khi có tiền tố riêng ─────────
  // Bản cũ ghi dòng theo mã / tên chung tiền tố với dòng theo số thứ tự (imp:card:0002:site), màn Đối chiếu đọc nhầm mã thành số thứ tự
  // và nhập lại cùng file sinh dòng trùng. Đổi một lần khi khởi động; hậu tố cho biết dòng theo mã hay theo số thứ tự (dev:…:cond theo mã là mức thấp).
  const OLD_REF = [
    [/^imp:card:(.+:(?:site|nosite))$/, 'cardcode'], [/^imp:kit:(.+:(?:site|nosite|siteok))$/, 'kitcode'], [/^imp:dev:(.+:(?:type|unknown))$/, 'devcode'],
    [/^imp:dev:(.+:cond)$/, 'devcode', (r) => r.level === 'low'], [/^imp:bo:(.+:(?:sale|\d*))$/, 'boname'],
  ];
  const moved = [];
  for (const r of store.recon.find({ source: 'import' })) {
    for (const [re, pre, only] of OLD_REF) { const m = re.exec(r.ref || ''); if (m && (!only || only(r))) { moved.push([r.id, `imp:${pre}:${m[1]}`]); break; } }
  }
  if (moved.length) {
    store.tx(() => {
      for (const [id, ref] of moved) store.recon.update(id, { ref });
      log('recon', null, 'migrate', `Hệ thống đổi mã tham chiếu của ${moved.length} dòng Đối chiếu từ file nhập (theo mã thẻ, mã kit, mã thiết bị, tên BO) sang tiền tố riêng để không mở nhầm kit, thẻ, BO.`, null, { rows: moved.length });
    });
  }

  return { targets, guessSheet, dateOf, timeOf, weekdaysOf, coordOf, norm };
}
