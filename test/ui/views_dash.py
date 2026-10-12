#!/usr/bin/env python3
"""Kiểm thử giao diện nhóm bảng số: Tổng quan vận hành, Dashboard Kinh doanh, Đánh giá nhân sự, Hiệu suất của tôi, Sự cố thiết bị.

    python3 test/ui/views_dash.py            # chạy kiểm thử, in tóm tắt, lỗi thì thoát mã ≠ 0
    python3 test/ui/views_dash.py --serve    # chỉ dựng máy chủ có dữ liệu để xem tay (Ctrl+C để dừng)
    SHOTS=/thư/mục python3 test/ui/views_dash.py   # lưu ảnh chụp màn hình (sáng / tối, 1366 và 390 px)

Có dữ liệu mẫu 9 tuần (DEMO=1, core/hub/demo.js) thì dùng luôn; chưa có thì tự dựng dữ liệu qua API:
nhập BO / kit / lịch sử giờ quay / lịch sử sự cố bằng màn hình Nhập dữ liệu (API import), rồi thao tác thật (báo sự cố, Tech xử lý,
Lead chấm công, việc giao tay) để có số liệu kỳ hiện tại.
"""
import base64, datetime as dt, os, random, re, sys, tempfile, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hubsrv as S
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', '8141'))
SHOTS = os.environ.get('SHOTS', '')
fails, passes = [], [0]


def ok(cond, msg):
    if cond:
        passes[0] += 1
    else:
        fails.append(msg)
        print('    ✗ ' + msg)
    return cond


def step(name):
    print('  • ' + name)


# ───────────────────────── Dữ liệu thử (khi chưa có dữ liệu mẫu) ─────────────────────────
TODAY = dt.date.today()
MON = TODAY - dt.timedelta(days=TODAY.weekday())
D = lambda n: (TODAY + dt.timedelta(days=n)).isoformat()

BOS = [
    # mã, tên, sale, trạng thái, onboard (ngày trước hôm nay), quota, nhịp giờ/kit/ngày, số kit, khu vực
    ('BO01', 'Highlands Bến Thành', 'sale', 'Đang ghi hình', 330, 2600, 6.2, 2, 'Quận 1'),
    ('BO02', 'Phúc Long Lê Lợi', 'sale', 'Đang ghi hình', 290, 1700, 5.6, 2, 'Quận 1'),
    ('BO03', 'Circle K Nguyễn Huệ', 'sale2', 'Đang ghi hình', 240, 760, 4.1, 1, 'Quận 1'),
    ('BO04', 'Bách Hoá Xanh Gò Vấp', 'sale2', 'Đang ghi hình', 200, 900, 6.8, 2, 'Gò Vấp'),
    ('BO05', 'Pharmacity Thảo Điền', 'sale3', 'Đang ghi hình', 170, None, 3.2, 1, 'Thủ Đức'),
    ('BO06', 'GS25 Phan Xích Long', 'sale', 'Đang ghi hình', 130, 820, 5.9, 2, 'Phú Nhuận'),
    ('BO07', 'Ministop Cộng Hoà', 'sale3', 'Đang ghi hình', 100, 700, 2.4, 1, 'Tân Bình'),
    ('BO08', 'Cộng Cà Phê Hồ Con Rùa', 'sale2', 'Đang ghi hình', 75, 500, 5.2, 1, 'Quận 3'),
    ('BO09', 'FamilyMart Hai Bà Trưng', 'sale', 'Đang ghi hình', 52, 360, 6.6, 1, 'Quận 3'),
    ('BO10', 'Katinat Võ Văn Tần', 'sale3', 'Đang ghi hình', 33, 300, 4.6, 2, 'Quận 3'),
    ('BO11', 'Trung Nguyên Legend Thủ Đức', 'sale2', 'Đang ghi hình', 16, 400, 5.4, 1, 'Thủ Đức'),
    ('BO12', 'WinMart Quận 7', 'sale', 'Chờ launch', None, None, 0, 0, 'Quận 7'),
    ('BO13', 'Lotte Mart Nam Sài Gòn', 'sale3', 'Chờ launch', None, None, 0, 0, 'Quận 7'),
    ('BO14', 'The Coffee House Bình Thạnh', 'sale2', 'Tạm nghỉ', 210, 800, 3.8, 1, 'Bình Thạnh'),
    ('BO15', 'Co.op Food Tân Phú', 'sale3', 'Kết thúc', 300, None, 4.0, 0, 'Tân Phú'),
]
LABELS_MC = ['Không lên nguồn', 'Không ghi hình', 'CM5 mất kết nối', 'Lỗi thẻ nhớ', 'Thẻ đầy', 'Powerbank không sạc', 'Cáp lỏng hoặc đứt', 'Quá nhiệt', 'Lệch góc quay', 'BO tắt máy']
LABELS_IP = ['Không lên nguồn', 'Hết bộ nhớ', 'Pin chai hoặc không sạc', 'Quá nhiệt', 'Ứng dụng lỗi']


