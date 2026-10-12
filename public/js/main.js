/* Khởi động: xem đang đăng nhập bằng tài khoản nào rồi mở đúng màn hình cho vai trò đó. */
(() => {
  'use strict';
  const root = document.getElementById('root');
  let unmount = null, gen = 0;
  function cleanup() {
    if (unmount) { try { unmount(); } catch (e) { console.error(e); } unmount = null; }
    for (const d of document.querySelectorAll('dialog.dlg')) { try { d.close(); } catch { /* chưa mở */ } d.remove(); }
  }
  // Link dùng một lần của BO: https://ten-mien/?b=<mã>. Có mã thì mở thẳng trang của BO, không cần đăng nhập.
  const qb = new URLSearchParams(location.search).get('b');
  if (qb && /^[A-Za-z0-9_-]{20,80}$/.test(qb)) ARL.boToken = qb;
  async function boot() {
    const my = ++gen;
    cleanup();
    if (ARL.boToken) { unmount = ARL.mountBoLink(root, ARL.boToken); return; }
    let me;
    try { me = await ARL.backend.api('GET', '/api/me'); } catch (e) {
      if (my !== gen) return;
      if (e.status === 401) return ARL.viewLogin(root, boot);
      const box = ARL.el('<div class="auth"><div class="auth-card"><h1>Chưa kết nối được</h1><p class="sub"></p><button type="button" class="primary big">Thử lại</button></div></div>');
      box.querySelector('p').textContent = e.message || 'Không kết nối được máy chủ.';
      box.querySelector('button').addEventListener('click', boot);
      return root.replaceChildren(box);
    }
    if (my !== gen) return;
    if (!me.user) return ARL.viewLogin(root, boot);
    ARL.me = me; ARL.cfg = me.cfg;
    if (me.user.must_change) return ARL.viewPassword(root, me, boot);
    if (me.needConsent) return ARL.viewConsent(root, me, boot);
    // FO dùng ứng dụng trên điện thoại (ca làm, task, gửi vị trí). Mọi vai trò khác vào Ops Hub; Logistics và Quản trị chuyển sang Rider Live ngay trong Ops Hub.
    const mount = me.user.role === 'fo' ? ARL.mountFo : ARL.mountHub;
    unmount = mount(root, me);
  }
  let rebootT = null;
  ARL.reboot = () => { clearTimeout(rebootT); rebootT = setTimeout(boot, 150); }; // gộp nhiều yêu cầu nạp lại dồn dập thành một
  ARL.onUnauth = () => { gen++; cleanup(); ARL.viewLogin(root, boot); };
  ARL.logout = async () => {
    try { await ARL.backend.api('POST', '/api/logout'); } catch { /* mất mạng: vẫn về màn hình đăng nhập */ }
    gen++; cleanup();
    ARL.noteAuth();
    ARL.viewLogin(root, boot);
  };
  // Tab khác của cùng trình duyệt vừa đăng nhập / đăng xuất → cookie đã đổi → tab này mở lại đúng màn hình của tài khoản hiện tại
  // (không để màn hình FO cũ gửi yêu cầu bằng phiên của Logistic rồi bị từ chối "không có quyền").
  window.addEventListener('storage', (e) => { if (e.key === 'arl.auth' && !ARL.boToken) ARL.reboot(); });
  boot();
})();
