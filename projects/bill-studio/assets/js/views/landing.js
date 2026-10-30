// Public home page: what Bill Studio is, with Log in / Sign up in the corner.
// Sign up is offered only while this device has no organisation — after that, people are added by the
// owner or a manager (so nobody can make themselves an administrator).
import { icon } from '../lib/icons.js';
import { esc, modal, toast, pickFile, downloadText } from '../ui.js';
import { COUNTRY_LIST } from '../tax/countries.js';
import { hasAccounts, signUp, login, changeOwnPassword, passwordError, recoverOwner, getOrg } from '../auth.js';
import { session } from '../session.js';
import { cycleTheme } from '../app.js';

// Resolves once someone is signed in (and has set their own password if they had a temporary one).
export function render(root, { openLogin = false } = {}) {
  return new Promise(async (resolve) => {
    const accounts = await hasAccounts();
    const org = await getOrg();
    const finish = async () => { if (session.user?.mustChangePassword) await forceChange(root); resolve(session.user); };

    root.innerHTML = `<div class="landing">
      <header class="land-top">
        <div class="brand"><span class="brand-mark">${icon('receipt', 18)}</span>Bill Studio</div>
        <div class="spacer"></div>
        <button class="btn icon ghost" data-theme-btn aria-label="Appearance">${icon('sun', 18)}</button>
        <button class="btn ghost" data-login>Log in</button>
        ${accounts ? '' : `<button class="btn primary" data-signup>Sign up</button>`}
      </header>
      <section class="land-hero">
        <div class="hero-mark">${icon('receipt', 42)}</div>
        <h1>Billing.<br>Beautifully simple.</h1>
        <p class="lead">Professional bills, payments, stock and reports for any business — from a single shop to a company with branches and a whole team. ${COUNTRY_LIST.length - 1} countries’ tax rules built in.</p>
        <div class="btn-row" style="justify-content:center">
          ${accounts ? `<button class="btn primary lg" data-login>${icon('lock', 18)} Log in${org?.name ? ` to ${esc(org.name)}` : ''}</button>`
            : `<button class="btn primary lg" data-signup>Create your free account ${icon('chevron-right', 18)}</button><button class="btn lg" data-login>Log in</button>`}
        </div>
        ${accounts ? '' : `<p class="small muted mt">Moving from another computer? <a href="#" role="button" data-restore>Restore a backup file</a></p>`}
      </section>
      <section class="land-grid">
        <div class="feature">${icon('globe', 22)}<b>Every country’s rules</b><span>GST, VAT and sales tax with the right bill titles, tax splits, e-invoice notices and amount in words.</span></div>
        <div class="feature">${icon('users', 22)}<b>Built for teams</b><span>Owner, administrators, managers, accountants, billing and store staff, each with exactly the access they need.</span></div>
        <div class="feature">${icon('shield', 22)}<b>Every action recorded</b><span>An activity log shows who created, changed, cancelled or paid what, and when.</span></div>
        <div class="feature">${icon('building-2', 22)}<b>Branches & businesses</b><span>Run several businesses or branches and choose who can open each one.</span></div>
        <div class="feature">${icon('lock', 22)}<b>Private by design</b><span>Your data stays on your own device and works offline. No subscription and no cloud account.</span></div>
        <div class="feature">${icon('printer', 22)}<b>Any paper</b><span>A4, Letter, half page, 1/8 page and thermal receipts, in five designs you can rearrange.</span></div>
      </section>
      <section class="land-roles card">
        <h2>How teams work</h2>
        <ol class="small" style="line-height:1.8;margin:8px 0 0;padding-left:20px">
          <li>The first person signs up and becomes the <b>Owner</b>. They choose their own User ID and password.</li>
          <li>The owner adds <b>administrators, managers, accountants and staff</b> in Team, giving each one a role and a temporary password.</li>
          <li>Managers can add people <b>below their own level</b>, and can only give access they have themselves.</li>
          <li>Everyone signs in with their own ID. New members choose their own password on first sign-in.</li>
        </ol>
      </section>
      <footer class="land-foot small muted">Bill Studio · runs in your browser · <a href="#" role="button" data-login>Log in</a></footer>
    </div>`;

    root.querySelector('[data-theme-btn]').addEventListener('click', (e) => cycleTheme(e.currentTarget));
    root.querySelectorAll('[data-login]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openLoginDialog(); }));
    root.querySelectorAll('[data-signup]').forEach((b) => b.addEventListener('click', () => openSignup()));
    root.querySelector('[data-restore]')?.addEventListener('click', (e) => { e.preventDefault(); restore(); });

    function openLoginDialog() {
      if (!accounts) {
        const m = modal({ title: 'Log in', body: `<p class="muted" style="margin:0">There are no accounts on this device yet. Create one — the first account becomes the owner. If you used Bill Studio on another computer, restore your backup instead.</p>`,
          foot: `<button class="btn" data-restore2>Restore a backup</button><button class="btn primary" data-ok>Sign up</button>` });
        m.el.querySelector('[data-ok]').addEventListener('click', () => { m.close(); openSignup(); });
        m.el.querySelector('[data-restore2]').addEventListener('click', () => { m.close(); restore(); });
        return;
      }
      let until = 0;
      const m = modal({
        title: 'Log in',
        body: `<form data-form autocomplete="on" novalidate>
          <div class="field"><label for="lg-id">User ID</label><input class="input" id="lg-id" name="username" autocomplete="username" autocapitalize="none" required></div>
          <div class="field mt"><label for="lg-pw">Password</label><input class="input" id="lg-pw" name="password" type="password" autocomplete="current-password" required></div>
          <div class="help err mt-s" data-err role="alert"></div>
          <button class="btn primary lg mt" style="width:100%" type="submit">Log in</button>
          <button class="btn plain sm mt" type="button" data-forgot style="width:100%">Forgot password?</button></form>`,
      });
      const f = m.el.querySelector('[data-form]'), err = m.el.querySelector('[data-err]');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (Date.now() < until) return;
        until = Date.now() + 800;
        try { await login(f.username.value, f.password.value); m.close(); await finish(); }
        catch (ex) { err.textContent = ex.message; f.password.value = ''; f.password.focus(); }
      });
      m.el.querySelector('[data-forgot]').addEventListener('click', () => { m.close(); forgot(); });
    }

    function openSignup() {
      const m = modal({
        title: 'Create your account',
        body: `<p class="small muted" style="margin-top:0">You’ll be the <b>Owner</b> of this organisation. You can add your team after setting up your business.</p>
          <form data-form class="form-grid" novalidate>
          <div class="field span2"><label>Your name *</label><input class="input" name="name" autocomplete="name"></div>
          <div class="field span2"><label>Organisation / company name</label><input class="input" name="orgName" autocomplete="organization" placeholder="Optional, e.g. Sharma Group"></div>
          <div class="field"><label>Choose a User ID *</label><input class="input" name="username" autocomplete="username" autocapitalize="none" placeholder="e.g. ravi"></div>
          <div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" placeholder="Optional"></div>
          <div class="field"><label>Password *</label><input class="input" name="password" type="password" autocomplete="new-password"></div>
          <div class="field"><label>Repeat password *</label><input class="input" name="password2" type="password" autocomplete="new-password"></div>
          <div class="help span2">At least 8 characters with letters and numbers. Nobody, not even us, can see or recover it, so you’ll get a recovery key next.</div>
          <div class="help err span2" data-err role="alert"></div>
          <button class="btn primary lg span2" type="submit">Create account</button></form>`,
      });
      const f = m.el.querySelector('[data-form]'), err = m.el.querySelector('[data-err]');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (f.password.value !== f.password2.value) { err.textContent = 'The two passwords don’t match.'; return; }
        try {
          const { recoveryKey } = await signUp({ name: f.name.value, username: f.username.value, password: f.password.value, email: f.email.value, orgName: f.orgName.value });
          m.close();
          await showRecovery(recoveryKey);
          toast('Account created — now set up your business');
          resolve(session.user);
        } catch (ex) { err.textContent = ex.message; }
      });
    }

    function forgot() {
      const m = modal({
        title: 'Forgot password?',
        body: `<p class="small" style="margin-top:0"><b>Team members:</b> ask your manager, an administrator or the owner to reset it from <i>Team</i>. They’ll give you a temporary password.</p>
          <p class="small"><b>Owner:</b> use the recovery key you saved when you created the account.</p>
          <form data-form class="form-grid" novalidate>
          <div class="field span2"><label>Recovery key</label><input class="input mono" name="key" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autocapitalize="characters"></div>
          <div class="field"><label>New password</label><input class="input" name="pw" type="password" autocomplete="new-password"></div>
          <div class="field"><label>Repeat</label><input class="input" name="pw2" type="password" autocomplete="new-password"></div>
          <div class="help err span2" data-err role="alert"></div>
          <button class="btn primary span2" type="submit">Reset owner password</button></form>`,
      });
      const f = m.el.querySelector('[data-form]'), err = m.el.querySelector('[data-err]');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (f.pw.value !== f.pw2.value) { err.textContent = 'The two passwords don’t match.'; return; }
        try { const o = await recoverOwner(f.key.value, f.pw.value); m.close(); toast(`Password reset. Log in as “${o.username}”.`); openLoginDialog(); }
        catch (ex) { err.textContent = ex.message; }
      });
    }

    async function restore() {
      const file = await pickFile('.json,application/json');
      if (!file) return;
      const { readBackup, importData } = await import('../backup.js');
      let data;
      try { data = await readBackup(await file.text()); }
      catch (ex) {
        if (ex.code !== 'PASS') { toast(ex.message || 'Not a Bill Studio backup', 'err'); return; }
        const pass = prompt('This backup is encrypted. Enter its passphrase:');
        if (!pass) return;
        try { data = await readBackup(await file.text(), pass); } catch (e2) { toast(e2.message, 'err'); return; }
      }
      if (data.kind && data.kind !== 'full') { toast('Please choose a FULL backup to set up a new device.', 'err'); return; }
      await importData(data, 'replace');
      toast('Backup restored — log in with your usual User ID');
      setTimeout(() => location.reload(), 600);
    }

    try { sessionStorage.removeItem('bs-open-login'); } catch { /* ignore */ }
    if (openLogin && accounts) openLoginDialog();
  });
}