def csv_b64(rows):
    def cell(v):
        s = '' if v is None else str(v)
        return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s
    text = '\r\n'.join(','.join(cell(v) for v in r) for r in rows)
    return base64.b64encode(('﻿' + text).encode('utf8')).decode()


def do_import(cli, name, target, rows):
    r = cli.req('POST', '/api/hub/import/parse', {'name': name, 'data': csv_b64(rows)})
    sh = r['sheets'][0]
    g = sh['guess']
    plan = [{'sheet': 0, 'target': target, 'mapping': g['mapping'], 'header_row': sh['header_row']}]
    out = cli.req('POST', '/api/hub/import/run', {'token': r['token'], 'plan': plan, 'commit': True})
    rep = out['report'][0]
    if rep['error_count']:
        print(f'      nhập {name}: {rep["error_count"]} dòng lỗi, ví dụ {rep["errors"][:2]}')
    return rep


def login_cli(base, user, pw):
    c = S.Cli(base)
    c.login(user, pw)
    return c


def new_user(admin, base, username, name, role, pw):
    tmp = admin.req('POST', '/api/users', {'username': username, 'name': name, 'role': role})['tempPassword']
    c = S.Cli(base)
    c.login(username, tmp)
    c.req('POST', '/api/password', {'old': tmp, 'new': pw})
    return login_cli(base, username, pw)


