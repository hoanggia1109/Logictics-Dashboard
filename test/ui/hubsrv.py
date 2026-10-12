"""Tiện ích cho kiểm thử giao diện Ops Hub: bật máy chủ sạch, có đủ tài khoản theo vai trò, mở Chromium.

    import hubsrv as S
    srv, base, pw = S.start(8131)            # DEMO=1: dữ liệu mẫu 9 tuần nếu có, nếu chưa có thì tự tạo tài khoản qua API
    with sync_playwright() as p:
        b = S.browser(p); pg = b.new_page(); errs = S.watch(pg)
        S.login(pg, base, 'lead', pw)
    S.stop(srv)

Tài khoản: admin, techlead, tech, lead, log, salehead, sale (và fo khi chạy dữ liệu mẫu).
"""
import os, subprocess, tempfile, time, urllib.request, urllib.error, json, http.cookiejar, shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEMO_PW = 'demo1234'
PW = 'Thu-nghiem-2026'
ROLES = {'admin': 'admin', 'techlead': 'tech_lead', 'tech': 'tech', 'lead': 'lead', 'log': 'logistic', 'salehead': 'sale_head', 'sale': 'sale'}
NAMES = {'techlead': 'Trưởng nhóm Tech', 'tech': 'Kỹ thuật viên', 'lead': 'Trưởng nhóm Logistics', 'log': 'Nhân viên Logistics', 'salehead': 'Trưởng phòng Kinh doanh', 'sale': 'Nhân viên Kinh doanh'}


class Cli:
    """Gọi API như trình duyệt (giữ cookie, gửi Origin để qua kiểm tra cùng nguồn)."""
    def __init__(s, base):
        s.base = base
        s.cj = http.cookiejar.CookieJar()
        s.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(s.cj))

    def req(s, m, p, body=None):
        r = urllib.request.Request(s.base + p, method=m, data=json.dumps(body).encode() if body is not None else None,
                                   headers={'Content-Type': 'application/json', 'Origin': s.base})
        try:
            return json.loads(s.op.open(r, timeout=30).read() or b'{}')
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{m} {p} → {e.code} {e.read()[:300].decode("utf8", "replace")}')

    def login(s, u, pw):
        return s.req('POST', '/api/login', {'username': u, 'password': pw})


def _boot(port, demo, extra_env=None):
    data = tempfile.mkdtemp(prefix='hub-ui-')
    env = dict(os.environ, PORT=str(port), DATA_DIR=data, TILE_URL='', DEMO='1' if demo else '0', ADMIN_PASS='Khoitao-12345')
    env.update(extra_env or {})
    proc = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    proc.data_dir = data
    base = f'http://localhost:{port}'
    for _ in range(600):  # dữ liệu mẫu 9 tuần có thể mất vài giây
        try:
            urllib.request.urlopen(base + '/healthz', timeout=1)
            return proc, base
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError('máy chủ dừng khi khởi động:\n' + proc.stdout.read().decode('utf8', 'replace')[-3000:])
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError('máy chủ không khởi động được')


def _make_accounts(base):
    a = Cli(base)
    a.login('admin', 'Khoitao-12345')
    a.req('POST', '/api/password', {'old': 'Khoitao-12345', 'new': PW})
    a = Cli(base)
    a.login('admin', PW)
    for un, role in ROLES.items():
        if un == 'admin':
            continue
        tmp = a.req('POST', '/api/users', {'username': un, 'name': NAMES[un], 'role': role}).get('tempPassword')
        c = Cli(base)
        c.login(un, tmp)
        c.req('POST', '/api/password', {'old': tmp, 'new': PW})


def start(port, demo=True, extra_env=None):
    """Trả về (tiến trình, địa chỉ gốc, mật khẩu chung của mọi tài khoản thử)."""
    if demo:
        proc, base = _boot(port, True, extra_env)
        try:
            Cli(base).login('admin', DEMO_PW)
            return proc, base, DEMO_PW
        except RuntimeError:
            stop(proc)  # dữ liệu mẫu chưa có đủ vai trò → dựng máy chủ trống và tạo tài khoản qua API
    proc, base = _boot(port, False, extra_env)
    _make_accounts(base)
    return proc, base, PW


def stop(proc):
    try:
        proc.kill()
        proc.wait(5)
    except Exception:
        pass
    shutil.rmtree(getattr(proc, 'data_dir', ''), ignore_errors=True)


def browser(p, **kw):
    try:
        return p.chromium.launch(**kw)
    except Exception:
        return p.chromium.launch(executable_path='/opt/pw-browsers/chromium', **kw)


def watch(pg, ignore=()):
    """Ghi lại lỗi JS, console.error và phản hồi 5xx của trang. ignore: chuỗi con của lỗi được phép."""
    errs = []
    def keep(kind, text):
        if not any(i in text for i in ignore):
            errs.append(f'{kind}: {text}')
    pg.on('pageerror', lambda e: keep('pageerror', str(e)))
    pg.on('console', lambda m: keep('console', m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.on('response', lambda r: keep('http', f'{r.status} {r.request.method} {r.url}') if r.status >= 500 else None)
    return errs


def login(pg, base, user, pw, hash_=''):
    pg.goto(base + '/' + hash_)
    pg.wait_for_selector('input[name=username]')
    pg.fill('input[name=username]', user)
    pg.fill('input[name=password]', pw)
    pg.click('button[type=submit]')
    pg.wait_for_selector('.h-app, .fo, .auth .err:not([hidden])', timeout=15000)
    if pg.query_selector('.auth .err:not([hidden])'):
        raise RuntimeError(f'đăng nhập {user} thất bại: ' + pg.inner_text('.auth .err'))
    pg.wait_for_selector('.h-view:not(:has(.h-loading))', timeout=15000)
