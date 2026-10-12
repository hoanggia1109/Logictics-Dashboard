"""Kiểm thử giao diện nhóm E (đội nhóm và hệ thống): Phân ca, Chấm công, Tài khoản, Cấu hình, Nhập dữ liệu.

Chạy:  python3 test/ui/views_team.py            (cổng 8185, ảnh chụp vào thư mục tạm, in đường dẫn)
       SHOTS=/duong/dan python3 test/ui/views_team.py
       HUB_DATA=/kho/co/du/lieu/mau python3 test/ui/views_team.py   (chạy trên bản sao của một kho có sẵn)

Luồng thật qua giao diện:
  - nhân viên Tech đăng ký ca → Tech Lead duyệt → nhân viên "trong ca" (/api/hub/me) → việc tự sinh chỉ giao cho người trong ca
  - Lead xếp nhanh nhiều ô, chép tuần, không duyệt kèm lý do
  - Lead sửa chấm công (bắt buộc lý do)
  - Lead tạo tài khoản (mật khẩu tạm hiện một lần, đăng nhập được), không có vai trò Tech (và máy chủ chặn 403), cấp lại mật khẩu, khoá; mã thiết bị FO
  - Head of Sale đổi cấu hình của Sale; Lead không sửa được mục của Sale (không có nút, máy chủ 403); Tech Lead đổi định mức việc Tech
  - Lead nhập file .xlsx: đọc → chạy thử → nhập thật → dữ liệu có trên hệ thống, có trong lịch sử
  - vai trò không được mở thì không thấy mục trong danh mục và bị chuyển đi; không lỗi JS; điện thoại không cuộn ngang.
"""
import datetime, json, os, re, shutil, subprocess, sys, tempfile, time, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hubsrv as S  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PORT = int(os.environ.get('PORT_TEAM', '8185'))
OUT = os.environ.get('SHOTS') or tempfile.mkdtemp(prefix='views-team-')
os.makedirs(OUT, exist_ok=True)
DESK = {'width': 1366, 'height': 850}
PHONE = {'width': 390, 'height': 800}
NEW_PW = 'Mat-khau-moi-2026'

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond or not detail else f'  ({detail})'), flush=True)
    return bool(cond)


def cli(base, user, pw):
    c = S.Cli(base)
    c.login(user, pw)
    return c


def api_status(c, m, p, body=None):
    try:
        c.req(m, p, body)
        return 200
    except RuntimeError as e:
        mm = re.search(r'→ (\d{3})', str(e))
        return int(mm.group(1)) if mm else 0


def make_user(admin, base, username, name, role):
    """Tạo tài khoản qua API rồi đổi mật khẩu tạm để đăng nhập được trên trình duyệt."""
    j = admin.req('POST', '/api/users', {'username': username, 'name': name, 'role': role})
    c = cli(base, username, j['tempPassword'])
    c.req('POST', '/api/password', {'old': j['tempPassword'], 'new': NEW_PW})
    c = cli(base, username, NEW_PW)
    return j['user'], c


def new_page(browser, base, user, pw, hash_='', viewport=DESK, dark=False):
    ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light')
    pg = ctx.new_page()
    errs = S.watch(pg)
    S.login(pg, base, user, pw, hash_)
    if hash_:
        pg.wait_for_timeout(300)
    return ctx, pg, errs


def open_view(pg, base, view, wait='.h-view'):
    pg.goto(base + '/#/' + view)
    pg.wait_for_selector(f'.h-view[data-view="{view}"]', timeout=10000)
    pg.wait_for_selector(wait, timeout=10000)
    pg.wait_for_timeout(250)


def dlg(pg):
    return pg.locator('dialog.dlg[open]').last


def dlg_click(pg, label):
    dlg(pg).locator('.dlg-foot button', has_text=label).first.click()


def confirm(pg, label=None):
    """Bấm nút đồng ý trên hộp xác nhận (ARL.ask) đang mở trên cùng."""
    pg.wait_for_selector('dialog.dlg.small[open]', timeout=5000)
    d = pg.locator('dialog.dlg.small[open]').last
    (d.locator('.dlg-foot button', has_text=label) if label else d.locator('.dlg-foot button.primary')).first.click()


def toast_text(pg, timeout=6000):
    pg.wait_for_selector('#toast:not([hidden])', timeout=timeout)
    return pg.inner_text('#toast')


def no_hscroll(pg):
    return pg.evaluate("() => { const m = document.querySelector('.h-main'); return document.documentElement.scrollWidth <= innerWidth + 1 && (!m || m.scrollWidth <= m.clientWidth + 1); }")


def shot(pg, name, full=False):
    pg.wait_for_timeout(200)
    pg.screenshot(path=os.path.join(OUT, name + '.png'), full_page=full)


def build_xlsx(path, sheets):
    js = ("import { buildXlsx } from './test/xlsx-build.mjs'; import fs from 'node:fs';"
          f"fs.writeFileSync({json.dumps(path)}, buildXlsx(JSON.parse(process.argv[1])));")
    subprocess.run(['node', '--input-type=module', '-e', js, json.dumps(sheets)], cwd=S.ROOT, check=True)