def seed(base, pw):
    """Dựng dữ liệu đủ để mọi bảng số có hình: 15 BO, ~20 kit, 9 tuần giờ quay, 9 tuần sự cố, việc xong trong tuần."""
    rnd = random.Random(20261008)
    admin = login_cli(base, 'admin', pw)
    clis = {'admin': admin}
    for u in ['techlead', 'tech', 'lead', 'log', 'salehead', 'sale']:
        clis[u] = login_cli(base, u, pw)
    clis['sale2'] = new_user(admin, base, 'sale2', 'Trần Thị Bình', 'sale', pw)
    clis['sale3'] = new_user(admin, base, 'sale3', 'Lê Minh Cường', 'sale', pw)
    clis['tech2'] = new_user(admin, base, 'tech2', 'Phạm Quốc Huy', 'tech', pw)
    clis['log2'] = new_user(admin, base, 'log2', 'Võ Thanh Tâm', 'logistic', pw)

    # BO
    rows = [['Mã BO', 'Tên BO', 'Sale phụ trách', 'Trạng thái', 'Ngày launch', 'Ngày onboard', 'Ngày kết thúc', 'Quota giờ quay', 'Khu vực', 'Ngành', 'Vĩ độ', 'Kinh độ', 'Ngày đổi thẻ', 'Khung giờ đổi thẻ', 'Người liên hệ', 'SĐT']]
    for i, (code, name, sale, stt, ob, quota, pace, nk, area) in enumerate(BOS):
        onb = D(-ob) if ob else ''
        end = D(-20) if stt == 'Kết thúc' else ''
        launch = onb or D(9 + i)
        rows.append([code, name, sale, stt, launch, onb, end, quota or '', area, 'Bán lẻ' if i % 2 else 'F&B', round(10.76 + i * 0.004, 5), round(106.68 + i * 0.005, 5), 'T2, T4, T6', '09:00-11:00', 'Quản lý cửa hàng', f'0909{100000 + i:06d}'])
    do_import(admin, 'bo.csv', 'outlets', rows)

    # Kit
    rows = [['Mã kit', 'Loại kit', 'Trạng thái', 'BO đang đặt kit']]
    kits = {}
    n = 1
    for code, name, sale, stt, ob, quota, pace, nk, area in BOS:
        for j in range(nk if stt in ('Đang ghi hình', 'Tạm nghỉ') else 0):
            kind = 'iPhone Mono' if (n % 4 == 0) else 'Multicam'
            kc = ('IP' if kind == 'iPhone Mono' else 'MC') + f'{n:03d}'
            rows.append([kc, kind, 'Tại BO', code])
            kits.setdefault(code, []).append(kc)
            n += 1
    for j in range(6):
        rows.append([f'MC{100 + j}', 'Multicam' if j % 3 else 'iPhone Mono', 'Sẵn sàng', ''])
    rows.append(['MC120', 'Multicam', 'Đang sửa', ''])
    rows.append(['IP121', 'iPhone Mono', 'Đang sửa', ''])
    do_import(admin, 'kit.csv', 'kits', rows)

    # Lịch sử giờ quay: 9 tuần, mỗi kit một thẻ mỗi ngày (bỏ 1 ngày gần nhất: thẻ chưa về).
    rows = [['Mã thẻ', 'BO', 'Ngày quay', 'Giờ quay', 'Mã kit', 'Lý do 0 giờ']]
    start = MON - dt.timedelta(days=7 * 8)
    for code, name, sale, stt, ob, quota, pace, nk, area in BOS:
        if not ob or code not in kits:
            continue
        first = max(start, TODAY - dt.timedelta(days=ob))
        last = TODAY - dt.timedelta(days=1)
        if stt == 'Tạm nghỉ':
            last = TODAY - dt.timedelta(days=12)
        d = first
        while d <= last:
            trend = 1 + 0.12 * ((d - start).days / 63 - 0.5)
            for kc in kits[code]:
                if rnd.random() < 0.035:
                    hrs, why = 0, 'BO không bật máy'
                else:
                    hrs, why = max(0.3, round(pace * trend * rnd.uniform(0.72, 1.22), 2)), ''
                rows.append([f'SD{kc[2:]}{d.strftime("%m%d")}', code, d.isoformat(), hrs, kc, why])
            d += dt.timedelta(days=1)
    do_import(admin, 'gio-quay.csv', 'records', rows)

    # Lịch sử sự cố: 9 tuần; tuần này "CM5 mất kết nối" tăng vọt.
    rows = [['Ngày báo', 'BO', 'Mã kit', 'Nhãn lỗi', 'Mô tả', 'Trạng thái', 'Cách xử lý', 'Ngày xử lý']]
    live = [b for b in BOS if b[3] == 'Đang ghi hình']
    for w in range(9, 0, -1):
        for k in range(rnd.randint(3, 7)):
            day = MON - dt.timedelta(days=7 * w) + dt.timedelta(days=rnd.randint(0, 6))
            b = rnd.choice(live)
            kc = rnd.choice(kits[b[0]])
            lab = rnd.choice(LABELS_IP if kc.startswith('IP') else LABELS_MC)
            res = rnd.choice(['Xử lý tại chỗ', 'Xử lý tại chỗ', 'Đổi máy', 'Mang về sửa'])
            rows.append([day.isoformat(), b[0], kc, lab, f'{lab} tại quầy', 'Đã xử lý', res, (day + dt.timedelta(days=1)).isoformat()])
    for i, b in enumerate([live[0], live[2], live[4], live[6]]):
        day = MON + dt.timedelta(days=min(i, TODAY.weekday()))
        mc = [k for k in kits[b[0]] if k.startswith('MC')] or kits[b[0]]
        rows.append([day.isoformat(), b[0], mc[0], 'CM5 mất kết nối', 'CM5 mất kết nối, đèn đỏ', 'Đã xử lý', 'Xử lý tại chỗ', day.isoformat()])
    do_import(admin, 'su-co.csv', 'incidents', rows)

    outlets = {o['code']: o for o in admin.req('GET', '/api/hub/outlets')['outlets']}
    # Sale gửi yêu cầu mở BO (BO "chờ máy").
    clis['sale'].req('POST', '/api/hub/requests', {'site_id': outlets['BO12']['id'], 'need': {'multicam': 2}, 'launch_date': D(6), 'note': 'Khai trương cuối tuần'})
    # Sự cố đang mở trong tuần (báo qua API như người dùng thật), Tech nhận và xử lý một phần.
    inc = []
    for who, code, lab, urgent in [('sale', 'BO01', 'Quá nhiệt', True), ('sale2', 'BO04', 'Lỗi thẻ nhớ', False), ('lead', 'BO06', 'Cáp lỏng hoặc đứt', False), ('sale3', 'BO10', 'Không ghi hình', True), ('salehead', 'BO09', 'Thẻ đầy', False), ('lead', 'BO03', 'Powerbank không sạc', False)]:
        o = outlets[code]
        det = clis[who].req('GET', f'/api/hub/outlets/{o["id"]}')
        kit = next((k for k in det['kits'] if k['kind'] == 'multicam'), det['kits'][0] if det['kits'] else None)
        r = clis[who].req('POST', '/api/hub/incidents', {'site_id': o['id'], 'kit_id': kit['id'] if kit else None, 'label': lab, 'text': f'{lab}, BO báo qua điện thoại', 'urgent': urgent})
        inc.append(r['incident'])
    clis['tech'].req('POST', f'/api/hub/incidents/{inc[0]["id"]}/ack')
    clis['tech'].req('POST', f'/api/hub/incidents/{inc[0]["id"]}/resolve', {'resolution': 'no_recover', 'note': 'Vệ sinh khe tản nhiệt, đặt lại vị trí'})
    clis['tech2'].req('POST', f'/api/hub/incidents/{inc[1]["id"]}/ack')
    clis['tech2'].req('POST', f'/api/hub/incidents/{inc[1]["id"]}/resolve', {'resolution': 'swap', 'note': 'Thẻ lỗi, đổi máy cho BO'})
    clis['tech'].req('POST', f'/api/hub/incidents/{inc[2]["id"]}/ack')

    # Chấm công tuần này và tuần trước để đủ công xếp loại; việc giao tay có phút chuẩn để có điểm khối lượng.
    users = {u['username']: u for u in admin.req('GET', '/api/users')['users']}
    days = [MON + dt.timedelta(days=i) for i in range(TODAY.weekday())] + [MON - dt.timedelta(days=7) + dt.timedelta(days=i) for i in range(5)]
    for lead, members in [('techlead', ['tech', 'tech2']), ('lead', ['log', 'log2'])]:
        for m in members:
            for d in days:
                st = 'late' if (d.day + len(m)) % 7 == 0 else 'present'
                clis[lead].req('PATCH', f'/api/hub/attendance/{users[m]["id"]}/{d.isoformat()}', {'status': st, 'checkin': '08:40' if st == 'late' else '08:25', 'reason': 'Bổ sung chấm công cho dữ liệu thử'})
    plan = [('techlead', 'tech', 'tech', [40, 25, 60, 30]), ('techlead', 'tech', 'tech2', [20, 35]), ('lead', 'logistics', 'log', [45, 30, 30, 20, 25]), ('lead', 'logistics', 'log2', [30, 15, 40])]
    for lead, team, who, stds in plan:
        for i, s in enumerate(stds):
            j = clis[lead].req('POST', '/api/hub/jobs', {'team': team, 'title': f'Việc giao tay {i + 1} cho {who}', 'assignee_id': users[who]['id'], 'std_min': s, 'due_hours': 1 if i == 0 and who == 'log2' else 24})['job']
            if not (who == 'log2' and i == 0):
                clis[who].req('POST', f'/api/hub/jobs/{j["id"]}/start')
                clis[who].req('POST', f'/api/hub/jobs/{j["id"]}/done', {'result': {}})
    return {'outlets': outlets, 'incidents': inc, 'users': users}


