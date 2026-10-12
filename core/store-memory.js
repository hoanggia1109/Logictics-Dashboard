// store-memory.js — kho dữ liệu trong bộ nhớ, cùng giao diện với kho SQLite.
// Dùng cho bản xem thử chạy trong trình duyệt và để kiểm thử lõi nghiệp vụ.
import { createVersions, PARTS } from './store-ver.js';

const OPS = ['gte', 'gt', 'lte', 'lt', 'ne'];
export function matchWhere(row, where) {
  for (const k in where) {
    const w = where[k], v = row[k] ?? null;
    if (w === null || w === undefined) { if (v !== null) return false; }
    else if (Array.isArray(w)) { if (!w.includes(v)) return false; }
    else if (typeof w === 'object') {
      for (const op of Object.keys(w)) if (!OPS.includes(op)) throw new Error('unknown operator ' + op);
      if (w.gte !== undefined && !(v !== null && v >= w.gte)) return false;
      if (w.gt !== undefined && !(v !== null && v > w.gt)) return false;
      if (w.lte !== undefined && !(v !== null && v <= w.lte)) return false;
      if (w.lt !== undefined && !(v !== null && v < w.lt)) return false;
      if (w.ne !== undefined && v === w.ne) return false;
    } else if (v !== w) return false;
  }
  return true;
}
const clone = (o) => (o === null || o === undefined ? o : JSON.parse(JSON.stringify(o)));

export function createMemoryStore(schema) {
  const tables = {};
  let journal = null; // trong giao dịch: danh sách thao tác hoàn tác
  const undo = (fn) => { if (journal) journal.push(fn); };
  let after = null; // trong giao dịch: việc chờ chạy sau khi ghi xong
  const runAll = (list) => { for (const f of list) { try { f(); } catch { /* việc sau ghi lỗi thì bỏ qua, dữ liệu đã ghi xong */ } } };
  const V = createVersions(); // số phiên bản dữ liệu theo bảng, như kho SQLite
  for (const [name, def] of Object.entries(schema)) {
    const rows = new Map();
    const part = PARTS[name] || null;
    const partOf = (r) => (part ? [r[part] ?? null] : null);
    let seq = 0;
    const cols = ['id', ...Object.keys(def.cols)];
    const normalize = (row) => {
      const out = {};
      for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
      return out;
    };
    const checkCols = (obj) => { for (const k in obj) if (!cols.includes(k)) throw new Error(`${name}: cột không tồn tại "${k}"`); };
    tables[name] = {
      insert(row) {
        checkCols(row);
        const r = normalize(clone(row));
        if (def.idType === 'text') { if (typeof r.id !== 'string' || !r.id) throw new Error(`${name}: thiếu id`); } else if (r.id === null) r.id = ++seq; else seq = Math.max(seq, r.id);
        if (rows.has(r.id)) throw new Error(`${name}: trùng id ${r.id}`);
        rows.set(r.id, r);
        undo(() => rows.delete(r.id));
        V.wrote(name, partOf(r));
        return r.id;
      },
      get(id) { V.read(name, part === 'id' ? 'id' : null, id); return clone(rows.get(id)) ?? null; },
      update(id, patch) {
        checkCols(patch);
        const r = rows.get(id);
        if (!r) return false;
        const before = { ...r };
        undo(() => rows.set(id, before));
        Object.assign(r, clone(patch));
        for (const c of cols) if (r[c] === undefined) r[c] = null;
        V.wrote(name, part ? [before[part] ?? null, r[part] ?? null] : null);
        return true;
      },
      remove(id) {
        const r = rows.get(id);
        if (!r) return false;
        undo(() => rows.set(id, r));
        V.wrote(name, partOf(r));
        return rows.delete(id);
      },
      find(where = {}, opt = {}) {
        V.read(name, part, part ? where[part] : undefined);
        checkCols(where);
        let out = [];
        for (const r of rows.values()) if (matchWhere(r, where)) out.push(r);
        const order = opt.order || 'id', desc = !!opt.desc;
        out.sort((a, b) => {
          const x = a[order], y = b[order];
          const c = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
          return (desc ? -c : c) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (desc ? -1 : 1);
        });
        if (opt.limit) out = out.slice(0, opt.limit);
        if (opt.cols) { // chỉ lấy các cột cần (luôn kèm id), giống kho SQLite
          checkCols(Object.fromEntries(opt.cols.map((c) => [c, 1])));
          const pick = ['id', ...opt.cols.filter((c) => c !== 'id')];
          return clone(out.map((r) => Object.fromEntries(pick.map((c) => [c, r[c] ?? null]))));
        }
        return clone(out);
      },
      count(where = {}) { V.read(name, part, part ? where[part] : undefined); checkCols(where); let n = 0; for (const r of rows.values()) if (matchWhere(r, where)) n++; return n; },
      removeWhere(where) {
        checkCols(where);
        let n = 0;
        for (const [id, r] of rows) if (matchWhere(r, where)) { undo(() => rows.set(id, r)); rows.delete(id); n++; }
        if (n) V.wrote(name, part ? V.ALL : null);
        return n;
      },
    };
  }
  return {
    ...tables,
    /** Gói nhiều thao tác thành một giao dịch: lỗi giữa chừng thì hoàn tác toàn bộ. */
    tx(fn) {
      if (journal) { // giao dịch lồng: lỗi ở trong chỉ hoàn tác phần của nó (như SAVEPOINT)
        const mark = journal.length, amark = after.length;
        try { return fn(); } catch (e) { for (let i = journal.length - 1; i >= mark; i--) journal[i](); journal.length = mark; after.length = amark; throw e; }
      }
      journal = []; after = [];
      const s0 = V.seq();
      try {
        const out = fn();
        const a = after; journal = null; after = null;
        if (V.seq() !== s0) V.wrote('__tx', null); // giao dịch có ghi: thêm một nhịp phiên bản lúc ghi xong
        runAll(a);
        return out;
      } catch (e) {
        const j = journal; journal = null; after = null;
        for (let i = j.length - 1; i >= 0; i--) j[i]();
        if (V.seq() !== s0) V.wrote('__tx', null);
        throw e;
      }
    },
    /** Phiên bản dữ liệu (core/store-ver.js), như kho SQLite. */
    version: V.seq,
    track: (fn) => V.track(fn, () => journal !== null),
    fresh: V.fresh,
    adopt: V.adopt,
    noteRead: (table, val) => V.read(table, PARTS[table] || null, val),
    inTx: () => journal !== null,
    /** Việc làm sau khi giao dịch ngoài cùng ghi xong (đẩy thông báo, gửi Slack); giao dịch hoàn tác thì bỏ. Ngoài giao dịch: chạy ngay. */
    afterCommit(fn) { if (after) after.push(fn); else runAll([fn]); },
    /** Việc làm khi phần giao dịch chứa nó bị hoàn tác (xoá bộ nhớ đệm đã đổi theo). */
    onRollback(fn) { undo(fn); },
    close() {},
  };
}
