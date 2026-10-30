// Team: members, roles & permissions, and the activity log.
import { icon } from '../lib/icons.js';
import { esc, modal, toast, confirmDialog, segmented, toCSV, downloadText } from '../ui.js';
import { db, uid } from '../db.js';
import { state } from '../store.js';
import { session, can, isOwner, level, allRoles, canManageUser, canAssignRole, audit, PERM_GROUPS, ALL_PERMS, setSession } from '../session.js';
import { allUsers, findUser, usernameError, newUserRecord, resetPassword, tempPassword, normUser, getOrg, saveOrg } from '../auth.js';

const ui = { tab: 'members', q: '', who: '' };

export async function render(root, { query = {} } = {}) {
  if (query.tab) ui.tab = query.tab;
  const tabs = [can('users.view') && ['members', 'Members'], can('users.view') && ['roles', 'Roles & permissions'], can('audit.view') && ['activity', 'Activity log']].filter(Boolean);
  if (!tabs.some(([k]) => k === ui.tab)) ui.tab = tabs[0]?.[0];
  const [users, roles, businesses, org] = await Promise.all([allUsers(), allRoles(), db.all('businesses'), getOrg()]);
  const roleById = (id) => roles.find((r) => r.id === id);
  const bizName = (id) => businesses.find((b) => b.id === id)?.name || 'Removed business';
  const dt = (iso) => (iso ? new Date(iso).toLocaleString(state.business?.locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  root.innerHTML = `<div class="page">
    <div class="large-title"><div><h1>Team</h1><p>${esc(org?.name || state.business?.name || 'Your organisation')} · ${users.filter((u) => u.status === 'active').length} active member${users.length === 1 ? '' : 's'}</p></div>
      <div class="actions">${ui.tab === 'members' && can('users.manage') ? `<button class="btn primary" data-add>${icon('user-plus', 16)} Add member</button>` : ''}
        ${ui.tab === 'roles' && can('roles.manage') ? `<button class="btn primary" data-new-role>${icon('plus', 16)} New role</button>` : ''}
        ${ui.tab === 'activity' ? `<button class="btn" data-csv>${icon('download', 16)} Export CSV</button>` : ''}</div></div>
    <div class="toolbar"><span data-tabs></span></div>
    <div data-body></div></div>`;
  root.querySelector('[data-tabs]').append(segmented(tabs, ui.tab, (v) => { ui.tab = v; render(root, {}); }));
  const body = root.querySelector('[data-body]');

  // ---------------- Members ----------------
  if (ui.tab === 'members') {
    const order = (u) => -(roleById(u.roleId)?.level ?? 0);
    const list = [...users].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    body.innerHTML = `<div class="card" style="padding:6px 0"><div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>User ID</th><th>Role</th><th>Businesses</th><th>Reports to</th><th>Last sign-in</th><th>Status</th></tr></thead>
      <tbody>${list.map((u) => { const r = roleById(u.roleId); const manageable = canManageUser(u, r) || u.id === session.user.id;
        return `<tr class="${manageable ? 'click' : ''}" data-u="${u.id}">
        <td><b>${esc(u.name)}</b>${u.id === session.user.id ? ' <span class="badge info">You</span>' : ''}${u.title ? `<div class="tiny muted">${esc(u.title)}</div>` : ''}</td>
        <td class="mono small">${esc(u.username)}</td>
        <td><span class="badge ${u.roleId === 'owner' ? 'paid' : u.roleId === 'admin' ? 'partial' : 'neutral'}">${esc(r?.name || 'Unknown role')}</span></td>
        <td class="small">${u.roleId === 'owner' || !u.businessIds?.length ? 'All' : u.businessIds.map((id) => esc(bizName(id))).join(', ')}</td>
        <td class="small">${esc(users.find((x) => x.id === u.managerId)?.name || '—')}</td>
        <td class="small">${dt(u.lastLoginAt)}</td>
        <td>${u.status === 'active' ? (u.mustChangePassword ? '<span class="badge partial">Invited</span>' : '<span class="badge paid">Active</span>') : '<span class="badge overdue">Disabled</span>'}</td></tr>`; }).join('')}</tbody></table></div></div>
      <p class="help mt">${icon('shield', 13)} You can manage people whose role is below yours, and only give access you have yourself. The owner can’t be disabled or removed. To hand the business over, the owner can transfer ownership.</p>`;
    body.querySelectorAll('tr[data-u]').forEach((tr) => tr.addEventListener('click', async () => {
      const u = users.find((x) => x.id === tr.dataset.u);
      if (u.id === session.user.id) { location.hash = '#/settings'; return; }
      if (!canManageUser(u, roleById(u.roleId))) return;
      if (await memberDialog(u)) render(root, {});
    }));
    root.querySelector('[data-add]')?.addEventListener('click', async () => { if (await memberDialog(null)) render(root, {}); });
  }

  async function memberDialog(u) {
    const isNew = !u;
    const x = u || { name: '', username: '', title: '', email: '', phone: '', roleId: roles.filter(canAssignRole).sort((a, b) => a.level - b.level).find((r) => r.id === 'sales')?.id || roles.filter(canAssignRole).at(-1)?.id, businessIds: [], managerId: session.user.id, status: 'active' };
    const assignable = roles.filter((r) => canAssignRole(r) || r.id === x.roleId);
    const myBiz = businesses.filter((b) => !session.user.businessIds?.length || session.user.businessIds.includes(b.id));
    const allBiz = !x.businessIds?.length;
    const m = modal({
      title: isNew ? 'Add team member' : `Edit ${x.name}`, wide: true,
      body: `<div class="form-grid">
        <div class="field"><label>Full name *</label><input class="input" name="name" value="${esc(x.name)}"></div>
        <div class="field"><label>User ID *</label><input class="input" name="username" value="${esc(x.username)}" ${isNew ? '' : 'readonly'} autocapitalize="none" placeholder="e.g. priya.sales"></div>
        <div class="field"><label>Job title</label><input class="input" name="title" value="${esc(x.title || '')}" placeholder="e.g. Branch manager, Cashier"></div>
        <div class="field"><label>Reports to</label><select class="input" name="managerId"><option value="">—</option>${users.filter((o) => o.id !== x.id && o.status === 'active').map((o) => `<option value="${o.id}" ${o.id === x.managerId ? 'selected' : ''}>${esc(o.name)} (${esc(roleById(o.roleId)?.name || '')})</option>`).join('')}</select></div>
        <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${esc(x.email || '')}"></div>
        <div class="field"><label>Phone</label><input class="input" name="phone" type="tel" value="${esc(x.phone || '')}"></div>
        <div class="field span2"><label>Role *</label><select class="input" name="roleId">${assignable.map((r) => `<option value="${r.id}" ${r.id === x.roleId ? 'selected' : ''} ${canAssignRole(r) ? '' : 'disabled'}>${esc(r.name)} — ${esc(r.description || '')}</option>`).join('')}</select>
          <div class="help" data-role-help></div></div>
        <div class="field span2"><label>Business access</label>
          <label class="flex small" style="cursor:pointer"><input type="radio" name="bizMode" value="all" ${allBiz ? 'checked' : ''} ${session.user.businessIds?.length && !isOwner() ? 'disabled' : ''}> All businesses (including ones added later)</label>
          <label class="flex small mt-s" style="cursor:pointer"><input type="radio" name="bizMode" value="some" ${allBiz ? '' : 'checked'}> Only these:</label>
          <div class="chips mt-s" data-bizlist>${myBiz.map((b) => `<label class="chip" style="cursor:pointer"><input type="checkbox" value="${b.id}" ${x.businessIds?.includes(b.id) ? 'checked' : ''}> ${esc(b.name || 'Untitled')}</label>`).join('')}</div></div>
        ${isNew ? `<div class="field span2"><label>Temporary password</label><div class="flex"><input class="input mono" name="temp" value="${esc(tempPassword())}" style="flex:1"><button class="btn" type="button" data-regen>${icon('rotate-ccw', 15)}</button></div>
          <div class="help">Give this to ${'them'} privately. They must choose their own password when they first sign in.</div></div>` : ''}
      </div>
      ${isNew ? '' : `<div class="group mt" style="box-shadow:none;border:1px solid var(--sep)">
        <div class="row"><span class="grow">Password<div class="sub">Last changed ${dt(x.passwordChangedAt)}${x.lockedUntil && Date.now() < new Date(x.lockedUntil).getTime() ? ' · <b>locked after wrong passwords</b>' : ''}</div></span><button class="btn sm" data-reset>${icon('key-round', 14)} Reset password</button></div>
        <div class="row"><span class="grow">${x.status === 'active' ? 'Account is active' : 'Account is disabled'}<div class="sub">${x.status === 'active' ? 'Disabled people can’t sign in. Their bills and history stay.' : 'Enable to let them sign in again.'}</div></span><button class="btn sm ${x.status === 'active' ? 'danger' : ''}" data-toggle>${x.status === 'active' ? `${icon('ban', 14)} Disable` : 'Enable'}</button></div>
        ${isOwner() && x.status === 'active' ? `<div class="row"><span class="grow">Transfer ownership<div class="sub">${esc(x.name)} becomes the owner; you become an administrator.</div></span><button class="btn sm" data-transfer>Transfer…</button></div>` : ''}
        ${!x.lastLoginAt ? `<div class="row"><span class="grow">Remove<div class="sub">Only for people who never signed in. Otherwise disable them to keep the history.</div></span><button class="btn sm danger" data-remove>Remove</button></div>` : ''}
      </div>`}`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${isNew ? 'Add member' : 'Save'}</button>`,
    });
    const el = m.el;
    const roleHelp = () => {
      const r = roleById(el.querySelector('[name=roleId]').value);
      el.querySelector('[data-role-help]').textContent = r ? `${r.perms.length === ALL_PERMS.length ? 'Full access' : `${r.perms.length} of ${ALL_PERMS.length} permissions`} · level ${r.level}${r.perms.includes('bills.viewAll') ? '' : ' · sees only bills they create'}` : '';
    };
    roleHelp(); el.querySelector('[name=roleId]').addEventListener('change', roleHelp);
    el.querySelector('[data-regen]')?.addEventListener('click', () => (el.querySelector('[name=temp]').value = tempPassword()));
    el.querySelector('[data-ok]').addEventListener('click', async () => {
      const v = (n) => el.querySelector(`[name=${n}]`)?.value.trim() ?? '';
      const rec = { ...x, name: v('name'), title: v('title'), email: v('email'), phone: v('phone'), roleId: v('roleId'), managerId: v('managerId') };
      const some = el.querySelector('[name=bizMode]:checked').value === 'some';
      rec.businessIds = some ? [...el.querySelectorAll('[data-bizlist] input:checked')].map((i) => i.value) : [];
      if (!rec.name) { toast('Enter the person’s name', 'err'); return; }
      if (some && !rec.businessIds.length) { toast('Choose at least one business', 'err'); return; }
      if (!some && session.user.businessIds?.length && !isOwner()) { toast('You can only give access to your own businesses', 'err'); return; }
      const role = roleById(rec.roleId);
      if (!role || (rec.roleId !== x.roleId && !canAssignRole(role))) { toast('You can’t give that role', 'err'); return; }
      if (isNew) {
        const ue = usernameError(v('username')); if (ue) { toast(ue, 'err'); return; }
        if (await findUser(v('username'))) { toast('That User ID is already taken', 'err'); return; }
        const temp = v('temp');
        if (temp.length < 8) { toast('Temporary password: at least 8 characters', 'err'); return; }
        const created = await newUserRecord({ ...rec, username: v('username') }, temp);
        await db.put('users', created);
        await audit('Team member added', `${created.name} (${created.username}) as ${role.name}`);
        m.close(true);
        credentials(created, temp);
      } else {
        await db.put('users', rec);
        await audit('Team member updated', `${rec.name} (${rec.username})${rec.roleId !== x.roleId ? ` · role ${roleById(x.roleId)?.name} → ${role.name}` : ''}`);
        toast('Saved'); m.close(true);
      }
    });
    el.querySelector('[data-reset]')?.addEventListener('click', async () => {
      const temp = tempPassword();
      if (!(await confirmDialog(`Reset ${x.name}’s password?`, 'They will get a temporary password and must choose a new one when they next sign in.', { ok: 'Reset password' }))) return;
      await resetPassword(x, temp);
      await audit('Password reset', `${x.name} (${x.username})`);
      m.close(true); credentials(x, temp, true);
    });
    el.querySelector('[data-toggle]')?.addEventListener('click', async () => {
      const off = x.status === 'active';
      if (off && !(await confirmDialog(`Disable ${x.name}?`, 'They won’t be able to sign in. Everything they did stays in your records.', { ok: 'Disable', danger: true }))) return;
      x.status = off ? 'disabled' : 'active'; x.failedLogins = 0; x.lockedUntil = '';
      await db.put('users', x); await audit(off ? 'Team member disabled' : 'Team member enabled', `${x.name} (${x.username})`);
      toast(off ? 'Disabled' : 'Enabled'); m.close(true);
    });
    el.querySelector('[data-remove]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove ${x.name}?`, 'This deletes the account. It can’t be undone.', { ok: 'Remove', danger: true }))) return;
      await db.del('users', x.id); await audit('Team member removed', `${x.name} (${x.username})`); m.close(true);
    });
    el.querySelector('[data-transfer]')?.addEventListener('click', async () => {
      const typed = prompt(`Type ${x.username} to make ${x.name} the owner of this organisation. You will become an administrator.`);
      if (normUser(typed) !== x.username) { toast('Ownership not transferred'); return; }
      const me = await db.get('users', session.user.id);
      x.roleId = 'owner'; x.businessIds = []; me.roleId = 'admin';
      await db.put('users', x); await db.put('users', me);
      const org = await getOrg(); await saveOrg({ ...org, ownerId: x.id, recovery: null });
      await audit('Ownership transferred', `${me.name} → ${x.name}`);
      await setSession(me);
      toast(`${x.name} is now the owner. They should create a new recovery key in Settings.`); m.close(true);
      location.reload();
    });
    return m.done;
  }

  function credentials(u, temp, reset = false) {
    const text = `Bill Studio sign-in for ${u.name}\nUser ID: ${u.username}\nTemporary password: ${temp}\nYou'll choose your own password when you first sign in.`;
    const m = modal({
      title: reset ? 'New temporary password' : 'Member added',
      body: `<p class="small" style="margin-top:0">Share these details with <b>${esc(u.name)}</b> privately. The password is shown only now.</p>
        <dl class="kv"><dt>User ID</dt><dd class="mono">${esc(u.username)}</dd><dt>Temporary password</dt><dd class="mono" style="font-size:17px">${esc(temp)}</dd></dl>
        <div class="notice mt">${icon('lock', 18)}<div>Team accounts live on <b>this device</b>. ${esc(u.name)} signs in here, on this computer or browser. To work on another computer, move the data there with a full backup (Settings → Your data).</div></div>`,
      foot: `<button class="btn" data-copy>${icon('copy', 15)} Copy</button><button class="btn primary" data-close>Done</button>`,
    });
    m.el.querySelector('[data-copy]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy not allowed here — please write it down', 'err'); } });
  }

  // ---------------- Roles ----------------
  if (ui.tab === 'roles') {
    const count = (id) => users.filter((u) => u.roleId === id && u.status === 'active').length;
    body.innerHTML = `<div class="grid c2">${roles.map((r) => `<div class="card">
        <div class="flex between"><div><b style="font-size:16px">${esc(r.name)}</b> ${r.builtin ? '<span class="badge neutral">Built-in</span>' : '<span class="badge info">Custom</span>'}</div><span class="tiny muted">Level ${r.level}</span></div>
        <p class="small muted" style="margin:6px 0 10px">${esc(r.description || '')}</p>
        <div class="small">${r.perms.length === ALL_PERMS.length ? 'Full access' : `${r.perms.length} of ${ALL_PERMS.length} permissions`} · ${count(r.id)} member${count(r.id) === 1 ? '' : 's'}</div>
        <div class="btn-row mt"><button class="btn sm" data-role="${r.id}">${can('roles.manage') && roleEditable(r) ? 'Edit' : 'View'} permissions</button>
          ${can('roles.manage') ? `<button class="btn sm ghost" data-dup="${r.id}">${icon('copy', 14)} Duplicate</button>` : ''}</div></div>`).join('')}</div>
      <p class="help mt">Roles control what people can do. Built-in roles follow common business practice; managers and the owner can fine-tune them or create their own (e.g. “Branch cashier”, “Purchase officer”). A role’s level decides who can manage whom.</p>`;
    body.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => { if (await roleDialog(roles.find((r) => r.id === b.dataset.role))) render(root, {}); }));
    body.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => {
      const src = roles.find((r) => r.id === b.dataset.dup);
      if (await roleDialog({ id: '', name: `${src.name} (copy)`, description: src.description, level: Math.min(src.level, level() - 1), perms: src.perms.filter((p) => isOwner() || session.perms.has(p)), builtin: false })) render(root, {});
    }));
    root.querySelector('[data-new-role]')?.addEventListener('click', async () => { if (await roleDialog({ id: '', name: '', description: '', level: Math.max(1, Math.min(40, level() - 1)), perms: ['bills.view'], builtin: false })) render(root, {}); });
  }

  function roleEditable(r) { return !['owner', 'admin'].includes(r.id) && (isOwner() || r.level < level()); }

  async function roleDialog(r) {
    const editable = can('roles.manage') && (r.id ? roleEditable(r) : true);
    const isNew = !r.id;
    const allowed = (p) => isOwner() || session.perms.has(p);
    const maxLevel = isOwner() ? 99 : level() - 1;
    const m = modal({
      title: isNew ? 'New role' : r.name, wide: true,
      body: `<div class="form-grid">
        <div class="field"><label>Role name *</label><input class="input" name="name" value="${esc(r.name)}" ${editable && !r.builtin ? '' : 'readonly'}></div>
        <div class="field"><label>Level (1–${maxLevel})</label><input class="input" name="level" type="number" min="1" max="${maxLevel}" value="${esc(r.level)}" ${editable && !r.builtin ? '' : 'readonly'}>
          <div class="help">People can manage only roles with a lower level.</div></div>
        <div class="field span2"><label>Description</label><input class="input" name="description" value="${esc(r.description || '')}" ${editable && !r.builtin ? '' : 'readonly'}></div></div>
        ${PERM_GROUPS.map((g) => `<div class="section-title" style="margin-top:14px">${esc(g.name)}</div><div class="group" style="box-shadow:none;border:1px solid var(--sep)">
          ${g.perms.map(([k, label]) => `<label class="row" style="cursor:${editable && allowed(k) ? 'pointer' : 'default'}"><span class="grow small">${esc(label)}${!allowed(k) ? ' <span class="tiny muted">(you don’t have this)</span>' : ''}</span>
            <span class="switch"><input type="checkbox" data-p="${k}" ${r.perms.includes(k) ? 'checked' : ''} ${editable && allowed(k) ? '' : 'disabled'}><span></span></span></label>`).join('')}</div>`).join('')}`,
      foot: `${!isNew && !r.builtin && editable ? '<button class="btn danger" data-del style="margin-right:auto">Delete role</button>' : ''}
        ${r.builtin && editable && r.customised ? '<button class="btn" data-reset-role style="margin-right:auto">Restore defaults</button>' : ''}
        <button class="btn" data-close>${editable ? 'Cancel' : 'Close'}</button>${editable ? '<button class="btn primary" data-ok>Save role</button>' : ''}`,
    });
    const el = m.el;
    el.querySelector('[data-ok]')?.addEventListener('click', async () => {
      const perms = [...el.querySelectorAll('[data-p]:checked')].map((i) => i.dataset.p).filter(allowed);
      const name = el.querySelector('[name=name]').value.trim();
      const lv = Math.round(Number(el.querySelector('[name=level]').value));
      if (!name) { toast('Give the role a name', 'err'); return; }
      if (!(lv >= 1 && lv <= maxLevel)) { toast(`Level must be between 1 and ${maxLevel}`, 'err'); return; }
      if (perms.includes('bills.viewAll') && !perms.includes('bills.view')) perms.push('bills.view');
      const rec = r.builtin ? { id: r.id, name: r.name, level: r.level, description: r.description, perms, customised: true }
        : { id: r.id || uid('role_'), name, level: lv, description: el.querySelector('[name=description]').value.trim(), perms };
      await db.put('roles', rec);
      await audit(isNew ? 'Role created' : 'Role changed', `${rec.name}: ${perms.length} permissions`);
      toast('Role saved'); m.close(true);
    });
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      const n = users.filter((u) => u.roleId === r.id).length;
      if (n) { toast(`${n} member${n === 1 ? ' has' : 's have'} this role — give them another role first`, 'err'); return; }
      if (!(await confirmDialog(`Delete role “${r.name}”?`, 'This can’t be undone.', { ok: 'Delete', danger: true }))) return;
      await db.del('roles', r.id); await audit('Role deleted', r.name); m.close(true);
    });
    el.querySelector('[data-reset-role]')?.addEventListener('click', async () => {
      await db.del('roles', r.id); await audit('Role restored to defaults', r.name); toast('Defaults restored'); m.close(true);
    });
    return m.done;
  }

  // ---------------- Activity ----------------
  if (ui.tab === 'activity') {
    const logs = (await db.all('audit')).sort((a, b) => b.at.localeCompare(a.at));
    const draw = () => {
      const q = ui.q.toLowerCase();
      const rows = logs.filter((l) => (!ui.who || l.userId === ui.who || l.username === ui.who) && (!q || `${l.action} ${l.detail} ${l.userName} ${l.username}`.toLowerCase().includes(q)));
      body.innerHTML = `<div class="toolbar"><div class="searchbar">${icon('search', 16)}<input class="input" data-q placeholder="Search activity" value="${esc(ui.q)}"></div>
        <select class="input" data-who style="width:auto;height:36px"><option value="">Everyone</option>${users.map((u) => `<option value="${u.id}" ${ui.who === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        <div class="card" style="padding:6px 0"><div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>Business</th></tr></thead>
        <tbody>${rows.slice(0, 500).map((l) => `<tr><td class="small" style="white-space:nowrap">${dt(l.at)}</td><td class="small">${esc(l.userName || l.username || '—')}</td><td><b class="small">${esc(l.action)}</b></td><td class="small muted">${esc(l.detail)}</td><td class="small">${l.businessId ? esc(bizName(l.businessId)) : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted" style="text-align:center;padding:22px">No activity yet</td></tr>'}</tbody></table></div></div>
        ${rows.length > 500 ? `<p class="help">Showing the latest 500 of ${rows.length}. Export CSV for everything.</p>` : ''}
        <p class="help">The activity log can’t be edited or deleted from the app. It is part of every full backup.</p>`;
      const qi = body.querySelector('[data-q]');
      qi.addEventListener('input', () => { ui.q = qi.value; const p = qi.selectionStart; draw(); const n = body.querySelector('[data-q]'); n.focus(); n.setSelectionRange(p, p); });
      body.querySelector('[data-who]').addEventListener('change', (e) => { ui.who = e.target.value; draw(); });
    };
    draw();
    root.querySelector('[data-csv]').addEventListener('click', () => {
      downloadText(toCSV([['When', 'User ID', 'Name', 'Action', 'Details', 'Business'], ...logs.map((l) => [l.at, l.username, l.userName, l.action, l.detail, l.businessId ? bizName(l.businessId) : ''])]), `activity-log-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
      audit('Activity log exported');
    });
  }
}