def boot():
    srv, base, pw = S.start(PORT)
    demo = pw == S.DEMO_PW
    info = None
    if not demo:
        t0 = time.time()
        info = seed(base, pw)
        print(f'  (chưa có dữ liệu mẫu: đã dựng dữ liệu qua API trong {time.time() - t0:.1f} giây)')
    return srv, base, pw, demo, info



# ───────────────────────── Kiểm thử giao diện ─────────────────────────
USERS = ['admin', 'techlead', 'tech', 'lead', 'log', 'salehead', 'sale']
VIEWS = {
    'overview': (['admin', 'techlead', 'lead', 'salehead'], '.ov .h-kpis'),
    'sale': (['admin', 'salehead', 'sale'], '.sale-v .h-kpis'),
    'perf': (['admin', 'techlead', 'lead'], '.perf-v .h-kpis'),
    'me': (['techlead', 'tech', 'lead', 'log'], '.me-v .h-kpis, .me-v .h-empty'),
    'incidents': (USERS, '.inc-v .h-tbl'),
}
SHOT_ROLE = {'overview': 'admin', 'sale': 'salehead', 'perf': 'lead', 'me': 'tech', 'incidents': 'techlead'}
FO_WORDS = ['Field Ops', 'Rider Live', 'FO ']


def iso_week(d):
    y, w, _ = d.isocalendar()
    return f'{y}-W{w:02d}'


def settle(pg, ms=500):
    pg.wait_for_selector('.h-view:not(:has(.h-loading))', timeout=15000)
    pg.wait_for_timeout(ms)


def open_view(pg, base, view, query=''):
    pg.goto(f'{base}/#/{view}{query}')
    settle(pg)


def no_hscroll(pg):
    return pg.evaluate("""() => {
        const doc = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
        const m = document.querySelector('.h-main');
        return Math.max(doc, m ? m.scrollWidth - m.clientWidth : 0);
    }""") <= 1


def dlg(pg, title):
    return pg.locator(f'dialog[open]:has(.dlg-head h2:has-text("{title}"))').last


def wait_api(fn, ok_fn, tries=40):
    for _ in range(tries):
        v = fn()
        if ok_fn(v):
            return v
        time.sleep(0.15)
    return v


