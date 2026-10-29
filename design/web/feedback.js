const toast = document.querySelector('[data-feedback]');
if (toast) {
  let removeTimer;
  const dismiss = () => {
    clearTimeout(removeTimer);
    toast.classList.remove('is-visible');
    removeTimer = setTimeout(() => toast.remove(), 350);
  };
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  removeTimer = setTimeout(dismiss, 6000);
  toast.querySelector('[data-feedback-close]')?.addEventListener('click', dismiss);
}

const deleteForms = document.querySelectorAll('form[data-confirm-delete]');
if (deleteForms.length) {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirm-dialog';
  dialog.innerHTML = '<div class="confirm-dialog-body"><span class="confirm-dialog-mark" aria-hidden="true">×</span><h2>In den Papierkorb verschieben</h2><p data-confirm-question></p><p class="confirm-dialog-note" data-confirm-note></p><div class="confirm-dialog-actions"><button type="button" class="secondary" data-confirm-cancel>Abbrechen</button><button type="button" class="confirm-danger" data-confirm-accept>In den Papierkorb</button></div></div>';
  document.body.append(dialog);
  let pendingForm = null;
  deleteForms.forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (form.dataset.confirmed === '1') {
        delete form.dataset.confirmed;
        return;
      }
      event.preventDefault();
      pendingForm = form;
      const kind = form.dataset.confirmKind || 'Eintrag';
      dialog.querySelector('[data-confirm-question]').textContent = `${kind} „${form.dataset.confirmDelete}“ in den Papierkorb verschieben?`;
      dialog.querySelector('[data-confirm-note]').textContent = kind === 'Ausgabe' ? 'Die Nummer bleibt 30 Tage reserviert. Eine bereits angekündigte Ausgabe kann nicht verschoben werden.' : 'Du kannst den Inhalt 30 Tage lang wiederherstellen.';
      dialog.showModal();
      dialog.querySelector('[data-confirm-cancel]').focus();
    });
  });
  dialog.querySelector('[data-confirm-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-confirm-accept]').addEventListener('click', () => {
    const form = pendingForm;
    if (!form) return;
    form.querySelector('input[name="confirm"]').value = form.dataset.confirmId;
    form.dataset.confirmed = '1';
    pendingForm = null;
    dialog.close();
    form.requestSubmit();
  });
  dialog.addEventListener('close', () => { pendingForm = null; });
}
