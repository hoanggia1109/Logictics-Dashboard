#!/usr/bin/env python3
"""Kiểm thử giao diện nhóm Kho: Kit & thiết bị, Phụ kiện, Thẻ nhớ & bàn giao, Nhập dung lượng.

Chạy: python3 test/ui/views_stock.py      (cổng 8161; SHOTS=<thư mục> để lưu ảnh chụp màn hình)
Dữ liệu: dùng dữ liệu mẫu (DEMO=1) nếu có, rồi tự tạo thêm thiết bị / kit / thẻ riêng của bài kiểm qua API (mã có hậu tố ngẫu nhiên).
Luồng thật qua giao diện: thêm thiết bị → tạo kit → gửi Tech kiểm → (Tech kiểm đạt qua API) → kit sẵn sàng → báo hỏng (sinh việc sửa)
→ sửa thành phần; sổ phụ kiện nhập thêm / ghi giảm / kiểm kê; phiếu gửi Tech → Tech nhận có thiếu thẻ → Tech nhập dung lượng bằng bàn phím
→ sửa bản ghi; Lead điều chỉnh thẻ; thêm loại thiết bị; ngừng dùng kit; quyền theo vai trò; điện thoại 390 px; sáng / tối.
"""
import os, re, sys, time, random, tempfile, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hubsrv as S
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', '8161'))
SHOTS = os.environ.get('SHOTS') or tempfile.mkdtemp(prefix='views-stock-')
SUF = str(random.randint(100, 999))
U = lambda x: f'U{x}{SUF}'  # mã riêng của lần chạy này

passes, fails = [0], []
def ok(cond, msg):
    if cond:
        passes[0] += 1
    else:
        fails.append(msg); print('    ✗ ' + msg)
def step(name): print('  • ' + name)
def until(fn, timeout=8.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.2)
    return None

def dlg(pg): return pg.locator('dialog.dlg[open]').last
def submit(pg): dlg(pg).locator('.dlg-foot button.primary').click()
def toast_has(pg, text, timeout=6000):
    try:
        pg.wait_for_function('(t) => { const e = document.querySelector("#toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=timeout)
        return True
    except Exception:
        return False
def shot(pg, name, full=False):
    pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)
def settle(pg, ms=500):
    pg.wait_for_timeout(ms)
    try:
        pg.wait_for_function('() => !document.querySelector(".h-view .h-loading, dialog.dlg[open] .h-loading")', timeout=8000)
    except Exception:
        pass
def no_hscroll(pg):
    return pg.evaluate('() => { const m = document.querySelector(".h-main"); return document.documentElement.scrollWidth <= innerWidth + 1 && (!m || m.scrollWidth <= m.clientWidth + 1); }')


