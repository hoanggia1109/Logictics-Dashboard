#!/usr/bin/env python3
"""Kiểm thử giao diện nhóm D: BO (#/outlets) và Yêu cầu của Sale (#/requests) trên Chromium thật.

Luồng chính: Sale gửi yêu cầu mở BO → Logistics gán kit, gửi Tech kiểm → (Tech kiểm, giao xong: chạy qua API vì thuộc màn hình khác)
→ Sale thấy trạng thái đổi ngay trên trang đang mở; Sale sửa đúng các trường được phép, gửi hỗ trợ (gộp phụ kiện, chặn đổi máy trùng),
báo sự cố, kết thúc ghi hình; Logistics thêm BO, gửi yêu cầu rồi huỷ. Sale không mở được Điều phối / Rider Live và API của Sale
không chứa vị trí, chuyến hay tên FO. Chụp ảnh máy tính + điện thoại, sáng + tối.

Chạy: python3 test/ui/views_bo.py        (SHOTS=/thư/mục để giữ ảnh; mặc định thư mục tạm)
"""
import datetime, json, os, re, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hubsrv as S
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('BO_PORT', '8172'))
SHOTS = os.environ.get('SHOTS') or tempfile.mkdtemp(prefix='bo-shots-')
os.makedirs(SHOTS, exist_ok=True)
passes, fails = [0], []
ROLES = ['admin', 'techlead', 'tech', 'lead', 'log', 'salehead', 'sale']
OPS_EDIT = {'admin', 'lead', 'log'}            # POST /api/hub/outlets
REQ_CREATE = {'admin', 'lead', 'log', 'salehead', 'sale'}  # POST /api/hub/requests
# Rider Live / điều phối: Sale không được gọi tới.
FO_PATHS = re.compile(r'/api/(live|history|tasks|my/|stops|stats|alerts|sites|loc|shift|templates|plan|suggest|hub/dispatch|hub/jobs)(\b|/|\?)')
FO_KEYS = {'fo', 'fo_id', 'fo_name', 'task', 'task_id', 'tasks', 'trip', 'trips', 'track', 'tracks', 'pos', 'positions', 'speed', 'heading', 'stops', 'live'}


def ok(cond, msg):
    if cond:
        passes[0] += 1
    else:
        fails.append(msg)
        print('    ✗ ' + msg)
    return cond


def step(t):
    print('  • ' + t)


def local_today():
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=420)).date()


def shot(pg, name, full=True):
    pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)


def dlg(pg):
    return pg.locator('dialog.dlg[open]').last


def dlg_submit(pg):
    dlg(pg).locator('.dlg-foot button.primary').click()


def no_dlg(pg, timeout=10000):
    pg.wait_for_selector('dialog.dlg[open]', state='detached', timeout=timeout)


def has_toast(pg, want, timeout=6000):
    """Chờ thông báo có chữ `want` (thông báo trước có thể còn hiện)."""
    return wait_text(pg.locator('#toast'), want, timeout)


def wait_text(loc, text, timeout=10000):
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        try:
            if text in loc.inner_text(timeout=1000):
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def no_overflow(pg, what):
    r = pg.evaluate('''() => { const m = document.getElementById('h-main');
        return { doc: document.documentElement.scrollWidth - window.innerWidth, main: m ? m.scrollWidth - m.clientWidth : 0 }; }''')
    ok(r['doc'] <= 1 and r['main'] <= 1, f'{what}: không tràn ngang ({r})')


def walk(o, path='$', parent=None):
    """Duyệt JSON: trả về các khoá vi phạm (khoá dính FO, lat/lon ngoài đối tượng BO)."""
    bad = []
    if isinstance(o, dict):
        is_outlet = 'ops_status' in o or 'has_coord' in o
        for k, v in o.items():
            if k in FO_KEYS:
                bad.append(f'{path}.{k}')
            if k in ('lat', 'lon', 'lng', 'latitude', 'longitude') and not is_outlet:
                bad.append(f'{path}.{k}')
            bad += walk(v, f'{path}.{k}', o)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            bad += walk(v, f'{path}[{i}]', parent)
    return bad


