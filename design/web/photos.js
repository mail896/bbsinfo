(() => {
  'use strict';
  const base = '/bbsinfo/';
  const folder = document.querySelector('[name="folder"]');
  folder?.addEventListener('change', () => {
    const file = folder.files?.[0];
    const form = folder.form;
    const title = form?.elements.namedItem('title');
    if (file?.webkitRelativePath && title && !title.value.trim()) title.value = file.webkitRelativePath.split('/')[0].replace(/[_-]+/g, ' ').slice(0, 200);
  });
  const accepted = (file) => /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) && file.size > 0 && file.size <= 40 * 1024 * 1024;
  async function upload(files, setId, csrf, status) {
    const images = files.filter(accepted);
    const skipped = files.length - images.length;
    if (!images.length || images.length > 300) throw new Error('Bitte 1 bis 300 JPEG-, PNG-, WebP- oder HEIC-Bilder bis 40 MB wählen.');
    for (const [index, file] of images.entries()) {
      status.textContent = `Bild ${index + 1} von ${images.length} wird hochgeladen: ${file.name}${skipped ? ` · ${skipped} andere Dateien ausgelassen` : ''}`;
      const body = new FormData();
      body.set('file', file);
      const modified = new Date(file.lastModified);
      const fileDate = Number.isFinite(modified.getTime()) ? `${modified.getFullYear()}-${String(modified.getMonth() + 1).padStart(2, '0')}-${String(modified.getDate()).padStart(2, '0')}` : '';
      const response = await fetch(`${base}photos/sets/${setId}/upload`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf, 'X-File-Date': fileDate }, body });
      if (!response.ok) throw new Error(`Bild ${file.name} konnte nicht hochgeladen werden. Die bisherigen Bilder bleiben in der Einreichung.`);
      const result = await response.json();
      const date = document.querySelector('[name="eventDate"]');
      if (date && !date.value) {
        date.value = result.capturedDate || fileDate;
      }
    }
  }
  document.querySelector('[data-photo-upload-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector('[data-photo-upload-status]');
    const files = [...(form.elements.namedItem('folder').files || []), ...(form.elements.namedItem('files').files || [])];
    const csrf = form.elements.namedItem('csrf').value;
    const button = form.querySelector('button[type="submit"]');
    let createdId = null;
    button.disabled = true;
    try {
      if (!files.some(accepted) || files.filter(accepted).length > 300) throw new Error('Bitte 1 bis 300 gültige Bilder auswählen.');
      const title = form.elements.namedItem('title').value.trim();
      if (!title) throw new Error('Bitte einen Titel eingeben.');
      const body = new URLSearchParams({ csrf, title, eventDate: form.elements.namedItem('eventDate').value });
      const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!response.ok) throw new Error('Einreichung konnte nicht angelegt werden.');
      const { id } = await response.json();
      createdId = id;
      await upload(files, id, csrf, status);
      location.href = `${base}photos/sets/${id}`;
    } catch (error) {
      status.textContent = error.message;
      if (createdId) {
        const link = document.createElement('a');
        link.href = `${base}photos/sets/${createdId}`;
        link.textContent = 'Einreichung öffnen und fortsetzen';
        status.append(' ', link);
      }
    }
    finally { button.disabled = false; }
  });
  document.querySelector('[data-photo-more-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector('[data-photo-upload-status]');
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await upload([...(form.elements.namedItem('files').files || [])], form.dataset.setId, form.elements.namedItem('csrf').value, status);
      location.reload();
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.addEventListener('keydown', (event) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const link = document.querySelector(`[aria-label="${event.key === 'ArrowLeft' ? 'Vorheriges' : 'Nächstes'} Bild"]`);
      if (link) location.href = link.href;
    }
  });
})();
