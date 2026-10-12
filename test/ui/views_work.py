#!/usr/bin/env python3
"""Kiểm thử giao diện nhóm việc hằng ngày: Việc của tôi, Bảng việc, Điều phối chuyến, Đối chiếu, Thông báo, Nhật ký thao tác.

    python3 test/ui/views_work.py            # chạy kiểm thử, in tóm tắt, lỗi thì thoát mã ≠ 0
    python3 test/ui/views_work.py --serve    # chỉ dựng máy chủ có dữ liệu để xem tay (Ctrl+C để dừng)
    SHOTS=/thư/mục python3 test/ui/views_work.py   # lưu ảnh chụp màn hình (sáng / tối, 1366 và 390 px)

Luồng thật qua giao diện, nhiều team nối nhau:
  Logistics gán kit, gửi Tech kiểm → Tech (điện thoại) bắt đầu và báo kiểm đạt → yêu cầu sẵn sàng, sinh việc giao cho Logistics.
  Logistics báo hỏng kit → việc sửa hiện ngay trên "Việc của tôi" của Tech (không tải lại) → Tech mở chi tiết, bắt đầu, báo sửa xong
  (đánh dấu thiết bị đã sửa) → Logistics nhận việc "Nhận lại kit" → báo đã nhận → kit sẵn sàng.
  Logistics trả việc cho cả đội rồi nhận lại; kiểm kho có chênh lệch → vào Đối chiếu.
  Logistic Lead tạo việc giao tay, giao hàng loạt cho người khác, xem bảng theo trạng thái; lập chuyến FO gồm việc giao kit
  và đổi kit hỏng (chọn kit thay), xem chuyến đang chạy, gỡ một việc khỏi chuyến; ghi cách xử lý dòng đối chiếu; lọc nhật ký.
  Head of Sale ghi cách xử lý dòng đối chiếu của Sale, nhật ký chỉ có yêu cầu / BO / sự cố. Thông báo: bấm để mở, đánh dấu đã đọc.
  Vai trò không được mở màn hình thì bị đưa về trang đầu và không thấy mục trên thanh bên.
Kịch bản chính dựng dữ liệu qua API như người dùng thật (cổng 8151). Sau đó, nếu máy chủ DEMO=1 nạp đủ dữ liệu mẫu Ops Hub
(core/hub/demo.js), chạy thêm một vòng trên dữ liệu mẫu 9 tuần (cổng 8152): mở từng màn hình theo vai trò, bấm một việc thật, chụp ảnh.
DEMO_PASS=0 để bỏ vòng dữ liệu mẫu.
"""
import base64, datetime as dt, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hubsrv as S
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', '8151'))
SHOTS = os.environ.get('SHOTS', '')
DESK = {'width': 1366, 'height': 850}
PHONE = {'width': 390, 'height': 800}
fails, passes = [], [0]
REQS = []  # thao tác ghi (POST/PATCH) từ các trang, để in khi có lỗi


def ok(cond, msg):
    if cond:
        passes[0] += 1
    else:
        fails.append(msg)
        print('    ✗ ' + msg)
    return bool(cond)


def step(name):
    print('  • ' + name)


# ───────────────────────── Dữ liệu thử ─────────────────────────
def csv_b64(rows):
    def cell(v):
        s = '' if v is None else str(v)
        return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s
    text = '\r\n'.join(','.join(cell(v) for v in r) for r in rows)
    return base64.b64encode(('﻿' + text).encode('utf8')).decode()


def do_import(cli, name, target, rows):
    r = cli.req('POST', '/api/hub/import/parse', {'name': name, 'data': csv_b64(rows)})
    sh = r['sheets'][0]
    plan = [{'sheet': 0, 'target': target, 'mapping': sh['guess']['mapping'], 'header_row': sh['header_row']}]
    return cli.req('POST', '/api/hub/import/run', {'token': r['token'], 'plan': plan, 'commit': True})['report'][0]


def login_cli(base, u, pw):
    c = S.Cli(base)
    c.login(u, pw)
    return c