def setup(base, pw):
    """Dữ liệu cho kịch bản (qua API): 3 kit Multicam, UITK01 và UITK03 đã kiểm (sẵn sàng), UITK02 đang chuẩn bị; một tài khoản FO."""
    lead = S.Cli(base); lead.login('lead', pw)
    tl = S.Cli(base); tl.login('techlead', pw)
    lead.req('POST', '/api/hub/devices', {'type': 'multicam', 'codes': ['UITMC01', 'UITMC02', 'UITMC03']})
    lead.req('POST', '/api/hub/devices', {'type': 'cm5', 'codes': ['UITCM01', 'UITCM02', 'UITCM03']})
    kits = {}
    for i in (1, 2, 3):
        kits[i] = lead.req('POST', '/api/hub/kits', {'code': f'UITK0{i}', 'kind': 'multicam', 'devices': [f'UITMC0{i}', f'UITCM0{i}']})['kit']
    for i in (1, 3):
        lead.req('POST', f'/api/hub/kits/{kits[i]["id"]}/submit')
    check_jobs(tl, ['UITK01', 'UITK03'])
    admin = S.Cli(base); admin.login('admin', pw)
    fos = [u for u in admin.req('GET', '/api/users')['users'] if u['role'] == 'fo']
    if not fos:
        admin.req('POST', '/api/users', {'username': 'fo', 'name': 'Tài Xế Thử Nghiệm', 'role': 'fo'})
        fos = [u for u in admin.req('GET', '/api/users')['users'] if u['role'] == 'fo']
    return {k: v['id'] for k, v in kits.items()}, [u['name'] for u in fos], fos[0]['id']


def check_jobs(tl, codes):
    jobs = tl.req('GET', '/api/hub/jobs?type=check_kit&view=team')['jobs']
    done = 0
    for j in jobs:
        if j.get('kit') and j['kit']['code'] in codes and j['status'] in ('open', 'doing'):
            tl.req('POST', f'/api/hub/jobs/{j["id"]}/done', {'result': {'pass': True}})
            done += 1
    return done


def login_page(b, base, user, pw, hash_='', mobile=False, dark=False):
    ctx = b.new_context(viewport={'width': 390, 'height': 800} if mobile else {'width': 1366, 'height': 850}, is_mobile=mobile, has_touch=mobile,
                        color_scheme='dark' if dark else 'light', locale='vi-VN')
    pg = ctx.new_page()
    errs = S.watch(pg)
    S.login(pg, base, user, pw, hash_)
    return ctx, pg, errs