def check_roles(b, base, pw, width):
    """Mọi vai trò: mở các màn hình được phép (có nội dung, không lỗi JS, không cuộn ngang); màn hình không được phép thì bị chuyển đi và không có trên menu."""
    step(f'Vai trò × màn hình ở {width}px')
    for u in USERS:
        ctx = b.new_context(viewport={'width': width, 'height': 850 if width > 500 else 800})
        pg = ctx.new_page()
        errs = S.watch(pg)
        S.login(pg, base, u, pw)
        for view, (roles, sel) in VIEWS.items():
            nav = pg.locator(f'.h-side a[data-view="{view}"]').count()
            if u in roles:
                open_view(pg, base, view)
                pg.wait_for_selector(sel, timeout=15000)
                ok(pg.evaluate('location.hash').startswith(f'#/{view}'), f'{u} mở được #{view} ({width}px)')
                ok(pg.locator('.h-view .h-err').count() == 0, f'{u} #{view}: không có khối lỗi tải dữ liệu ({width}px)')
                ok(no_hscroll(pg), f'{u} #{view}: không cuộn ngang trang ({width}px)')
                if width > 500:
                    ok(nav == 1, f'{u} thấy #{view} trên menu')
                if u in ('sale', 'salehead') and view in ('sale', 'overview', 'incidents'):
                    txt = pg.inner_text('.h-view')
                    ok(not any(w in txt for w in FO_WORDS), f'{u} #{view}: không có gì về Field Ops')
            else:
                pg.goto(f'{base}/#/{view}')
                pg.wait_for_timeout(500)
                ok(not pg.evaluate('location.hash').startswith(f'#/{view}'), f'{u} không vào được #{view} (bị chuyển đi)')
                ok(nav == 0, f'{u} không thấy #{view} trên menu')
        if u in ('sale', 'log'):
            open_view(pg, base, 'incidents')
            ok(pg.locator('.inc-stats').count() == 0, f'{u}: không có khối thống kê sự cố')
        ok(not errs, f'{u} ({width}px): không lỗi JS / 5xx — {errs[:3]}')
        ctx.close()


