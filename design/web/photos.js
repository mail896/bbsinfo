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
  function sendFile(setId, csrf, fileDate, body, onProgress, onProcessing) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${base}photos/sets/${setId}/upload`);
      request.setRequestHeader('X-CSRF-Token', csrf);
      request.setRequestHeader('X-File-Date', fileDate);
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
      request.upload.addEventListener('load', onProcessing);
      request.addEventListener('load', () => {
        if (request.status !== 201) return reject(new Error('Upload fehlgeschlagen. Die bereits hochgeladenen Bilder bleiben in der Einreichung.'));
        try { resolve(JSON.parse(request.responseText)); }
        catch { reject(new Error('Antwort des Servers konnte nicht gelesen werden.')); }
      });
      request.addEventListener('error', () => reject(new Error('Verbindung beim Hochladen unterbrochen. Die bereits hochgeladenen Bilder bleiben in der Einreichung.')));
      request.addEventListener('abort', () => reject(new Error('Upload abgebrochen.')));
      request.send(body);
    });
  }
  async function upload(files, setId, csrf, status, progress) {
    const images = files.filter(accepted);
    const skipped = files.length - images.length;
    if (!images.length || images.length > 300) throw new Error('Bitte 1 bis 300 JPEG-, PNG-, WebP- oder HEIC-Bilder bis 40 MB wählen.');
    const totalBytes = images.reduce((sum, file) => sum + file.size, 0);
    const bar = progress.querySelector('progress');
    const percent = progress.querySelector('output');
    let completedBytes = 0;
    progress.hidden = false;
    const showProgress = (current = 0, finished = false) => {
      const value = finished ? 100 : Math.min(99, Math.floor((completedBytes + current) * 100 / totalBytes));
      bar.value = value;
      percent.textContent = `${value} %`;
    };
    showProgress();
    for (const [index, file] of images.entries()) {
      status.textContent = `Bild ${index + 1} von ${images.length} wird hochgeladen: ${file.name}${skipped ? ` · ${skipped} andere Dateien ausgelassen` : ''}`;
      const body = new FormData();
      body.set('file', file);
      const modified = new Date(file.lastModified);
      const fileDate = Number.isFinite(modified.getTime()) ? `${modified.getFullYear()}-${String(modified.getMonth() + 1).padStart(2, '0')}-${String(modified.getDate()).padStart(2, '0')}` : '';
      const result = await sendFile(setId, csrf, fileDate, body,
        (fraction) => showProgress(file.size * Math.min(1, fraction)),
        () => { status.textContent = `Bild ${index + 1} von ${images.length} wird verarbeitet: ${file.name}`; });
      completedBytes += file.size;
      showProgress(0, index === images.length - 1);
      const date = document.querySelector('[name="eventDate"]');
      if (date && !date.value) {
        date.value = result.capturedDate || fileDate;
      }
    }
    status.textContent = `${images.length} Bilder vollständig hochgeladen${skipped ? ` · ${skipped} andere Dateien ausgelassen` : ''}.`;
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
      await upload(files, id, csrf, status, form.querySelector('[data-photo-upload-progress]'));
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
      await upload([...(form.elements.namedItem('files').files || [])], form.dataset.setId, form.elements.namedItem('csrf').value, status, form.querySelector('[data-photo-upload-progress]'));
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
