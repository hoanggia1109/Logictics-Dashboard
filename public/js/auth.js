/* Đăng nhập · đổi mật khẩu · đồng ý điều khoản */
(() => {
  'use strict';
  const { $, $$, el, esc, api, modal, ask, toast, fmtDT } = ARL;

  const shell = (inner) => el(`<div class="auth"><div class="auth-card"><div class="brand"><span class="logo" aria-hidden="true"></span><b>Atlas Rider Live</b></div>${inner}</div></div>`);

  ARL.viewLogin = function (root, onDone) {
    const v = shell(`
      <h1>Đăng nhập</h1>
      <form class="stack" novalidate>
        <label>Tên đăng nhập<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="err" hidden></p>
        <button type="submit" class="primary big">Đăng nhập</button>
      </form>
      <p class="sub">Chưa có tài khoản hoặc quên mật khẩu: báo Logistic Lead để được cấp lại.</p>`);
    const form = $('form', v), err = $('.err', v), btn = $('button', v);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = form.username.value.trim(), password = form.password.value;
      if (!username || !password) { err.hidden = false; err.textContent = 'Nhập đủ tên đăng nhập và mật khẩu.'; return; }
      btn.disabled = true; btn.textContent = 'Đang đăng nhập…'; err.hidden = true;
      try { await api('POST', '/api/login', { username, password }); ARL.noteAuth(); onDone(); } catch (ex) {
        err.hidden = false; err.textContent = ex.message;
        btn.disabled = false; btn.textContent = 'Đăng nhập';
        form.password.value = ''; form.password.focus();
      }
    });
    root.replaceChildren(v);
    form.username.focus();
  };

  function passwordForm(forced) {
    return `
      <form class="stack" novalidate>
        <label>${forced ? 'Mật khẩu tạm được cấp' : 'Mật khẩu hiện tại'}<input name="old" type="password" autocomplete="current-password" required></label>
        <label>Mật khẩu mới (ít nhất 8 ký tự)<input name="new1" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Nhập lại mật khẩu mới<input name="new2" type="password" autocomplete="new-password" minlength="8" required></label>
        <p class="err" hidden></p>
        ${forced ? '<button type="submit" class="primary big">Đổi mật khẩu và tiếp tục</button>' : ''}
      </form>`;
  }
  async function submitPassword(form) {
    const o = form.old.value, a = form.new1.value, b = form.new2.value;
    if (!o || !a) throw new Error('Nhập đủ các ô.');
    if (a.length < 8) throw new Error('Mật khẩu mới cần ít nhất 8 ký tự.');
    if (a !== b) throw new Error('Hai lần nhập mật khẩu mới không giống nhau.');
    await api('POST', '/api/password', { old: o, new: a });
  }
  ARL.viewPassword = function (root, me, onDone) {
    const v = shell(`<h1>Đặt mật khẩu của riêng bạn</h1><p class="sub">Chào ${esc(me.user.name)}. Đây là lần đăng nhập đầu, bạn cần đổi mật khẩu tạm thành mật khẩu chỉ mình bạn biết.</p>${passwordForm(true)}<button type="button" class="ghost out">Đăng xuất</button>`);
    const form = $('form', v), err = $('.err', v), btn = $('button[type=submit]', v);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true; err.hidden = true;
      try { await submitPassword(form); toast('Đã đổi mật khẩu'); onDone(); } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
    });
    $('.out', v).addEventListener('click', ARL.logout);
    root.replaceChildren(v);
    form.old.focus();
  };
  /** Hộp thoại đổi mật khẩu (dùng trong menu tài khoản của mọi vai trò). */
  ARL.changePasswordDialog = function () {
    const body = el(`<div>${passwordForm(false)}</div>`);
    modal({ title: 'Đổi mật khẩu', body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Đổi mật khẩu', cls: 'primary', run: async () => { await submitPassword($('form', body)); toast('Đã đổi mật khẩu'); } }] });
  };

  ARL.viewConsent = function (root, me, onDone) {
    const t = me.terms;
    const v = shell(`
      <h1>${esc(t.title || 'Điều khoản sử dụng')}</h1>
      <p class="sub">${esc(t.intro || '')}</p>
      <ol class="terms">${t.items.map((s, i) => `<li><label><input type="checkbox" data-i="${i}"><span>${esc(s)}</span></label></li>`).join('')}</ol>
      <p class="sub count" aria-live="polite"></p>
      <p class="err" hidden></p>
      <button type="button" class="primary big agree" disabled>Tôi đồng ý tất cả các mục trên</button>
      <button type="button" class="ghost out">Tôi không đồng ý – đăng xuất</button>
      <p class="sub">Bản điều khoản: ${esc(t.version)}. Thời điểm bạn bấm đồng ý, địa chỉ IP và loại thiết bị sẽ được ghi lại làm bằng chứng.</p>`);
    v.classList.add('consent');
    const boxes = $$('input[type=checkbox]', v), btn = $('.agree', v), cnt = $('.count', v), err = $('.err', v);
    const upd = () => {
      const n = boxes.filter((b) => b.checked).length;
      btn.disabled = n !== boxes.length;
      cnt.textContent = n === boxes.length ? 'Bạn đã đánh dấu đủ các mục.' : `Đã đánh dấu ${n}/${boxes.length} mục. Cần đánh dấu đủ để tiếp tục.`;
    };
    boxes.forEach((b) => b.addEventListener('change', upd));
    upd();
    btn.addEventListener('click', async () => {
      btn.disabled = true; err.hidden = true;
      try { await api('POST', '/api/consent', { version: t.version, checked: boxes.filter((b) => b.checked).map((b) => +b.dataset.i) }); toast('Đã ghi nhận sự đồng ý của bạn'); onDone(); } catch (ex) {
        err.hidden = false; err.textContent = ex.message;
        if (ex.code === 'terms_changed') setTimeout(ARL.reboot, 1500); else upd();
      }
    });
    $('.out', v).addEventListener('click', ARL.logout);
    root.replaceChildren(v);
  };
  /** FO xem lại điều khoản đã đồng ý và rút lại sự đồng ý. */
  ARL.termsDialog = async function (me) {
    let t;
    try { t = await api('GET', '/api/terms'); } catch (e) { return toast(e.message, true); }
    const body = el(`<div><p class="sub">${esc(t.intro || '')}</p><ol class="terms read">${t.items.map((s) => `<li>${esc(s)}</li>`).join('')}</ol><p class="sub">Bản ${esc(t.version)}${me.user.consent_at ? ` · bạn đồng ý lúc ${esc(fmtDT(me.user.consent_at))}` : ''}</p></div>`);
    modal({
      title: t.title || 'Điều khoản', body, wide: true,
      actions: [{ label: 'Rút lại sự đồng ý', cls: 'ghost danger', run: async () => {
        if (!(await ask('Rút lại sự đồng ý? Ứng dụng sẽ ngừng ghi vị trí ngay và bạn không nhận task qua ứng dụng được nữa cho tới khi đồng ý lại. Logistic Lead sẽ được báo.', 'Rút lại', true))) return false;
        await api('POST', '/api/consent/withdraw');
        ARL.reboot();
      } }, { label: 'Đóng', cls: 'primary', run: () => {} }],
    });
  };
})();
