import { h } from './ui.js';

// Modal dialogs built on <dialog>. They resolve to the entered values, or null
// when cancelled, instead of blocking the page like window.prompt/confirm.

// fields: [{ name, label, type: 'text' | 'select', value, placeholder, options: [{value, label}], hint }]
export function formDialog({ title, message, fields = [], okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const fieldEls = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name },
          f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value || null }, o.label)));
      } else {
        input = h('input', { type: 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder, autocomplete: 'off', spellcheck: 'false' });
      }
      inputs[f.name] = input;
      return h('label', { class: 'field' },
        h('span', { class: 'field-label' }, f.label),
        input,
        f.hint ? h('span', { class: 'field-hint' }, f.hint) : null);
    });

    const error = h('div', { class: 'error', role: 'alert' });
    const cancel = h('button', { type: 'button', value: 'cancel' }, 'Cancel');
    const ok = h('button', { type: 'submit', class: danger ? 'danger' : 'primary' }, okLabel);
    const form = h('form', { method: 'dialog' },
      h('h2', {}, title),
      message ? h('p', { class: 'dialog-message' }, message) : null,
      fieldEls,
      error,
      h('div', { class: 'dialog-buttons' }, cancel, ok));
    const dialog = h('dialog', { class: 'dialog' }, form);

    let result = null;
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));

    form.addEventListener('submit', (e) => {
      const firstText = fields.find((f) => f.type !== 'select' && f.required);
      if (firstText && !inputs[firstText.name].value.trim()) {
        e.preventDefault();
        error.textContent = `${firstText.label} is required.`;
        inputs[firstText.name].focus();
        return;
      }
      result = values();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.append(dialog);
    dialog.showModal();
    const first = fields.length ? inputs[fields[0].name] : ok;
    first.focus();
    if (first.select) first.select();
  });
}

export async function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  return (await formDialog({ title, message, okLabel, danger })) !== null;
}

export async function promptDialog({ title, label, value = '', okLabel = 'OK', hint }) {
  const res = await formDialog({ title, okLabel, fields: [{ name: 'value', label, value, hint, required: true }] });
  return res ? res.value.trim() : null;
}
