// backup.js — sao lưu tự động tệp SQLite: mỗi ngày một bản vào DATA_DIR/backups, giữ N bản gần nhất.
// Chạy theo giờ địa phương (mặc định 02:00). Máy chủ khởi động lại sau giờ đó mà hôm nay chưa có bản nào thì sao lưu ngay.
// Ảnh giao nhận nằm ở DATA_DIR/photos, không nằm trong tệp sao lưu: chép cả thư mục DATA_DIR ra ngoài máy theo lịch riêng.
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^atlas-(\d{8})-(\d{4})\.db$/;

export function createBackups({ store, dir, keep = 14, hour = 2, tzOffsetMin = 420, now = Date.now, onError = () => {} }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const local = (t) => new Date(t + tzOffsetMin * 60000);
  const stamp = (t) => local(t).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); // 20261008-0200
  const list = () => fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
  let last = null; // { file, at, ms, bytes } hoặc { error, at }

  function run() {
    const t = now(), name = `atlas-${stamp(t)}.db`, dest = path.join(dir, name), tmp = dest + '.tmp';
    const t0 = Date.now();
    try {
      fs.rmSync(tmp, { force: true });
      store.backup(tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, dest); // đổi tên sau khi chép xong: không bao giờ để lại bản sao lưu dở dang dưới tên thật
      const all = list();
      for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
      last = { file: name, at: t, ms: Date.now() - t0, bytes: fs.statSync(dest).size, kept: Math.min(all.length, keep) };
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      last = { error: e.message, at: t };
      onError(e);
    }
    return last;
  }
  /** Gọi định kỳ: tới giờ sao lưu mà hôm nay chưa có bản nào thì chạy. */
  function maybeRun() {
    const t = now(), d = local(t);
    if (d.getUTCHours() < hour) return null;
    const today = stamp(t).slice(0, 8);
    if (list().some((f) => NAME.exec(f)[1] === today)) return null;
    if (last?.error && t - last.at < 30 * 60000) return null; // lỗi thì 30 phút sau thử lại, không dội cảnh báo
    return run();
  }
  let timer = null;
  return {
    run, maybeRun, list,
    start(everyMs = 10 * 60000) { maybeRun(); timer = setInterval(maybeRun, everyMs); timer.unref?.(); return this; },
    stop() { clearInterval(timer); timer = null; },
    /** Cho /healthz: bản gần nhất và tuổi của nó. */
    status() {
      const all = list(), f = all[all.length - 1];
      return { count: all.length, latest: f || null, last_error: last?.error || null };
    },
  };
}
