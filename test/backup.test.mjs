// backup.test.mjs — sao lưu tự động: bản sao lưu mở được và đủ dữ liệu, giữ đúng số bản, chạy đúng giờ, lỗi không làm sập máy chủ.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ok, eq, group, summary } from './harness.mjs';
import { SCHEMA } from '../core/schema.js';
import { createSqliteStore } from '../core/store-sqlite.js';
import { createBackups } from '../lib/backup.js';

const H = 3600000, DAY = 24 * H;
const T0 = Date.parse('2026-10-07T19:30:00Z'); // 02:30 sáng 08/10 giờ Việt Nam

await group('Sao lưu SQLite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bk-'));
  const store = createSqliteStore(SCHEMA, path.join(dir, 'atlas.db'));
  const table = Object.keys(SCHEMA).find((n) => SCHEMA[n].cols.name === 'text') || Object.keys(SCHEMA)[0];
  const cols = SCHEMA[table].cols;
  const row = Object.fromEntries(Object.entries(cols).map(([c, t]) => [c, t === 'int' || t === 'real' ? 1 : t === 'json' ? {} : 'x']));
  for (let i = 0; i < 25; i++) store[table].insert({ ...row });
  let t = T0, errors = 0;
  const bk = createBackups({ store, dir: path.join(dir, 'backups'), keep: 3, hour: 2, now: () => t, onError: () => errors++ });

  const r = bk.maybeRun();
  ok(r && r.file === 'atlas-20261008-0230.db', `tới giờ thì sao lưu, tên theo giờ Việt Nam — nhận ${r && r.file}`);
  const copy = new DatabaseSync(path.join(dir, 'backups', r.file), { readOnly: true });
  eq(copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 25, 'bản sao lưu mở được và đủ số dòng');
  copy.close();
  eq(bk.maybeRun(), null, 'cùng ngày không sao lưu lần hai');
  ok(!fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.tmp')), 'không còn tệp dở dang');

  t = T0 + DAY - 2 * H; // 00:30 ngày hôm sau: chưa tới giờ
  eq(bk.maybeRun(), null, 'chưa tới 02:00 thì chưa chạy');
  for (let d = 1; d <= 4; d++) { t = T0 + d * DAY; bk.maybeRun(); }
  eq(bk.list(), ['atlas-20261010-0230.db', 'atlas-20261011-0230.db', 'atlas-20261012-0230.db'], 'chỉ giữ 3 bản mới nhất');
  eq(bk.status().latest, 'atlas-20261012-0230.db', '/healthz thấy bản mới nhất');

  // Lỗi khi chép (ví dụ đầy đĩa): ghi nhận, báo một lần, không ném lỗi ra ngoài, 30 phút sau mới thử lại.
  const real = store.backup;
  store.backup = () => { throw new Error('SQLITE_FULL'); };
  t = T0 + 5 * DAY;
  const bad = bk.maybeRun();
  ok(bad && bad.error === 'SQLITE_FULL' && errors === 1, 'lỗi sao lưu được ghi nhận và báo');
  t += 10 * 60000; eq(bk.maybeRun(), null, 'không thử lại dồn dập');
  store.backup = real;
  t += 30 * 60000; ok(bk.maybeRun()?.file?.startsWith('atlas-20261013'), 'hết 30 phút thì thử lại và thành công');
  eq(bk.status().last_error, null, 'thành công thì xoá lỗi cũ');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

summary('Sao lưu');