function showRecovery(key) {
  const m = modal({
    title: 'Save your recovery key',
    body: `<p class="small" style="margin-top:0">If you ever forget your password, this key is the <b>only</b> way back in. Bill Studio can’t reset it for you. Download it or write it down, and keep it somewhere safe, away from this computer.</p>
      <div class="mono" style="font-size:20px;letter-spacing:.06em;text-align:center;padding:16px;border-radius:12px;background:var(--fill)" data-key>${esc(key)}</div>
      <label class="flex mt small" style="cursor:pointer"><input type="checkbox" data-ack> I have saved my recovery key</label>`,
    foot: `<button class="btn" data-dl>${icon('download', 16)} Download</button><button class="btn primary" data-ok disabled>Continue</button>`,
  });
  const ok = m.el.querySelector('[data-ok]');
  m.el.querySelector('[data-ack]').addEventListener('change', (e) => (ok.disabled = !e.target.checked));
  m.el.querySelector('[data-dl]').addEventListener('click', () => downloadText(`Bill Studio recovery key\nUser ID: ${session.user.username}\nKey: ${key}\nCreated: ${new Date().toLocaleString()}\n`, 'bill-studio-recovery-key.txt'));
  ok.addEventListener('click', () => m.close(true));
  // It can't be dismissed without confirming.
  return m.done.then((v) => (v ? true : showRecovery(key)));
}

