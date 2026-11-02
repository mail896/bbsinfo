import { readFile } from 'node:fs/promises';
import { photoFile, receivePhoto, removePhotoFiles, streamPhoto, streamAlbumZip } from './photo-files.mjs';
import { saveSubmissionFile, removeSubmissionFile } from './submission-files.mjs';
import { photoIndexPage, photoMinePage, photoSetPage, photoReviewPage, photoAlbumPage, photoDetailPage, privatePhotoPage, photoCommentHistoryPage } from './photo-pages.mjs';
import { page, base } from './web-pages.mjs';

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const bad = (send, message = 'Bitte Eingaben und Auswahl prüfen.') => send(400, page('Ungültige Eingabe', `<section><h1>Ungültige Eingabe</h1><p>${message}</p></section>`));
const missing = (send) => send(404, page('Nicht gefunden', '<section><h1>Inhalt nicht gefunden</h1></section>'));
const forbidden = (send) => send(403, page('Zugriff verweigert', '<section><h1>Zugriff verweigert</h1></section>'));
const slug = (value) => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'album';
function removeRejectedSoon(store, root) {
  setImmediate(() => { void (async () => {
    for (let batch = 0; batch < 10; batch++) {
      const files = await store.expiredPhotoFiles();
      if (!files.length) break;
      for (const file of files) await store.purgeExpiredPhoto(file.id, (name) => removePhotoFiles(root, name));
    }
  })().catch(() => process.stderr.write('BBS Info: Abgelehnte Fotos konnten nicht bereinigt werden.\n')); });
}
const patterns = {
  set: /^\/bbsinfo\/photos\/sets\/([1-9][0-9]*)$/,
  upload: /^\/bbsinfo\/photos\/sets\/([1-9][0-9]*)\/upload$/,
  album: /^\/bbsinfo\/photos\/albums\/([1-9][0-9]*)$/,
  zip: /^\/bbsinfo\/photos\/albums\/([1-9][0-9]*)\/originale\.zip$/,
  photo: /^\/bbsinfo\/photos\/([1-9][0-9]*)$/,
  preview: /^\/bbsinfo\/photos\/([1-9][0-9]*)\/preview\.webp$/,
  original: /^\/bbsinfo\/photos\/([1-9][0-9]*)\/original$/,
  history: /^\/bbsinfo\/photos\/comments\/([1-9][0-9]*)\/history$/,
};
export async function handlePhotoRoute({ req, res, path, url, identity, csrf, cmsStore, photoRoot, editorImageRoot, send, redirect, readForm, sameToken, origin }) {
  const method = req.method;
  const get = method === 'GET' || method === 'HEAD';
  const store = cmsStore;
  const sendFile = (file, contentType, disposition = null) => {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.size, ...(disposition ? { 'Content-Disposition': disposition } : {}) });
    if (method === 'HEAD') return res.end();
    streamPhoto(res, file);
  };
  if (get) {
    if (path === `${base}photos/`) {
      const query = url.searchParams.get('q') || '';
      if (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) return bad(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, query ? 'photo_album.search' : 'page.view', query ? 'photo_album' : 'page', query ? null : 'photos');
      return send(200, photoIndexPage(await store.listPhotoAlbums(query), query, identity.editor));
    }
    if (path === `${base}photos/mine`) {
      if (method === 'GET') await store.recordAudit(identity.uuid, 'page.view', 'page', 'photos.mine');
      return send(200, photoMinePage(await store.listOwnPhotoSets(identity.uuid), csrf));
    }
    if (path === `${base}photos/review`) {
      if (!identity.editor) return forbidden(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'page.view', 'page', 'photos.review');
      return send(200, photoReviewPage(await store.listPendingPhotoSets()));
    }
    if (path === `${base}photos/picker`) {
      if (!identity.editor) return forbidden(send);
      const query = url.searchParams.get('q') || '';
      if (query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) return bad(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'photo.picker_search', 'photo');
      return json(res, 200, (await store.listPublishedPhotos(query)).map((photo) => ({ id: photo.id, originalName: photo.originalName, uploaderName: photo.uploaderName || 'Unbekannt' })));
    }
    let match;
    if ((match = patterns.history.exec(path))) {
      if (!identity.auditOwner) return forbidden(send);
      const rows = await store.getPhotoCommentHistory(match[1]);
      if (!rows.length) return missing(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'photo_comment.history_view', 'photo_comment', match[1]);
      return send(200, photoCommentHistoryPage(match[1], rows));
    }
    if ((match = patterns.set.exec(path))) {
      const set = await store.getPhotoSet(identity.uuid, match[1], identity.editor);
      if (!set) return missing(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'photo_set.view', 'photo_set', set.id);
      return send(200, photoSetPage(set, csrf, identity.editor, set.ownerUuid === identity.uuid, identity.editor ? await store.listPhotoAlbums() : []));
    }
    if ((match = patterns.album.exec(path))) {
      const album = await store.getPhotoAlbum(match[1]);
      if (!album) return missing(send);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'photo_album.visit', 'photo_album', album.id, album.title);
      return send(200, photoAlbumPage(album, csrf, identity.editor));
    }
    if ((match = patterns.zip.exec(path))) {
      const album = await store.getPhotoAlbum(match[1]);
      if (!album) return missing(send);
      for (const photo of album.photos) photoFile(photoRoot, photo.storedName);
      if (method === 'GET') await store.recordAudit(identity.uuid, 'photo_album.zip', 'photo_album', album.id, album.title);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="bbs-info_${slug(album.title)}.zip"` });
      if (method === 'HEAD') return res.end();
      return streamAlbumZip(res, photoRoot, album, album.photos);
    }
    if ((match = patterns.preview.exec(path)) || (match = patterns.original.exec(path))) {
      const photo = await store.getPhotoAsset(identity.uuid, match[1], identity.editor);
      if (!photo) return missing(send);
      const preview = path.endsWith('.webp');
      const file = photoFile(photoRoot, photo.storedName, preview);
      if (!preview && method === 'GET') await store.recordAudit(identity.uuid, 'photo.original', 'photo', photo.id);
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[photo.mediaType];
      return sendFile(file, preview ? 'image/webp' : photo.mediaType, preview ? null : `attachment; filename="bbs-info-foto-${photo.id}.${extension}"`);
    }
    if ((match = patterns.photo.exec(path))) {
      const photo = await store.getPhotoAsset(identity.uuid, match[1], identity.editor);
      if (!photo) return missing(send);
      if (photo.status !== 'published') return send(200, privatePhotoPage(photo));
      const album = await store.getPhotoAlbum(photo.albumId);
      if (!album) return missing(send);
      return send(200, photoDetailPage(photo, album, await store.getPhotoComments(photo.id), csrf, identity));
    }
    return missing(send);
  }
  if (method !== 'POST' || req.headers.origin !== origin) return forbidden(send);
  const upload = patterns.upload.exec(path);
  if (upload) {
    if (!sameToken(req.headers['x-csrf-token'], csrf)) return forbidden(send);
    const set = await store.getPhotoSet(identity.uuid, upload[1], false);
    if (!set || set.status !== 'open') return missing(send);
    let file;
    try { file = await receivePhoto(req, photoRoot); }
    catch (error) {
      if (error.message === 'Foto-Speicher derzeit voll.') return send(507, page('Foto-Upload pausiert', '<section><h1>Foto-Upload zurzeit nicht möglich</h1><p>Bitte die Administration informieren.</p></section>'));
      return bad(send, 'Bitte ein gültiges JPEG-, PNG-, WebP- oder HEIC-Bild bis 40 MB wählen.');
    }
    file.eventDateFallback = req.headers['x-file-date'] || null;
    try {
      const photoId = await store.addPhoto(identity.uuid, set.id, file);
      if (!photoId) { await removePhotoFiles(photoRoot, file.storedName); return missing(send); }
      return json(res, 201, { id: photoId, capturedDate: file.capturedDate });
    } catch (error) {
      await removePhotoFiles(photoRoot, file.storedName);
      if (/Ungültig|zu groß/.test(error.message)) return bad(send);
      throw error;
    }
  }
  const form = await readForm(req, path === `${base}photos/sets/review` ? 24000 : 8000);
  if (!sameToken(form.get('csrf'), csrf)) return forbidden(send);
  try {
    if (path === `${base}photos/sets/create`) {
      const setId = await store.createPhotoSet(identity.uuid, form.get('title'), form.get('eventDate'));
      return json(res, 201, { id: setId });
    }
    if (path === `${base}photos/sets/submit`) {
      if (!(await store.submitPhotoSet(identity.uuid, form.get('id'), form.get('title'), form.get('eventDate'), form.get('rights')))) return missing(send);
      return redirect(`${base}photos/mine`, 'Fotoeinreichung an die Redaktion gesendet.');
    }
    if (path === `${base}photos/sets/cancel`) {
      if (form.get('confirm') !== 'yes') return bad(send);
      if (!(await store.cancelPhotoSet(identity.uuid, form.get('id')))) return missing(send);
      removeRejectedSoon(store, photoRoot);
      return redirect(`${base}photos/mine`, 'Nicht eingereichte Sammlung verworfen.');
    }
    if (path === `${base}photos/sets/review`) {
      if (!identity.editor) return forbidden(send);
      const albumId = await store.reviewPhotoSet(identity.uuid, form.get('id'), form.getAll('photoId'), form.get('albumId'), form.get('title'), form.get('eventDate'), form.get('description'));
      if (albumId === null) return missing(send);
      removeRejectedSoon(store, photoRoot);
      return redirect(albumId ? `${base}photos/albums/${albumId}` : `${base}photos/review`, 'Fotoeinreichung gesichtet.');
    }
    if (path === `${base}photos/albums/edit`) {
      if (!identity.editor) return forbidden(send);
      if (!(await store.editPhotoAlbum(identity.uuid, form.get('id'), form.get('title'), form.get('eventDate'), form.get('description')))) return missing(send);
      return redirect(`${base}photos/albums/${form.get('id')}`, 'Album geändert.');
    }
    if (path === `${base}photos/albums/delete`) {
      if (!identity.editor) return forbidden(send);
      if (form.get('confirm') !== 'yes') return bad(send);
      if (!(await store.deletePhotoAlbum(identity.uuid, form.get('id')))) return missing(send);
      return redirect(`${base}photos/`, 'Album gelöscht.');
    }
    if (path === `${base}photos/delete`) {
      if (!identity.editor) return forbidden(send);
      if (form.get('confirm') !== 'yes') return bad(send);
      const photo = await store.getPhotoAsset(identity.uuid, form.get('id'), true);
      if (!photo || photo.status !== 'published' || !(await store.deletePublishedPhoto(identity.uuid, photo.id))) return missing(send);
      return redirect(`${base}photos/albums/${photo.albumId}`, 'Bild gelöscht.');
    }
    if (path === `${base}photos/date-edit`) {
      if (!identity.editor) return forbidden(send);
      if (!(await store.editPhotoDate(identity.uuid, form.get('id'), form.get('capturedDate')))) return missing(send);
      return redirect(`${base}photos/${form.get('id')}`, 'Aufnahmedatum geändert.');
    }
    if (path === `${base}photos/comments/add`) {
      const photo = await store.getPhotoAsset(identity.uuid, form.get('photoId'), identity.editor);
      if (!photo || photo.status !== 'published') return missing(send);
      if (!(await store.addPhotoComment(identity.uuid, photo.id, form.get('body')))) return missing(send);
      return redirect(`${base}photos/${photo.id}`, 'Kommentar gespeichert.');
    }
    if (path === `${base}photos/comments/edit` || path === `${base}photos/comments/delete`) {
      const photo = await store.getPhotoAsset(identity.uuid, form.get('photoId'), identity.editor);
      if (!photo || photo.status !== 'published') return missing(send);
      const done = path.endsWith('/edit') ? await store.editPhotoComment(identity.uuid, form.get('id'), photo.id, form.get('body')) : await store.deletePhotoComment(identity.uuid, form.get('id'), photo.id, identity.editor);
      if (!done) return missing(send);
      return redirect(`${base}photos/${photo.id}`, 'Kommentar geändert.');
    }
    if (path === `${base}photos/issue-image`) {
      if (!identity.editor || !editorImageRoot) return forbidden(send);
      const photo = await store.getPhotoAsset(identity.uuid, form.get('id'), true);
      if (!photo || photo.status !== 'published') return missing(send);
      const preview = await readFile(photoFile(photoRoot, photo.storedName, true).path);
      const storedName = await saveSubmissionFile(editorImageRoot, preview);
      try {
        if (!(await store.createPhotoIssueImage(identity.uuid, photo.id, storedName, preview.length))) { await removeSubmissionFile(editorImageRoot, storedName); return missing(send); }
      } catch (error) { await removeSubmissionFile(editorImageRoot, storedName); throw error; }
      return json(res, 201, { url: `${base}editor-images/${storedName}`, alt: `${photo.originalName} · ${photo.uploaderName || 'Unbekannt'}` });
    }
  } catch (error) {
    if (error.message === 'Zu viele offene Fotoeinreichungen.') return bad(send, 'Bitte zuerst eine offene Fotoeinreichung abschließen oder verwerfen.');
    if (/Ungültig|fehlt|zu groß|Doppelte|nicht gefunden|Fotoeinreichung/.test(error.message)) return bad(send);
    throw error;
  }
  return missing(send);
}