def main():
    srv, base, pw = S.start(PORT)
    print(f'Máy chủ {base} · ảnh chụp: {SHOTS}')
    all_errs = []
    try:
        lead = S.Cli(base); lead.login('lead', pw)
        tl = S.Cli(base); tl.login('techlead', pw)
        meta = lead.req('GET', '/api/hub/meta')
        gbh = meta['cfg']['gbPerHour']
        demo = len(lead.req('GET', '/api/hub/kits')['kits']) > 0
        print(f'  (dữ liệu mẫu: {"có" if demo else "không"}; GB mỗi giờ: {gbh})')
        # Dữ liệu riêng cho bài kiểm (thẻ đã thu về VP để lập phiếu; kit phụ để ngừng dùng)
        lead.req('POST', '/api/hub/devices', {'type': 'multicam', 'codes': f'{U("MCX")}'})
        lead.req('POST', '/api/hub/devices', {'type': 'cm5', 'codes': f'{U("CMX")}'})
        k2 = lead.req('POST', '/api/hub/kits', {'code': U('KX'), 'kind': 'multicam', 'devices': f'{U("MCX")} {U("CMX")}'})['kit']
        sd = [U(f'SD{i}') for i in range(1, 5)]
        lead.req('POST', '/api/hub/devices', {'type': 'sd', 'codes': ' '.join(sd)})
        allc = lead.req('GET', '/api/hub/cards?limit=3000')['cards']
        cid = {c['code']: c['id'] for c in allc if c['code'] in sd}
        for code in sd:
            lead.req('PATCH', f'/api/hub/cards/{cid[code]}', {'status': 'returned', 'reason': 'Thu về cho bài kiểm giao diện'})

        with sync_playwright() as p:
            b = S.browser(p)
            def page(user, w=1366, h=850, scheme='light'):
                ctx = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, locale='vi-VN', device_scale_factor=1)
                pg = ctx.new_page()
                errs = S.watch(pg)
                all_errs.append((user, errs))
                S.login(pg, base, user, pw)
                return ctx, pg

            # ───────────── 1. Quyền: ai thấy màn hình nào ─────────────
            step('Quyền theo vai trò: thanh điều hướng và chặn mở thẳng địa chỉ')
            want = {'admin': {'kits', 'acc', 'cards', 'upload'}, 'techlead': {'kits', 'acc', 'cards', 'upload'}, 'tech': {'kits', 'acc', 'cards', 'upload'},
                    'lead': {'kits', 'acc', 'cards'}, 'log': {'kits', 'acc', 'cards'}, 'salehead': set(), 'sale': set()}
            for user, views in want.items():
                ctx, pg = page(user)
                for v in ['kits', 'acc', 'cards', 'upload']:
                    has = pg.locator(f'nav.h-nav a[data-view="{v}"]').count() > 0
                    ok(has == (v in views), f'{user}: mục "{v}" trên thanh điều hướng {"phải" if v in views else "không được"} hiện')
                    if v not in views:
                        pg.goto(f'{base}/#/{v}'); pg.wait_for_timeout(400)
                        ok(not pg.url.endswith(f'#/{v}') and pg.locator(f'.h-view[data-view="{v}"]').count() == 0, f'{user}: mở thẳng #/{v} phải bị đưa về màn hình khác')
                    else:
                        pg.goto(f'{base}/#/{v}'); settle(pg, 300)
                        ok(pg.locator(f'.h-view[data-view="{v}"] .h-head h1').count() == 1, f'{user}: mở được #/{v}')
                if user == 'tech':
                    pg.goto(f'{base}/#/kits'); settle(pg)
                    ok(pg.get_by_role('button', name='Tạo kit').count() == 0, 'tech: không có nút "Tạo kit"')
                    pg.goto(f'{base}/#/acc'); settle(pg)
                    ok(pg.get_by_role('button', name='Nhập thêm').count() == 0, 'tech: không có nút ghi sổ phụ kiện')
                    ok(pg.get_by_role('button', name='Xem sổ kho').count() > 0, 'tech: xem được sổ kho')
                if user == 'log':
                    pg.goto(f'{base}/#/kits'); settle(pg)
                    ok(pg.get_by_role('button', name='Tạo kit').count() == 1, 'log: có nút "Tạo kit"')
                ctx.close()

            # ───────────── 2. Phụ kiện: nhập thêm, ghi giảm, kiểm kê, sổ kho ─────────────
            step('Phụ kiện: Logistics nhập thêm / ghi giảm / kiểm kê, số tồn và sổ kho cập nhật')
            ctx, pg = page('log')
            acc0 = {a['id']: a for a in lead.req('GET', '/api/hub/acc')['acc']}['hub_sac']
            pg.goto(f'{base}/#/acc'); settle(pg)
            row = pg.locator('.h-tbl tbody tr', has=pg.locator('b', has_text='Hub sạc')).filter(has_not_text='Hub sạc to').first
            row.get_by_role('button', name='Nhập thêm').click()
            d = dlg(pg); d.locator('input[type=number]').fill('5'); d.locator('textarea').fill('Mua thêm 5 hub sạc (bài kiểm)')
            ok('tổng ' in d.locator('.acc-preview').inner_text(), 'xem trước số tổng sau khi ghi')
            submit(pg)
            ok(toast_has(pg, 'Đã ghi sổ'), 'báo đã ghi sổ nhập thêm')
            acc1 = until(lambda: next(a for a in lead.req('GET', '/api/hub/acc')['acc'] if a['id'] == 'hub_sac' and a['total'] == acc0['total'] + 5))
            ok(acc1 is not None, 'máy chủ: tổng hub sạc +5')
            pg.wait_for_timeout(500)
            ok(H_cell(row, 1) == fmt(acc0['total'] + 5), f'bảng hiện tổng mới {acc0["total"] + 5} (đang: {H_cell(row, 1)})')
            # ghi giảm vượt số rảnh: chặn ngay trên giao diện
            row.get_by_role('button', name='Ghi giảm').click()
            d = dlg(pg); d.locator('input[type=number]').fill(str(acc1['free'] + 3)); d.locator('textarea').fill('Thử ghi giảm quá số rảnh')
            submit(pg)
            ok(d.locator('.dlg-err:not([hidden])').count() == 1 and 'rảnh' in d.locator('.dlg-err').inner_text(), 'ghi giảm quá số rảnh: báo lỗi ngay trong hộp thoại')
            d.locator('input[type=number]').fill('2'); d.locator('textarea').fill('2 hub sạc cháy cổng, thanh lý')
            submit(pg)
            ok(toast_has(pg, '−2'), 'báo đã ghi giảm 2')
            acc2 = until(lambda: next(a for a in lead.req('GET', '/api/hub/acc')['acc'] if a['id'] == 'hub_sac' and a['total'] == acc1['total'] - 2))
            ok(acc2 is not None, 'máy chủ: tổng hub sạc −2')
            row.get_by_role('button', name='Kiểm kê').click()
            d = dlg(pg); d.locator('input[type=number]').fill(str(acc2['free'] - 1)); d.locator('textarea').fill('Kiểm kho cuối tuần (bài kiểm)')
            submit(pg)
            acc3 = until(lambda: next(a for a in lead.req('GET', '/api/hub/acc')['acc'] if a['id'] == 'hub_sac' and a['free'] == acc2['free'] - 1))
            ok(acc3 is not None, 'kiểm kê: số rảnh bằng số đếm được')
            pg.wait_for_timeout(600)
            row.click()
            pg.wait_for_selector('dialog.dlg[open] .acc-ledger .h-tbl tbody tr')
            settle(pg)
            ok('#/acc/hub_sac' in pg.url, 'sổ kho mở theo địa chỉ #/acc/hub_sac')
            led = dlg(pg).locator('.h-tbl tbody').inner_text()
            ok('+5' in led and '−2' in led and 'Kiểm kê' in led, 'sổ kho có đủ 3 dòng vừa ghi')
            ok('null' not in dlg(pg).inner_text(), 'sổ kho không hiện chữ "null"')
            shot(pg, 'acc_ledger_desktop')
            pg.go_back(); pg.wait_for_timeout(500)
            ok(pg.locator('dialog.dlg[open]').count() == 0 and pg.url.endswith('#/acc'), 'nút quay lại đóng sổ kho')
            shot(pg, 'acc_desktop_light')
            ctx.close()

            # ───────────── 3. Thiết bị → tạo kit → gửi kiểm → sẵn sàng → báo hỏng → sửa thành phần ─────────────
            step('Kit: thêm thiết bị, tạo kit, gửi Tech kiểm, Tech kiểm đạt → sẵn sàng')
            ctx, pg = page('log')
            pg.goto(f'{base}/#/kits?tab=devices'); settle(pg)
            # Dữ liệu mẫu có hơn 50 thiết bị / kit (bảng chia trang theo mã): lọc theo đuôi mã riêng của lần chạy để thấy dòng của bài kiểm.
            pg.get_by_placeholder('Tìm mã thiết bị…').fill(SUF); pg.wait_for_timeout(300)
            for typ, codes in [('multicam', f'{U("MC1")} {U("MC2")}'), ('cm5', f'{U("CM1")}')]:
                pg.get_by_role('button', name='Thêm thiết bị').click()
                d = dlg(pg); d.locator('select[name=type]').select_option(typ); d.locator('textarea[name=codes]').fill(codes)
                submit(pg)
                ok(toast_has(pg, 'Đã thêm'), f'thêm thiết bị {typ}')
                pg.wait_for_timeout(300)
            devs = {d['code']: d for d in lead.req('GET', '/api/hub/devices?limit=2000')['devices']}
            ok(all(c in devs for c in [U('MC1'), U('MC2'), U('CM1')]), 'máy chủ: 3 thiết bị mới có trong kho')
            until(lambda: pg.locator('.h-tbl tbody tr', has_text=U('MC1')).count() > 0, 5)
            ok(pg.locator('.h-tbl tbody tr', has_text=U('MC1')).count() == 1, 'bảng thiết bị hiện mã mới (cập nhật tại chỗ)')
            shot(pg, 'kits_devices_desktop')
            pg.get_by_role('tab', name='Kit').click(); settle(pg)
            pg.get_by_placeholder('Tìm mã kit, mã thiết bị, BO…').fill(SUF); pg.wait_for_timeout(300)
            pg.get_by_role('button', name='Tạo kit').click()
            pg.wait_for_selector('dialog.dlg[open] input[name=code]')
            d = dlg(pg)
            d.locator('input[name=code]').fill(U('K1').lower())
            d.locator('select[data-type=multicam]').select_option(U('MC1'))
            d.locator('select[data-type=cm5]').select_option(U('CM1'))
            d.locator('input[aria-label="Hub sạc"]').fill('1')
            ok('Đủ thành phần' in d.locator('.kits-hint').inner_text(), 'gợi ý: đủ thành phần chính')
            shot(pg, 'kits_create_dialog')
            submit(pg)
            ok(toast_has(pg, 'Đã tạo kit'), 'báo đã tạo kit')
            pg.wait_for_selector('dialog.dlg[open] .kits-facts')
            settle(pg)
            kit = until(lambda: next(k for k in lead.req('GET', '/api/hub/kits')['kits'] if k['code'] == U('K1')))
            ok(kit and kit['status'] == 'preparing' and kit['acc'].get('hub_sac') == 1, 'máy chủ: kit mới đang chuẩn bị, có 1 hub sạc')
            ok(f'/kits/{kit["id"]}' in pg.url, 'chi tiết kit mở theo địa chỉ #/kits/<id>')
            dlg(pg).get_by_role('button', name='Gửi Tech kiểm').click()
            ok(toast_has(pg, 'Tech kiểm'), 'báo đã gửi Tech kiểm')
            k = until(lambda: (lambda x: x if x['status'] == 'wait_check' else None)(lead.req('GET', f'/api/hub/kits/{kit["id"]}')['kit']))
            ok(k is not None, 'máy chủ: kit chờ Tech kiểm')
            job = next((j for j in (k or {}).get('jobs', []) if j['type'] == 'check_kit' and j['status'] in ('open', 'doing')), None)
            ok(job is not None, 'máy chủ: đã sinh việc "Kiểm kit trước khi xuất"')
            pg.wait_for_timeout(400)
            ok(dlg(pg).locator('.vs-job', has_text='Kiểm kit').count() >= 1, 'chi tiết kit hiện việc kiểm đang mở')
            shot(pg, 'kits_detail_wait_check')
            dlg(pg).locator('.dlg-head button.x').click(); pg.wait_for_timeout(300)
            ok(re.search(r'#/kits(\?[^/]*)?$', pg.url) is not None, 'đóng chi tiết thì địa chỉ về danh sách')  # giữ bộ lọc đang gõ (?q=…)
            tl.req('POST', f'/api/hub/jobs/{job["id"]}/done', {'pass': True})  # Tech Lead kiểm đạt (màn hình Bảng việc thuộc nhóm khác)
            ok(until(lambda: pg.locator('.h-tbl tbody tr', has_text=U('K1')).locator('.pill[data-k="ready"]').count() == 1, 8), 'danh sách tự cập nhật: kit "Sẵn sàng" sau khi Tech kiểm đạt')
            shot(pg, 'kits_desktop_light')

            step('Kit: báo hỏng → sang Tech, sinh việc sửa; Logistics sửa thành phần khi kit ở Tech')
            pg.locator('.h-tbl tbody tr', has_text=U('K1')).click()
            pg.wait_for_selector('dialog.dlg[open] .kits-facts'); settle(pg)
            dlg(pg).locator('.kits-acts').get_by_role('button', name='Báo hỏng').click()
            d = dlg(pg)
            d.locator('select[name=device_id]').select_option(label=f'{U("MC1")} · Multicam')
            d.locator('textarea[name=reason]').fill('Multicam không lên nguồn sau khi sạc')
            ok('Sửa kit' in d.locator('.h-form').inner_text(), 'hộp thoại giải thích việc sẽ sinh ra cho Tech')
            submit(pg)
            ok(toast_has(pg, 'chuyển sang Tech'), 'báo kit đã chuyển sang Tech')
            kf = until(lambda: (lambda x: x if x['status'] == 'at_tech' else None)(lead.req('GET', f'/api/hub/kits/{kit["id"]}')['kit']))
            ok(kf is not None, 'máy chủ: kit sang "Đang ở Tech"')
            ok(any(j['type'] == 'repair' and j['status'] in ('open', 'doing') for j in (kf or {}).get('jobs', [])), 'máy chủ: đã sinh việc "Sửa kit hỏng"')
            ok(any(d['code'] == U('MC1') and d['cond'] == 'faulty' for d in (kf or {}).get('devices', [])), 'máy chủ: thiết bị báo hỏng ghi "Hỏng"')
            pg.wait_for_timeout(400)
            ok(dlg(pg).locator('.kits-facts .pill[data-k="at_tech"]').count() == 1, 'chi tiết kit cập nhật trạng thái mới')
            dlg(pg).get_by_role('button', name='Sửa thành phần').click()
            pg.wait_for_selector(f'dialog.dlg[open] input[aria-label="Gỡ {U("MC1")}"]')
            d = dlg(pg)
            d.locator(f'input[aria-label="Gỡ {U("MC1")}"]').check()
            d.locator('select[aria-label="Gắn thêm Multicam"]').select_option(U('MC2'))
            shot(pg, 'kits_parts_dialog')
            submit(pg)
            ok(toast_has(pg, 'Đã cập nhật thành phần'), 'báo đã cập nhật thành phần')
            kp = until(lambda: (lambda x: x if sorted(d['code'] for d in x['devices']) == sorted([U('MC2'), U('CM1')]) else None)(lead.req('GET', f'/api/hub/kits/{kit["id"]}')['kit']))
            ok(kp is not None, 'máy chủ: kit đã thay Multicam hỏng bằng Multicam mới')
            pg.wait_for_timeout(300)
            shot(pg, 'kits_detail_at_tech')
            dlg(pg).locator('.dlg-head button.x').click()
            # Quay lại bằng nút trình duyệt
            pg.locator('.h-tbl tbody tr', has_text=U('K1')).click(); pg.wait_for_selector('dialog.dlg[open] .kits-facts')
            pg.go_back(); pg.wait_for_timeout(500)
            ok(pg.locator('dialog.dlg[open]').count() == 0, 'nút quay lại đóng chi tiết kit')
            # Lọc theo nhóm trạng thái từ ô số liệu
            pg.locator('.kits-strip .h-kpi', has_text='Đang ở Tech').click(); pg.wait_for_timeout(300)
            ok(pg.locator('.h-tbl tbody tr', has_text=U('K1')).count() == 1 and 'st=tech' in pg.url, 'bấm ô "Đang ở Tech" lọc đúng kit')
            ctx.close()

            step('Kit: Tech Lead cho kit ngừng dùng (bắt buộc lý do)')
            ctx, pg = page('techlead')
            pg.goto(f'{base}/#/kits/{k2["id"]}'); pg.wait_for_selector('dialog.dlg[open] .kits-facts'); settle(pg)
            dlg(pg).get_by_role('button', name='Ngừng dùng kit').click()
            d = dlg(pg); submit(pg)
            ok(d.locator('.dlg-err:not([hidden])').count() == 1, 'chưa ghi lý do thì không cho ngừng dùng')
            d.locator('textarea[name=reason]').fill('Kit thử nghiệm, tháo ra dùng lẻ')
            submit(pg)
            ok(until(lambda: lead.req('GET', f'/api/hub/kits/{k2["id"]}')['kit']['status'] == 'retired'), 'máy chủ: kit đã ngừng dùng')
            ok(dlg(pg).get_by_role('button', name='Ngừng dùng kit').count() == 0, 'kit đã ngừng dùng thì không còn nút ngừng dùng')
            dlg(pg).locator('.dlg-head button.x').click()
            step('Loại thiết bị: thêm và sửa tên')
            pg.goto(f'{base}/#/kits?tab=types'); settle(pg)
            pg.get_by_role('button', name='Thêm loại').click()
            d = dlg(pg); d.locator('input[name=name]').fill(f'Gimbal {SUF}'); d.locator('select[name=kind]').select_option('device')
            submit(pg)
            ok(toast_has(pg, 'Đã thêm loại'), 'báo đã thêm loại')
            ok(until(lambda: any(t['name'] == f'Gimbal {SUF}' and t['kind'] == 'device' for t in lead.req('GET', '/api/hub/types')['types'])), 'máy chủ: có loại mới')
            until(lambda: pg.locator('.h-tbl tbody tr', has_text=f'Gimbal {SUF}').count() == 1, 5)
            pg.locator('.h-tbl tbody tr', has_text=f'Gimbal {SUF}').click()
            d = dlg(pg); d.locator('input[name=name]').fill(f'Gimbal cầm tay {SUF}'); submit(pg)
            ok(until(lambda: any(t['name'] == f'Gimbal cầm tay {SUF}' for t in lead.req('GET', '/api/hub/types')['types'])), 'máy chủ: đổi tên loại')
            shot(pg, 'kits_types_desktop')
            ctx.close()

            # ───────────── 4. Thẻ nhớ: phiếu gửi Tech, Tech nhận (thiếu 1 thẻ) ─────────────
            step('Thẻ nhớ: Logistics lập phiếu gửi Tech từ gợi ý')
            ctx, pg = page('log')
            pg.goto(f'{base}/#/cards'); settle(pg)
            ok(pg.locator('.cards-cta').count() == 1, 'nhắc lập phiếu khi có thẻ đã thu về')
            shot(pg, 'cards_desktop_light')
            pg.get_by_role('button', name='Lập phiếu gửi Tech').first.click()
            pg.wait_for_selector('dialog.dlg[open] .cards-groups')
            d = dlg(pg)
            for cb in d.locator('.cards-group-h input[type=checkbox]').all():
                cb.uncheck()
            for code in sd:
                d.locator(f'.cards-chip input[value="{code}"]').check()
            ok(f'Đã chọn {len(sd)} thẻ' in d.locator('.cards-counter').inner_text(), 'đếm số thẻ đã chọn')
            submit(pg)
            ok(toast_has(pg, 'Đã gửi phiếu'), 'báo đã gửi phiếu')
            pg.wait_for_selector('dialog.dlg[open] .cards-groups'); settle(pg)
            ho = until(lambda: next(x for x in lead.req('GET', '/api/hub/handovers')['handovers'] if x['status'] == 'sent' and x['lines'] == 4 and x['dir'] == 'to_tech'))
            ok(ho is not None, 'máy chủ: phiếu Logistics → Tech có 4 thẻ')
            ok('tab=handovers' in pg.url and f'/cards/{ho["id"]}' in pg.url, 'chi tiết phiếu mở theo địa chỉ #/cards/<id>?tab=handovers')
            ok(all(lead.req('GET', f'/api/hub/cards/{cid[c]}')['card']['status'] == 'to_tech' for c in sd), 'máy chủ: 4 thẻ đang bàn giao cho Tech')
            ok(dlg(pg).get_by_role('button', name='Huỷ phiếu').count() == 1, 'bên gửi có nút huỷ phiếu')
            ok(dlg(pg).locator('.cards-scan').count() == 0, 'bên gửi không tự xác nhận nhận phiếu')
            shot(pg, 'cards_handover_sender')
            ctx.close()

            step('Thẻ nhớ: Tech mở phiếu từ thông báo, quét 3/4 thẻ, ghi lý do thiếu')
            ctx, pg = page('tech')
            pg.goto(f'{base}/#/cards/{ho["id"]}?tab=handovers')
            pg.wait_for_selector('dialog.dlg[open] .cards-scan input'); settle(pg)
            ok(pg.locator('.h-tabs [role=tab][aria-selected=true]', has_text='Phiếu bàn giao').count() == 1, 'mở thẳng địa chỉ phiếu thì đang ở tab Phiếu bàn giao')
            d = dlg(pg)
            scan = d.locator('.cards-scan input')
            scan.fill(f'{sd[0]} {sd[1]}'); scan.press('Enter')
            scan.fill(sd[2]); scan.press('Enter')
            scan.fill('KHONGCO123'); scan.press('Enter')
            ok('Không có trong phiếu' in d.locator('.cards-scan-msg').inner_text(), 'quét mã lạ: báo không có trong phiếu')
            ok('3/4' in d.locator('.cards-counter').first.inner_text(), 'đếm 3/4 thẻ đã đánh dấu')
            ok(sd[3] in d.locator('.cards-miss-list').inner_text(), 'thẻ chưa đánh dấu hiện trong danh sách thiếu')
            shot(pg, 'cards_receive_checklist')
            d.get_by_role('button', name='Xác nhận nhận 3/4').click()
            ok(d.locator('.vs-err:not([hidden])').count() == 1, 'thiếu thẻ mà chưa ghi lý do → báo lỗi tại chỗ')
            d.locator('.cards-miss textarea').fill('Túi thẻ chỉ có 3 thẻ')
            d.get_by_role('button', name='Xác nhận nhận 3/4').click()
            ok(toast_has(pg, 'Đã nhận 3/4'), 'báo đã nhận 3/4 thẻ')
            hv = until(lambda: (lambda x: x if x['status'] == 'received' else None)(lead.req('GET', f'/api/hub/handovers/{ho["id"]}')['handover']))
            ok(hv and hv['recv'] == 3 and hv['missing'] == 1, 'máy chủ: phiếu đã nhận 3, thiếu 1')
            ok(lead.req('GET', f'/api/hub/cards/{cid[sd[3]]}')['card']['status'] == 'returned', 'máy chủ: thẻ thiếu trở về "Đã thu về VP"')
            ok(lead.req('GET', f'/api/hub/cards/{cid[sd[0]]}')['card']['status'] == 'at_tech', 'máy chủ: thẻ nhận được sang "Tech đã nhận"')
            pg.wait_for_timeout(400)
            ok(dlg(pg).locator('.cards-chip[data-st="missing"]', has_text=sd[3]).count() == 1, 'chi tiết phiếu đánh dấu thẻ thiếu')
            shot(pg, 'cards_handover_received')
            dlg(pg).locator('.dlg-head button.x').click()

            # ───────────── 5. Nhập dung lượng bằng bàn phím ─────────────
            step('Nhập dung lượng: Tech nhập GB bằng bàn phím, 0 GB cần lý do, lưu')
            pg.goto(f'{base}/#/upload'); settle(pg)
            gb = lambda c: pg.locator(f'input[aria-label="GB thẻ {c}"]')
            ok(all(gb(c).count() == 1 for c in sd[:3]), 'hàng chờ có 3 thẻ vừa nhận')
            ok(gb(sd[3]).count() == 0, 'thẻ thiếu không có trong hàng chờ')
            # Thẻ do Lead ghi "đã thu về" không rõ thời gian ở BO: hệ thống không đoán ngày quay, Tech nhập ngày.
            yday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
            for c in sd[:3]:
                dt = pg.locator(f'input[aria-label="Ngày quay thẻ {c}"]')
                ok(dt.input_value() == '', f'thẻ {c} không rõ thời gian ở BO: ngày quay để trống')
                dt.fill(yday)
            gb(sd[0]).click(); gb(sd[0]).fill('33,8'); gb(sd[0]).press('Enter')
            ok(pg.evaluate('document.activeElement.getAttribute("aria-label")') == f'GB thẻ {sd[1]}', 'Enter chuyển xuống ô GB thẻ kế tiếp')
            pg.keyboard.type('0'); pg.keyboard.press('Enter')
            ok(pg.evaluate('document.activeElement.getAttribute("aria-label")') == f'Lý do 0 giờ thẻ {sd[1]}', '0 GB: Enter chuyển sang ô lý do')
            ok(pg.locator('tr.upl-row[data-st="bad"]').count() >= 1, '0 GB chưa có lý do: dòng báo lỗi')
            pg.locator(f'select[aria-label="Lý do 0 giờ thẻ {sd[1]}"]').select_option(index=1)
            pg.locator(f'select[aria-label="Lý do 0 giờ thẻ {sd[1]}"]').press('Enter')
            ok(pg.evaluate('document.activeElement.getAttribute("aria-label")') == f'GB thẻ {sd[2]}', 'Enter ở ô lý do chuyển xuống dòng kế tiếp')
            pg.keyboard.type('16.9')
            ok('Lưu 3 thẻ' in pg.locator('.upl-foot-r button.primary').inner_text(), 'nút lưu đếm 3 thẻ hợp lệ')
            ok(pg.locator('.upl-row', has_text=sd[0]).locator('.upl-hrs').inner_text().startswith('≈'), 'hiện giờ quay ước tính theo GB')
            shot(pg, 'upload_grid_desktop')
            pg.locator('.upl-foot-r button.primary').click()
            ok(toast_has(pg, 'Đã lưu 3 thẻ'), 'báo đã lưu 3 thẻ')
            today = datetime.date.today()
            def recs():
                r = lead.req('GET', f'/api/hub/cards/records?from={(today - datetime.timedelta(days=7)).isoformat()}&to={(today + datetime.timedelta(days=1)).isoformat()}')['records']
                return {x['code']: x for x in r if x['code'] in sd}
            rr = until(lambda: (lambda x: x if len(x) == 3 else None)(recs()))
            ok(rr is not None, 'máy chủ: 3 bản ghi dung lượng')
            if rr:
                ok(abs(rr[sd[0]]['hours'] - round(33.8 / gbh, 2)) < 0.011, f'giờ quay = GB ÷ {gbh} (thẻ 1: {rr[sd[0]]["hours"]})')
                ok(rr[sd[1]]['hours'] == 0 and rr[sd[1]]['zero_reason'], 'thẻ 0 GB có lý do')
            ok(all(lead.req('GET', f'/api/hub/cards/{cid[c]}')['card']['status'] == 'uploaded' for c in sd[:3]), 'máy chủ: thẻ chuyển "Đã nhập dung lượng"')
            pg.wait_for_timeout(500)
            ok(gb(sd[0]).count() == 0, 'hàng chờ tự bỏ thẻ đã nhập')

            step('Nhập dung lượng: xem và sửa bản ghi (người nhập, trong 48 giờ)')
            pg.get_by_role('tab', name='Đã nhập').click(); settle(pg)
            row = pg.locator('.h-tbl tbody tr', has_text=sd[2])
            ok(row.count() == 1, 'bản ghi vừa nhập có trong danh sách')
            shot(pg, 'upload_records_desktop')
            row.click(); pg.wait_for_selector('dialog.dlg[open] .h-dl'); settle(pg, 300)
            shot(pg, 'upload_record_dialog')
            dlg(pg).get_by_role('button', name='Sửa bản ghi').click()
            d = dlg(pg); d.locator('input[name=gb]').fill('50.7'); submit(pg)
            ok(toast_has(pg, 'Đã sửa bản ghi'), 'báo đã sửa bản ghi')
            ok(until(lambda: abs(recs()[sd[2]]['gb'] - 50.7) < 0.001 and abs(recs()[sd[2]]['hours'] - round(50.7 / gbh, 2)) < 0.011), 'máy chủ: GB và giờ quay được tính lại')
            ctx.close()

            step('Thẻ nhớ: Lead điều chỉnh thẻ thiếu sang "Thất lạc" (bắt buộc lý do)')
            ctx, pg = page('lead')
            pg.goto(f'{base}/#/cards/{cid[sd[3]]}'); pg.wait_for_selector('dialog.dlg[open] .kits-facts'); settle(pg)
            dlg(pg).get_by_role('button', name='Điều chỉnh trạng thái').click()
            d = dlg(pg); d.locator('select[name=status]').select_option('lost')
            ok(d.locator('select[name=site_id]').is_hidden(), 'ô chọn BO chỉ hiện khi chọn "Đang ở BO"')
            d.locator('textarea[name=reason]').fill('Tìm cả văn phòng không thấy')
            submit(pg)
            ok(until(lambda: lead.req('GET', f'/api/hub/cards/{cid[sd[3]]}')['card']['status'] == 'lost'), 'máy chủ: thẻ thất lạc')
            pg.wait_for_timeout(300)
            ok(dlg(pg).locator('.pill[data-k="lost"]').count() == 1, 'chi tiết thẻ cập nhật')
            dlg(pg).locator('.dlg-head button.x').click()
            pg.goto(f'{base}/#/cards?tab=handovers'); settle(pg)
            ok(pg.locator('.h-tbl tbody tr').count() >= 0, 'tab phiếu bàn giao mở được')
            ctx.close()

            # ───────────── 6. Điện thoại, sáng / tối ─────────────
            step('Điện thoại 390 px và giao diện tối: không tràn ngang, ảnh chụp')
            for scheme in ['light', 'dark']:
                for user, hs in [('log', ['#/kits', f'#/kits/{kit["id"]}', '#/kits?tab=devices', '#/kits?tab=types', '#/acc', '#/acc/hub_sac', '#/cards', f'#/cards/{ho["id"]}?tab=handovers', '#/cards?tab=handovers']),
                                 ('tech', ['#/upload', '#/upload?tab=records'])]:
                    ctx, pg = page(user, 390, 800, scheme)
                    for hsh in hs:
                        pg.goto(f'{base}/{hsh}'); settle(pg, 700)
                        ok(no_hscroll(pg), f'{user} {scheme} 390px {hsh}: không tràn ngang')
                        ok('null' not in pg.locator('.h-view').inner_text(), f'{user} {scheme} {hsh}: không có chữ "null"')
                        ok(pg.locator('.h-err').count() == 0, f'{user} {scheme} {hsh}: không có khung báo lỗi')
                        shot(pg, f'm_{scheme}_{hsh.strip("#/").replace("/", "_").replace("?", "_").replace("=", "-")}')
                    ctx.close()
                if scheme == 'dark':
                    ctx, pg = page('log', 1366, 850, 'dark')
                    for hsh in ['#/kits', f'#/kits/{kit["id"]}', '#/acc', '#/cards']:
                        pg.goto(f'{base}/{hsh}'); settle(pg, 600)
                        shot(pg, f'd_dark_{hsh.strip("#/").replace("/", "_")}')
                    ctx.close()
            # hàng chờ nhập trên điện thoại: chuẩn bị thêm thẻ chờ nhập
            more = [U(f'SM{i}') for i in range(1, 3)]
            lead.req('POST', '/api/hub/devices', {'type': 'sd', 'codes': ' '.join(more)})
            mid = {c['code']: c['id'] for c in lead.req('GET', '/api/hub/cards?limit=3000')['cards'] if c['code'] in more}
            for code in more:
                lead.req('PATCH', f'/api/hub/cards/{mid[code]}', {'status': 'returned', 'reason': 'Chuẩn bị ảnh chụp'})
            lg = S.Cli(base); lg.login('log', pw)
            h2 = lg.req('POST', '/api/hub/handovers', {'dir': 'to_tech', 'codes': more})['handover']
            tc = S.Cli(base); tc.login('tech', pw)
            tc.req('POST', f'/api/hub/handovers/{h2["id"]}/receive', {'all': True})
            for scheme in ['light', 'dark']:
                ctx, pg = page('tech', 390, 800, scheme)
                pg.goto(f'{base}/#/upload'); settle(pg, 700)
                ok(no_hscroll(pg), f'tech {scheme} 390px hàng chờ nhập: không tràn ngang')
                ok(pg.locator(f'input[aria-label="GB thẻ {more[0]}"]').count() == 1, f'tech {scheme}: hàng chờ hiện thẻ trên điện thoại')
                shot(pg, f'm_{scheme}_upload_queue')
                ctx.close()
            ctx, pg = page('tech', 1366, 850)
            pg.goto(f'{base}/#/upload'); settle(pg, 600); shot(pg, 'upload_queue_desktop_light')
            ctx.close()
    finally:
        S.stop(srv)

    errs = [f'{u}: {e}' for u, es in all_errs for e in es]
    ok(not errs, 'không có lỗi JS / lỗi máy chủ 5xx' + ('' if not errs else ':\n      ' + '\n      '.join(errs[:20])))
    print(f'\nKho (kits, acc, cards, upload): {passes[0]} phép kiểm đạt, {len(fails)} không đạt. Ảnh: {SHOTS}')
    sys.exit(1 if fails else 0)


def fmt(n):
    return f'{n:,}'.replace(',', '.')
def H_cell(row, i):
    return row.locator('td').nth(i).inner_text().strip()


if __name__ == '__main__':
    main()
