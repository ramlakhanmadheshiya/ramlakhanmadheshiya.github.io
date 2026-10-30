// Who is signed in, what they may do, and the activity log.
// Model (as in Zoho Books / QuickBooks): one Owner, built-in roles + custom roles, permissions per module,
// optional limit to some businesses, and nobody can manage people at or above their own level.
import { db, uid, setActor } from './db.js';

// ---- Permission catalogue -------------------------------------------------------------------
export const PERM_GROUPS = [
  { name: 'Bills & sales', perms: [
    ['bills.view', 'View bills, quotations and receipts'],
    ['bills.viewAll', 'See bills created by other team members'],
    ['bills.create', 'Create bills and quotations'],
    ['bills.edit', 'Edit bills'],
    ['bills.cancel', 'Cancel bills'],
    ['bills.delete', 'Delete bills permanently'],
  ] },
  { name: 'Payments', perms: [
    ['payments.view', 'View payments received'],
    ['payments.record', 'Record payments'],
    ['payments.delete', 'Edit or delete payments'],
  ] },
  { name: 'Customers', perms: [
    ['customers.view', 'View customers and their balances'],
    ['customers.manage', 'Add, edit and import customers'],
  ] },
  { name: 'Items & stock', perms: [
    ['items.view', 'View items and stock'],
    ['items.manage', 'Add, edit and import items, adjust stock'],
  ] },
  { name: 'Expenses & purchases', perms: [
    ['expenses.view', 'View expenses'],
    ['expenses.manage', 'Add, edit and delete expenses'],
  ] },
  { name: 'Reports', perms: [
    ['reports.view', 'View reports and the business dashboard'],
    ['reports.export', 'Download reports (PDF / CSV)'],
  ] },
  { name: 'Business setup', perms: [
    ['business.manage', 'Business profile, taxes, numbering and print settings'],
    ['templates.manage', 'Create and edit bill designs'],
    ['business.add', 'Add new businesses / branches'],
  ] },
  { name: 'Data', perms: [
    ['data.backup', 'Back up and export data'],
    ['data.import', 'Import and restore data'],
  ] },
  { name: 'People & security', perms: [
    ['users.view', 'See team members'],
    ['users.manage', 'Add team members, reset passwords, disable accounts'],
    ['roles.manage', 'Create and edit roles'],
    ['audit.view', 'View the activity log'],
  ] },
];
export const ALL_PERMS = PERM_GROUPS.flatMap((g) => g.perms.map(([k]) => k));
const VIEW_PERMS = ALL_PERMS.filter((p) => p.endsWith('.view') || p === 'bills.viewAll');

// ---- Built-in roles (level: higher = more authority) ------------------------------------------
export const BUILTIN_ROLES = [
  { id: 'owner', name: 'Owner', level: 100, builtin: true, description: 'Full control, including ownership and every setting. There is exactly one owner.', perms: ALL_PERMS },
  { id: 'admin', name: 'Administrator', level: 90, builtin: true, description: 'Full access to everything except transferring ownership.', perms: ALL_PERMS },
  { id: 'manager', name: 'Manager', level: 70, builtin: true, description: 'Runs day-to-day work and the team below them: all bills, payments, customers, items, expenses and reports; can add staff.',
    perms: ALL_PERMS.filter((p) => !['data.import', 'roles.manage', 'business.add', 'bills.delete'].includes(p)) },
  { id: 'accountant', name: 'Accountant', level: 50, builtin: true, description: 'Books and compliance: sees all bills, records payments and expenses, runs and exports reports, makes backups.',
    perms: ['bills.view', 'bills.viewAll', 'payments.view', 'payments.record', 'payments.delete', 'customers.view', 'items.view', 'expenses.view', 'expenses.manage', 'reports.view', 'reports.export', 'data.backup', 'audit.view'] },
  { id: 'sales', name: 'Sales / Billing staff', level: 30, builtin: true, description: 'Creates bills and quotations, takes payments and adds customers. Sees only the bills they made.',
    perms: ['bills.view', 'bills.create', 'bills.edit', 'payments.view', 'payments.record', 'customers.view', 'customers.manage', 'items.view'] },
  { id: 'store', name: 'Store / Inventory', level: 30, builtin: true, description: 'Looks after items and stock, and prepares delivery challans.',
    perms: ['bills.view', 'bills.create', 'items.view', 'items.manage', 'customers.view'] },
  { id: 'viewer', name: 'Viewer / Auditor', level: 10, builtin: true, description: 'Read-only access to everything, including reports and the activity log. Cannot change anything.',
    perms: [...VIEW_PERMS, 'audit.view'] },
];

// ---- Current session --------------------------------------------------------------------------
export const session = { user: null, role: null, perms: new Set() };

export async function allRoles() {
  const custom = await db.all('roles');
  return [...BUILTIN_ROLES.map((r) => ({ ...r, ...(custom.find((c) => c.id === r.id) || {}), builtin: true })), ...custom.filter((c) => !BUILTIN_ROLES.some((r) => r.id === c.id))]
    .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}
export async function roleOf(user) {
  return (await allRoles()).find((r) => r.id === user?.roleId) || BUILTIN_ROLES.find((r) => r.id === 'viewer');
}

export async function setSession(user) {
  session.user = user;
  session.role = user ? await roleOf(user) : null;
  session.perms = new Set(user ? (user.roleId === 'owner' ? ALL_PERMS : session.role.perms) : []);
  setActor(user ? user.id : '');
}

// Any of the permissions (pipe-separated) is enough.
export const can = (perm) => String(perm).split('|').some((p) => session.perms.has(p.trim()));
export const isOwner = () => session.user?.roleId === 'owner';
export const level = () => session.role?.level ?? 0;
export const me = () => session.user;

// Businesses this user may open ([] / undefined = all).
export const businessAllowed = (bizId, user = session.user) => !user || !user.businessIds?.length || user.businessIds.includes(bizId);

// Bills: staff without "see others' bills" only see what they created.
export const docVisible = (d) => can('bills.viewAll') || (!!d?.createdBy && d.createdBy === session.user?.id);
export const visibleDocs = (docs) => (can('bills.viewAll') ? docs : docs.filter(docVisible));

// Can the signed-in user manage this person / grant this role?
export function canManageUser(target, targetRole) {
  if (!can('users.manage') || !target || target.id === session.user?.id) return false;
  if (target.roleId === 'owner') return false;
  return isOwner() || (targetRole?.level ?? 0) < level();
}
export function canAssignRole(role) {
  if (!can('users.manage') || role.id === 'owner') return false;
  if (isOwner()) return true;
  return role.level < level() && role.perms.every((p) => session.perms.has(p));
}

// ---- Activity log ------------------------------------------------------------------------------
export async function audit(action, detail = '', extra = {}) {
  try {
    await db.put('audit', { id: uid('log_'), at: new Date().toISOString(), userId: session.user?.id || '', userName: session.user?.name || extra.userName || '',
      username: session.user?.username || extra.username || '', action, detail: String(detail).slice(0, 300), businessId: extra.businessId ?? '' });
  } catch { /* the log must never break the action itself */ }
}