def main():
    srv, base, pw = S.start(PORT)
    print(f'Máy chủ {base} · ảnh: {SHOTS}')
    all_errs = []
    try:
        kit_ids, fo_names, fo_id = setup(base, pw)
        sale_api = S.Cli(base); sale_api.login('sale', pw)
        sale_me = sale_api.req('GET', '/api/me')['user']
        admin_api = S.Cli(base); admin_api.login('admin', pw)
        lead_api = S.Cli(base); lead_api.login('lead', pw)
        tl_api = S.Cli(base); tl_api.login('techlead', pw)
        with sync_playwright() as p:
            b = S.browser(p)

            # ═══ 1. Ai thấy gì ═══
            print('1. Vai trò: menu, nút thao tác')
            for u in ROLES:
                ctx, pg, errs = login_page(b, base, u, pw, '#/outlets')
                pg.wait_for_selector('.outlets-list .h-head h1', timeout=15000)
                pg.wait_for_selector('.outlets-list .h-tbl, .outlets-list .h-empty', timeout=15000)
                navs = pg.eval_on_selector_all('.h-nav a[data-view]', 'as => as.map(a => a.dataset.view)')
                ok('outlets' in navs and 'requests' in navs, f'{u}: menu có BO và Yêu cầu')
                head = pg.inner_text('.outlets-list .h-head')
                ok(('Thêm BO' in head) == (u in OPS_EDIT), f'{u}: nút "Thêm BO" chỉ cho Logistics/Quản trị')
                ok(('mở BO' in head) == (u in REQ_CREATE), f'{u}: nút gửi yêu cầu mở BO đúng vai')
                if u in ('sale', 'salehead'):
                    ok('dispatch' not in navs, f'{u}: không có Điều phối trong menu')
                    ok(pg.locator('.h-svc').count() == 0, f'{u}: không có nút chuyển sang Rider Live')
                pg.goto(base + '/#/requests')
                pg.wait_for_selector('.requests-list .h-head h1', timeout=15000)
                pg.wait_for_selector('.requests-list .h-tbl, .requests-list .h-empty', timeout=15000)
                head = pg.inner_text('.requests-list .h-head')
                ok(('Gửi yêu cầu mở BO' in head) == (u in REQ_CREATE), f'{u}: Yêu cầu — nút gửi đúng vai')
                ok(not errs, f'{u}: không lỗi JS ({errs[:2]})')
                all_errs += errs
                ctx.close()

            # ═══ 2. Sale gửi yêu cầu mở BO qua giao diện ═══
            print('2. Sale gửi yêu cầu mở BO')
            sctx, SP, serrs = login_page(b, base, 'sale', pw, '#/requests')
            sale_reqs, sale_ws = [], []
            SP.on('request', lambda r: sale_reqs.append(r.url))
            SP.on('websocket', lambda ws: ws.on('framereceived', lambda f: sale_ws.append(f if isinstance(f, str) else '')))
            SP.reload()
            SP.wait_for_selector('.requests-list .h-head h1')
            SP.click('.requests-list .h-head >> text=Gửi yêu cầu mở BO')
            d = dlg(SP)
            d.wait_for()
            launch = (local_today() + datetime.timedelta(days=6)).isoformat()
            d.locator('[name=name]').fill('UI BO Hoa Mai')
            d.locator('[name=address]').fill('12 Lê Lợi, Quận 1')
            d.locator('[name=contact]').fill('Anh Minh')
            d.locator('[name=coord]').fill('https://www.google.com/maps/@10.7769,106.7009,17z')
            d.locator('[name=multicam]').fill('2')
            d.locator('[name=launch_date]').fill(launch)
            for t in ('T2', 'T4', 'T6'):
                d.locator('.outlets-days button', has_text=t).click()
            d.locator('[name=swap_from]').fill('09:00')
            d.locator('[name=swap_to]').fill('11:00')
            shot(SP, 'd_sale_request_form', full=False)
            dlg_submit(SP)
            no_dlg(SP)
            ok(has_toast(SP, 'Đã gửi yêu cầu'), 'Sale: báo đã gửi yêu cầu')
            SP.wait_for_selector('.requests-detail .h-head h1', timeout=10000)
            m = re.search(r'#/requests/(\d+)', SP.url)
            ok(bool(m), f'Sale: mở trang chi tiết yêu cầu ({SP.url})')
            rid = int(m.group(1))
            req = sale_api.req('GET', f'/api/hub/requests/{rid}')['request']
            site_id = req['site']['id']
            ok(req['need']['multicam'] == 2 and req['launch_date'] == launch and req['status'] == 'submitted', 'máy chủ: yêu cầu đúng số kit, ngày launch, trạng thái')
            o = sale_api.req('GET', f'/api/hub/outlets/{site_id}')['outlet']
            ok(o['swap_days'] == '1,3,5' and o['swap_from'] == '09:00' and o['has_coord'] and abs(o['lat'] - 10.7769) < 1e-6, 'máy chủ: BO mới có lịch đổi thẻ T2-T4-T6 và vị trí từ link Google Maps')
            ok(o['sale'] and o['sale']['id'] == sale_me['id'], 'máy chủ: BO giao cho chính Sale gửi')
            wait_box = SP.locator('.requests-detail .requests-wait')
            ok(wait_text(wait_box, 'Đang chờ: Logistics'), 'Sale thấy "Đang chờ: Logistics"')
            ok(SP.locator('.requests-tl li[data-state=now]').count() == 1, 'Sale thấy bước hiện tại trên dòng tiến trình')
            shot(SP, 'd_sale_request_submitted')

            step('Sale sửa yêu cầu (ngày launch, ghi chú)')
            launch2 = (local_today() + datetime.timedelta(days=7)).isoformat()
            SP.click('.requests-detail .h-head >> text=Sửa yêu cầu')
            d = dlg(SP); d.wait_for()
            d.locator('[name=launch_date]').fill(launch2)
            d.locator('[name=note]').fill('Cửa hàng mở cửa từ 8 giờ')
            dlg_submit(SP); no_dlg(SP)
            req = sale_api.req('GET', f'/api/hub/requests/{rid}')['request']
            ok(req['launch_date'] == launch2 and req['note'] == 'Cửa hàng mở cửa từ 8 giờ' and req['need']['multicam'] == 2, 'máy chủ: Sale đổi được ngày launch và ghi chú, số kit giữ nguyên')

            # ═══ 3. Logistics gán kit, gửi Tech kiểm ═══
            print('3. Logistics gán kit')
            lctx, LP, lerrs = login_page(b, base, 'log', pw, '#/requests')
            LP.wait_for_selector('.requests-list .h-tbl')
            row = LP.locator('.requests-list tbody tr', has_text=req['code'])
            ok(row.count() == 1, 'Logistics thấy yêu cầu trong danh sách')
            row.click()
            LP.wait_for_selector('.requests-detail .h-head h1')
            LP.click('.requests-detail .h-actions >> text=Gán kit')
            d = dlg(LP); d.wait_for()
            labels = d.locator('.requests-pick label')
            codes = labels.all_inner_texts()
            ok(any('UITK01' in c for c in codes) and any('UITK02' in c for c in codes) and any('UITK03' in c for c in codes), 'hộp gán kit liệt kê kit rảnh đúng loại')
            d.locator('.requests-pick label', has_text='UITK01').locator('input').check()
            d.locator('.requests-pick label', has_text='UITK02').locator('input').check()
            ok(d.locator('.requests-pick label', has_text='UITK03').locator('input').is_disabled(), 'đủ số kit cần thì không chọn thêm được')
            shot(LP, 'd_log_assign', full=False)
            dlg_submit(LP); no_dlg(LP)
            ok(has_toast(LP, 'Đã gán 2 kit'), 'Logistics: báo đã gán kit')
            pill = LP.locator('.requests-detail .h-head .pill')
            ok(wait_text(pill, 'Đang chuẩn bị'), 'yêu cầu chuyển "Đang chuẩn bị"')
            ok(wait_text(SP.locator('.requests-detail .h-head .pill'), 'Đang chuẩn bị'), 'trang của Sale tự cập nhật trạng thái (không tải lại)')
            ok(wait_text(SP.locator('.requests-detail .requests-wait'), 'UITK02'), 'Sale thấy kit nào Logistics đang chuẩn bị')

            step('Gửi Tech kiểm kit đang chuẩn bị')
            LP.locator('.requests-detail .h-item', has_text='UITK02').locator('button', has_text='Gửi Tech kiểm').click()
            ok(has_toast(LP, 'Đã gửi kit UITK02'), 'Logistics: báo đã gửi Tech kiểm')
            ok(wait_text(SP.locator('.requests-detail .requests-wait'), 'Tech'), 'Sale thấy yêu cầu đang chờ Tech kiểm')
            shot(SP, 'd_sale_waiting_tech')

            step('Tech kiểm đạt (API) → kit sẵn sàng')
            ok(check_jobs(tl_api, ['UITK02']) == 1, 'Tech hoàn thành việc kiểm kit qua API')
            ok(wait_text(SP.locator('.requests-detail .h-head .pill'), 'Kit sẵn sàng'), 'Sale thấy "Kit sẵn sàng, chờ giao"')
            ok(wait_text(LP.locator('.requests-detail .h-head .pill'), 'Kit sẵn sàng'), 'Logistics thấy "Kit sẵn sàng, chờ giao"')
            ok(wait_text(LP.locator('.requests-detail'), 'Giao và setup'), 'Logistics thấy việc giao đi kèm trong "Việc liên quan"')
            ok(SP.locator('.requests-detail >> text=Việc liên quan').count() == 0, 'Sale không thấy danh sách việc nội bộ')

            step('Giao xong (API) → BO đang ghi hình')
            jobs = lead_api.req('GET', '/api/hub/jobs?type=deliver&view=team&upcoming=1')['jobs']
            dj = [j for j in jobs if j['request_id'] == rid]
            ok(len(dj) == 1, 'có đúng 1 việc giao cho yêu cầu')
            lead_api.req('POST', f'/api/hub/jobs/{dj[0]["id"]}/done', {'result': {'doc_code': 'BB-UI-01'}})
            ok(wait_text(SP.locator('.requests-detail .h-head .pill'), 'Đang ghi hình'), 'Sale thấy yêu cầu "Đang ghi hình"')
            ok(SP.locator('.requests-tl li[data-state=done]').count() == 5, 'dòng tiến trình đủ 5 bước đã qua')
            ok(SP.locator('.requests-detail .h-actions >> text=Sửa yêu cầu').count() == 0, 'đã giao thì Sale không còn nút sửa yêu cầu')
            shot(SP, 'd_sale_request_live')
            shot(LP, 'd_log_request_live')
            all_errs += lerrs
            lctx.close()

            # ═══ 4. Sale trên trang BO ═══
            print('4. Sale trên trang BO')
            SP.click('.requests-detail .h-head .sub a')
            SP.wait_for_selector('.outlets-detail .h-head h1', timeout=10000)
            ok('UI BO Hoa Mai' in SP.inner_text('.outlets-detail .h-head h1') and 'Đang ghi hình' in SP.inner_text('.outlets-detail .h-head h1'), 'trang BO: tên và trạng thái "Đang ghi hình"')
            ok(SP.locator('.outlets-detail .h-tabs button').count() == 5, 'trang BO có 5 tab')
            shot(SP, 'd_sale_outlet_overview')

            step('Sale sửa thông tin BO: chỉ trường được phép')
            SP.click('.outlets-detail .h-actions >> text=Sửa thông tin')
            d = dlg(SP); d.wait_for()
            for n in ('name', 'coord', 'sale_id', 'area'):
                ok(d.locator(f'[name={n}]').count() == 0, f'Sale không thấy trường "{n}"')
            ok(d.locator('[name=code]').count() == 1, 'Sale thấy trường mã BO (mã BO do Sale và Quản trị sửa)')
            d.locator('[name=contact]').fill('Chị Lan')
            d.locator('[name=phone]').fill('0901 234 567')
            d.locator('[name=quota_hours]').fill('300')
            dlg_submit(SP); no_dlg(SP)
            o = sale_api.req('GET', f'/api/hub/outlets/{site_id}')['outlet']
            ok(o['contact'] == 'Chị Lan' and o['phone'] == '0901 234 567' and o['quota_hours'] == 300 and o['name'] == 'UI BO Hoa Mai', f'máy chủ: Sale đổi được liên hệ, SĐT, quota; tên giữ nguyên ({o["contact"]!r}, {o["phone"]!r}, {o["quota_hours"]!r}, {o["name"]!r})')
            ok(o['swap_days'] == '1,3,5', 'máy chủ: lịch đổi thẻ không bị xoá khi sửa')
            try:
                sale_api.req('PATCH', f'/api/hub/outlets/{site_id}', {'name': 'Đổi tên lén'})
            except RuntimeError:
                pass
            ok(sale_api.req('GET', f'/api/hub/outlets/{site_id}')['outlet']['name'] == 'UI BO Hoa Mai', 'máy chủ bỏ qua trường Sale không được sửa (tên BO)')

            step('Sale gửi hỗ trợ: bổ sung phụ kiện, lần hai gộp vào yêu cầu cũ')
            SP.click('.outlets-detail .h-actions >> text=Yêu cầu hỗ trợ')
            d = dlg(SP); d.wait_for()
            d.locator('[name=kind]').select_option('extra_acc')
            d.locator('[name=kit_id]').select_option(str(kit_ids[1]))
            d.locator('[name="acc:headstrap"]').fill('2')
            d.locator('[name=note]').fill('Headstrap bị đứt')
            dlg_submit(SP); no_dlg(SP)
            ok(has_toast(SP, 'Đã gửi yêu cầu hỗ trợ'), 'Sale: báo đã gửi yêu cầu hỗ trợ')
            SP.wait_for_timeout(400)
            SP.click('.outlets-detail .h-actions >> text=Yêu cầu hỗ trợ')
            d = dlg(SP); d.wait_for()
            d.locator('[name=kind]').select_option('extra_acc')
            d.locator('[name=kit_id]').select_option(str(kit_ids[1]))
            d.locator('[name="acc:headstrap"]').fill('1')
            d.locator('[name=note]').fill('Thêm một cái dự phòng')
            dlg_submit(SP); no_dlg(SP)
            ok(has_toast(SP, 'Đã gộp'), 'lần hai cùng kit: gộp vào yêu cầu đang chờ giao')
            sup = [r for r in sale_api.req('GET', f'/api/hub/requests?site={site_id}')['requests'] if r['kind'] == 'support' and r['need'].get('kind') == 'extra_acc']
            ok(len(sup) == 1 and sup[0]['need']['acc'].get('headstrap') == 3, f'máy chủ: một yêu cầu phụ kiện, cộng dồn 3 headstrap ({[s["need"] for s in sup]})')

            step('Sale gửi đổi máy hư; gửi lại cùng kit bị chặn')
            SP.click('.outlets-detail .h-tabs >> text=Kit & thẻ')
            SP.wait_for_selector('.outlets-tab .h-tbl')
            shot(SP, 'd_sale_outlet_kits')
            SP.locator('.outlets-tab tbody tr', has_text='UITK02').locator('button', has_text='Đổi máy hư').click()
            d = dlg(SP); d.wait_for()
            ok(d.locator('[name=kind]').input_value() == 'swap_device' and d.locator('[name=kit_id]').input_value() == str(kit_ids[2]), 'hộp hỗ trợ chọn sẵn "Đổi máy hư" và đúng kit')
            d.locator('[name=note]').fill('Máy không lên nguồn từ sáng')
            dlg_submit(SP); no_dlg(SP)
            ok(has_toast(SP, 'Đã gửi yêu cầu hỗ trợ'), 'Sale: đã gửi đổi máy hư')
            SP.wait_for_timeout(600)
            SP.locator('.outlets-tab tbody tr', has_text='UITK02').locator('button', has_text='Đổi máy hư').click()
            d = dlg(SP); d.wait_for()
            ok(wait_text(d, 'đang được ghi lỗi', 3000), 'hộp hỗ trợ cảnh báo kit đang ghi lỗi')
            d.locator('[name=note]').fill('Vẫn chưa lên nguồn')
            dlg_submit(SP)
            ok(wait_text(d.locator('.dlg-err'), 'đã có việc đổi kit', 6000), 'máy chủ chặn đổi máy trùng, lời báo hiện trong hộp thoại')
            d.locator('.dlg-foot button', has_text='Thôi').click(); no_dlg(SP)

            step('Sale báo sự cố')
            SP.locator('.outlets-detail .h-actions button[aria-label="Thao tác khác"]').click()
            SP.click('.h-pop >> text=Báo sự cố')
            d = dlg(SP); d.wait_for()
            d.locator('[name=kit_id]').select_option(str(kit_ids[1]))
            opts = d.locator('[name=label] option').all_inner_texts()
            d.locator('[name=label]').select_option(label=[x for x in opts if x and x != 'Chọn lỗi'][0])
            d.locator('[name=text]').fill('Màn hình CM5 báo lỗi đỏ')
            dlg_submit(SP); no_dlg(SP)
            ok(has_toast(SP, 'Đã báo sự cố'), 'Sale: báo sự cố thành công')
            incs = sale_api.req('GET', f'/api/hub/incidents?site={site_id}')['incidents']
            ok(any(i['text'] == 'Màn hình CM5 báo lỗi đỏ' for i in incs), 'máy chủ: có sự cố mới tại BO')
            SP.click('.outlets-detail .h-tabs >> text=Sự cố')
            ok(wait_text(SP.locator('.outlets-tab'), 'Màn hình CM5') or SP.locator('.outlets-tab .h-item').count() >= 1, 'tab Sự cố liệt kê sự cố của BO')
            shot(SP, 'd_sale_outlet_incidents')
            SP.click('.outlets-detail .h-tabs >> text=Thông tin')
            ok(wait_text(SP.locator('.outlets-tab'), 'Chị Lan'), 'tab Thông tin hiện liên hệ mới')
            SP.click('.outlets-detail .h-tabs >> text=Yêu cầu')
            ok(SP.locator('.outlets-tab .h-item').count() >= 3, 'tab Yêu cầu liệt kê yêu cầu của BO')

            # ═══ 5. Sale không chạm được dữ liệu FO ═══
            print('5. Sale và dữ liệu FO')
            SP.goto(base + '/#/dispatch')
            SP.wait_for_timeout(800)
            ok('#/dispatch' not in SP.url, f'Sale mở #/dispatch bị đưa về trang chính ({SP.url})')
            SP.goto(base + '/#/live')
            SP.wait_for_timeout(800)
            ok(SP.locator('.h-live-layer:not([hidden])').count() == 0 and '#/live' not in SP.url, 'Sale mở #/live: không có Rider Live')
            bad_urls = [u for u in sale_reqs if FO_PATHS.search(u)]
            ok(not bad_urls, f'trình duyệt của Sale không gọi API Rider Live / điều phối ({bad_urls[:3]})')
            kinds = set()
            for f in sale_ws:
                try:
                    kinds.add(json.loads(f).get('t'))
                except Exception:
                    pass
            ok(kinds <= {'hello', 'hub', 'inbox', 'pong', 'kick', None}, f'kênh trực tiếp của Sale chỉ có thông báo hub ({kinds})')
            # Có dữ liệu FO thật: Logistics đưa việc đổi kit hỏng của BO vào chuyến của một FO (thay bằng UITK03).
            sw = [j for j in lead_api.req('GET', f'/api/hub/jobs?type=swap_faulty&view=team&site={site_id}')['jobs'] if j['status'] in ('open', 'doing') and not j.get('task_id')]
            ok(len(sw) == 1, 'máy chủ: có một việc đổi kit hỏng chờ lên chuyến')
            if sw:
                t = lead_api.req('POST', '/api/hub/dispatch', {'job_ids': [sw[0]['id']], 'fo_id': fo_id, 'swap_kits': {str(sw[0]['id']): kit_ids[3]}})['task']
                ok(t.get('fo') and t['fo']['name'] in fo_names, 'máy chủ: chuyến đã giao cho FO')
            SP.goto(base + f'/#/outlets/{site_id}?tab=requests')
            SP.wait_for_selector('.outlets-detail .outlets-tab .h-item', timeout=10000)
            SP.wait_for_timeout(400)
            page_txt = SP.inner_text('#h-main')
            ok(not any(fn and fn in page_txt for fn in fo_names), 'trang BO của Sale không hiện tên FO khi việc đã lên chuyến')
            payloads = {
                'outlets': sale_api.req('GET', '/api/hub/outlets?metrics=1'),
                'outlet': sale_api.req('GET', f'/api/hub/outlets/{site_id}?metrics=1&days=28'),
                'requests': sale_api.req('GET', '/api/hub/requests'),
            }
            for r in sale_api.req('GET', f'/api/hub/requests?site={site_id}')['requests']:
                payloads[f'request {r["code"]}'] = sale_api.req('GET', f'/api/hub/requests/{r["id"]}')
            for o2 in payloads['outlets']['outlets'][:15]:
                payloads[f'outlet {o2["id"]}'] = sale_api.req('GET', f'/api/hub/outlets/{o2["id"]}?metrics=1')
            leaks = []
            for name, j in payloads.items():
                for k in walk(j):
                    leaks.append(f'{name}: {k}')
                txt = json.dumps(j, ensure_ascii=False)
                for fn in fo_names:
                    if fn and fn in txt:
                        leaks.append(f'{name}: có tên FO "{fn}"')
            ok(not leaks, f'API của Sale (BO, yêu cầu) không có vị trí / chuyến / tên FO ({leaks[:5]})')
            ok(all(not j.get('jobs') and not j.get('candidates') for n, j in payloads.items() if n.startswith('request ')), 'API yêu cầu của Sale không trả việc nội bộ và kit gợi ý')

            # ═══ 6. Sale kết thúc ghi hình ═══
            print('6. Kết thúc ghi hình')
            SP.goto(base + f'/#/outlets/{site_id}')
            SP.wait_for_selector('.outlets-detail .h-head h1', timeout=10000)
            SP.locator('.outlets-detail .h-actions button[aria-label="Thao tác khác"]').click()
            SP.click('.h-pop >> text=Kết thúc ghi hình')
            d = dlg(SP); d.wait_for()
            ok('thu hồi 2 kit' in d.inner_text(), 'hộp kết thúc nói rõ sẽ thu hồi 2 kit')
            dlg_submit(SP)
            ok(wait_text(d.locator('.dlg-err'), 'Lý do'), 'thiếu lý do thì không gửi')
            d.locator('[name=note]').fill('Hết hợp đồng thử nghiệm')
            shot(SP, 'd_sale_end_dialog', full=False)
            dlg_submit(SP); no_dlg(SP)
            ok(has_toast(SP, 'Đã kết thúc ghi hình'), 'Sale: báo đã kết thúc ghi hình')
            o = sale_api.req('GET', f'/api/hub/outlets/{site_id}')['outlet']
            ok(o['ops_status'] == 'ending', 'máy chủ: BO chuyển "Đang thu hồi"')
            rec = [j for j in lead_api.req('GET', f'/api/hub/jobs?type=recover&view=team&upcoming=1&site={site_id}')['jobs']]
            ok(len(rec) == 1, 'máy chủ: có việc thu hồi cho Logistics')
            ok(wait_text(SP.locator('.outlets-detail'), 'đang thu hồi thiết bị'), 'trang BO báo đang thu hồi')
            all_errs += serrs
            sctx.close()

            # ═══ 7. Logistics thêm BO, gửi yêu cầu rồi huỷ ═══
            print('7. Logistics: thêm BO, yêu cầu, huỷ')
            lctx, LP, lerrs = login_page(b, base, 'lead', pw, '#/outlets')
            LP.wait_for_selector('.outlets-list .h-tbl')
            LP.click('.outlets-list .h-head >> text=Thêm BO')
            d = dlg(LP); d.wait_for()
            d.locator('[name=name]').fill('UI BO Logistics')
            d.locator('[name=code]').fill('UIBO2')
            d.locator('[name=coord]').fill('10.78, 106.69')
            d.locator('[name=sale_id]').select_option(str(sale_me['id']))
            dlg_submit(LP); no_dlg(LP)
            LP.wait_for_selector('.outlets-detail .h-head h1', timeout=10000)
            o2 = [x for x in lead_api.req('GET', '/api/hub/outlets')['outlets'] if x['code'] == 'UIBO2']
            ok(len(o2) == 1 and o2[0]['sale'] and o2[0]['sale']['id'] == sale_me['id'] and o2[0]['has_coord'], 'máy chủ: BO mới có mã, vị trí và Sale phụ trách')
            ok(wait_text(LP.locator('.outlets-detail'), 'chưa có yêu cầu mở BO'), 'BO chờ launch chưa có yêu cầu: có lời nhắc')
            LP.click('.outlets-detail .h-actions >> text=Yêu cầu mở BO')
            d = dlg(LP); d.wait_for()
            d.locator('[name=launch_date]').fill((local_today() + datetime.timedelta(days=4)).isoformat())
            dlg_submit(LP); no_dlg(LP)
            LP.wait_for_selector('.requests-detail .h-head h1', timeout=10000)
            rid2 = int(re.search(r'#/requests/(\d+)', LP.url).group(1))
            LP.locator('.requests-detail .h-actions button[aria-label="Thao tác khác"]').click()
            LP.click('.h-pop >> text=Huỷ yêu cầu')
            d = dlg(LP); d.wait_for()
            d.locator('[name=reason]').fill('Sale báo BO lùi lịch')
            dlg_submit(LP); no_dlg(LP)
            ok(wait_text(LP.locator('.requests-detail .h-head .pill'), 'Đã huỷ'), 'yêu cầu chuyển "Đã huỷ"')
            ok(LP.locator('.requests-tl li[data-state=cancel]').count() == 1, 'dòng tiến trình đánh dấu bước huỷ')
            ok(lead_api.req('GET', f'/api/hub/requests/{rid2}')['request']['status'] == 'cancelled', 'máy chủ: yêu cầu đã huỷ')
            step('lọc danh sách BO')
            LP.goto(base + '/#/outlets?st=all')
            LP.wait_for_selector('.outlets-list .h-tbl')
            LP.fill('.outlets-list input[type=search]', 'hoa mai')
            LP.wait_for_timeout(500)
            ok(LP.locator('.outlets-list tbody tr').count() == 1 and 'UI BO Hoa Mai' in LP.inner_text('.outlets-list tbody'), 'tìm kiếm không dấu ra đúng BO')
            ok('q=hoa' in LP.url, 'bộ lọc ghi lên địa chỉ')
            LP.locator('.outlets-list tbody tr').first.click()
            LP.wait_for_selector('.outlets-detail .h-head h1')
            LP.click('.outlets-back button')
            LP.wait_for_selector('.outlets-list:not([hidden]) .h-tbl')
            ok(LP.input_value('.outlets-list input[type=search]') == 'hoa mai' and LP.locator('.outlets-list tbody tr').count() == 1, 'quay lại danh sách giữ bộ lọc')
            shot(LP, 'd_lead_outlets_list')
            all_errs += lerrs
            lctx.close()

            # ═══ 8. Điện thoại và giao diện tối ═══
            print('8. Điện thoại, giao diện tối')
            for dark in (False, True):
                tag = 'dark' if dark else 'light'
                for user, hashes in (('sale', [('outlets', '#/outlets?st=all'), ('outlet', f'#/outlets/{site_id}'), ('requests', '#/requests?st=all'), ('request', f'#/requests/{rid}')]),
                                     ('log', [('outlets', '#/outlets'), ('requests', '#/requests?st=all'), ('request', f'#/requests/{rid2}')])):
                    for mobile in (True, False):
                        if not mobile and not dark:
                            continue  # máy tính sáng đã chụp ở trên
                        ctx, pg, errs = login_page(b, base, user, pw, '', mobile=mobile, dark=dark)
                        for name, hs in hashes:
                            pg.goto(base + '/' + hs)
                            pg.wait_for_selector('.outlets-list .h-tbl, .outlets-detail .h-tabs, .requests-list .h-tbl, .requests-detail .requests-tl >> visible=true', timeout=15000)
                            pg.wait_for_timeout(500)
                            dev = 'm' if mobile else 'd'
                            shot(pg, f'{dev}_{tag}_{user}_{name}')
                            if mobile:
                                no_overflow(pg, f'{user} {name} điện thoại {tag}')
                        if mobile and user == 'sale':
                            pg.goto(base + f'/#/outlets/{site_id}?tab=kits')
                            pg.wait_for_selector('.outlets-tab .h-tbl')
                            shot(pg, f'm_{tag}_sale_outlet_kits')
                            no_overflow(pg, f'sale tab kit điện thoại {tag}')
                        ok(not errs, f'{user} {"điện thoại" if mobile else "máy tính"} {tag}: không lỗi JS ({errs[:2]})')
                        all_errs += errs
                        ctx.close()
            # Hộp gửi yêu cầu trên điện thoại
            ctx, pg, errs = login_page(b, base, 'sale', pw, '#/requests', mobile=True)
            pg.wait_for_selector('.requests-list .h-head h1')
            pg.click('.requests-list .h-head >> text=Gửi yêu cầu mở BO')
            dlg(pg).wait_for()
            shot(pg, 'm_light_sale_request_form', full=False)
            no_overflow(pg, 'hộp gửi yêu cầu trên điện thoại')
            ok(not errs, f'hộp thoại trên điện thoại: không lỗi JS ({errs[:2]})')
            ctx.close()
            b.close()
    finally:
        S.stop(srv)
    ok(not all_errs, f'tổng: không lỗi JS / 5xx ({all_errs[:3]})')
    print(f'\nBO & Yêu cầu: {passes[0]} phép kiểm đạt, {len(fails)} không đạt. Ảnh: {SHOTS}')
    for f in fails:
        print('  ✗ ' + f)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
