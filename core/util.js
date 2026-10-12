// util.js — tiện ích thuần (không phụ thuộc Node), dùng chung cho máy chủ và bản xem thử.

const RAD = Math.PI / 180;

/** Khoảng cách đường chim bay giữa 2 toạ độ, tính bằng mét. */
export function distM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD, dLon = (bLon - aLon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bearingDeg(aLat, aLon, bLat, bLon) {
  const y = Math.sin((bLon - aLon) * RAD) * Math.cos(bLat * RAD);
  const x = Math.cos(aLat * RAD) * Math.sin(bLat * RAD) - Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLon - aLon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Số hữu hạn hoặc null (chuỗi rỗng, NaN, undefined → null). */
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
/** Số nguyên trong [min, max] hoặc null. */
export function int(v, min, max) {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
export function cleanStr(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
/** Giữ xuống dòng (cho ghi chú, điều khoản). */
export function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
export const validCoord = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

// ───────────── Thời gian theo múi giờ cố định (Việt Nam: UTC+7, không đổi giờ mùa) ─────────────
const pad2 = (n) => String(n).padStart(2, '0');
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
/** Tên BO kèm chữ "BO" phía trước, trừ khi tên đã bắt đầu bằng "BO" (tránh "BO BO Quận 7"). */
export const boLabel = (name) => { const n = String(name ?? '').trim(); return /^bo(\s|$)/i.test(n) ? n : `BO ${n}`; };
export const isHM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
/** 'YYYY-MM-DD' của mốc ts theo múi giờ offMin phút. */
export const localDate = (ts, offMin) => new Date(ts + offMin * 60000).toISOString().slice(0, 10);
/** Mốc ts của 00:00 ngày dateStr theo múi giờ offMin. */
export const dayStart = (dateStr, offMin) => Date.parse(dateStr + 'T00:00:00Z') - offMin * 60000;
export const atTime = (dateStr, hm, offMin) => dayStart(dateStr, offMin) + (+hm.slice(0, 2) * 60 + +hm.slice(3, 5)) * 60000;
export function localHM(ts, offMin) {
  const d = new Date(ts + offMin * 60000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** Thứ trong tuần: 1 = Thứ Hai … 7 = Chủ nhật. */
export function weekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}
export function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
/** Phút trong ngày (0–1439) của ts theo múi giờ. */
export function minuteOfDay(ts, offMin) {
  const d = new Date(ts + offMin * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ───────────── Tuyến đường ─────────────
/** Tổng quãng đường chim bay (m) qua các điểm theo thứ tự. */
export function pathM(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  return s;
}
/**
 * Sắp lại thứ tự điểm dừng cho quãng đường ngắn nhất, giữ nguyên điểm đầu.
 * roundTrip: tính cả chặng quay về điểm đầu. ≤ 9 điểm: thử mọi hoán vị (tối ưu thật); nhiều hơn: láng giềng gần nhất + 2-opt.
 * Trả về mảng chỉ số theo thứ tự mới.
 */
export function optimizeOrder(pts, roundTrip = false) {
  const n = pts.length;
  const idx = pts.map((_, i) => i);
  if (n <= 2) return idx;
  const D = pts.map((a) => pts.map((b) => distM(a.lat, a.lon, b.lat, b.lon)));
  const len = (order) => {
    let s = 0;
    for (let i = 1; i < order.length; i++) s += D[order[i - 1]][order[i]];
    return roundTrip ? s + D[order[order.length - 1]][order[0]] : s;
  };
  let best = idx.slice(), bestLen = len(best);
  if (n <= 9) {
    const rest = idx.slice(1), cur = [0];
    const used = new Array(n).fill(false);
    const walk = (acc) => {
      if (acc >= bestLen) return; // cắt nhánh
      if (cur.length === n) {
        const total = roundTrip ? acc + D[cur[n - 1]][0] : acc;
        if (total < bestLen - 1e-6) { bestLen = total; best = cur.slice(); }
        return;
      }
      for (const j of rest) {
        if (used[j]) continue;
        used[j] = true; cur.push(j);
        walk(acc + D[cur[cur.length - 2]][j]);
        cur.pop(); used[j] = false;
      }
    };
    walk(0);
    return best;
  }
  // Láng giềng gần nhất
  const order = [0], left = new Set(idx.slice(1));
  while (left.size) {
    const last = order[order.length - 1];
    let pick = -1, pd = Infinity;
    for (const j of left) if (D[last][j] < pd) { pd = D[last][j]; pick = j; }
    order.push(pick); left.delete(pick);
  }
  // 2-opt
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (len(cand) < len(order) - 1e-6) { order.splice(0, n, ...cand); improved = true; }
      }
    }
  }
  return len(order) < bestLen ? order : best;
}

// ───────────── Đường đi theo đường phố ("encoded polyline" của Google, độ chính xác 5 chữ số) ─────────────
/** Chuỗi polyline → [[vĩ độ, kinh độ], ...]. Chuỗi hỏng thì dừng ở điểm cuối còn đọc được. */
export function decodePolyline(str, precision = 5) {
  const out = [], f = 10 ** precision;
  if (typeof str !== 'string') return out;
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let res = 0, shift = 0, b;
    do {
      b = i < str.length ? str.charCodeAt(i++) - 63 : -1;
      if (b < 0 || b > 63 || shift > 30) return null;
      res += (b & 31) * 2 ** shift; shift += 5;
    } while (b >= 32);
    return res % 2 ? -(res + 1) / 2 : res / 2;
  };
  while (i < str.length) {
    const dLat = next(), dLon = dLat === null ? null : next();
    if (dLat === null || dLon === null) break;
    lat += dLat; lon += dLon;
    out.push([+(lat / f).toFixed(precision), +(lon / f).toFixed(precision)]);
  }
  return out;
}
/** [[vĩ độ, kinh độ], ...] (hoặc [{ lat, lon }, ...]) → chuỗi polyline. */
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    let x = v < 0 ? -v * 2 - 1 : v * 2, s = '';
    while (x >= 32) { s += String.fromCharCode((32 | (x % 32)) + 63); x = Math.floor(x / 32); }
    return s + String.fromCharCode(x + 63);
  };
  for (const p of Array.isArray(points) ? points : []) {
    const la = Array.isArray(p) ? p[0] : p && p.lat, lo = Array.isArray(p) ? p[1] : p && p.lon;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const lat = Math.round(la * f), lon = Math.round(lo * f);
    out += enc(lat - pLat) + enc(lon - pLon);
    pLat = lat; pLon = lon;
  }
  return out;
}
/**
 * Chiếu một toạ độ lên đường đi [[vĩ độ, kinh độ], ...]: lấy đoạn gần nhất (xấp xỉ mặt phẳng, đủ chính xác trong phạm vi thành phố).
 * Trả về { idx: đoạn thứ mấy, t: vị trí trên đoạn (0–1), distAlongM: quãng từ đầu đường tới điểm chiếu, totalM: dài cả đường, offM: cách đường (m) }; đường rỗng → null.
 */
export function projectOnPath(path, lat, lon) {
  if (!Array.isArray(path) || !path.length) return null;
  const kx = Math.cos(lat * RAD) * 6371000 * RAD, ky = 6371000 * RAD; // mét trên một độ quanh điểm cần chiếu
  const xy = (p) => [(p[1] - lon) * kx, (p[0] - lat) * ky];
  let [ax, ay] = xy(path[0]), total = 0, best = { idx: 0, t: 0, distAlongM: 0, offM: Math.hypot(ax, ay) };
  for (let i = 0; i < path.length - 1; i++) {
    const [bx, by] = xy(path[i + 1]), dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const t = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.offM) best = { idx: i, t, distAlongM: total + t * len, offM: off };
    total += len; ax = bx; ay = by;
  }
  return { ...best, totalM: total };
}
/** Phần đường còn lại, bắt đầu từ điểm chiếu (đoạn fromIdx, vị trí fromT của projectOnPath) tới cuối đường. */
export function slicePath(path, fromIdx, fromT) {
  if (!Array.isArray(path) || !path.length) return [];
  const i = Math.min(Math.max(0, Math.floor(fromIdx) || 0), path.length - 1), t = Math.min(1, Math.max(0, +fromT || 0));
  const a = path[i], b = path[i + 1];
  if (!b) return [a];
  if (t >= 1) return path.slice(i + 1);
  return [[+(a[0] + (b[0] - a[0]) * t).toFixed(6), +(a[1] + (b[1] - a[1]) * t).toFixed(6)], ...path.slice(i + 1)];
}

/** Kiểm tra chữ ký tệp ảnh. Trả về mime hoặc null. */
export function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
/** data:image/...;base64,xxx → { mime, bytes } hoặc null nếu không phải ảnh hợp lệ. */
export function decodeDataUrl(s, maxBytes) {
  if (typeof s !== 'string') return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return null;
  if (m[2].length * 0.75 > maxBytes + 3) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!bytes.length || bytes.length > maxBytes) return null;
  const mime = sniffImage(bytes);
  if (!mime || mime !== 'image/' + m[1]) return null;
  return { mime, bytes };
}

export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // chặn công thức khi mở bằng Excel
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