def seed(base, pw):
    """Dựng kho, BO, yêu cầu như người dùng thật làm qua API. Trả về các client theo tài khoản."""
    C = {u: login_cli(base, u, pw) for u in ['admin', 'techlead', 'tech', 'lead', 'log', 'salehead', 'sale']}
    A, L, LL, SA = C['admin'], C['log'], C['lead'], C['sale']
    # log2 chưa đăng nhập lần nào (ngoài ca) để Lead giao việc cho; một FO cho chuyến.
    A.req('POST', '/api/users', {'username': 'log2', 'name': 'Võ Thanh Tâm', 'role': 'logistic'})
    A.req('POST', '/api/users', {'username': 'fo', 'name': 'Nguyễn Văn Tài', 'role': 'fo'})
    LL.req('POST', '/api/sites', {'name': 'Văn phòng Atlas', 'type': 'office', 'lat': 10.7769, 'lon': 106.7009})
    LL.req('POST', '/api/hub/devices', {'type': 'multicam', 'codes': 'MC01 MC02 MC03 MC04'})
    LL.req('POST', '/api/hub/devices', {'type': 'cm5', 'codes': 'CM01 CM02 CM03 CM04'})
    LL.req('POST', '/api/hub/devices', {'type': 'sd', 'codes': ' '.join(f'SD{i:02d}' for i in range(1, 13))})
    for t, q in [['hub_sac', 10], ['day_gan', 10], ['cap_c_c', 10], ['headstrap', 6]]:
        L.req('POST', f'/api/hub/acc/{t}/move', {'kind': 'in', 'qty': q, 'reason': 'Khai báo tồn đầu kỳ'})
    for code, m, c in [['K01', 'MC01', 'CM01'], ['K02', 'MC02', 'CM02'], ['K03', 'MC03', 'CM03'], ['K04', 'MC04', 'CM04']]:
        L.req('POST', '/api/hub/kits', {'code': code, 'kind': 'multicam', 'devices': f'{m} {c}', 'acc': {'hub_sac': 1, 'day_gan': 1, 'cap_c_c': 1}})
    today = dt.date.fromisoformat(C['tech'].req('GET', '/api/hub/me')['today'])
    D = lambda n: (today + dt.timedelta(days=n)).isoformat()
    # Ca cả ngày đã duyệt hôm nay cho Tech và Logistics (không có ca đã duyệt thì không vào ca, không được tự giao việc); log2 không có ca.
    me = {u: C[u].req('GET', '/api/hub/me') for u in ['tech', 'log']}
    uid = lambda u: me[u]['user']['id']
    C['techlead'].req('PUT', '/api/hub/roster', {'rows': [{'user_id': uid('tech'), 'date': D(0)}]})
    LL.req('PUT', '/api/hub/roster', {'rows': [{'user_id': uid('log'), 'date': D(0)}]})
    for u in ['tech', 'log']:
        assert C[u].req('GET', '/api/hub/me')['on_shift'], f'{u} chưa vào ca'  # mở ứng dụng trong ca → vào ca
    # BO đang ghi hình (nhập từ file như lúc chuyển dữ liệu cũ): BO02 ghi Sale chưa có tài khoản, kit KB09 ghi ở BO không tồn tại → Đối chiếu.
    do_import(A, 'bo.csv', 'outlets', [
        ['Mã BO', 'Tên BO', 'Sale phụ trách', 'Trạng thái', 'Ngày launch', 'Ngày onboard', 'Ngày kết thúc', 'Quota giờ quay', 'Khu vực', 'Ngành', 'Vĩ độ', 'Kinh độ', 'Ngày đổi thẻ', 'Khung giờ đổi thẻ', 'Người liên hệ', 'SĐT'],
        ['BO01', 'Phúc Long Lê Lợi', 'sale', 'Đang ghi hình', D(-60), D(-60), '', 1700, 'Quận 1', 'F&B', 10.7731, 106.7012, 'T2, T4, T6', '09:00-11:00', 'Chị Mai', '0909100001'],
        ['BO02', 'Circle K Nguyễn Huệ', 'Người Chưa Có', 'Đang ghi hình', D(-30), D(-30), '', 800, 'Quận 1', 'Bán lẻ', 10.7745, 106.7035, 'T3, T5', '14:00-16:00', 'Anh Long', '0909100002']])
    do_import(A, 'kit.csv', 'kits', [['Mã kit', 'Loại kit', 'Trạng thái', 'BO đang đặt kit'], ['KB01', 'Multicam', 'Tại BO', 'BO01'], ['KB02', 'Multicam', 'Tại BO', 'BO02'], ['KB09', 'Multicam', 'Tại BO', 'BO99']])
    # Sale gửi yêu cầu mở BO mới, launch ngày mai; Logistics gán K02 và gửi Tech kiểm.
    req = SA.req('POST', '/api/hub/requests', {'need': {'multicam': 1}, 'launch_date': D(1), 'swap_days': [1, 3, 5], 'swap_from': '09:00', 'swap_to': '11:00',
                                               'outlet': {'name': 'Highlands Võ Văn Tần', 'code': 'HL01', 'lat': 10.7835, 'lon': 106.6869, 'contact': 'Chị Hoa', 'phone': '0901111222', 'address': '12 Võ Văn Tần, Quận 3'}})['request']
    K = kits(L)
    L.req('POST', f"/api/hub/requests/{req['id']}/assign", {'kit_ids': [K['K02']['id']]})
    L.req('POST', f"/api/hub/kits/{K['K02']['id']}/submit")
    # Kit ở BO01 bị BO báo không lên hình → việc đổi kit hỏng (ngoài hiện trường) cho Logistics.
    L.req('POST', f"/api/hub/kits/{K['KB01']['id']}/faulty", {'reason': 'BO báo không lên hình'})
    return C, req


def kits(cli):
    return {k['code']: k for k in cli.req('GET', '/api/hub/kits')['kits']}


def jobs(cli, **q):
    from urllib.parse import urlencode
    return cli.req('GET', '/api/hub/jobs?' + urlencode({'status': 'all', 'view': 'team', **q}))['jobs']


def find_job(cli, pred, **q):
    for j in jobs(cli, **q):
        if pred(j):
            return j
    return None


# ───────────────────────── Trình duyệt ─────────────────────────
class Page:
    def __init__(s, b, base, user, pw, hash_='', phone=False):
        s.ctx = b.new_context(viewport=PHONE if phone else DESK, is_mobile=phone, has_touch=phone, locale='vi-VN', timezone_id='Asia/Ho_Chi_Minh')
        s.pg = s.ctx.new_page()
        s.errs = S.watch(s.pg)
        s.reqs = REQS
        s.pg.on('request', lambda r: s.reqs.append(f'{time.time():.1f} {user} {r.method} {r.url.split("/api/")[-1]} {(r.post_data or "")[:120]}') if r.method != 'GET' else None)
        s.user, s.phone = user, phone
        S.login(s.pg, base, user, pw, hash_)

    def go(s, hash_, view):
        s.pg.evaluate('h => { location.hash = h; }', hash_)
        s.wait_view(view)

    def wait_view(s, view, timeout=15000):
        s.pg.wait_for_selector(f'.h-view[data-view="{view}"]', timeout=timeout)
        s.pg.wait_for_function('v => { const el = document.querySelector(`.h-view[data-view="${v}"]`); return el && !el.querySelector(".h-loading:not([hidden] .h-loading)"); }', arg=view, timeout=timeout)

    def view_id(s):
        return s.pg.evaluate('() => { const v = document.querySelector(".h-view"); return v ? v.dataset.view : null; }')

    def hash(s):
        return s.pg.evaluate('() => location.hash')

    def dialog(s, title=None, timeout=8000):
        sel = 'dialog.dlg[open]'
        s.pg.wait_for_selector(sel, timeout=timeout)
        d = s.pg.locator(sel).last
        if title:
            s.pg.wait_for_function('t => { const d = [...document.querySelectorAll("dialog.dlg[open]")].pop(); return d && d.querySelector(".dlg-head h2") && d.querySelector(".dlg-head h2").textContent.includes(t); }', arg=title, timeout=timeout)
        return d

    def dialog_gone(s, timeout=10000):
        s.pg.wait_for_function('() => !document.querySelector("dialog.dlg[open]")', timeout=timeout)

    def dlg_err(s):
        d = s.pg.query_selector('dialog.dlg[open] .dlg-err')
        return d.inner_text().strip() if d else ''

    def toast(s, text, timeout=8000):
        try:
            s.pg.wait_for_function('t => [...document.querySelectorAll(".toast")].some((n) => n.textContent.includes(t))', arg=text, timeout=timeout)
            return True
        except Exception:
            return False

    def no_hscroll(s):
        return s.pg.evaluate('''() => {
            const m = document.querySelector('.h-main'), v = document.querySelector('.h-view');
            const over = (n) => n && n.scrollWidth > n.clientWidth + 1;
            return !(document.documentElement.scrollWidth > innerWidth + 1 || over(m) || over(v));
        }''')

    def small_taps(s, sel):
        """Nút / link thao tác nhỏ hơn 40 px (chỉ phần đang hiện)."""
        return s.pg.evaluate('''sel => [...document.querySelectorAll(sel)].filter((n) => { const r = n.getBoundingClientRect(); return r.width && r.height && r.height < 40; }).map((n) => (n.textContent || n.getAttribute('aria-label') || '').trim().slice(0, 30))''', sel)

    def view_small_taps(s):
        """Mọi nút / ô chọn trong màn hình đang mở thấp hơn 40 px (bỏ thanh phân trang dùng chung của bảng)."""
        return s.pg.evaluate("""() => [...document.querySelectorAll('.h-view button, .h-view a.btn, .h-view select, .h-view .chip, .jobs-panel button')]
            .filter((n) => !n.closest('.h-tbl-foot, [hidden], dialog') && n.offsetParent !== null)
            .filter((n) => { const r = n.getBoundingClientRect(); return r.width && r.height && r.height < 40; })
            .map((n) => (n.textContent || n.getAttribute('aria-label') || n.tagName).trim().slice(0, 24))""")

    def nav_has(s, view):
        return s.pg.query_selector(f'nav.h-nav a[data-view="{view}"]') is not None

    def shot(s, name):
        if not SHOTS:
            return
        os.makedirs(SHOTS, exist_ok=True)
        s.pg.wait_for_timeout(250)
        s.pg.screenshot(path=os.path.join(SHOTS, f'{name}-{"phone" if s.phone else "desk"}-light.png'))
        s.pg.emulate_media(color_scheme='dark')
        s.pg.wait_for_timeout(200)
        s.pg.screenshot(path=os.path.join(SHOTS, f'{name}-{"phone" if s.phone else "desk"}-dark.png'))
        s.pg.emulate_media(color_scheme='light')

    def item(s, box, text):
        return s.pg.locator(f'{box} .jobs-item', has_text=text)

    def close(s):
        ok(not s.errs, f'{s.user}{" (điện thoại)" if s.phone else ""}: không có lỗi JS / máy chủ — {s.errs[:4]}')
        s.ctx.close()


