// period.js — kỳ báo cáo: tuần đánh số theo ISO (thứ Hai đến Chủ nhật, W41…) như cách công ty đang dùng, và tháng dương lịch.
import { addDays, dayStart, isDate } from '../util.js';

const d2 = (n) => String(n).padStart(2, '0');
const utc = (s) => new Date(s + 'T00:00:00Z');
const iso = (dt) => dt.toISOString().slice(0, 10);

/** Thứ Hai của tuần chứa ngày s. */
export function mondayOf(s) { const dt = utc(s); const wd = (dt.getUTCDay() + 6) % 7; return addDays(s, -wd); }
/** '2026-10-08' → '2026-W41' (ISO 8601). */
export function weekKey(s) {
  const dt = utc(s);
  const th = new Date(dt.getTime() + (3 - ((dt.getUTCDay() + 6) % 7)) * 86400000); // thứ Năm của tuần
  const y = th.getUTCFullYear();
  const wk = 1 + Math.floor((th - Date.UTC(y, 0, 1)) / 86400000 / 7);
  return `${y}-W${d2(wk)}`;
}
/** '2026-W41' → { from: thứ Hai, to: Chủ nhật }. */
export function weekRange(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const y = +m[1], w = +m[2];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  const from = iso(new Date(mon1.getTime() + (w - 1) * 7 * 86400000));
  if (weekKey(from) !== key) return null;
  return { from, to: addDays(from, 6) };
}
export const shiftWeek = (key, n) => weekKey(addDays(weekRange(key).from, 7 * n));
export const monthKey = (s) => s.slice(0, 7);
export function monthRange(key) {
  if (!/^\d{4}-\d{2}$/.test(String(key || ''))) return null;
  const [y, m] = key.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  const from = `${key}-01`;
  const to = iso(new Date(Date.UTC(y, m, 0)));
  return { from, to };
}
export function shiftMonth(key, n) { const [y, m] = key.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); return `${dt.getUTCFullYear()}-${d2(dt.getUTCMonth() + 1)}`; }
/** Kỳ theo tham số: period = week | month, key = '2026-W41' | '2026-10'. Thiếu key thì lấy kỳ chứa hôm nay. */
export function periodOf(period, key, today) {
  if (period === 'month') { const k = key && monthRange(key) ? key : monthKey(today); return { period: 'month', key: k, ...monthRange(k), prev: shiftMonth(k, -1) }; }
  const k = key && weekRange(key) ? key : weekKey(today);
  return { period: 'week', key: k, ...weekRange(k), prev: shiftWeek(k, -1) };
}
export const rangeOf = (period, key) => (period === 'month' ? monthRange(key) : weekRange(key));
/** Khoảng thời gian (ms) của một kỳ theo giờ địa phương. */
export const tsRange = (r, off) => ({ t0: dayStart(r.from, off), t1: dayStart(addDays(r.to, 1), off) });
export const weekLabel = (key) => 'W' + key.slice(6);
export const monthLabel = (key) => `T${+key.slice(5)}/${key.slice(0, 4)}`;
export const okDate = isDate;

const dayDiff = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
const minDate = (a, b) => (a < b ? a : b);
/**
 * Khung so sánh WoW / MoM của kỳ P (từ periodOf). Mọi chỉ số "so với kỳ trước" đi qua đây để không so nửa kỳ với cả kỳ.
 * - Kỳ đã qua: cả kỳ với cả kỳ trước.
 * - Kỳ đang chạy: phần đã qua với ĐÚNG phần tương ứng của kỳ trước. ts: số liệu theo thời điểm (việc xong, sự cố) cắt kỳ trước
 *   ở cùng khoảng thời gian đã trôi (T2 00:00 → T5 16:00 so với T2 00:00 → T5 16:00 tuần trước; 1/10 → 8/10 16:00 so với
 *   1/9 → 8/9 16:00). day: số liệu theo ngày (onboard, chấm công) lấy cùng số ngày, tính cả hôm nay.
 * - data: giờ quay theo ngày quay. Thẻ của lagDays ngày gần nhất thường chưa thu về và nhập dung lượng, nên chỉ so tới hết
 *   ngày (hôm nay − lagDays) ở kỳ này và đúng chừng ấy ngày ở kỳ trước. null khi kỳ này chưa có ngày nào đủ dữ liệu.
 * info gửi kèm cho giao diện để ghi rõ đang so với khoảng nào.
 */
export function compareOf(P, today, nowTs, off, lagDays = 0) {
  const prevR = rangeOf(P.period, P.prev);
  const cur = tsRange(P, off), prev = tsRange(prevR, off);
  const running = today >= P.from && today <= P.to;
  const sameDays = (end) => ({ cur: { from: P.from, to: end }, prev: { from: prevR.from, to: minDate(prevR.to, addDays(prevR.from, dayDiff(P.from, end))) } });
  const full = { cur: { from: P.from, to: P.to }, prev: { from: prevR.from, to: prevR.to } };
  const ts = running ? { cur: { t0: cur.t0, t1: nowTs }, prev: { t0: prev.t0, t1: Math.min(prev.t1, prev.t0 + Math.max(0, nowTs - cur.t0)) } } : { cur, prev };
  const day = running ? sameDays(today) : full;
  const lastData = addDays(today, -Math.max(0, lagDays | 0));
  const dataEnd = minDate(P.to, lastData);
  const data = dataEnd < P.from ? null : dataEnd < P.to ? sameDays(dataEnd) : full;
  return {
    running, ts, day, data,
    info: {
      running, lag_days: Math.max(0, lagDays | 0), from: P.from, prev_from: prevR.from,
      day_to: day.cur.to, prev_day_to: day.prev.to, // kỳ đang chạy: tới hôm nay; kỳ trước: tới ngày tương ứng
      data_to: data ? data.cur.to : null, prev_data_to: data ? data.prev.to : null, data_partial: !data || data.cur.to < P.to,
    },
  };
}