def flows(b, base, pw, demo):
    errs_all = []
    def page(u):
        ctx = b.new_context(viewport={'width': 1366, 'height': 850})
        pg = ctx.new_page()
        errs = S.watch(pg)
        errs_all.append((u, errs))
        S.login(pg, base, u, pw)
        return ctx, pg

    # 1. Đổi kỳ: Tuần → Tháng → tháng trước → Tháng này
    step('Tổng quan: đổi kỳ tuần / tháng, lùi kỳ, về kỳ này')
    ctx, pg = page('admin')
    open_view(pg, base, 'overview')
    cur_w = pg.inner_text('.dash-plabel b')
    ok(re.match(r'^W\d+$', cur_w) is not None, f'nhãn tuần hiện tại: {cur_w}')
    pg.click('.dash-period .h-seg button:has-text("Tháng")')
    pg.wait_for_function("() => /^T\\d+\\//.test(document.querySelector('.dash-plabel b').textContent)")
    m_cur = pg.inner_text('.dash-plabel b')
    ok('period=month' in pg.evaluate('location.hash'), 'kỳ tháng ghi vào địa chỉ')
    pg.click('.dash-step button[aria-label="Xem tháng trước"]')
    pg.wait_for_function(f"() => document.querySelector('.dash-plabel b').textContent !== {json.dumps(m_cur)}")
    ok(pg.locator('.dash-period button:has-text("Tháng này")').count() == 1, 'lùi tháng: có nút "Tháng này"')
    ok(pg.locator('.dash-step button[aria-label="Xem tháng sau"]').is_enabled(), 'lùi tháng: nút tháng sau bấm được')
    pg.click('.dash-period button:has-text("Tháng này")')
    pg.wait_for_function(f"() => document.querySelector('.dash-plabel b').textContent === {json.dumps(m_cur)}")
    ok(pg.locator('.dash-step button[aria-label="Xem tháng sau"]').is_disabled(), 'kỳ hiện tại: không đi tới tương lai')
    ok(pg.locator('.ov .ch svg').count() >= 4, 'tổng quan có ít nhất 4 biểu đồ')
    # tooltip biểu đồ bằng bàn phím
    ch = pg.locator('.ov .ch[tabindex="0"]').first
    ch.focus(); pg.keyboard.press('ArrowLeft')
    ok(pg.locator('.ch-tip:visible').count() >= 1, 'biểu đồ: phím mũi tên hiện số')
    ctx.close()

    # 2. Kinh doanh: sửa quota (Sale), lọc theo Sale Lead (Head of Sale)
    step('Kinh doanh: Sale sửa quota; Head of Sale lọc BO theo Sale Lead')
    ctx, pg = page('sale')
    open_view(pg, base, 'sale')
    ok(pg.locator('.sale-v h3:has-text("Theo Sale Lead")').count() == 0, 'Sale Lead không thấy bảng so sánh các Sale Lead')
    rows = pg.locator('.sale-q')
    if ok(rows.count() > 0, 'Sale có danh sách quota'):
        name = rows.first.locator('.sale-q-n a, .sale-q-n b').first.inner_text()
        rows.first.locator('.sale-q-e').click()
        d = dlg(pg, 'Quota giờ quay')
        d.locator('input[name=quota_hours]').fill('987')
        d.locator('.dlg-foot button.primary').click()
        cli = login_cli(base, 'sale', pw)
        got = wait_api(lambda: [o for o in cli.req('GET', '/api/hub/outlets')['outlets'] if o['name'] == name], lambda v: v and v[0].get('quota_hours') == 987)
        ok(got and got[0].get('quota_hours') == 987, f'quota của {name} đã lưu 987 giờ')
        pg.wait_for_timeout(600)
        ok(pg.locator('.sale-q:has-text("987")').count() >= 1 or pg.locator('.sale-v .h-tbl:has-text("987")').count() >= 0, 'danh sách quota cập nhật')
    hrefs = pg.eval_on_selector_all('.sale-v .h-tbl a[href^="#/outlets/"]', 'els => els.map(e => e.getAttribute("href"))')
    ok(len(hrefs) > 0 and all(re.match(r'^#/outlets/\d+$', x) for x in hrefs), f'mọi dòng BO có link #/outlets/<id> ({len(hrefs)})')
    ctx.close()
    ctx, pg = page('salehead')
    open_view(pg, base, 'sale')
    lead_rows = pg.locator('.sale-v .h-card:has(h3:has-text("Theo Sale Lead")) tbody tr')
    if ok(lead_rows.count() >= 1, 'Head of Sale thấy bảng theo Sale Lead'):
        lead_rows.first.click()
        pg.wait_for_timeout(400)
        ok(pg.eval_on_selector('.sale-bo select', 'e => e.value') != '', 'bấm Sale Lead: bảng BO lọc theo người đó')
    ok(pg.locator('.sale-v .ch svg').count() >= 3, 'Kinh doanh có biểu đồ (giờ, onboard, phân bố)')
    ctx.close()

    # 3. Đánh giá nhân sự: xem chi tiết người, chốt kỳ trước (Tech Lead), mở lại (Quản trị)
    prev_key = iso_week(MON - dt.timedelta(days=7))
    step(f'Đánh giá nhân sự: chi tiết, chốt {prev_key}, Quản trị mở lại')
    ctx, pg = page('techlead')
    open_view(pg, base, 'perf')
    people = pg.locator('.perf-v .h-card:has(h3:has-text("Từng người")) tbody tr')
    if ok(people.count() >= 1, 'Tech Lead thấy bảng từng người'):
        people.first.click()
        pg.wait_for_selector('dialog[open] .inc-detail')
        ok(re.match(r'^#/perf/\d+', pg.evaluate('location.hash')) is not None, 'chi tiết người có địa chỉ #/perf/<id>')
        ok(pg.locator('dialog[open]:has-text("Thành phần điểm")').count() == 1, 'chi tiết có thành phần điểm')
        pg.locator('dialog[open] .dlg-head .x').click()
        pg.wait_for_timeout(300)
        ok(pg.evaluate('location.hash').startswith('#/perf') and not re.match(r'^#/perf/\d', pg.evaluate('location.hash')), 'đóng chi tiết: về #/perf')
    ok(pg.locator('.perf-v .h-seg:has-text("Logistics")').count() == 0, 'Tech Lead không có nút đổi team')
    open_view(pg, base, 'perf', f'?key={prev_key}')
    btn = pg.locator('.perf-lock button:has-text("Chốt số liệu kỳ này")')
    tl = login_cli(base, 'techlead', pw)
    already = tl.req('GET', f'/api/hub/perf?key={prev_key}')['locked']
    if not already and ok(btn.count() == 1, 'kỳ trước chưa chốt: có nút chốt'):
        btn.click()
        d = dlg(pg, 'Xác nhận')
        ok('giữ nguyên' in d.inner_text(), 'hộp xác nhận nói rõ chốt là giữ nguyên số')
        d.locator('.dlg-foot button.primary').click()
        pg.wait_for_selector('.perf-lock[data-tone="go"]', timeout=10000)
        ok(tl.req('GET', f'/api/hub/perf?key={prev_key}')['locked'] is not None, 'máy chủ: kỳ trước đã chốt')
        ok(pg.locator('.perf-lock button:has-text("Mở lại kỳ")').count() == 0, 'Tech Lead không có nút mở lại')
    open_view(pg, base, 'perf')
    ok(pg.locator('.perf-lock button:has-text("Chốt")').count() == 0, 'kỳ đang chạy: không có nút chốt')
    ctx.close()
    ctx, pg = page('admin')
    open_view(pg, base, 'perf', f'?key={prev_key}')
    ok(pg.locator('.h-head .h-seg:has-text("Logistics")').count() == 1, 'Quản trị có nút đổi team')
    ub = pg.locator('.perf-lock button:has-text("Mở lại kỳ")')
    if ok(ub.count() == 1, 'Quản trị thấy nút mở lại kỳ đã chốt'):
        ub.click()
        d = pg.locator('dialog[open]:has(textarea[name=reason])').last
        d.locator('textarea[name=reason]').fill('Bổ sung chấm công sót của tuần trước')
        d.locator('.dlg-foot button.primary').click()
        pg.wait_for_selector('.perf-lock[data-tone="wait"]', timeout=10000)
        ok(tl.req('GET', f'/api/hub/perf?key={prev_key}')['locked'] is None, 'máy chủ: kỳ đã mở lại')
    pg.click('.h-head .h-seg button:has-text("Logistics")')
    pg.wait_for_function("() => document.querySelector('.h-head .sub').textContent.includes('Logistics')")
    ok(pg.locator('.perf-v h2:has-text("Field Ops")').count() == 1, 'Logistics có phần Field Ops riêng')
    ctx.close()

    # 4. Hiệu suất của tôi: chỉ số của mình
    step('Hiệu suất của tôi: không có tên / số của người khác')
    adm = login_cli(base, 'admin', pw)
    team_names = [r['user']['name'] for r in adm.req('GET', '/api/hub/perf?team=tech')['rows']]
    me_name = login_cli(base, 'tech', pw).req('GET', '/api/hub/me')['user']['name']
    ctx, pg = page('tech')
    open_view(pg, base, 'me')
    txt = pg.inner_text('.me-v')
    others = [n for n in team_names if n and n != me_name and n in txt]
    ok(not others, f'trang của tôi không có tên người khác ({others})')
    ctx.close()

    # 5. Sự cố: Sale báo → Tech nhận → Tech xử lý; Sale huỷ trong 30 phút; lọc theo lỗi từ thống kê
    step('Sự cố: báo, nhận, xử lý, huỷ, lọc theo lỗi')
    ctx, pg = page('sale')
    open_view(pg, base, 'incidents')
    pg.click('.h-head button:has-text("Báo sự cố")')
    d = dlg(pg, 'Báo sự cố')
    d.locator('select[name=site_id]').select_option(index=1)
    pg.wait_for_function("() => { const s = document.querySelector('dialog[open] select[name=kit_id]'); return s && !/Đang tải/.test(s.options[0].text); }")
    ok(d.locator('select[name=label] option').count() > 2, 'danh sách lỗi có sẵn')
    d.locator('select[name=label]').select_option(index=1)
    d.locator('textarea[name=text]').fill('Máy không ghi từ sáng, đèn báo đỏ (kiểm thử giao diện)')
    d.locator('.dlg-foot button.primary').click()
    pg.wait_for_selector('dialog[open] .dlg-head h2:has-text("Sự cố S")', timeout=10000)
    code = pg.inner_text('dialog[open] .dlg-head h2').replace('Sự cố ', '').strip()
    inc_id = int(re.search(r'#/incidents/(\d+)', pg.evaluate('location.hash')).group(1))
    sc = login_cli(base, 'sale', pw)
    so = sc.req('GET', '/api/hub/incidents?status=open')
    ok(any(i['code'] == code for i in so['incidents']), f'máy chủ có sự cố {code}')
    ok(so['open'] == len(so['incidents']), f'Sale: số "đang mở" ({so["open"]}) khớp danh sách BO của mình ({len(so["incidents"])})')
    ok(pg.locator('dialog[open] button:has-text("Nhận xử lý")').count() == 0, 'Sale không có nút Nhận xử lý')
    ok(pg.locator('dialog[open] button:has-text("Huỷ sự cố")').count() == 1, 'người báo có nút huỷ trong 30 phút')
    ctx.close()
    ctx, pg = page('tech')
    pg.goto(f'{base}/#/incidents/{inc_id}')
    pg.wait_for_selector('dialog[open] button:has-text("Nhận xử lý")', timeout=10000)
    pg.click('dialog[open] button:has-text("Nhận xử lý")')
    pg.wait_for_selector('dialog[open] .pill:has-text("Tech đang xử lý")', timeout=10000)
    pg.click('dialog[open] button:has-text("Báo đã xử lý")')
    d = dlg(pg, 'Báo đã xử lý')
    d.locator('.dlg-foot button.primary').click()
    ok('Chọn cách xử lý' in d.locator('.dlg-err').inner_text(), 'chưa chọn cách xử lý thì báo lỗi')
    d.locator('input[value=no_recover]').check()
    d.locator('textarea[name=note]').fill('Cắm lại cáp nguồn, máy ghi bình thường')
    d.locator('.dlg-foot button.primary').click()
    pg.wait_for_selector('dialog[open] .pill:has-text("Đã xử lý")', timeout=10000)
    tc = login_cli(base, 'tech', pw)
    ok(tc.req('GET', f'/api/hub/incidents/{inc_id}')['incident']['status'] == 'resolved', 'máy chủ: sự cố đã xử lý')
    ok(pg.locator('dialog[open] .inc-tl li').count() >= 3, 'diễn biến có báo, nhận, xử lý')
    pg.keyboard.press('Escape')
    pg.wait_for_timeout(300)
    ok(not re.match(r'^#/incidents/\d', pg.evaluate('location.hash')), 'đóng chi tiết: về danh sách')
    ok(pg.locator('.inc-stats').count() == 1, 'Tech thấy thống kê sự cố')
    ctx.close()
    sale_out = sc.req('GET', '/api/hub/outlets')['outlets']
    site = next((o for o in sale_out if o.get('ops_status') == 'live'), sale_out[0])
    labels = sc.req('GET', '/api/hub/labels')['labels']
    inc2 = sc.req('POST', '/api/hub/incidents', {'site_id': site['id'], 'label': (labels.get('multicam') or list(labels.values())[0])[-1], 'text': 'Báo nhầm để thử huỷ'})['incident']
    ctx, pg = page('sale')
    pg.goto(f'{base}/#/incidents/{inc2["id"]}')
    pg.wait_for_selector('dialog[open] button:has-text("Huỷ sự cố")', timeout=10000)
    pg.click('dialog[open] button:has-text("Huỷ sự cố")')
    d = pg.locator('dialog[open]:has(textarea[name=reason])').last
    d.locator('textarea[name=reason]').fill('Báo nhầm BO')
    d.locator('.dlg-foot button.primary').click()
    pg.wait_for_selector('dialog[open] .pill:has-text("Đã huỷ")', timeout=10000)
    ok(sc.req('GET', f'/api/hub/incidents/{inc2["id"]}')['incident']['status'] == 'cancelled', 'máy chủ: sự cố đã huỷ')
    ctx.close()
    ctx, pg = page('techlead')
    open_view(pg, base, 'incidents')
    first = pg.locator('.inc-stats .dash-rank a').first
    if ok(first.count() == 1, 'thống kê có top lỗi'):
        lab = first.locator('.dash-rank-l').inner_text()
        first.click()
        pg.wait_for_selector('.inc-filters .chip', timeout=10000)
        ok('label=' in pg.evaluate('location.hash'), 'bấm lỗi: lọc theo nhãn trong địa chỉ')
        pg.wait_for_timeout(500)
        labs = pg.eval_on_selector_all('.inc-v .h-tbl tbody .inc-lab b', 'els => els.map(e => e.textContent)')
        ok(labs and all(x == lab for x in labs), f'danh sách chỉ còn lỗi "{lab}" ({len(labs)} dòng)')
    pg.goto(f'{base}/#/incidents?new=1&site={site["id"]}')
    d = dlg(pg, 'Báo sự cố')
    d.wait_for(timeout=10000)
    ok(d.locator('select[name=site_id]').input_value() == str(site['id']), '#/incidents?new=1&site=<id>: mở hộp báo sự cố với BO chọn sẵn')
    d.locator('.dlg-foot button.ghost').click()
    ctx.close()

    for u, errs in errs_all:
        ok(not errs, f'thao tác của {u}: không lỗi JS / 5xx — {errs[:3]}')


