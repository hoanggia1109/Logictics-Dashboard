#!/usr/bin/env python3
"""Kiểm thử bản xem thử một-file (không máy chủ): node tools/build-preview.mjs /tmp/p.html --inline-leaflet && python3 test/ui/preview.py /tmp/p.html
Bản xem thử chạy đúng lõi nghiệp vụ trong trình duyệt; bài này soát: mở được, đúng nút theo vai, chuyển Ops Hub ↔ Rider Live,
Sale không thấy bản đồ FO, vai FO và BO dùng được, điện thoại giao diện tối không tràn ngang, không lỗi JS."""
import os, sys, time
from playwright.sync_api import sync_playwright

FILE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'preview/atlas-ops-hub-demo.html')
SHOTS = os.environ.get('SHOTS', '')
EXE = '/opt/pw-browsers/chromium' if os.path.exists('/opt/pw-browsers/chromium') else None
fails, passes, errs = [], [0], []
def ok(cond, msg):
    if cond: passes[0] += 1
    else: fails.append(msg); print('    ✗ ' + msg)
def step(name): print('  • ' + name)

# Mục điều hướng mong đợi theo vai (lấy từ NAV trong public/js/hub.js; đổi NAV thì đổi ở đây).
MUST = {
    'admin': ['overview', 'sale', 'jobs', 'dispatch', 'perf', 'accounts', 'settings', 'import'],
    'salehead': ['sale', 'overview', 'outlets', 'requests', 'incidents', 'accounts', 'log'],
    'sale': ['sale', 'outlets', 'requests', 'incidents'],
    'lead': ['overview', 'jobs', 'dispatch', 'kits', 'acc', 'perf', 'roster', 'attendance', 'accounts'],
    'log': ['home', 'jobs', 'dispatch', 'kits', 'acc', 'cards', 'me', 'roster'],
    'techlead': ['overview', 'jobs', 'upload', 'perf', 'accounts', 'import'],
    'tech': ['home', 'jobs', 'upload', 'incidents', 'me'],
}
MUST_NOT = {
    'salehead': ['jobs', 'dispatch', 'kits', 'cards', 'perf', 'me', 'roster', 'attendance', 'home'],
    'sale': ['overview', 'jobs', 'dispatch', 'kits', 'cards', 'perf', 'me', 'roster', 'accounts', 'log', 'settings', 'recon'],
    'log': ['perf', 'attendance', 'accounts', 'settings', 'import', 'upload', 'overview'],
    'tech': ['perf', 'attendance', 'accounts', 'settings', 'import', 'dispatch', 'overview'],
    'techlead': ['dispatch'],
}
LIVE = {'admin': True, 'lead': True, 'log': True, 'salehead': False, 'sale': False, 'techlead': False, 'tech': False}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE) if EXE else p.chromium.launch()
    def mk(w, h, mobile=False, scheme='light'):
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, color_scheme=scheme, locale='vi-VN')
        ctx.route('**/*', lambda r: r.abort() if r.request.url.startswith('http') else r.continue_())  # bản xem thử không được phụ thuộc mạng
        pg = ctx.new_page()
        pg.on('console', lambda m: errs.append(f'[console] {m.text}') if m.type == 'error' and 'net::ERR' not in m.text else None)
        pg.on('pageerror', lambda e: errs.append(f'[pageerror] {e}'))
        return ctx, pg
    def shot(pg, name):
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, name + '.png'))
    def role(pg, u, sel='.h-app'):
        pg.click(f'.demo-bar button[data-u={u}]')
        pg.wait_for_function(f"document.querySelector('.demo-bar button[data-u={u}]').getAttribute('aria-pressed') === 'true'", timeout=30000)
        pg.wait_for_selector(sel, timeout=30000)
    def settle(pg):  # chờ màn hình hiện xong (không còn khung chờ tải)
        pg.wait_for_function("document.querySelector('#h-main') && !document.querySelector('#h-main .h-loading, #h-main .h-skel') && document.querySelector('#h-main').children.length > 0", timeout=30000)
        pg.wait_for_timeout(400)
    def nav(pg): return pg.evaluate("[...document.querySelectorAll('.h-nav a[href^=\"#/\"]')].map(a => a.getAttribute('href').slice(2).split(/[/?]/)[0])")
    def no_overflow(pg, what): ok(pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'{what}: không tràn ngang')

    print('Bản xem thử – máy tính')
    ctx, P = mk(1366, 860)
    t0 = time.time(); P.goto('file://' + FILE); P.wait_for_selector('.h-app', timeout=90000); settle(P)
    print(f'    (dựng dữ liệu mẫu mất {time.time() - t0:.1f} giây)')
    ok(P.locator('.demo-bar button[aria-pressed=true]').get_attribute('data-u') == 'admin', 'mở ra bằng vai Quản trị')
    ok(P.locator('#h-main .h-card').count() >= 4, 'Tổng quan vận hành có các thẻ số liệu')
    shot(P, 'p_admin')

    for u in ['admin', 'salehead', 'sale', 'lead', 'log', 'techlead', 'tech']:
        step(f'vai {u}: đúng nút, mở được từng màn hình')
        if u != 'admin': role(P, u)
        settle(P)
        items = nav(P)
        miss = [x for x in MUST.get(u, []) if x not in items]
        extra = [x for x in MUST_NOT.get(u, []) if x in items]
        ok(not miss, f'{u}: có đủ mục {MUST.get(u)} (thiếu {miss})')
        ok(not extra, f'{u}: không có mục của vai khác (thừa {extra})')
        ok((P.locator('.h-svc button[data-svc=live]').count() > 0) == LIVE[u], f'{u}: nút Rider Live {"có" if LIVE[u] else "không có"}')
        bad = []
        for x in items:
            P.evaluate(f"location.hash = '#/{x}'")
            try:
                settle(P)
                if P.locator('#h-main .h-err').count(): bad.append(x)
            except Exception:
                bad.append(x)
        ok(not bad, f'{u}: mở được mọi màn hình trong thanh bên (lỗi: {bad})')
        shot(P, f'p_{u}')

    step('Sale gõ thẳng địa chỉ Rider Live và màn hình của Logistics: bị đưa về trang của mình')
    role(P, 'sale'); settle(P)
    P.evaluate("location.hash = '#/live'"); P.wait_for_timeout(800)
    ok(P.locator('.rm').count() == 0 and P.locator('.h-app').is_visible(), 'Sale không mở được bản đồ FO')
    P.evaluate("location.hash = '#/dispatch'"); settle(P)
    ok(not P.evaluate("location.hash").startswith('#/dispatch'), 'Sale không mở được Điều phối chuyến')

    step('Logistic Lead chuyển Ops Hub ↔ Rider Live, giữ nguyên màn hình đang xem')
    role(P, 'lead'); settle(P)
    P.evaluate("location.hash = '#/kits'"); settle(P)
    P.click('.h-svc button[data-svc=live]'); P.wait_for_selector('.rm', timeout=20000)
    ok(not P.locator('.h-app').is_visible(), 'Rider Live dùng trọn màn hình')
    ok(P.locator('.rm').count() >= 3, 'bản đồ có FO đang chạy')
    shot(P, 'p_live')
    t1 = time.time(); P.go_back(); P.wait_for_selector('.h-app', state='visible', timeout=10000)
    ok(P.evaluate("location.hash").startswith('#/kits'), 'quay lại Ops Hub đúng màn hình Kit')
    ok(time.time() - t1 < 3, f'chuyển dịch vụ nhanh ({time.time() - t1:.1f} giây)')

    step('vai FO: phải đồng ý điều khoản, rồi vào ứng dụng điện thoại')
    role(P, 'fo', '.consent, .fo-home')
    if P.locator('.consent').count():
        ok(P.locator('.agree').is_disabled(), 'FO phải đồng ý điều khoản trước')
        for c in P.locator('.terms input').all(): c.check()
        P.click('.agree')
    P.wait_for_selector('.fo-home', timeout=20000); ok(True, 'FO vào được màn hình chuyến')
    shot(P, 'p_fo')

    step('vai BO: mở link dùng một lần')
    role(P, 'bo', '.bl'); ok(P.locator('.bl').count() == 1, 'BO thấy lượt giao nhận của mình')
    ctx.close()

    print('Bản xem thử – điện thoại, giao diện tối')
    ctx, M = mk(390, 844, True, 'dark')
    M.goto('file://' + FILE); M.wait_for_selector('.h-app', timeout=90000); settle(M)
    for u in ['admin', 'salehead', 'sale', 'log', 'tech']:
        if u != 'admin': role(M, u)
        settle(M)
        ok(M.locator('.h-tabbar a').count() >= 2, f'{u}: có thanh chức năng dưới đáy')
        no_overflow(M, f'{u} – trang đầu'); shot(M, f'pm_{u}')
        tabs = M.evaluate("[...document.querySelectorAll('.h-tabbar a[href^=\"#/\"]')].map(a => a.getAttribute('href'))")
        for t in tabs[:4]:
            M.evaluate(f"location.hash = '{t}'"); settle(M); no_overflow(M, f'{u} – {t}')
    ctx.close(); b.close()

ok(not errs, 'trình duyệt không ghi lỗi nào: ' + ' | '.join(errs[:5]))
print(f'\nBản xem thử: {passes[0]} phép kiểm đạt, {len(fails)} không đạt.')
for f in fails: print(' - ' + f)
sys.exit(1 if fails else 0)