// People given a temporary password must choose their own before doing anything else.
function forceChange(root) {
  return new Promise((resolve) => {
    root.innerHTML = `<div class="welcome"><div class="welcome-inner" style="max-width:420px">
      <div class="hero-mark" style="width:72px;height:72px;border-radius:18px">${icon('lock', 34)}</div>
      <h1 style="font-size:30px;margin-bottom:6px">Choose your password</h1>
      <p class="lead" style="margin-bottom:22px">Hi ${esc(session.user.name)}, you signed in with a temporary password. Choose your own to continue.</p>
      <form class="onb-card" data-form novalidate>
        <div class="field"><label>Temporary password</label><input class="input" name="cur" type="password" autocomplete="current-password"></div>
        <div class="field mt"><label>New password</label><input class="input" name="pw" type="password" autocomplete="new-password"></div>
        <div class="field mt"><label>Repeat new password</label><input class="input" name="pw2" type="password" autocomplete="new-password"></div>
        <div class="help mt-s">At least 8 characters with letters and numbers.</div>
        <div class="help err mt-s" data-err role="alert"></div>
        <button class="btn primary lg mt" style="width:100%" type="submit">Save and continue</button>
      </form></div></div>`;
    const f = root.querySelector('[data-form]'), err = root.querySelector('[data-err]');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (f.pw.value !== f.pw2.value) { err.textContent = 'The two passwords don’t match.'; return; }
      const pe = passwordError(f.pw.value, session.user.username); if (pe) { err.textContent = pe; return; }
      try { await changeOwnPassword(f.cur.value, f.pw.value); toast('Password saved'); resolve(); } catch (ex) { err.textContent = ex.message; }
    });
  });
}
