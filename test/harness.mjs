// harness.mjs — dựng lõi nghiệp vụ với đồng hồ giả để kiểm thử nhanh và lặp lại được.
import crypto from 'node:crypto';
import { SCHEMA } from '../core/schema.js';
import { createMemoryStore } from '../core/store-memory.js';
import { createSqliteStore } from '../core/store-sqlite.js';
import { createCore } from '../core/core.js';
import { parseSheet } from '../lib/xlsx.js';

// Ảnh JPEG/PNG tối thiểu (chỉ cần đúng chữ ký tệp).
export const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
export const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64');

export const MON_10H = Date.parse('2026-10-05T03:00:00Z'); // Thứ Hai 05/10/2026, 10:00 giờ Việt Nam (ngoài giờ cao điểm)

export function mk(kind = 'memory', opt = {}) {
  let t = opt.t ?? MON_10H;
  const files = new Map(), notes = [];
  let weather = { precip: 0, code: 0, intervalSec: 900 };
  const store = opt.store || (kind === 'sqlite' ? createSqliteStore(SCHEMA, opt.file || ':memory:') : createMemoryStore(SCHEMA));
  const deps = {
    store, now: () => t, cfg: opt.cfg || {},
    hashPassword: async (p) => 'h:' + p,
    verifyPassword: async (p, h) => h === 'h:' + p,
    token: (n) => crypto.randomBytes(n).toString('base64url'),
    sha: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    files: { put: (id, bytes, mime) => files.set(id, { bytes, mime }), remove: (id) => files.delete(id) },
    notify: (text) => notes.push(text),
    parseSheet,
  };
  if (!opt.noWeather) deps.fetchWeather = async () => { if (weather instanceof Error) throw weather; return weather; };
  const core = createCore(deps);
  const byName = (username) => store.users.find({ username }, { limit: 1 })[0] || null;
  /** Gọi API với tư cách một người dùng (tên đăng nhập) hoặc ẩn danh (null). */
  const call = (who, method, path, body, query) => core.api({ user: who ? byName(who) : null, ip: '10.0.0.1', ua: 'test-agent' }, method, path, query || {}, body || {});
  return {
    core, store, files, notes, call, byName,
    clock: { now: () => t, set: (v) => { t = v; }, add: (ms) => { t += ms; } },
    setWeather: (w) => { weather = w; },
    /** Tạo người dùng đã sẵn sàng dùng (không cần đổi mật khẩu; FO đã đồng ý điều khoản). */
    async user(username, role, extra = {}) {
      const r = await core.createUser({ username, name: extra.name || username, role, password: 'matkhau-' + username, must_change: false, ...extra }, null);
      if (role === 'fo' && !extra.noConsent) store.users.update(r.user.id, { consent_version: core.terms().version, consent_at: t });
      return byName(username);
    },
  };
}

/** "Điện thoại của BO": gọi API không đăng nhập, tự giữ cookie thiết bị (arl_bl) như trình duyệt thật. */
export function boDevice(h, ip = '10.0.0.9') {
  let dev = null;
  return {
    get dev() { return dev; },
    async call(method, path, body, query) {
      const r = await h.core.api({ user: null, ip, ua: 'bo-phone', dev }, method, path, query || {}, body || {});
      if (r.body && r.body.__dev) dev = r.body.__dev;
      return r;
    },
  };
}

// Bộ chạy kiểm thử tối giản.
let passed = 0, failed = 0;
const failures = [];
export function ok(cond, msg) {
  if (cond) passed++; else { failed++; failures.push(msg); console.log('    ✗ ' + msg); }
}
export function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — nhận ${JSON.stringify(a)}, mong ${JSON.stringify(b)}`); }
export async function group(name, fn) {
  const before = failed;
  try { await fn(); } catch (e) { failed++; failures.push(`${name}: ${e.stack || e}`); console.log('    ✗ lỗi ngoài dự kiến: ' + (e.stack || e)); }
  console.log(`  ${failed === before ? '✓' : '✗'} ${name}`);
}
export function summary(label) {
  console.log(`\n${label}: ${passed} phép kiểm đạt, ${failed} không đạt.`);
  if (failed) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
}
