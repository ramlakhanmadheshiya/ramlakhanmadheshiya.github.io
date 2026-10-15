import { db } from './db.js';
import { BUILTIN_TEMPLATES, builtinById } from './templates.js';
import { state } from './store.js';

export async function allTemplates() {
  const custom = await db.all('templates', state.business.id);
  return [...BUILTIN_TEMPLATES, ...custom.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))];
}

export async function getTemplate(id) {
  if (!id) return null;
  return builtinById(id) || (await db.get('templates', id)) || null;
}

export function defaultTemplateId(type, business = state.business) {
  return business.defaultTemplates?.[type] || business.defaultTemplates?.all || (business.country === 'IN' ? 'tpl-classic' : 'tpl-cupertino');
}

// Template for a document, honouring business accent colour on built-ins.
export async function templateFor(doc, business = state.business) {
  const t = (await getTemplate(doc.templateId)) || (await getTemplate(defaultTemplateId(doc.type, business))) || BUILTIN_TEMPLATES[0];
  return t;
}
