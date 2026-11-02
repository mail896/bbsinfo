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
  const reviewForm = document.querySelector('[data-photo-review-form]');
  if (reviewForm) {
    const album = reviewForm.elements.namedItem('albumId');
    const newAlbumFields = reviewForm.querySelector('[data-photo-new-album-fields]');
    const existingAlbumNote = reviewForm.querySelector('[data-photo-existing-album-note]');
    const syncAlbumChoice = () => {
      const creatingAlbum = !album.value;
      newAlbumFields.hidden = !creatingAlbum;
      existingAlbumNote.hidden = creatingAlbum;
      for (const field of newAlbumFields.querySelectorAll('input, textarea')) field.disabled = !creatingAlbum;
    };
    album.addEventListener('change', syncAlbumChoice);
    if (typeof window !== 'undefined') window.addEventListener('pageshow', syncAlbumChoice);
    syncAlbumChoice();
  }
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
        if (request.status !== 201 && request.status !== 200) return reject(new Error('Upload fehlgeschlagen. Die bereits hochgeladenen Bilder bleiben in der Einreichung.'));
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
    let duplicates = 0;
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
      if (result.duplicate) duplicates++;
      showProgress(0, index === images.length - 1);
      const date = document.querySelector('[name="eventDate"]');
      if (date && !date.value) {
        date.value = result.capturedDate || fileDate;
      }
    }
    status.textContent = `${images.length - duplicates} Bilder vollständig hochgeladen${duplicates ? ` · ${duplicates} bereits vorhandene übersprungen` : ''}${skipped ? ` · ${skipped} andere Dateien ausgelassen` : ''}.`;
  }
  async function missingFiles(files, setId, csrf, status) {
    const images = files.filter(accepted);
    if (!images.length || images.length > 300) throw new Error('Bitte 1 bis 300 JPEG-, PNG-, WebP- oder HEIC-Bilder bis 40 MB wählen.');
    status.textContent = 'Bereits hochgeladene Bilder werden geprüft …';
    const body = new URLSearchParams({ csrf });
    for (const size of new Set(images.map((file) => file.size))) body.append('size', String(size));
    const response = await fetch(`${base}photos/sets/${setId}/resume-check`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error('Vorhandene Bilder konnten nicht geprüft werden. Bitte später erneut versuchen.');
    const { entries } = await response.json();
    const known = new Map();
    for (const entry of entries) {
      if (!known.has(entry.size)) known.set(entry.size, new Set());
      known.get(entry.size).add(entry.sha256);
    }
    const counts = new Map();
    for (const file of images) counts.set(file.size, (counts.get(file.size) || 0) + 1);
    const selected = new Map();
    const remaining = [];
    let skipped = 0;
    for (const [index, file] of images.entries()) {
      if (!known.has(file.size) && counts.get(file.size) === 1) { remaining.push(file); continue; }
      status.textContent = `Bild ${index + 1} von ${images.length} wird abgeglichen: ${file.name}`;
      const bytes = await file.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (known.get(file.size)?.has(digest) || selected.get(file.size)?.has(digest)) { skipped++; continue; }
      if (!selected.has(file.size)) selected.set(file.size, new Set());
      selected.get(file.size).add(digest);
      remaining.push(file);
    }
    return { remaining, skipped };
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
      const files = [...(form.elements.namedItem('folder').files || []), ...(form.elements.namedItem('files').files || [])];
      const csrf = form.elements.namedItem('csrf').value;
      const { remaining, skipped } = await missingFiles(files, form.dataset.setId, csrf, status);
      if (!remaining.length) { status.textContent = `Alle ${skipped} ausgewählten Bilder sind bereits in dieser Einreichung.`; return; }
      status.textContent = `${skipped} vorhandene Bilder übersprungen · ${remaining.length} werden hochgeladen.`;
      await upload(remaining, form.dataset.setId, csrf, status, form.querySelector('[data-photo-upload-progress]'));
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