def denied(P, view, home):
    """Vai trò không được mở: không có mục trên thanh bên, mở địa chỉ thì về trang đầu."""
    ok(not P.nav_has(view), f'{P.user}: không thấy mục "{view}" trên thanh bên')
    P.pg.evaluate('h => { location.hash = h; }', f'#/{view}')
    try:
        P.pg.wait_for_function('h => location.hash.startsWith(h)', arg=f'#/{home}', timeout=6000)
    except Exception:
        pass
    ok(P.hash().startswith(f'#/{home}') and P.view_id() == home, f'{P.user}: mở #/{view} → về #/{home} (đang ở {P.hash()})')


# ───────────────────────── Kịch bản ─────────────────────────
def run(base, pw, b, C, req):
    A, L, LL, T = C['admin'], C['log'], C['lead'], C['tech']

    # ── 1. Tech trên điện thoại: kiểm kit, việc sửa hiện ngay, sửa xong qua khung chi tiết ──
    step('Tech (điện thoại): Việc của tôi, kiểm kit đạt, việc sửa đến tức thì, báo sửa xong')
    P = Page(b, base, 'tech', pw, '#/home', phone=True)
    P.wait_view('home')
    ok('Chào' in P.pg.inner_text('.h-head h1'), 'lời chào trên Việc của tôi')
    ok(P.pg.locator('.home-kpis .h-kpi').count() >= 3, 'có ô số liệu của tôi')
    ok(P.item('.home-list', 'Kiểm kit K02').count() == 1, 'việc "Kiểm kit K02" có trong Việc của tôi')
    ok(P.pg.locator('.home-shift-note').count() == 1, 'hiện tình trạng ca làm')
    ok(P.no_hscroll(), 'Việc của tôi (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Việc của tôi (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    small = P.small_taps('.h-view[data-view="home"] .jobs-item-a button, .h-view[data-view="home"] .jobs-item-a .btn')
    ok(not small, f'nút thao tác trong danh sách ≥ 40 px: {small}')
    P.shot('home')
    ok(not P.nav_has('dispatch') and not P.nav_has('log'), 'Tech không thấy Điều phối chuyến và Nhật ký trên thanh bên')

    # Logistics báo hỏng K01 (ở màn hình Kit của nhóm khác) → việc sửa hiện trên Việc của tôi của Tech mà không tải lại trang.
    K = kits(L)
    mc01 = next(d for d in K['K01']['devices'] if d['code'] == 'MC01')
    L.req('POST', f"/api/hub/kits/{K['K01']['id']}/faulty", {'reason': 'Không lên nguồn', 'device_id': mc01['id']})
    try:
        P.pg.wait_for_selector('.home-list .jobs-item:has-text("Sửa kit K01")', timeout=12000)
        live_ok = True
    except Exception:
        live_ok = False
    ok(live_ok, 'việc sửa K01 hiện ngay trên Việc của tôi của Tech (cập nhật trực tiếp, không tải lại)')

    # Kiểm kit K02: Bắt đầu → Báo xong… → Đạt.
    it = P.item('.home-list', 'Kiểm kit K02')
    it.locator('.jobs-item-a button', has_text='Bắt đầu').click()
    P.pg.wait_for_selector('.home-list .jobs-item:has-text("Kiểm kit K02") .jobs-item-a button:has-text("Báo xong")', timeout=8000)
    ok(P.toast('Đã bắt đầu'), 'bấm Bắt đầu → báo đã bắt đầu')
    P.item('.home-list', 'Kiểm kit K02').locator('.jobs-item-a button', has_text='Báo xong').click()
    d = P.dialog('Kiểm kit K02')
    ok(d.locator('.jobs-dev').count() == 2, 'hộp thoại kiểm kit liệt kê 2 thiết bị của kit')
    if P.phone:
        P.shot('dlg-check')
    d.locator('.dlg-foot button', has_text='Gửi kết quả').click()
    P.dialog_gone()
    P.pg.wait_for_function('() => ![...document.querySelectorAll(".home-list .jobs-item")].some((n) => n.textContent.includes("Kiểm kit K02"))', timeout=8000)
    ck = find_job(A, lambda j: j['type'] == 'check_kit' and j['kit'] and j['kit']['code'] == 'K02', team='tech')
    ok(ck and ck['status'] == 'done', 'máy chủ: việc kiểm K02 đã xong')
    ok(kits(L)['K02']['status'] == 'reserved', 'máy chủ: K02 đạt → chờ giao cho BO')
    dlv = find_job(A, lambda j: j['type'] == 'deliver' and j['request_id'] == req['id'], team='logistics', status='active')
    ok(dlv is not None, 'máy chủ: yêu cầu đủ kit → tự sinh việc giao cho Logistics')

    # Sửa K01 qua khung chi tiết: mở việc, Bắt đầu, Báo xong…, đánh dấu MC01 đã sửa.
    P.item('.home-list', 'Sửa kit K01').locator('a.jobs-item-main').click()
    P.pg.wait_for_selector('.jobs-panel:not([hidden]) .jobs-acts', timeout=8000)
    ok(re.match(r'#/home/\d+', P.hash()) is not None, f'mở chi tiết việc → địa chỉ #/home/<id> ({P.hash()})')
    ok('Sửa kit K01' in P.pg.inner_text('.jobs-panel h2'), 'khung chi tiết hiện đúng việc')
    ok(P.no_hscroll(), 'khung chi tiết (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'khung chi tiết (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.shot('home-panel')
    P.pg.locator('.jobs-panel .jobs-acts button', has_text='Bắt đầu').click()
    P.pg.wait_for_selector('.jobs-panel .jobs-acts button:has-text("Báo xong")', timeout=8000)
    P.pg.locator('.jobs-panel .jobs-acts button', has_text='Báo xong').click()
    d = P.dialog('Sửa xong kit K01')
    row = d.locator('.jobs-dev', has_text='MC01')
    ok(row.locator('input[type=checkbox]').is_checked() is False, 'MC01 đang hỏng → chưa đánh dấu tốt')
    # Báo xong khi chưa sửa thiết bị → máy chủ chặn, lỗi hiện trong hộp thoại (không đóng).
    d.locator('.dlg-foot button', has_text='Báo sửa xong').click()
    P.pg.wait_for_timeout(600)
    ok('hỏng' in P.dlg_err(), f'chưa sửa thiết bị hỏng → lỗi máy chủ hiện nguyên văn trong hộp thoại ("{P.dlg_err()[:80]}")')
    row.locator('input[type=checkbox]').check()
    d.locator('input[name=cause]').fill('Hỏng nguồn')
    d.locator('.dlg-foot button', has_text='Báo sửa xong').click()
    P.dialog_gone()
    P.errs[:] = [e for e in P.errs if '409' not in e]  # lỗi 409 ở trên là cố ý (hiện trong hộp thoại)
    ok(kits(L)['K01']['status'] == 'tech_done', 'máy chủ: K01 sửa xong → chờ Logistics nhận lại')
    rb = find_job(A, lambda j: j['type'] == 'receive_back' and j['kit'] and j['kit']['code'] == 'K01', team='logistics', status='active')
    ok(rb is not None and rb['assignee'] and rb['assignee']['name'] == 'Nhân viên Logistics', 'máy chủ: tự sinh việc "Nhận lại kit K01" giao cho Logistics đang trong ca')
    P.pg.locator('.jobs-panel .jobs-px').click()
    P.pg.wait_for_function('() => location.hash === "#/home"', timeout=5000)
    P.pg.wait_for_selector('.jobs-panel[hidden]', state='attached', timeout=5000)
    ok(P.pg.locator('.jobs-panel[hidden]').count() == 1, 'đóng chi tiết → về danh sách')
    denied(P, 'dispatch', 'home')
    denied(P, 'log', 'home')
    P.go('#/jobs', 'jobs')
    ok(P.no_hscroll(), 'Bảng việc (390 px): không cuộn ngang')
    P.shot('jobs')
    P.go('#/recon', 'recon')
    ok(P.pg.locator('.recon-st button').count() == 0, 'Tech không có nút ghi cách xử lý đối chiếu')
    P.close()

    # ── 2. Logistics (máy tính): nhận lại kit, kiểm kho, trả việc rồi nhận lại ──
    step('Logistic Executive: nhận lại kit từ Tech, kiểm kho có chênh lệch, trả việc rồi nhận lại')
    P = Page(b, base, 'log', pw, '#/home')
    P.wait_view('home')
    it = P.item('.home-list', 'Nhận lại kit K01')
    ok(it.count() == 1, 'Logistics thấy "Nhận lại kit K01 từ Tech" trong Việc của tôi')
    it.locator('.jobs-item-a button', has_text='Bắt đầu').click()
    P.pg.wait_for_selector('.home-list .jobs-item:has-text("Nhận lại kit K01") .jobs-item-a button:has-text("Báo xong")', timeout=8000)
    P.item('.home-list', 'Nhận lại kit K01').locator('.jobs-item-a button', has_text='Báo xong').click()
    d = P.dialog('Nhận lại kit K01')
    d.locator('.dlg-foot button', has_text='Xác nhận đã nhận').click()
    P.dialog_gone()
    ok(P.toast('Đã báo xong'), 'báo xong → thông báo')
    ok(kits(L)['K01']['status'] == 'ready', 'máy chủ: K01 về "Sẵn sàng"')
    ok(P.item('.home-list', 'Đổi kit hỏng KB01').count() == 1, 'việc đổi kit hỏng KB01 có trong Việc của tôi')
    P.shot('home-log')

    sc = find_job(L, lambda j: j['type'] == 'stock_check' and j['status'] == 'open', status='active')
    if sc:
        P.go(f"#/jobs/{sc['id']}", 'jobs')
        P.pg.wait_for_selector('.jobs-panel:not([hidden]) .jobs-acts', timeout=8000)
        P.pg.locator('.jobs-panel .jobs-acts button', has_text='Báo xong').click()
        d = P.dialog('Báo xong kiểm kho')
        d.locator('textarea[name=diff]').fill('Thiếu 1 hub sạc ở kệ B')
        d.locator('.dlg-foot button', has_text='Báo xong').click()
        P.dialog_gone()
        rec = A.req('GET', '/api/hub/recon')['items']
        if not ok(any(r['source'] == 'stock_check' for r in rec), 'kiểm kho có chênh lệch → vào Đối chiếu (không tự sửa số)'):
            print('      nhật ký việc:', [x['text'] for x in A.req('GET', '/api/hub/jobs/' + str(sc['id']))['log']])
            print('      yêu cầu từ trang:', *P.reqs, sep='\n        ')
        P.pg.locator('.jobs-panel .jobs-px').click()
    else:
        print('    (hôm nay không phải ngày kiểm kho định kỳ: bỏ bước kiểm kho)')

    prep = find_job(L, lambda j: j['type'] == 'prep_kit', status='all')
    # Trả việc giao kit cho cả đội, rồi nhận lại từ mục "Chưa ai nhận".
    P.go(f"#/home/{dlv['id']}", 'home')
    P.pg.wait_for_selector('.jobs-panel:not([hidden]) .jobs-acts', timeout=8000)
    P.pg.locator('.jobs-panel .jobs-phead button[aria-label="Thao tác khác với việc này"]').click()
    P.pg.locator('.h-pop button', has_text='Trả việc cho cả đội').click()
    d = P.dialog('Trả việc cho cả đội')
    d.locator('textarea').fill('Chiều nay đi kho Thủ Đức')
    d.locator('.dlg-foot button', has_text='Trả việc').click()
    P.dialog_gone()
    P.pg.locator('.jobs-panel .jobs-px').click()
    P.pg.wait_for_selector('.home-sec:not([hidden]) .home-list .jobs-item:has-text("Giao") .jobs-item-a button:has-text("Nhận việc")', timeout=8000)
    j = A.req('GET', f"/api/hub/jobs/{dlv['id']}")['job']
    ok(j['assignee'] is None, 'máy chủ: việc trả về chung, không tự giao lại cho người vừa trả')
    P.pg.locator('.home-list .jobs-item', has_text=j['title']).locator('.jobs-item-a button', has_text='Nhận việc').click()
    ok(P.toast('Đã nhận việc'), 'bấm Nhận việc → đã nhận')
    P.pg.wait_for_selector(f'.home-list .jobs-item[data-id="{dlv["id"]}"] .jobs-item-a button:has-text("Bắt đầu")', timeout=8000)
    ok(A.req('GET', f"/api/hub/jobs/{dlv['id']}")['job']['assignee']['name'] == 'Nhân viên Logistics', 'máy chủ: việc về lại người nhận')
    ok(not P.nav_has('log'), 'Logistic Executive không thấy Nhật ký trên thanh bên')
    P.go('#/dispatch', 'dispatch')
    ok(P.pg.locator('.dispatch-job').count() >= 2, 'Logistic Executive mở được Điều phối chuyến, thấy việc ngoài hiện trường')
    # Thông báo: bấm một thông báo việc → mở đúng việc, đánh dấu đã đọc.
    unread0 = L.req('GET', '/api/hub/inbox')['unread']
    P.go('#/inbox', 'inbox')
    ok(P.pg.locator('.inbox-it').count() >= 1 and unread0 >= 1, f'Thông báo có {unread0} chưa đọc')
    first = P.pg.locator('.inbox-it[data-unread="1"]', has_text='Việc mới').first
    first.click()
    P.pg.wait_for_function('() => /^#\\/(jobs|home)\\/\\d+/.test(location.hash)', timeout=8000)
    ok(True, 'bấm thông báo việc → mở chi tiết việc')
    P.pg.wait_for_selector('.jobs-panel:not([hidden])', timeout=8000)
    ok(L.req('GET', '/api/hub/inbox')['unread'] == unread0 - 1, 'máy chủ: thông báo vừa bấm đã đọc')
    P.go('#/inbox', 'inbox')
    P.shot('inbox')
    P.pg.locator('.h-head button', has_text='Đánh dấu đã đọc hết').click()
    ok(P.toast('Đã đánh dấu đã đọc hết'), 'đánh dấu đã đọc hết')
    P.pg.wait_for_timeout(400)
    ok(L.req('GET', '/api/hub/inbox')['unread'] == 0, 'máy chủ: không còn thông báo chưa đọc')
    ok(P.pg.locator('.inbox-it[data-unread="1"]').count() == 0, 'danh sách không còn dòng chưa đọc')
    P.close()

    # ── 3. Logistic Lead: tạo việc, giao hàng loạt, bảng theo trạng thái ──
    step('Logistic Lead: tạo việc giao tay, giao hàng loạt, bảng theo trạng thái, việc đã xong')
    P = Page(b, base, 'lead', pw, '#/jobs')
    P.wait_view('jobs')
    for title, bo in [('Lau ống kính kit tại BO', 'Phúc Long Lê Lợi (BO01)'), ('Sắp xếp kệ phụ kiện', '')]:
        P.pg.locator('.h-head button', has_text='Tạo việc').click()
        d = P.dialog('Tạo việc giao tay')
        d.locator('input[name=title]').fill(title)
        if bo:
            d.locator('input[name=site]').fill(bo)
        d.locator('.dlg-foot button', has_text='Tạo việc').click()
        P.dialog_gone()
        ok(P.toast('Đã tạo việc'), f'tạo việc "{title}"')
        P.pg.wait_for_selector('.jobs-panel:not([hidden]) .jobs-acts', timeout=8000)
        if bo:
            P.shot('jobs-panel')
        P.pg.locator('.jobs-panel .jobs-px').click()
        P.pg.wait_for_selector('.jobs-panel[hidden]', state='attached', timeout=5000)
    man = [find_job(LL, lambda j, t=t: j['type'] == 'manual' and j['title'] == t, status='active') for t in ['Lau ống kính kit tại BO', 'Sắp xếp kệ phụ kiện']]
    ok(all(man) and man[0]['site'] and man[0]['site']['name'] == 'Phúc Long Lê Lợi', 'máy chủ: tạo 2 việc giao tay (một việc có BO)')
    for j in man:
        P.pg.locator('.h-tbl tbody tr', has_text=j['title']).locator('input[type=checkbox]').check()
    P.pg.wait_for_selector('.jobs-bulk:not([hidden])', timeout=5000)
    ok('2' in P.pg.inner_text('.jobs-bulk'), 'thanh giao hàng loạt: đã chọn 2 việc')
    P.shot('jobs-bulk')
    P.pg.locator('.jobs-bulk button', has_text='Giao cho').click()
    P.pg.locator('.h-pop button', has_text='Võ Thanh Tâm').click()
    ok(P.toast('Đã giao 2 việc cho Võ Thanh Tâm'), 'giao 2 việc cho Võ Thanh Tâm')
    P.pg.wait_for_timeout(500)
    ok(all(A.req('GET', f"/api/hub/jobs/{j['id']}")['job']['assignee']['name'] == 'Võ Thanh Tâm' for j in man), 'máy chủ: cả 2 việc đã giao cho Võ Thanh Tâm')
    ok(P.pg.locator('details.jobs-team').count() == 1, 'Lead thấy bảng tải của team')
    ok(P.pg.locator('.jobs-tools select[aria-label="Loại việc"] option').count() > 3, 'bộ lọc loại việc có danh sách loại việc của team')
    ok(P.pg.locator('.jobs-tools select[aria-label="Người làm"] option', has_text='Võ Thanh Tâm').count() == 1, 'Lead lọc được theo người làm')
    P.pg.locator('.h-seg button', has_text='Theo trạng thái').click()
    P.pg.wait_for_selector('.jobs-board .jobs-col', timeout=5000)
    ok(P.pg.locator('.jobs-board .jobs-col').count() == 4, 'bảng theo trạng thái có 4 cột')
    P.shot('jobs-board')
    P.pg.locator('.h-seg button', has_text='Danh sách').click()
    P.pg.locator('.h-chips button', has_text='Đã xong').click()
    P.pg.wait_for_function('() => { const t = document.querySelector(".jobs-content .h-tbl tbody"); return t && t.textContent.includes("Nhận lại kit K01"); }', timeout=8000)
    ok(True, 'lọc "Đã xong" → thấy việc nhận lại K01')
    P.pg.locator('.h-chips button', has_text='Đang mở').click()

    # ── 4. Điều phối chuyến: giao kit + đổi kit hỏng (chọn kit thay) ──
    step('Logistic Lead: lập chuyến FO, xem chuyến đang chạy, gỡ việc khỏi chuyến')
    swf = find_job(A, lambda j: j['type'] == 'swap_faulty', team='logistics', status='active')
    P.go('#/dispatch', 'dispatch')
    P.pg.wait_for_selector('.dispatch-bo', timeout=8000)
    ok(P.pg.locator('.dispatch-area').count() >= 1, 'việc gom theo khu vực → BO')
    for jj in [dlv, swf]:
        P.pg.locator('.dispatch-job', has_text=jj['title']).locator('input[type=checkbox]').check()
    P.pg.wait_for_function('() => !document.querySelector(".dispatch-stops").textContent.includes("Đang tải")', timeout=8000)
    ok(P.pg.locator('.dispatch-stop:not(.dispatch-stop-off)').count() == 2, 'chuyến có 2 điểm BO')
    ok(P.pg.eval_on_selector('#dp-off', 's => s.selectedOptions[0] && s.selectedOptions[0].textContent') == 'Văn phòng Atlas', 'xuất phát mặc định từ văn phòng')
    ok(P.pg.locator('.dispatch-stop-off').count() == 2, 'chuyến hai chiều: điểm xuất phát và quay về văn phòng')
    ok('Mang 1 kit đã kiểm: K02' in P.pg.inner_text('.dispatch-stops'), 'điểm giao kit: mang K02 đã kiểm')
    sel = P.pg.locator(f'#dp-swap-{swf["id"]}')
    ok(sel.locator('option', has_text='K01').count() == 1, 'kit thay thế gợi ý K01 (sẵn sàng, cùng loại)')
    # Bấm tạo khi chưa chọn kit thay → báo ngay trên màn hình, không gửi.
    fo_val = P.pg.eval_on_selector('#dp-fo', 's => { const o = [...s.options].find((x) => x.textContent.startsWith("Nguyễn Văn Tài")); return o ? o.value : ""; }')
    ok(fo_val != '', 'FO có trong danh sách chọn (không hiện vị trí)')
    P.pg.locator('#dp-fo').select_option(fo_val or 'none')
    P.pg.locator('.dispatch-go').click()
    ok('kit thay thế' in P.pg.inner_text('.dispatch-err'), 'chưa chọn kit thay → nhắc chọn trước khi gửi')
    sel.select_option(label='K01')
    P.shot('dispatch')
    P.pg.locator('.dispatch-go').click()
    P.pg.wait_for_selector('.dispatch-ok:not([hidden])', timeout=8000)
    ok(P.pg.locator('.dispatch-ok a[href="#/live"]').count() == 1, 'tạo chuyến xong → có nút "Xem trên Rider Live"')
    j1, j2 = (A.req('GET', f"/api/hub/jobs/{x['id']}")['job'] for x in [dlv, swf])
    ok(j1['task_id'] and j1['task_id'] == j2['task_id'] and j1['status'] == 'doing', 'máy chủ: hai việc vào cùng một chuyến, chuyển "Đang làm"')
    P.pg.locator('.dispatch-ok button', has_text='Xem chuyến đang chạy').click()
    P.pg.wait_for_selector('.dispatch-trips:not([hidden]) .dispatch-trip', timeout=8000)
    trip = P.pg.locator('.dispatch-trip').first
    ok(dlv['title'] in trip.inner_text() and 'Nguyễn Văn Tài' in trip.inner_text(), 'chuyến đang chạy hiện việc và FO')
    P.shot('dispatch-trips')
    trip.locator('.dispatch-line', has_text=dlv['title']).locator('button', has_text='Gỡ khỏi chuyến').click()
    d = P.dialog('Xác nhận')
    d.locator('.dlg-foot button', has_text='Gỡ khỏi chuyến').click()
    P.dialog_gone()
    ok(P.toast('Đã gỡ'), 'gỡ việc khỏi chuyến → thông báo')
    j1 = A.req('GET', f"/api/hub/jobs/{dlv['id']}")['job']
    ok(not j1['task_id'] and j1['status'] == 'open', 'máy chủ: việc giao kit trở lại chờ làm, rời chuyến')
    ok(kits(L)['K02']['status'] == 'reserved', 'máy chủ: K02 vẫn giữ cho yêu cầu')

    # ── 5. Đối chiếu và nhật ký ──
    step('Logistic Lead: ghi cách xử lý đối chiếu, mở dòng theo địa chỉ, lọc nhật ký')
    P.go('#/recon', 'recon')
    ok(P.pg.locator('.recon-st button', has_text='Ghi cách xử lý').count() >= 1, 'Lead thấy nút ghi cách xử lý')
    rid = next(r['id'] for r in LL.req('GET', '/api/hub/recon')['items'] if 'KB09' in r['text'])
    P.pg.locator('.h-tbl tbody tr', has_text='không tìm thấy BO này').locator('button', has_text='Ghi cách xử lý').click()
    d = P.dialog('Ghi cách xử lý')
    d.locator('textarea[name=note]').fill('Đã gọi kho, KB09 thực tế đang ở VP; đã sửa ở mục Kit.')
    d.locator('.dlg-foot button', has_text='Lưu').click()
    P.dialog_gone()
    ok(P.toast('Đã ghi cách xử lý'), 'ghi cách xử lý → thông báo')
    r = next(x for x in LL.req('GET', '/api/hub/recon?status=all')['items'] if x['text'].endswith('không tìm thấy BO này.'))
    ok(r['status'] == 'resolved' and 'KB09' in r['note'], 'máy chủ: dòng đối chiếu đã xử lý, có ghi chú')
    P.go(f'#/recon/{rid}', 'recon')
    d = P.dialog('Dòng đối chiếu')
    ok('KB09' in d.inner_text(), 'mở #/recon/<id> → hiện chi tiết dòng')
    P.shot('recon-detail')
    d.locator('.dlg-foot button', has_text='Đóng').click()
    P.dialog_gone()
    P.shot('recon')
    P.go('#/log', 'log')
    ok(P.pg.locator('.h-tbl tbody tr').count() >= 5, 'nhật ký có nhiều thao tác')
    ok(P.pg.locator('.log-tools select[aria-label="Người làm"] option').count() >= 3, 'lọc nhật ký theo người làm')
    P.pg.locator('.log-tools select[aria-label="Đối tượng"]').select_option('kit')
    P.pg.wait_for_function('() => [...document.querySelectorAll(".h-tbl tbody tr")].every((tr) => tr.textContent.includes("Kit"))', timeout=8000)
    ok(True, 'lọc nhật ký theo Kit')
    P.pg.locator('.h-tbl tbody tr', has_text='K01').first.click()
    P.pg.wait_for_selector('.log-id:not([hidden])', timeout=5000)
    ok('Kit #' in P.pg.inner_text('.log-id'), 'bấm một dòng → xem nhật ký riêng của kit đó')
    ok('entity=kit' in P.hash() and 'id=' in P.hash(), 'bộ lọc nhật ký ghi lên địa chỉ')
    P.shot('log')
    P.close()

    # ── 6. Điện thoại: Lead xem điều phối / bảng việc; Head of Sale; Sale ──
    step('Điện thoại: Logistic Lead mở Điều phối / Bảng việc / Nhật ký')
    P = Page(b, base, 'lead', pw, '#/dispatch', phone=True)
    P.wait_view('dispatch')
    ok(P.no_hscroll(), 'Điều phối (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Điều phối (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.pg.locator('.dispatch-job', has_text=dlv['title']).locator('input[type=checkbox]').check()
    P.pg.wait_for_selector('.dispatch-bar:not([hidden])', timeout=5000)
    ok(P.pg.locator('.dispatch-bar').is_visible(), 'điện thoại: thanh "Lập chuyến ↓" hiện khi đã chọn việc')
    P.shot('dispatch')
    P.go('#/jobs', 'jobs')
    ok(P.no_hscroll(), 'Bảng việc của Lead (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Bảng việc (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.go(f"#/jobs/{man[0]['id']}", 'jobs')
    P.pg.wait_for_selector('.jobs-panel:not([hidden]) .jobs-acts', timeout=8000)
    small = P.small_taps('.jobs-panel .jobs-acts > button, .jobs-panel .jobs-acts > a')
    ok(not small, f'nút thao tác trong chi tiết ≥ 40 px: {small}')
    P.shot('jobs-panel')
    P.go('#/recon', 'recon')
    ok(P.no_hscroll(), 'Đối chiếu (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Đối chiếu (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.shot('recon')
    P.go('#/log', 'log')
    ok(P.no_hscroll(), 'Nhật ký (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Nhật ký (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.shot('log')
    P.go('#/inbox', 'inbox')
    ok(P.no_hscroll(), 'Thông báo (390 px): không cuộn ngang')
    ok(not P.view_small_taps(), f'Thông báo (390 px): chỗ bấm ≥ 40 px {P.view_small_taps()}')
    P.shot('inbox')
    P.close()

    step('Head of Sale (điện thoại): đối chiếu của Sale, nhật ký chỉ yêu cầu / BO / sự cố')
    P = Page(b, base, 'salehead', pw, '#/recon', phone=True)
    P.wait_view('recon')
    ok(P.pg.locator('.h-tbl tbody tr', has_text='Người Chưa Có').count() == 1, 'Head of Sale thấy dòng đối chiếu của Sale (BO chưa có Sale)')
    P.pg.locator('.h-tbl tbody tr', has_text='Người Chưa Có').locator('button', has_text='Ghi cách xử lý').click()
    d = P.dialog('Ghi cách xử lý')
    d.locator('.h-seg button', has_text='Bỏ qua').click()
    d.locator('textarea[name=note]').fill('BO02 sẽ giao cho Sale mới vào tuần sau.')
    d.locator('.dlg-foot button', has_text='Lưu').click()
    P.dialog_gone()
    ok(P.toast('Đã ghi bỏ qua'), 'Head of Sale ghi bỏ qua')
    rs = [x for x in C['salehead'].req('GET', '/api/hub/recon?status=all')['items'] if 'Người Chưa Có' in x['text']]
    ok(rs and rs[0]['status'] == 'ignored', 'máy chủ: dòng đối chiếu của Sale đã ghi bỏ qua')
    P.go('#/log', 'log')
    opts = P.pg.eval_on_selector_all('.log-tools select[aria-label="Đối tượng"] option', 'os => os.map((o) => o.value)')
    ok(sorted(opts) == sorted(['', 'request', 'outlet', 'incident']), f'Head of Sale: bộ lọc nhật ký chỉ có yêu cầu / BO / sự cố ({opts})')
    ents = {x['entity'] for x in C['salehead'].req('GET', '/api/hub/log?limit=1000')['items']}
    ok(ents and ents <= {'request', 'outlet', 'incident'}, f'máy chủ: nhật ký của Head of Sale chỉ gồm yêu cầu / BO / sự cố ({ents})')
    ok(P.pg.locator('.h-tbl tbody tr').count() >= 1, 'Head of Sale thấy nhật ký yêu cầu / BO')
    for v in ['home', 'jobs', 'dispatch']:
        denied(P, v, 'sale')
    P.close()

    step('Sale (điện thoại): thông báo; không mở được việc, điều phối, đối chiếu, nhật ký')
    P = Page(b, base, 'sale', pw, '#/inbox', phone=True)
    P.wait_view('inbox')
    ok(P.pg.locator('.inbox-it').count() >= 1, 'Sale có thông báo (yêu cầu đã sẵn sàng…)')
    ok(P.no_hscroll(), 'Thông báo của Sale (390 px): không cuộn ngang')
    for v in ['home', 'jobs', 'dispatch', 'recon', 'log']:
        denied(P, v, 'sale')
    P.close()

    step('Quản trị và Tech Lead: mở các màn hình, lọc theo team')
    P = Page(b, base, 'admin', pw, '#/jobs')
    P.wait_view('jobs')
    P.pg.locator('.h-chips button', has_text='Tech').first.click()
    P.pg.wait_for_timeout(600)
    ok(P.pg.locator('.jobs-content .h-tbl tbody tr').count() >= 1, 'Quản trị lọc Bảng việc theo team Tech')
    for v in ['home', 'dispatch', 'recon', 'inbox', 'log']:
        P.go(f'#/{v}', v)
        ok(P.view_id() == v, f'Quản trị mở được {v}')
    P.close()
    P = Page(b, base, 'techlead', pw, '#/home')
    P.wait_view('home')
    ok(P.pg.locator('.home-kpis .h-kpi').count() >= 5, 'Tech Lead thấy số liệu của team trên Việc của tôi')
    P.shot('home-techlead')
    denied(P, 'dispatch', 'overview')
    P.go('#/log', 'log')
    ok(P.view_id() == 'log', 'Tech Lead mở được Nhật ký')
    P.close()


def run_demo(base, pw, b):
    """Dữ liệu mẫu 9 tuần (DEMO=1): mở từng màn hình theo vai trò với khối lượng dữ liệu thật, bấm một việc thật, chụp ảnh."""
    plan = [('tech', True, '#/home'), ('log', True, '#/home'), ('lead', False, '#/jobs'), ('techlead', False, '#/home'), ('admin', False, '#/jobs'), ('salehead', True, '#/recon')]
    for user, phone, start in plan:
        step(f'Dữ liệu mẫu: {user}{" (điện thoại)" if phone else ""}')
        P = Page(b, base, user, pw, start, phone=phone)
        for v in ['home', 'jobs', 'dispatch', 'recon', 'inbox', 'log']:
            P.pg.evaluate('h => { location.hash = h; }', f'#/{v}')
            P.pg.wait_for_timeout(300)
            if P.view_id() != v:
                continue  # vai trò không mở được: đã kiểm ở kịch bản chính
            P.wait_view(v, timeout=20000)
            if phone:
                ok(P.no_hscroll(), f'dữ liệu mẫu, {user}: {v} (390 px) không cuộn ngang')
            if v == 'jobs':
                ok(P.pg.locator('.jobs-content .h-tbl tbody tr').count() >= 1, f'dữ liệu mẫu, {user}: Bảng việc có việc')
            P.shot(f'demo-{v}-{user}')
        if user == 'tech':
            P.go('#/home', 'home')
            btn = P.pg.locator('.home-list .jobs-item-a button', has_text='Bắt đầu')
            if btn.count():
                # Locator lồng (has=) tìm bên trong thẻ việc nên chỉ dùng phần chọn tương đối, không lặp lại .home-list.
                item = P.pg.locator('.home-list .jobs-item').filter(has=P.pg.locator('.jobs-item-a button', has_text='Bắt đầu')).first
                jid = item.get_attribute('data-id')
                item.locator('.jobs-item-a button', has_text='Bắt đầu').click()
                P.pg.wait_for_selector(f'.home-list .jobs-item[data-id="{jid}"] .jobs-item-a :text("Báo xong")', timeout=8000)
                ok(True, 'dữ liệu mẫu: Tech bắt đầu một việc thật từ Việc của tôi')
        P.close()


def main():
    serve = '--serve' in sys.argv
    t0 = time.time()
    srv, base, pw = S.start(PORT, demo=False)
    try:
        C, req = seed(base, pw)
        print(f'Máy chủ thử: {base} · mật khẩu {pw}')
        if serve:
            print('Đang chạy. Ctrl+C để dừng.')
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                return 0
        with sync_playwright() as p:
            b = S.browser(p)
            try:
                run(base, pw, b, C, req)
            except Exception as e:  # một bước hỏng: ghi lại và in tóm tắt
                import traceback
                traceback.print_exc()
                fails.append(f'kịch bản dừng giữa chừng: {e}')
            if fails and os.environ.get('DEBUG'):
                print('  Thao tác ghi từ trình duyệt:', *REQS[-60:], sep='\n    ')
                for j in jobs(C['admin'], team='logistics') + jobs(C['admin'], team='tech'):
                    print(f"    việc {j['id']} {j['type']} {j['status']} {j['title'][:40]} · {(j.get('done_by') or {}).get('name')}")
            b.close()
    finally:
        S.stop(srv)
    if not serve and os.environ.get('DEMO_PASS', '1') != '0':
        # Dữ liệu mẫu (core/hub/demo.js) nếu máy chủ đã nạp đủ vai trò; chưa có thì bỏ qua.
        srv2, base2, pw2 = S.start(PORT + 1, demo=True)
        try:
            if pw2 == S.DEMO_PW:
                with sync_playwright() as p:
                    b = S.browser(p)
                    try:
                        run_demo(base2, pw2, b)
                    except Exception as e:
                        import traceback
                        traceback.print_exc()
                        fails.append(f'dữ liệu mẫu: dừng giữa chừng: {e}')
                    b.close()
            else:
                print('  (máy chủ chưa nạp dữ liệu mẫu Ops Hub đủ vai trò: bỏ phần chạy trên dữ liệu mẫu)')
        finally:
            S.stop(srv2)
    print(f'\nNhóm việc hằng ngày: {passes[0]} phép kiểm đạt, {len(fails)} không đạt ({time.time() - t0:.0f} giây).')
    for f in fails:
        print('  ✗ ' + f)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
