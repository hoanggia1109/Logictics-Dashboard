// store-sqlite.js — kho dữ liệu SQLite (node:sqlite), cùng giao diện với kho bộ nhớ.
import { DatabaseSync } from 'node:sqlite';
import { createVersions, PARTS } from './store-ver.js';

const SQLTYPE = { int: 'INTEGER', real: 'REAL', text: 'TEXT', json: 'TEXT' };
const OPSQL = { gte: '>=', gt: '>', lte: '<=', lt: '<', ne: 'IS NOT' };

export function createSqliteStore(schema, file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const stmts = new Map();
  const prep = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
  const tables = {};
  const V = createVersions(); // số phiên bản dữ liệu theo bảng (bộ nhớ đệm số liệu tổng hợp dựa vào đây)

  for (const [name, def] of Object.entries(schema)) {
    const idDef = def.idType === 'text' ? 'id TEXT PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${idDef}, ${Object.entries(def.cols).map(([c, t]) => `"${c}" ${SQLTYPE[t]}`).join(', ')})`);
    // Nâng cấp phiên bản: bảng cũ thiếu cột mới thì thêm vào, không mất dữ liệu.
    const have = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((r) => r.name));
    for (const [c, t] of Object.entries(def.cols)) if (!have.has(c)) db.exec(`ALTER TABLE ${name} ADD COLUMN "${c}" ${SQLTYPE[t]}`);
    for (const ix of def.index || []) db.exec(`CREATE INDEX IF NOT EXISTS ${name}_${ix.join('_')} ON ${name} (${ix.map((c) => `"${c}"`).join(', ')})`);

    const cols = ['id', ...Object.keys(def.cols)];
    const jsonCols = Object.keys(def.cols).filter((c) => def.cols[c] === 'json');
    const checkCols = (obj) => { for (const k in obj) if (!cols.includes(k)) throw new Error(`${name}: cột không tồn tại "${k}"`); };
    const enc = (c, v) => {
      if (v === undefined || v === null) return null;
      if (def.cols[c] === 'json') return JSON.stringify(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    };
    const dec = (row) => {
      if (!row) return null;
      const out = {};
      for (const c of cols) out[c] = row[c] ?? null;
      if (def.idType !== 'text') out.id = Number(out.id);
      for (const c of jsonCols) if (out[c] !== null) { try { out[c] = JSON.parse(out[c]); } catch { out[c] = null; } }
      return out;
    };
    const whereSql = (where) => {
      checkCols(where);
      const parts = [], args = [];
      for (const k in where) {
        const w = where[k];
        if (w === null || w === undefined) parts.push(`"${k}" IS NULL`);
        else if (Array.isArray(w)) {
          if (!w.length) parts.push('0');
          else { parts.push(`"${k}" IN (${w.map(() => '?').join(',')})`); args.push(...w); }
        } else if (typeof w === 'object') {
          for (const op of Object.keys(w)) {
            if (!OPSQL[op]) throw new Error('unknown operator ' + op);
            parts.push(`"${k}" ${OPSQL[op]} ?`); args.push(w[op]);
          }
        } else { parts.push(`"${k}" = ?`); args.push(typeof w === 'boolean' ? (w ? 1 : 0) : w); }
      }
      return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', args };
    };

    // Bảng chia phiên bản theo cột (PARTS): giá trị cột đó của dòng trước khi sửa / xoá.
    const part = PARTS[name] || null;
    const partOf = (id) => (part === 'id' ? id : (prep(`SELECT "${part}" AS v FROM ${name} WHERE id = ?`).get(id) || { v: null }).v);
    tables[name] = {
      insert(row) {
        checkCols(row);
        const keys = cols.filter((c) => (c === 'id' ? row.id !== undefined && row.id !== null : true));
        if (def.idType === 'text' && (typeof row.id !== 'string' || !row.id)) throw new Error(`${name}: thiếu id`);
        const r = prep(`INSERT INTO ${name} (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((c) => (c === 'id' ? row.id : enc(c, row[c]))));
        V.wrote(name, part ? [row[part] ?? null] : null);
        return def.idType === 'text' ? row.id : Number(row.id ?? r.lastInsertRowid);
      },
      get(id) { V.read(name, part === 'id' ? 'id' : null, id); return dec(prep(`SELECT * FROM ${name} WHERE id = ?`).get(id)); },
      update(id, patch) {
        checkCols(patch);
        const keys = Object.keys(patch).filter((k) => k !== 'id');
        if (!keys.length) return !!this.get(id);
        const old = part ? partOf(id) : null;
        const r = prep(`UPDATE ${name} SET ${keys.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(...keys.map((c) => enc(c, patch[c])), id);
        if (r.changes > 0) V.wrote(name, part ? (part in patch ? [old, patch[part] ?? null] : [old]) : null);
        return r.changes > 0;
      },
      remove(id) {
        const old = part ? partOf(id) : null;
        const n = prep(`DELETE FROM ${name} WHERE id = ?`).run(id).changes;
        if (n > 0) V.wrote(name, part ? [old] : null);
        return n > 0;
      },
      find(where = {}, opt = {}) {
        V.read(name, part, part ? where[part] : undefined);
        const w = whereSql(where);
        const order = opt.order || 'id';
        if (!cols.includes(order)) throw new Error(`${name}: không sắp theo "${order}" được`);
        const dir = opt.desc ? 'DESC' : 'ASC';
        // opt.cols: chỉ đọc các cột cần (bảng tổng hợp đọc nhiều dòng, không cần giải mã cả dòng). Luôn kèm id.
        if (opt.cols) {
          checkCols(Object.fromEntries(opt.cols.map((c) => [c, 1])));
          const pick = ['id', ...opt.cols.filter((c) => c !== 'id')];
          const sql = `SELECT ${pick.map((c) => `"${c}"`).join(', ')} FROM ${name}${w.sql} ORDER BY "${order}" ${dir}, id ${dir}${opt.limit ? ' LIMIT ' + Math.floor(opt.limit) : ''}`;
          return prep(sql).all(...w.args).map((row) => {
            const out = {};
            for (const c of pick) out[c] = row[c] ?? null;
            if (def.idType !== 'text') out.id = Number(out.id);
            for (const c of pick) if (def.cols[c] === 'json' && out[c] !== null) { try { out[c] = JSON.parse(out[c]); } catch { out[c] = null; } }
            return out;
          });
        }
        const sql = `SELECT * FROM ${name}${w.sql} ORDER BY "${order}" ${dir}, id ${dir}${opt.limit ? ' LIMIT ' + Math.floor(opt.limit) : ''}`;
        return prep(sql).all(...w.args).map(dec);
      },
      count(where = {}) { V.read(name, part, part ? where[part] : undefined); const w = whereSql(where); return Number(prep(`SELECT COUNT(*) AS n FROM ${name}${w.sql}`).get(...w.args).n); },
      removeWhere(where) {
        const w = whereSql(where);
        const n = Number(prep(`DELETE FROM ${name}${w.sql}`).run(...w.args).changes);
        if (n > 0) V.wrote(name, part ? V.ALL : null);
        return n;
      },
    };
  }

  let depth = 0;
  // Việc chờ chạy sau khi giao dịch ngoài cùng ghi xong, và việc chạy khi hoàn tác (theo điểm lưu tạm như SAVEPOINT).
  let after = [], undos = [];
  const runAll = (list) => { for (const f of list) { try { f(); } catch { /* việc phụ lỗi thì bỏ qua */ } } };
  const unwind = (mark) => { const list = undos.splice(mark).reverse(); runAll(list); };
  return {
    ...tables,
    /** Gói nhiều thao tác thành một giao dịch: lỗi giữa chừng thì hoàn tác toàn bộ. */
    tx(fn) {
      if (depth) { // giao dịch lồng: lỗi ở trong chỉ hoàn tác phần của nó
        const sp = 'sp' + depth, amark = after.length, umark = undos.length;
        depth++;
        db.exec('SAVEPOINT ' + sp);
        try { const out = fn(); db.exec('RELEASE ' + sp); return out; } catch (e) {
          try { db.exec('ROLLBACK TO ' + sp); db.exec('RELEASE ' + sp); } catch { /* đã hoàn tác */ }
          after.length = amark; unwind(umark);
          throw e;
        } finally { depth--; }
      }
      depth++;
      after = []; undos = [];
      db.exec('BEGIN IMMEDIATE');
      const s0 = V.seq();
      let out;
      try { out = fn(); db.exec('COMMIT'); } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* đã hoàn tác */ }
        after = []; unwind(0);
        throw e;
      } finally { depth--; if (V.seq() !== s0) V.wrote('__tx', null); } // giao dịch có ghi: thêm một nhịp phiên bản lúc ghi xong / hoàn tác
      const a = after; after = []; undos = [];
      runAll(a);
      return out;
    },
    /** Việc làm sau khi giao dịch ngoài cùng ghi xong (đẩy thông báo, gửi Slack); giao dịch hoàn tác thì bỏ. Ngoài giao dịch: chạy ngay. */
    afterCommit(fn) { if (depth) after.push(fn); else runAll([fn]); },
    /** Việc làm khi phần giao dịch chứa nó bị hoàn tác (xoá bộ nhớ đệm đã đổi theo). */
    onRollback(fn) { if (depth) undos.push(fn); },
    /** Phiên bản dữ liệu (core/store-ver.js): số lệnh ghi, ghi lại bảng đã đọc trong một lượt tính, kiểm kết quả đã nhớ còn đúng không. */
    version: V.seq,
    track: (fn) => V.track(fn, () => depth > 0),
    fresh: V.fresh,
    adopt: V.adopt,
    /** Ghi nhận một lần đọc không đi qua kho (giá trị đã nhớ sẵn ở lõi, như cài đặt): lượt tính đang chạy phụ thuộc phần đó. */
    noteRead: (table, val) => V.read(table, PARTS[table] || null, val),
    inTx: () => depth > 0,
    /** Chép toàn bộ dữ liệu ra một tệp SQLite mới (bản chụp nhất quán; người dùng vẫn đọc được trong lúc chép). Tệp đích phải chưa tồn tại. */
    backup(file) { db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); },
    close() { stmts.clear(); db.close(); },
  };
}
