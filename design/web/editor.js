(() => {
  'use strict';
  const editors = new Map();
  const options = {
    language: 'de',
    height: 320,
    toolbarAdaptive: true,
    toolbarInlineDisableFor: ['img'],
    imageDefaultWidth: 420,
    buttons: ['undo', 'redo', '|', 'bold', 'italic', 'underline', 'strikethrough', '|', 'paragraph', 'fontsize', 'brush', '|', 'ul', 'ol', 'outdent', 'indent', '|', 'align', 'link', 'table', 'hr', '|', 'eraser', 'fullsize'],
    buttonsMD: ['undo', 'redo', '|', 'bold', 'italic', 'underline', '|', 'paragraph', 'fontsize', 'brush', '|', 'ul', 'ol', '|', 'align', 'link', 'table', '|', 'eraser', 'fullsize'],
    buttonsSM: ['undo', 'redo', '|', 'bold', 'italic', '|', 'paragraph', 'ul', 'ol', 'link', 'table', 'eraser'],
    disablePlugins: ['file', 'image', 'video', 'source', 'iframe', 'speech-recognize'],
    uploader: { insertImageAsBase64URI: false },
    askBeforePasteFromWord: true,
    defaultActionOnPasteFromWord: 'insert_clear_html',
  };

  function activate(textarea) {
    if (editors.has(textarea.id) || !window.Jodit) return;
    const editor = window.Jodit.make(textarea, options);
    editors.set(textarea.id, editor);
    const workplace = editor.container.querySelector('.jodit-workplace');
    if (workplace) {
      const controls = document.createElement('div');
      controls.className = 'editor-image-controls';
      controls.hidden = true;
      controls.innerHTML = '<label>Bildbreite (px) <input type="number" min="50" max="1200" step="10"></label><button type="button" class="secondary" data-image-size>Übernehmen</button><button type="button" class="secondary" data-image-properties>Eigenschaften</button><button type="button" class="secondary" data-image-remove>Entfernen</button>';
      workplace.before(controls);
      let selectedImage = null;
      const width = controls.querySelector('input');
      editor.editor.addEventListener('click', (event) => {
        selectedImage = event.target.closest('img');
        controls.hidden = !selectedImage;
        if (selectedImage) width.value = Math.round(selectedImage.getBoundingClientRect().width);
      });
      controls.querySelector('[data-image-size]').addEventListener('click', () => {
        const pixels = Number(width.value);
        if (!selectedImage || !Number.isInteger(pixels) || pixels < 50 || pixels > 1200) return;
        selectedImage.style.width = `${pixels}px`;
        selectedImage.style.height = 'auto';
        selectedImage.removeAttribute('width');
        selectedImage.removeAttribute('height');
        editor.synchronizeValues();
      });
      controls.querySelector('[data-image-properties]').addEventListener('click', () => {
        if (selectedImage) editor.e.fire('openImageProperties', selectedImage);
      });
      controls.querySelector('[data-image-remove]').addEventListener('click', () => {
        if (!selectedImage) return;
        selectedImage.remove();
        selectedImage = null;
        controls.hidden = true;
        editor.synchronizeValues();
      });
    }
    textarea.form?.addEventListener('submit', () => { textarea.value = editor.value; });
  }

  document.querySelectorAll('textarea[data-rich-editor]').forEach((textarea) => {
    const details = textarea.closest('details');
    if (!details || details.open) activate(textarea);
    else details.addEventListener('toggle', () => { if (details.open) activate(textarea); });
  });

  document.querySelectorAll('[data-insert-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.insertTemplate;
      const selector = document.getElementById(`picker-${id}`);
      const source = document.getElementById(`template-${selector?.value || ''}`);
      if (!source) return;
      const textarea = document.getElementById(id);
      const editor = editors.get(id);
      if (editor) {
        editor.s.insertHTML(source.innerHTML);
        editor.focus();
      } else if (textarea) {
        textarea.value += source.innerHTML;
        textarea.focus();
      }
      selector.value = '';
    });
  });

  document.querySelectorAll('[data-image-editor]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const status = input.parentElement.querySelector('.image-upload-status');
      const textarea = document.getElementById(input.dataset.imageEditor);
      const csrf = textarea?.form?.querySelector('input[name="csrf"]')?.value;
      if (!textarea || !csrf || file.size > 3 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        status.textContent = 'Bitte JPEG, PNG oder WebP bis 3 MB wählen.';
        input.value = '';
        return;
      }
      status.textContent = 'Bild wird hochgeladen …';
      input.disabled = true;
      try {
        const body = new FormData();
        body.set('csrf', csrf);
        body.set('title', file.name.slice(0, 200) || 'Bild');
        body.set('file', file);
        const response = await fetch('/bbsinfo/editor/images/upload', { method: 'POST', body, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Upload fehlgeschlagen');
        const result = await response.json();
        if (!/^\/bbsinfo\/editor-images\/[0-9a-f-]{36}$/.test(result.url)) throw new Error('Ungültige Antwort');
        const image = document.createElement('img');
        image.src = result.url;
        image.alt = file.name.replace(/\.[^.]+$/, '').slice(0, 200);
        image.style.width = '420px';
        image.style.height = 'auto';
        const editor = editors.get(textarea.id);
        if (editor) { editor.s.insertHTML(image.outerHTML); editor.focus(); }
        else { textarea.value += image.outerHTML; textarea.focus(); }
        status.textContent = 'Bild eingefügt. Bitte den Beitrag speichern.';
      } catch {
        status.textContent = 'Bild konnte nicht eingefügt werden. Bitte erneut versuchen.';
      } finally {
        input.value = '';
        input.disabled = false;
      }
    });
  });

  const sourceFields = { updates: 'updateId', contributions: 'contributionId', submissions: 'submissionId' };
  const sourceEmpty = { updates: 'Keine Updates gefunden.', contributions: 'Keine Beiträge gefunden.', submissions: 'Keine Steckbriefe gefunden.' };
  const dateTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function sourceLabel(kind, item) {
    if (kind === 'updates') {
      const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.publishedAtUtc || '') ? dateTime.format(new Date(`${item.publishedAtUtc.replace(' ', 'T')}Z`)).replace(',', '') : '';
      return `${item.title}${time ? ` · ${time}` : ''}`;
    }
    if (kind === 'contributions') return `${item.title} · von ${item.author || 'Name noch nicht erfasst'}`;
    return `${item.title} · ${item.ownerName || 'Name noch nicht erfasst'}`;
  }

  function sourceRow(kind, item, used) {
    const row = document.createElement('div');
    row.className = 'issue-source-row';
    row.dataset.issueSourceRow = String(item.id);
    row.dataset.sourceUsed = used ? '1' : '0';
    const label = document.createElement('label');
    label.className = 'choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = sourceFields[kind];
    checkbox.value = String(item.id);
    label.append(checkbox, document.createTextNode(` ${sourceLabel(kind, item)}`));
    row.append(label);
    if (used) {
      const numbers = String(item.usedInIssues || '').split(',').filter((number) => /^[1-9][0-9]*$/.test(number)).join(', ');
      if (numbers) {
        const reference = document.createElement('span');
        reference.className = 'issue-source-reference';
        reference.textContent = `BBS Info ${numbers}`;
        row.append(reference);
      }
    }
    return row;
  }

  document.querySelectorAll('[data-issue-source]').forEach((root) => {
    const kind = root.dataset.issueSource;
    if (!Object.hasOwn(sourceFields, kind)) return;
    const search = root.querySelector('[data-issue-source-search]');
    const selectedArea = root.querySelector('[data-issue-source-selected]');
    const usedDetails = root.querySelector('.issue-source-used');
    const status = root.querySelector('[data-issue-source-status]');
    const areas = {
      fresh: root.querySelector('[data-issue-source-results="fresh"]'),
      used: root.querySelector('[data-issue-source-results="used"]'),
    };
    const buttons = {
      fresh: root.querySelector('[data-issue-source-more="fresh"]'),
      used: root.querySelector('[data-issue-source-more="used"]'),
    };
    const selected = new Map();
    selectedArea.querySelectorAll('input[type="checkbox"]:checked').forEach((input) => selected.set(input.value, input.closest('.issue-source-row')));
    const state = {
      fresh: { page: 1, hasMore: !buttons.fresh.hidden, token: 0 },
      used: { page: 1, hasMore: !buttons.used.hidden, token: 0 },
    };
    let currentQuery = '';
    let debounce = null;
    const failedModes = new Set();

    async function load(mode, page, replace) {
      const bucket = state[mode];
      const token = ++bucket.token;
      const button = buttons[mode];
      button.disabled = true;
      if (replace) {
        areas[mode].replaceChildren();
        bucket.page = 1;
        bucket.hasMore = false;
        button.hidden = true;
        if (mode === 'used') usedDetails.hidden = true;
      }
      try {
        const params = new URLSearchParams({ kind, used: mode === 'used' ? '1' : '0', page: String(page), q: currentQuery });
        const response = await fetch(`/bbsinfo/editor/issue-sources?${params}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Suche fehlgeschlagen');
        const result = await response.json();
        if (!Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || result.items.length > 30) throw new Error('Ungültige Antwort');
        if (token !== bucket.token) return;
        if (!replace) areas[mode].querySelector('[data-issue-source-empty]')?.remove();
        for (const item of result.items) {
          if (!Number.isSafeInteger(item.id) || item.id < 1 || typeof item.title !== 'string' || selected.has(String(item.id))) continue;
          areas[mode].append(sourceRow(kind, item, mode === 'used'));
        }
        if (!areas[mode].children.length && page === 1) {
          const empty = document.createElement('p');
          empty.className = 'meta';
          empty.dataset.issueSourceEmpty = '';
          empty.textContent = sourceEmpty[kind];
          areas[mode].append(empty);
        }
        bucket.page = page;
        bucket.hasMore = result.hasMore;
        button.hidden = !result.hasMore;
        if (mode === 'used') {
          usedDetails.hidden = !areas.used.querySelector('.issue-source-row') && !result.hasMore;
          if (replace) usedDetails.open = !!currentQuery && !usedDetails.hidden;
        }
        if (failedModes.delete(mode) && !failedModes.size) status.textContent = '';
      } catch {
        if (token === bucket.token) {
          failedModes.add(mode);
          status.textContent = 'Auswahl gerade nicht verfügbar. Bitte erneut suchen.';
        }
      } finally {
        if (token === bucket.token) button.disabled = false;
      }
    }

    function refresh() {
      currentQuery = search.value.trim();
      failedModes.clear();
      status.textContent = '';
      void Promise.all([load('fresh', 1, true), load('used', 1, true)]);
    }

    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 250);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      clearTimeout(debounce);
      refresh();
    });
    for (const mode of ['fresh', 'used']) buttons[mode].addEventListener('click', () => {
      if (state[mode].hasMore && !buttons[mode].disabled) void load(mode, state[mode].page + 1, false);
    });
    root.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox' || input.name !== sourceFields[kind]) return;
      const row = input.closest('.issue-source-row');
      if (!row) return;
      if (input.checked) {
        if (selected.size >= 50) {
          input.checked = false;
          status.textContent = 'Höchstens 50 Inhalte pro Gruppe auswählen.';
          return;
        }
        selected.set(input.value, row);
        row.dataset.sourceUsed = row.closest('[data-issue-source-results="used"]') || row.querySelector('.issue-source-reference') ? '1' : '0';
        selectedArea.hidden = false;
        selectedArea.append(row);
        status.textContent = '';
      } else if (selected.delete(input.value)) {
        const mode = row.dataset.sourceUsed === '1' ? 'used' : 'fresh';
        if (!currentQuery || row.textContent.toLocaleLowerCase('de').includes(currentQuery.toLocaleLowerCase('de'))) {
          areas[mode].prepend(row);
          if (mode === 'used') usedDetails.hidden = false;
        } else row.remove();
        selectedArea.hidden = selected.size === 0;
      }
    });
  });

})();
