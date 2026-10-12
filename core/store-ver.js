// store-ver.js — số phiên bản dữ liệu cho kho (SQLite và bộ nhớ): mọi lệnh ghi đều tăng số phiên bản của bảng nó ghi,
// để bộ nhớ đệm số liệu tổng hợp (H.memo ở core/hub/index.js) biết chắc kết quả đã nhớ còn đúng với dữ liệu hiện tại hay không.
//  - Mỗi bảng có một số phiên bản; vài bảng ghi nhiều còn chia theo giá trị của một cột (PARTS), để lệnh ghi vào phần này
//    (ví dụ việc đang mở) không làm mất kết quả chỉ đọc phần khác (việc đã xong).
//  - track(fn): chạy fn và ghi lại mọi bảng (phần bảng) fn đã đọc cùng số phiên bản lúc đó. fresh(deps): các số đó còn nguyên không.
//  - Kết quả chỉ được nhớ khi tính ngoài giao dịch và không có lệnh ghi nào xen giữa lúc tính (ok), nên không bao giờ nhớ dữ liệu
//    chưa ghi xong hoặc sau đó bị hoàn tác.

/** Bảng chia phiên bản theo cột: lệnh đọc lọc đúng cột đó (giá trị cụ thể) chỉ phụ thuộc phần tương ứng. */
export const PARTS = { jobs: 'status', hub_log: 'entity', settings: 'id' };
const ALL = '*'; // phần "không rõ": ghi hàng loạt (removeWhere) làm mất mọi phần của bảng

export function createVersions() {
  const ver = new Map(); // khoá phụ thuộc → số phiên bản
  let seq = 0; // số lệnh ghi (mọi bảng): tăng là có dữ liệu mới
  let rec = null; // bộ ghi phụ thuộc của lượt track đang chạy (Set khoá)
  const bump = (k) => ver.set(k, (ver.get(k) || 0) + 1);
  const isVal = (v) => v === null || typeof v === 'string' || typeof v === 'number';
  /** Các giá trị phần mà điều kiện lọc giới hạn được (một giá trị, hoặc danh sách giá trị); không giới hạn được thì null. */
  const partVals = (w) => (isVal(w) ? [w] : Array.isArray(w) && w.length && w.every(isVal) ? w : null);
  return {
    /** Lệnh ghi vào bảng; vals: giá trị phần bị ảnh hưởng (cũ và mới), ALL khi không biết; bảng không chia phần thì bỏ qua. */
    wrote(table, vals) {
      seq++;
      bump(table);
      if (vals === ALL) bump(table + ':' + ALL);
      else if (vals) for (const v of vals) bump(table + ':' + v);
    },
    /** Lệnh đọc: điều kiện lọc của cột chia phần (where[col]) hoặc mã dòng (bảng chia theo id). */
    read(table, col, w) {
      if (!rec) return;
      const vals = col ? partVals(w) : null;
      if (!vals) { rec.add(table); return; }
      for (const v of vals) rec.add(table + ':' + v);
      rec.add(table + ':' + ALL);
    },
    seq: () => seq,
    track(fn, inTx) {
      const outer = rec, mine = new Set(), s0 = seq, tx0 = inTx();
      rec = mine;
      let value;
      try { value = fn(); } finally {
        rec = outer;
        if (outer) for (const k of mine) outer.add(k); // kết quả lồng trong một lượt tính khác: lượt ngoài cũng phụ thuộc các bảng này
      }
      const deps = [...mine].map((k) => [k, ver.get(k) || 0]);
      return { value, deps, ok: !tx0 && !inTx() && seq === s0 };
    },
    /** Kết quả lấy từ bộ nhớ đệm: lượt tính đang chạy (nếu có) cũng phụ thuộc các bảng của kết quả đó. */
    adopt(deps) { if (rec) for (const [k] of deps) rec.add(k); },
    fresh(deps) { for (const [k, v] of deps) if ((ver.get(k) || 0) !== v) return false; return true; },
    ALL,
  };
}