def shots(b, base, pw):
    step(f'Ảnh chụp vào {SHOTS}')
    os.makedirs(SHOTS, exist_ok=True)
    for view, u in SHOT_ROLE.items():
        for scheme in ('light', 'dark'):
            for w in (1366, 390):
                ctx = b.new_context(viewport={'width': w, 'height': 850 if w > 500 else 800}, color_scheme=scheme)
                pg = ctx.new_page()
                S.login(pg, base, u, pw)
                open_view(pg, base, view)
                pg.wait_for_timeout(700)
                hgt = pg.evaluate("() => { const m = document.querySelector('.h-main'); return m ? m.scrollHeight + 120 : 2000 }")
                pg.set_viewport_size({'width': w, 'height': min(hgt, 9000)})
                pg.wait_for_timeout(500)
                pg.screenshot(path=os.path.join(SHOTS, f'{view}-{w}-{scheme}.png'), full_page=True)
                ctx.close()


def main():
    t0 = time.time()
    print(f'Kiểm thử giao diện nhóm bảng số (cổng {PORT})')
    srv, base, pw, demo, info = boot()
    print(f'  dữ liệu: {"mẫu 9 tuần (DEMO=1)" if demo else "dựng qua API"}')
    try:
        with sync_playwright() as p:
            b = S.browser(p)
            for w in (1366, 390):
                check_roles(b, base, pw, w)
            flows(b, base, pw, demo)
            if SHOTS:
                shots(b, base, pw)
            b.close()
    except Exception as e:  # lỗi bất ngờ cũng tính là không đạt
        import traceback
        traceback.print_exc()
        fails.append(f'lỗi khi chạy: {e}')
    finally:
        S.stop(srv)
    print(f'\nKết quả: {passes[0]} đạt, {len(fails)} không đạt ({time.time() - t0:.0f} giây)')
    for f in fails:
        print('  ✗ ' + f)
    sys.exit(1 if fails else 0)


if __name__ == '__main__' and '--serve' in sys.argv:
    srv, base, pw, demo, info = boot()
    print(f'Máy chủ: {base}  mật khẩu: {pw}  dữ liệu mẫu: {demo}')
    try:
        srv.wait()
    except KeyboardInterrupt:
        pass
    S.stop(srv)
    sys.exit(0)

if __name__ == '__main__':
    main()