def main():
    # HUB_DATA=<thư mục kho đã có dữ liệu mẫu>: chạy trên bản sao của kho đó (khi server.js chưa tự tạo dữ liệu mẫu Ops Hub).
    extra = None
    if os.environ.get('HUB_DATA'):
        extra = {'DATA_DIR': tempfile.mkdtemp(prefix='hub-team-')}
        shutil.copytree(os.environ['HUB_DATA'], extra['DATA_DIR'], dirs_exist_ok=True)
    srv, base, pw = S.start(PORT, extra_env=extra)
    print(f'Máy chủ {base} · mật khẩu thử {pw} · ảnh: {OUT}', flush=True)
    all_errs = []
    try:
        admin = cli(base, 'admin', pw)
        me = admin.req('GET', '/api/hub/me')
        today = me['today']
        d0 = datetime.date.fromisoformat(today)
        mon = d0 - datetime.timedelta(days=d0.weekday())
        other = (mon if d0 != mon else mon + datetime.timedelta(days=1)).isoformat()   # ngày khác hôm nay trong tuần này
        later = (d0 + datetime.timedelta(days=2)).isoformat()
        users0 = admin.req('GET', '/api/users')['users']
        uid = {u['username']: u['id'] for u in users0}
        uname = {u['username']: u['name'] for u in users0}

        # Hai nhân viên Tech riêng cho bài thử (độc lập với dữ liệu mẫu nếu có).
        ua, ca = make_user(admin, base, 'kt.an', 'Trần Văn An', 'tech')
        ub, cb = make_user(admin, base, 'kt.binh', 'Lê Thị Bình', 'tech')
        ufo, _ = admin.req('POST', '/api/users', {'username': 'fo.thu', 'name': 'Phạm Giao Nhận', 'role': 'fo', 'vehicle': '59-A1 123.45'})['user'], None
        techlead = cli(base, 'techlead', pw)
        lead = cli(base, 'lead', pw)

        with sync_playwright() as p:
            browser = S.browser(p)
            try:
                # ═══════════ 1. PHÂN CA: đăng ký → duyệt → trong ca → giao việc theo ca ═══════════
                print('\n[Phân ca]', flush=True)
                ctxA, pa, errA = new_page(browser, base, 'kt.an', NEW_PW)
                open_view(pa, base, 'roster', '.ros-grid')
                check('nhân viên thấy nút "Đăng ký ca", không thấy "Xếp nhanh" / "Chép tuần trước"',
                      pa.locator('.h-head button', has_text='Đăng ký ca').count() == 1 and pa.locator('.h-head button', has_text='Xếp nhanh').count() == 0 and pa.locator('.h-head button', has_text='Chép tuần').count() == 0)
                check('có câu giải thích "Việc tự sinh chỉ giao cho người đang trong ca."', 'Việc tự sinh chỉ giao cho người đang trong ca.' in pa.inner_text('.ros-explain'))
                pa.click('.h-head button:has-text("Đăng ký ca")')
                pa.wait_for_selector('dialog.dlg[open] .ros-daypick')
                pa.check(f'dialog.dlg[open] .ros-daypick input[value="{today}"]')
                pa.check('dialog.dlg[open] .ros-pick input[value="custom"]')
                pa.fill('dialog.dlg[open] .ros-times input[aria-label="Giờ vào"]', '00:00')
                pa.fill('dialog.dlg[open] .ros-times input[aria-label="Giờ ra"]', '23:59')
                pa.fill('dialog.dlg[open] input[name="note"]', 'Làm cả ngày để kiểm thử')
                shot(pa, 'roster-register-dialog')
                dlg_click(pa, 'Gửi đăng ký')
                t = toast_text(pa)
                check('gửi đăng ký → báo chờ Lead duyệt', 'chờ Lead duyệt' in t, t)
                pa.wait_for_selector('.ros-req[data-st="pending"]')
                rA = ca.req('GET', '/api/hub/roster')
                req = [r for r in rA['rows'] if r['id'] == f'req:{ua["id"]}:{today}']
                check('máy chủ: yêu cầu ca đang chờ duyệt', req and req[0]['status'] == 'pending' and req[0]['start'] == '00:00', json.dumps(req)[:200])
                check('chưa duyệt: nhân viên chưa có ca hôm nay', ca.req('GET', '/api/hub/me')['shift'] is None)

                # B xin nghỉ một ngày (API) → Lead sẽ không duyệt qua giao diện
                cb.req('POST', '/api/hub/roster/register', {'rows': [{'date': later, 'kind': 'leave', 'note': 'Việc gia đình'}]})

                ctxL, pl, errL = new_page(browser, base, 'techlead', pw)
                open_view(pl, base, 'roster', '.ros-pend .h-tbl')
                pend_txt = pl.inner_text('.ros-pend')
                check('Tech Lead thấy bảng "Chờ duyệt" có yêu cầu của An và Bình', re.search(r'Chờ duyệt \(\d+\)', pend_txt) and 'Trần Văn An' in pend_txt and 'Lê Thị Bình' in pend_txt, pend_txt[:120])
                check('Tech Lead thấy "Xếp nhanh" và "Chép tuần trước", không thấy "Đăng ký ca"',
                      pl.locator('.h-head button', has_text='Xếp nhanh').count() == 1 and pl.locator('.h-head button', has_text='Chép tuần').count() == 1 and pl.locator('.h-head button', has_text='Đăng ký ca').count() == 0)
                shot(pl, 'roster-lead-pending')
                pl.locator('.ros-pend tr', has_text='Trần Văn An').locator('button:text-is("Duyệt")').click()
                t = toast_text(pl)
                check('Lead duyệt → báo đã duyệt', 'Đã duyệt 1' in t, t)
                pl.wait_for_function(f'() => !document.querySelector(".ros-pend") || !document.querySelector(".ros-pend").innerText.includes("Trần Văn An")')
                rL = techlead.req('GET', '/api/hub/roster')
                row = [r for r in rL['rows'] if r['id'] == f'{ua["id"]}:{today}']
                check('máy chủ: ca hôm nay của An đã duyệt (00:00–23:59)', row and row[0]['status'] == 'approved' and row[0]['end'] == '23:59', json.dumps(row)[:200])
                meA = ca.req('GET', '/api/hub/me')
                check('/api/hub/me: An đang trong ca (on_shift)', meA['on_shift'] is True, json.dumps({k: meA[k] for k in ('on_shift', 'shift', 'attendance')})[:300])
                meB = cb.req('GET', '/api/hub/me')
                check('/api/hub/me: Bình không có ca hôm nay → ngoài ca', meB['on_shift'] is False, str(meB['on_shift']))
                job = admin.req('POST', '/api/hub/jobs', {'team': 'tech', 'title': 'Kiểm tra giao việc theo ca'})['job']
                who = (job.get('assignee') or {}).get('id')
                onshift_ids = set(techlead.req('GET', '/api/hub/roster').get('on_shift') or [])
                check('việc tự sinh giao cho người trong ca, không giao cho người ngoài ca', who is not None and who != ub['id'] and who in onshift_ids | {ua['id']}, f'giao cho {job.get("assignee")}')

                # Không duyệt yêu cầu nghỉ của Bình (có lý do)
                pl.locator('.ros-pend tr', has_text='Lê Thị Bình').locator('button:text-is("Không duyệt")').click()
                pl.wait_for_selector('dialog.dlg[open] textarea[name="note"]')
                pl.fill('dialog.dlg[open] textarea[name="note"]', 'Ngày này thiếu người')
                dlg_click(pl, 'Không duyệt')
                toast_text(pl)
                rb = [r for r in cb.req('GET', f'/api/hub/roster?from={later}&to={later}')['rows'] if r['id'] == f'req:{ub["id"]}:{later}']
                check('máy chủ: yêu cầu nghỉ của Bình bị từ chối, kèm lý do', rb and rb[0]['status'] == 'rejected' and 'thiếu người' in rb[0]['note'], json.dumps(rb)[:200])

                # Xếp nhanh: chọn ca S rồi bấm ô của Bình (ngày khác hôm nay) → lưu
                pl.reload(); pl.wait_for_selector('.ros-grid')
                pl.click('.h-head button:has-text("Xếp nhanh")')
                pl.wait_for_selector('.ros-brush:not([hidden])')
                pl.locator('.ros-brush-b', has=pl.locator('b', has_text=re.compile(r'^S$'))).first.click()
                pl.click(f'.ros-gridbox button.ros-cell[data-u="{ub["id"]}"][data-d="{other}"]')
                pl.wait_for_selector('.ros-save:not([hidden])')
                check('ô xếp nhanh hiện thanh "1 ô chưa lưu"', '1 ô chưa lưu' in pl.inner_text('.ros-save'))
                shot(pl, 'roster-lead-quick')
                pl.click('.ros-save button:has-text("Lưu 1 ô")')
                toast_text(pl)
                rows = techlead.req('GET', '/api/hub/roster')['rows']
                check('máy chủ: Bình có ca S ngày ' + other, any(r['id'] == f'{ub["id"]}:{other}' and r['shift'] == 'S' for r in rows))
                check('Bình vẫn ngoài ca hôm nay sau khi xếp ngày khác', cb.req('GET', '/api/hub/me')['on_shift'] is False)
                pl.click('.h-head button:has-text("Xếp nhanh")')

                # Chép tuần: sang tuần sau rồi chép từ tuần này
                pl.click('.ros-nav button[aria-label="Tuần sau"]')
                pl.wait_for_function('() => document.querySelector(".h-head .sub").innerText.includes("Tuần")')
                pl.wait_for_timeout(400)
                pl.click('.h-head button:has-text("Chép tuần trước")')
                confirm(pl, 'Chép ca')
                # Thông báo "Đã lưu 1 ô" của lần lưu trước có thể còn trên màn hình: chờ đúng thông báo chép tuần.
                try:
                    pl.wait_for_function('() => { const t = document.querySelector("#toast"); return t && !t.hidden && t.innerText.includes("Đã chép"); }', timeout=8000)
                except Exception:
                    pass
                t = toast_text(pl)
                nmon = (mon + datetime.timedelta(days=7)).isoformat()
                nrows = techlead.req('GET', f'/api/hub/roster?from={nmon}&to={(mon + datetime.timedelta(days=13)).isoformat()}')['rows']
                check('chép tuần trước → tuần sau có ca đã duyệt', 'Đã chép' in t and any(r['user_id'] == ua['id'] for r in nrows), t)

                # Nhân viên thấy mình trong ca (thanh trên cùng + nhãn trong bảng)
                pa.reload(); pa.wait_for_selector('.ros-grid')
                pa.wait_for_selector('.h-shift[data-on="1"]', timeout=8000)
                check('thanh trên của An hiện "Trong ca"', 'Trong ca' in pa.inner_text('.h-shift'))
                check('bảng phân ca đánh dấu An "Đang trong ca"', pa.locator('.ros-gridbox tr.is-me .ros-on').count() == 1)
                shot(pa, 'roster-member-desk')
                # Điện thoại: danh sách theo ngày
                ctxM, pm, errM = new_page(browser, base, 'kt.an', NEW_PW, viewport=PHONE)
                open_view(pm, base, 'roster', '.ros-dlist')
                check('điện thoại: hiện danh sách theo ngày, ẩn bảng tuần', pm.is_visible('.ros-dlist') and not pm.is_visible('.ros-grid'))
                check('điện thoại: không cuộn ngang (Phân ca)', no_hscroll(pm))
                shot(pm, 'roster-member-phone')
                all_errs += errA + errM
                ctxA.close(); ctxM.close()
                all_errs += errL
                ctxL.close()

                # ═══════════ 2. CHẤM CÔNG: Lead sửa, bắt buộc lý do ═══════════
                print('\n[Chấm công]', flush=True)
                ctxL, pl, errL = new_page(browser, base, 'lead', pw)
                open_view(pl, base, 'attendance', '.att-grid')
                log_id = uid['log']
                cell = f'button.att-c[data-u="{log_id}"][data-d="{today}"]'
                check('Lead Logistics thấy ô chấm công hôm nay của Logistic Executive', pl.locator(cell).count() == 1)
                pl.click(cell)
                pl.wait_for_selector('dialog.dlg[open] select[name="status"]')
                pl.select_option('dialog.dlg[open] select[name="status"]', 'late')
                pl.fill('dialog.dlg[open] input[name="checkin"]', '09:45')
                pl.fill('dialog.dlg[open] input[name="ot_min"]', '30')
                dlg_click(pl, 'Lưu chấm công')
                pl.wait_for_selector('dialog.dlg[open] .dlg-err:not([hidden])')
                check('thiếu lý do → hộp thoại báo lỗi, không gửi', 'Lý do' in pl.inner_text('dialog.dlg[open] .dlg-err'))
                pl.fill('dialog.dlg[open] textarea[name="reason"]', 'Quên mở ứng dụng, đã báo Lead')
                shot(pl, 'attendance-edit-dialog')
                dlg_click(pl, 'Lưu chấm công')
                t = toast_text(pl)
                check('lưu chấm công → báo đã sửa', 'Đã sửa chấm công' in t, t)
                att = lead.req('GET', f'/api/hub/attendance?from={today}&to={today}')
                a = [x for x in att['rows'] if x['user_id'] == log_id]
                check('máy chủ: trạng thái Vào trễ, tăng ca 30 phút, ghi lý do, người sửa', a and a[0]['status'] == 'late' and a[0]['ot_min'] == 30 and 'Quên mở' in a[0]['note'] and a[0]['by'], json.dumps(a)[:250])
                pl.wait_for_selector(f'{cell}[data-st="late"]')
                check('ô trên bảng đổi sang "Vào trễ"', pl.locator(f'{cell}[data-st="late"]').count() == 1)
                pl.click('.h-seg button:has-text("Tháng")')
                pl.wait_for_selector('.att-grid[data-period="month"]')
                check('xem theo tháng', pl.locator('.att-grid[data-period="month"] thead th').count() >= 29)
                shot(pl, 'attendance-month-desk')
                all_errs += errL
                ctxL.close()

                # ═══════════ 3. TÀI KHOẢN ═══════════
                print('\n[Tài khoản]', flush=True)
                ctxL, pl, errL = new_page(browser, base, 'lead', pw)
                reqs = []
                pl.on('request', lambda r: reqs.append(r.url))
                open_view(pl, base, 'accounts', '.h-tbl')
                pl.click('.h-head button:has-text("Tạo tài khoản")')
                pl.wait_for_selector('dialog.dlg[open] select[name="role"]')
                roles = pl.eval_on_selector_all('dialog.dlg[open] select[name="role"] option', 'els => els.map(e => e.value)')
                check('Lead chỉ tạo được Logistic Executive và FO (không có Tech)', sorted(roles) == ['fo', 'logistic'], str(roles))
                pl.fill('dialog.dlg[open] input[name="name"]', 'Nguyễn Văn Kho')
                check('gợi ý tên đăng nhập từ họ tên', pl.input_value('dialog.dlg[open] input[name="username"]') == 'kho.nguyen')
                pl.fill('dialog.dlg[open] input[name="username"]', 'kho.moi')
                pl.select_option('dialog.dlg[open] select[name="role"]', 'logistic')
                pl.fill('dialog.dlg[open] input[name="phone"]', '0909 111 222')
                dlg_click(pl, 'Tạo tài khoản')
                pl.wait_for_selector('dialog.dlg[open] .accts-cred')
                cred = pl.inner_text('dialog.dlg[open] .accts-cred')
                m = re.search(r'Mật khẩu tạm: (\S+)', cred)
                check('hộp thoại mật khẩu tạm hiện một lần, có nút sao chép và lời dặn gửi riêng',
                      bool(m) and dlg(pl).locator('button', has_text='Sao chép').count() == 1 and 'chỉ hiện một lần' in dlg(pl).inner_text())
                shot(pl, 'accounts-temp-password')
                tmp = m.group(1) if m else ''
                check('đăng nhập được bằng mật khẩu tạm (phải đổi mật khẩu)', api_status(S.Cli(base), 'POST', '/api/login', {'username': 'kho.moi', 'password': tmp}) == 200)
                dlg_click(pl, 'Tôi đã gửi')
                check('máy chủ: Lead tạo tài khoản Tech → 403', api_status(lead, 'POST', '/api/users', {'username': 'tech.lau', 'name': 'Tech Lậu', 'role': 'tech'}) == 403)
                check('Lead không thấy tài khoản Tech trong danh sách', 'Trần Văn An' not in pl.inner_text('.h-tbl'))
                new_id = [u for u in lead.req('GET', '/api/users')['users'] if u['username'] == 'kho.moi'][0]['id']
                # Mở chi tiết theo địa chỉ (link từ thông báo user:id)
                pl.goto(base + f'/#/accounts/{new_id}')
                pl.wait_for_selector('dialog.dlg[open] input[name="name"]')
                check('địa chỉ #/accounts/<id> mở thẳng hộp thoại tài khoản', 'Nguyễn Văn Kho' in dlg(pl).inner_text())
                pl.fill('dialog.dlg[open] input[name="phone"]', '0909 333 444')
                dlg_click(pl, 'Lưu')
                toast_text(pl)
                pl.wait_for_function('() => !location.hash.match(/accounts\\/\\d/)')
                u2 = [u for u in lead.req('GET', '/api/users')['users'] if u['id'] == new_id][0]
                check('sửa SĐT lưu về máy chủ; đóng hộp thoại thì địa chỉ về #/accounts', u2['phone'] == '0909 333 444', u2['phone'])
                # Cấp lại mật khẩu qua menu ⋯
                pl.locator('.h-tbl tr', has_text='Nguyễn Văn Kho').locator('button[aria-label^="Thao tác"]').click()
                pl.click('.h-pop button:has-text("Cấp lại mật khẩu")')
                confirm(pl, 'Cấp mật khẩu mới')
                pl.wait_for_selector('dialog.dlg[open] .accts-cred')
                m2 = re.search(r'Mật khẩu tạm: (\S+)', pl.inner_text('dialog.dlg[open] .accts-cred'))
                check('cấp lại mật khẩu → mật khẩu tạm mới đăng nhập được, mật khẩu cũ hết hiệu lực',
                      m2 and m2.group(1) != tmp and api_status(S.Cli(base), 'POST', '/api/login', {'username': 'kho.moi', 'password': m2.group(1)}) == 200
                      and api_status(S.Cli(base), 'POST', '/api/login', {'username': 'kho.moi', 'password': tmp}) == 401)
                dlg_click(pl, 'Tôi đã gửi')
                # Mã thiết bị FO
                tok0 = lead.req('GET', f'/api/users/{ufo["id"]}/device')['deviceToken']
                pl.locator('.h-tbl tr', has_text='Phạm Giao Nhận').locator('button[aria-label^="Thao tác"]').click()
                pl.click('.h-pop button:has-text("Mã thiết bị")')
                pl.wait_for_selector('dialog.dlg[open] .accts-tok input')
                check('hộp thoại mã thiết bị: mã ẩn mặc định', pl.get_attribute('dialog.dlg[open] .accts-tok input', 'type') == 'password')
                dlg_click(pl, 'Đổi mã mới')
                confirm(pl, 'Đổi mã')
                toast_text(pl)
                tok1 = lead.req('GET', f'/api/users/{ufo["id"]}/device')['deviceToken']
                check('đổi mã thiết bị FO → mã mới trên máy chủ', tok1 != tok0 and pl.input_value('dialog.dlg[open] .accts-tok input') == tok1)
                dlg_click(pl, 'Đóng')
                # Khoá tài khoản
                pl.locator('.h-tbl tr', has_text='Nguyễn Văn Kho').click()
                pl.wait_for_selector('dialog.dlg[open] .accts-quick')
                pl.click('dialog.dlg[open] .accts-quick button:has-text("Khoá tài khoản")')
                confirm(pl, 'Khoá tài khoản')
                toast_text(pl)
                u3 = [u for u in lead.req('GET', '/api/users')['users'] if u['id'] == new_id][0]
                check('khoá tài khoản → máy chủ ghi đã khoá, danh sách "Đang dùng" không còn', u3['active'] is False and 'Nguyễn Văn Kho' not in pl.inner_text('.h-tbl'))
                check('Tài khoản: không gọi API vị trí FO', not any(re.search(r'/api/(fos|live|positions|track|tasks|stops)', u) for u in reqs), str([u for u in reqs if '/api/' in u][:8]))
                fo_row = [u for u in lead.req('GET', '/api/users')['users'] if u['id'] == ufo['id']][0]
                check('FO: có trạng thái điều khoản, không có toạ độ trong dữ liệu', 'consent_ok' in fo_row and not any(k in fo_row for k in ('lat', 'lon', 'last')))
                all_errs += errL
                ctxL.close()
                # Head of Sale chỉ tạo Sale Lead
                ctxS, ps, errS = new_page(browser, base, 'salehead', pw)
                open_view(ps, base, 'accounts', '.h-tbl')
                ps.click('.h-head button:has-text("Tạo tài khoản")')
                ps.wait_for_selector('dialog.dlg[open] select[name="role"]')
                roles = ps.eval_on_selector_all('dialog.dlg[open] select[name="role"] option', 'els => els.map(e => e.value)')
                check('Head of Sale chỉ tạo được Sale Lead', roles == ['sale'], str(roles))
                dlg_click(ps, 'Thôi')
                all_errs += errS
                ctxS.close()

                # ═══════════ 4. CẤU HÌNH ═══════════
                print('\n[Cấu hình]', flush=True)
                ctxS, ps, errS = new_page(browser, base, 'salehead', pw)
                open_view(ps, base, 'settings', '.set-row')
                r_daily = ps.locator('.set-row[data-k="dailyStdHours"]')
                check('mục "Chuẩn giờ quay" ghi đề xuất và team chốt (Sale chốt), có giải thích, có mặc định',
                      'Sale chốt' in r_daily.inner_text() and 'Mặc định' in r_daily.inner_text() and 'Chuẩn giờ quay' in r_daily.inner_text())
                check('Head of Sale không có nút Sửa ở mục của Tech (gbPerHour)', ps.locator('.set-row[data-k="gbPerHour"] button').count() == 0)
                r_daily.locator('button', has_text='Sửa').click()
                ps.wait_for_selector('dialog.dlg[open] input[name="v"]')
                ps.fill('dialog.dlg[open] input[name="v"]', '6')
                dlg_click(ps, 'Lưu')
                t = toast_text(ps)
                check('Head of Sale đổi chuẩn giờ quay 5 → 6 giờ', admin.req('GET', '/api/hub/config')['values']['dailyStdHours'] == 6, t)
                ps.wait_for_selector('.set-row[data-k="dailyStdHours"][data-changed="1"]')
                check('mục đã đổi hiện nhãn "Đã đổi" và giá trị mới', '6 giờ/ngày' in ps.inner_text('.set-row[data-k="dailyStdHours"]'))
                shot(ps, 'settings-salehead')
                all_errs += errS
                ctxS.close()
                ctxL, pl, errL = new_page(browser, base, 'lead', pw)
                open_view(pl, base, 'settings', '.set-row')
                check('Lead Logistics: mục của Sale chỉ xem (không có nút Sửa)', pl.locator('.set-row[data-k="dailyStdHours"] button').count() == 0 and 'Chỉ xem' in pl.inner_text('.set-row[data-k="dailyStdHours"]'))
                check('máy chủ: Lead đổi mục của Sale → 403', api_status(lead, 'PUT', '/api/hub/config', {'dailyStdHours': 7}) == 403)
                check('Lead thấy ai đổi gần đây (nhật ký cấu hình)', uname['salehead'] in pl.inner_text('.set-row[data-k="dailyStdHours"]'), pl.inner_text('.set-row[data-k="dailyStdHours"]')[:200])
                # Lead thêm ca mẫu
                pl.locator('.set-row[data-k="shifts"] button', has_text='Sửa').click()
                pl.wait_for_selector('dialog.dlg[open] .set-shiftrow')
                pl.click('dialog.dlg[open] button:has-text("+ Thêm ca")')
                last = pl.locator('dialog.dlg[open] .set-shiftrow').last
                last.locator('input[name="id"]').fill('T')
                last.locator('input[name="name"]').fill('Ca tối')
                last.locator('input[name="start"]').fill('18:00')
                last.locator('input[name="end"]').fill('22:00')
                dlg_click(pl, 'Lưu ca mẫu')
                toast_text(pl)
                sh = admin.req('GET', '/api/hub/config')['values']['shifts']  # ca mẫu riêng từng team: { tech, logistics }
                check('Lead Logistics thêm ca mẫu "T Ca tối 18:00–22:00" cho Logistics, ca mẫu của Tech giữ nguyên',
                      any(s['id'] == 'T' and s['start'] == '18:00' for s in sh['logistics']) and not any(s['id'] == 'T' for s in sh['tech']), json.dumps(sh, ensure_ascii=False))
                check('Lead không có nút Sửa định mức việc của Tech (Sửa kit hỏng)', pl.locator('.h-card tr', has_text='Sửa kit hỏng').locator('button', has_text='Sửa').count() == 0)
                shot(pl, 'settings-lead-desk')
                all_errs += errL
                ctxL.close()
                ctxT, pt, errT = new_page(browser, base, 'techlead', pw)
                open_view(pt, base, 'settings', '.set-row')
                pt.locator('.h-card tr', has_text='Sửa kit hỏng').locator('button', has_text='Sửa').click()
                pt.wait_for_selector('dialog.dlg[open] input[name="std"]')
                pt.fill('dialog.dlg[open] input[name="std"]', '50')
                pt.fill('dialog.dlg[open] input[name="sla"]', '2880')
                dlg_click(pt, 'Lưu định mức')
                pt.wait_for_function('() => !document.querySelector("dialog.dlg[open]")', timeout=8000)
                v = admin.req('GET', '/api/hub/config')['values']
                check('Tech Lead đổi định mức "Sửa kit hỏng": 50 phút/kit, hạn 2 ngày', v['jobStd'].get('repair') == 50 and v['jobSla'].get('repair') == 2880, json.dumps({'std': v['jobStd'], 'sla': v['jobSla']}))
                pt.locator('.set-row[data-k="gbPerHour"] button', has_text='Sửa').click()
                pt.wait_for_selector('dialog.dlg[open] input[name="v"]')
                pt.fill('dialog.dlg[open] input[name="v"]', '500')
                dlg_click(pt, 'Lưu')
                check('giá trị ngoài khoảng → báo lỗi trong hộp thoại', 'từ 1 đến 200' in pt.inner_text('dialog.dlg[open] .dlg-err'))
                pt.fill('dialog.dlg[open] input[name="v"]', '17.5')
                dlg_click(pt, 'Lưu')
                pt.wait_for_function('() => !document.querySelector("dialog.dlg[open]")', timeout=8000)
                check('Tech Lead đổi GB mỗi giờ 16,9 → 17,5', admin.req('GET', '/api/hub/config')['values']['gbPerHour'] == 17.5)
                all_errs += errT
                ctxT.close()

                # ═══════════ 5. NHẬP DỮ LIỆU ═══════════
                print('\n[Nhập dữ liệu]', flush=True)
                xl = os.path.join(OUT, 'Atlas_Ops_Hub_Data.xlsx')
                build_xlsx(xl, [
                    {'name': 'Danh sách BO', 'rows': [['DANH SÁCH BO THỬ'], [], ['Mã BO', 'Tên BO', 'SĐT', 'Địa chỉ', 'Ngày đổi thẻ'],
                                                     ['TN1', 'BO Thử Nhập Một', '0912 000 001', '1 Lê Lợi, Q1', 'T2, T5'], ['TN2', 'BO Thử Nhập Hai', '0912 000 002', '2 Lê Lợi, Q1', '']]},
                    {'name': 'Thẻ nhớ', 'rows': [['Mã thẻ', 'Trạng thái'], ['SDT01', 'Văn phòng'], ['SDT02', 'Văn phòng'], ['SDT03', 'Hỏng']]},
                    {'name': 'Ghi chú', 'rows': [['Ghi chú chung của file'], ['Không phải dữ liệu']]},
                ])
                ctxL, pl, errL = new_page(browser, base, 'lead', pw)
                open_view(pl, base, 'import', '.imp-drop')
                check('trang nhập mô tả các sheet cần có (không có sheet tài khoản với Lead Logistics)', 'Thẻ nhớ' in pl.inner_text('.imp-guide') and 'Tài khoản người dùng' not in pl.inner_text('.imp-guide'))
                pl.set_input_files('input.imp-file', xl)
                pl.wait_for_selector('.imp-sheet select', timeout=15000)
                sels = pl.eval_on_selector_all('.imp-sheet .imp-sel select', 'els => els.map(e => e.value)')
                check('đoán đúng loại dữ liệu: BO, Thẻ nhớ; sheet ghi chú bỏ qua', sels == ['outlets', 'cards', ''], str(sels))
                opts = pl.eval_on_selector_all('.imp-sheet .imp-sel select >> nth=0 >> option', 'els => els.map(e => e.value)')
                check('Lead Logistics không có lựa chọn nhập tài khoản', 'users' not in opts, str(opts))
                shot(pl, 'import-step2', full=True)
                pl.click('.imp-foot button:has-text("Chạy thử")')
                pl.wait_for_selector('.imp-main .h-kpis', timeout=15000)
                kp = pl.inner_text('.imp-main .h-kpis')
                check('chạy thử: sẽ thêm mới 5 (2 BO + 3 thẻ)', re.search(r'Sẽ thêm mới\s*5', kp) is not None, kp.replace('\n', ' ')[:200])
                check('chạy thử không đổi dữ liệu', not any(c['code'] == 'SDT01' for c in lead.req('GET', '/api/hub/cards').get('cards', [])))
                shot(pl, 'import-dry', full=True)
                pl.click('.imp-foot button:has-text("Nhập thật")')
                confirm(pl, 'Nhập thật')
                pl.wait_for_selector('.imp-steps li[aria-current="step"]:has-text("Nhập thật")', timeout=15000)
                check('nhập thật xong → báo "Đã nhập xong"', 'Đã nhập xong' in pl.inner_text('.imp-main'))
                cards = lead.req('GET', '/api/hub/cards').get('cards', [])
                outs = lead.req('GET', '/api/hub/outlets').get('outlets', [])
                check('máy chủ: có 3 thẻ SDT01–03 và 2 BO mới', sum(1 for c in cards if c['code'] in ('SDT01', 'SDT02', 'SDT03')) == 3 and sum(1 for o in outs if o['name'].startswith('BO Thử Nhập')) == 2,
                      f'{len(cards)} thẻ, {len(outs)} BO')
                pl.wait_for_function('() => document.body.innerText.includes("Atlas_Ops_Hub_Data.xlsx") && document.querySelectorAll(".h-tbl tbody tr").length > 0')
                check('lịch sử nhập có file vừa nhập', 'Atlas_Ops_Hub_Data.xlsx' in pl.inner_text('.h-view'))
                shot(pl, 'import-done', full=True)
                # File sai định dạng
                pl.click('.imp-foot button:has-text("Nhập file khác")')
                bad = os.path.join(OUT, 'cu.xls')
                open(bad, 'wb').write(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\x00\x00')
                pl.set_input_files('input.imp-file', bad)
                pl.wait_for_selector('.imp-status[data-bad]')
                check('file .xls cũ → báo cần lưu thành .xlsx', '.xlsx' in pl.inner_text('.imp-status'))
                all_errs += errL
                ctxL.close()

                # ═══════════ 6. QUYỀN XEM: danh mục và chuyển hướng ═══════════
                print('\n[Quyền theo vai trò]', flush=True)
                VIEWS = ['roster', 'attendance', 'accounts', 'settings', 'import']
                ALLOW = {
                    'admin': VIEWS, 'techlead': VIEWS, 'lead': VIEWS, 'tech': ['roster'], 'log': ['roster'],
                    'salehead': ['accounts', 'settings'], 'sale': [],
                }
                for user, ok in ALLOW.items():
                    c, pg, errs = new_page(browser, base, user, pw)
                    nav = pg.eval_on_selector_all('.h-nav a[data-view]', 'els => els.map(e => e.dataset.view)')
                    for v in VIEWS:
                        if v in ok:
                            open_view(pg, base, v)
                            check(f'{user} mở được {v}', pg.locator(f'.h-view[data-view="{v}"]').count() == 1 and v in nav)
                        else:
                            pg.goto(base + '/#/' + v)
                            pg.wait_for_timeout(500)
                            check(f'{user} không thấy {v} và bị chuyển đi', v not in nav and pg.locator(f'.h-view[data-view="{v}"]').count() == 0)
                    all_errs += errs
                    c.close()

                # ═══════════ 7. ẢNH: máy tính + điện thoại, sáng + tối ═══════════
                print('\n[Ảnh chụp, cuộn ngang trên điện thoại]', flush=True)
                for user, v, wait in [('techlead', 'roster', '.ros-legend .ros-leg'), ('kt.an', 'roster', '.ros-legend .ros-leg'), ('admin', 'attendance', '.att-grid'),
                                      ('admin', 'accounts', '.h-tbl'), ('lead', 'settings', '.set-row'), ('admin', 'import', '.imp-drop')]:
                    upw = NEW_PW if user.startswith('kt.') else pw
                    for vp, tag in [(DESK, 'desk'), (PHONE, 'phone')]:
                        for dark in (False, True):
                            c, pg, errs = new_page(browser, base, user, upw, viewport=vp, dark=dark)
                            open_view(pg, base, v, wait)
                            if tag == 'phone':
                                check(f'{v} ({user}) điện thoại {"tối" if dark else "sáng"}: không cuộn ngang', no_hscroll(pg))
                            shot(pg, f'z-{v}-{user}-{tag}-{"dark" if dark else "light"}')
                            all_errs += errs
                            c.close()
            except Exception:
                # Ảnh của mọi trang đang mở lúc lỗi, để xem giao diện đang hiện gì.
                for i, c in enumerate(browser.contexts):
                    for j, pg_ in enumerate(c.pages):
                        try:
                            pg_.screenshot(path=os.path.join(OUT, f"loi-{i}-{j}.png"))
                        except Exception:
                            pass
                raise
            browser.close()
    except Exception:
        traceback.print_exc()
        check('kịch bản chạy hết không ngoại lệ', False, traceback.format_exc().splitlines()[-1])
    finally:
        S.stop(srv)

    check('không có lỗi JS / phản hồi 5xx', not all_errs, '; '.join(all_errs[:5]))
    ok = sum(1 for _, c, _ in results if c)
    bad = [n for n, c, _ in results if not c]
    print(f'\nNhóm E (đội nhóm, hệ thống): {ok} đạt, {len(bad)} không đạt. Ảnh: {OUT}')
    for n in bad:
        print('  ✗ ' + n)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
