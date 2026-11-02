const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const id = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 4294967295) throw new Error('Ungültige Foto-ID.');
  return number;
};
const actor = (value) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Ungültige IServ-UUID.');
  return value.toLowerCase();
};
function title(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Ungültiger Titel.');
  return text;
}
function date(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Ungültiges Aufnahmedatum.');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Ungültiges Aufnahmedatum.');
  return value;
}
function note(value, max = 1000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Ungültiger Text.');
  return text;
}
function originalName(value) {
  const text = typeof value === 'string' ? value.split(/[\\/]/).pop()?.trim() : '';
  if (!text || text.length > 255 || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Ungültiger Dateiname.');
  return text;
}
const photoSelect = "SELECT a.id, a.set_id AS setId, a.album_id AS albumId, a.uploader_uuid AS uploaderUuid, u.display_name AS uploaderName, a.stored_name AS storedName, a.original_name AS originalName, a.media_type AS mediaType, a.byte_size AS byteSize, DATE_FORMAT(a.captured_date, '%Y-%m-%d') AS capturedDate, a.sequence_number AS sequenceNumber, a.status FROM photo_assets a LEFT JOIN iserv_identities u ON u.user_uuid = a.uploader_uuid";

export function photoStoreMethods(pool, transact, audit, writeAudit) {
  return {
    async createPhotoSet(user, name, eventDate) {
      const uuid = actor(user), label = title(name), day = date(eventDate);
      return transact(async (conn) => {
        const active = await conn.query("SELECT COUNT(*) AS n FROM photo_sets WHERE owner_uuid = ? AND status IN ('open','submitted')", [uuid]);
        if (Number(active[0].n) >= 5) throw new Error('Zu viele offene Fotoeinreichungen.');
        const result = await conn.query('INSERT INTO photo_sets (owner_uuid, title, event_date) VALUES (?, ?, ?)', [uuid, label, day]);
        await audit(conn, uuid, 'photo_set.create', 'photo_set', result.insertId, label);
        return Number(result.insertId);
      }, true);
    },
    async listOwnPhotoSets(user) {
      return pool.query("SELECT s.id, s.title, DATE_FORMAT(s.event_date, '%Y-%m-%d') AS eventDate, s.status, COUNT(a.id) AS photoCount FROM photo_sets s LEFT JOIN photo_assets a ON a.set_id = s.id AND a.status IN ('private','published') WHERE s.owner_uuid = ? GROUP BY s.id ORDER BY s.id DESC LIMIT 100", [actor(user)]);
    },
    async listPendingPhotoSets() {
      return pool.query("SELECT s.id, s.title, DATE_FORMAT(s.event_date, '%Y-%m-%d') AS eventDate, s.submitted_at AS submittedAt, u.display_name AS ownerName, COUNT(a.id) AS photoCount FROM photo_sets s LEFT JOIN photo_assets a ON a.set_id = s.id AND a.status = 'private' LEFT JOIN iserv_identities u ON u.user_uuid = s.owner_uuid WHERE s.status = 'submitted' GROUP BY s.id ORDER BY s.submitted_at, s.id LIMIT 100");
    },
    async getPhotoSet(user, setId, editor = false) {
      const uuid = actor(user), number = id(setId);
      const rows = await pool.query("SELECT s.id, s.owner_uuid AS ownerUuid, u.display_name AS ownerName, s.title, DATE_FORMAT(s.event_date, '%Y-%m-%d') AS eventDate, s.status, s.rights_confirmed_at AS rightsConfirmedAt FROM photo_sets s LEFT JOIN iserv_identities u ON u.user_uuid = s.owner_uuid WHERE s.id = ?", [number]);
      if (!rows.length || (rows[0].ownerUuid !== uuid && (!editor || rows[0].status === 'open'))) return null;
      const photos = await pool.query(`${photoSelect} WHERE a.set_id = ? AND a.status IN ('private','published') ORDER BY a.id`, [number]);
      return { ...rows[0], photos };
    },
    async addPhoto(user, setId, file) {
      const uuid = actor(user), number = id(setId);
      const name = originalName(file.originalName);
      if (!UUID.test(file.storedName) || !imageTypes.has(file.mediaType) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > 40 * 1024 * 1024) throw new Error('Ungültige Bilddatei.');
      const captured = date(file.capturedDate);
      const fallback = date(file.eventDateFallback);
      return transact(async (conn) => {
        const sets = await conn.query("SELECT id FROM photo_sets WHERE id = ? AND owner_uuid = ? AND status = 'open' FOR UPDATE", [number, uuid]);
        if (!sets.length) return null;
        const size = await conn.query("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM photo_assets WHERE set_id = ? AND status = 'private'", [number]);
        if (Number(size[0].count) >= 300 || Number(size[0].bytes) + file.byteSize > 2 * 1024 * 1024 * 1024) throw new Error('Fotoeinreichung zu groß.');
        const result = await conn.query('INSERT INTO photo_assets (set_id, uploader_uuid, stored_name, original_name, media_type, byte_size, captured_date) VALUES (?, ?, ?, ?, ?, ?, ?)', [number, uuid, file.storedName.toLowerCase(), name, file.mediaType, file.byteSize, captured]);
        if (captured || fallback) await conn.query('UPDATE photo_sets SET event_date = COALESCE(event_date, ?) WHERE id = ?', [captured || fallback, number]);
        await audit(conn, uuid, 'photo.upload', 'photo', result.insertId, name);
        return Number(result.insertId);
      }, true);
    },
    async submitPhotoSet(user, setId, name, eventDate, confirmed) {
      const uuid = actor(user), number = id(setId), label = title(name), day = date(eventDate);
      if (confirmed !== 'yes') throw new Error('Bestätigung der Bildrechte fehlt.');
      return transact(async (conn) => {
        const sets = await conn.query("SELECT status FROM photo_sets WHERE id = ? AND owner_uuid = ? FOR UPDATE", [number, uuid]);
        if (!sets.length || sets[0].status !== 'open') return false;
        const count = await conn.query("SELECT COUNT(*) AS n FROM photo_assets WHERE set_id = ? AND status = 'private'", [number]);
        if (!Number(count[0].n)) throw new Error('Bitte zuerst Bilder hochladen.');
        await conn.query("UPDATE photo_sets SET title = ?, event_date = ?, status = 'submitted', rights_confirmed_at = UTC_TIMESTAMP(6), submitted_at = UTC_TIMESTAMP(6) WHERE id = ?", [label, day, number]);
        await audit(conn, uuid, 'photo_set.submit', 'photo_set', number, label);
        return true;
      }, true);
    },
    async listPhotoAlbums(query = '') {
      const term = note(query, 100);
      return pool.query("SELECT b.id, b.title, DATE_FORMAT(b.event_date, '%Y-%m-%d') AS eventDate, b.description, COUNT(a.id) AS photoCount, COALESCE(MAX(CASE WHEN a.id = b.cover_photo_id THEN a.id END), MIN(a.id)) AS coverId FROM photo_albums b JOIN photo_assets a ON a.album_id = b.id AND a.status = 'published' WHERE b.deleted_at IS NULL AND LOCATE(LOWER(?), LOWER(b.title)) > 0 GROUP BY b.id ORDER BY b.event_date DESC, b.id DESC LIMIT 200", [term]);
    },
    async listPublishedPhotos(query = '') {
      const term = note(query, 100);
      return pool.query(`${photoSelect} JOIN photo_albums b ON b.id = a.album_id WHERE a.status = 'published' AND b.deleted_at IS NULL AND (LOCATE(LOWER(?), LOWER(b.title)) > 0 OR LOCATE(LOWER(?), LOWER(a.original_name)) > 0) ORDER BY a.published_at DESC, a.id DESC LIMIT 100`, [term, term]);
    },
    async createPhotoIssueImage(user, photoId, storedName, byteSize) {
      const uuid = actor(user), number = id(photoId);
      if (!UUID.test(storedName) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 10 * 1024 * 1024) throw new Error('Ungültiges Ausgabenbild.');
      return transact(async (conn) => {
        const rows = await conn.query("SELECT a.id FROM photo_assets a JOIN photo_albums b ON b.id = a.album_id WHERE a.id = ? AND a.status = 'published' AND b.deleted_at IS NULL FOR UPDATE", [number]);
        if (!rows.length) return false;
        const result = await conn.query('INSERT INTO editor_images (stored_name, media_type, byte_size, uploaded_by, source_photo_id) VALUES (?, ?, ?, ?, ?)', [storedName.toLowerCase(), 'image/webp', byteSize, uuid, number]);
        await audit(conn, uuid, 'photo.issue_copy', 'photo', number);
        await audit(conn, uuid, 'image.upload', 'image', result.insertId);
        return true;
      }, true);
    },
    async getPhotoAlbum(albumId) {
      const number = id(albumId);
      const albums = await pool.query("SELECT id, title, description, cover_photo_id AS coverPhotoId, DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate FROM photo_albums WHERE id = ? AND deleted_at IS NULL", [number]);
      if (!albums.length) return null;
      const photos = await pool.query(`${photoSelect} WHERE a.album_id = ? AND a.status = 'published' ORDER BY a.sequence_number`, [number]);
      return { ...albums[0], photos };
    },
    async getPhotoAsset(user, photoId, editor = false) {
      const uuid = actor(user), number = id(photoId);
      const rows = await pool.query(`${photoSelect} JOIN photo_sets s ON s.id = a.set_id LEFT JOIN photo_albums b ON b.id = a.album_id WHERE a.id = ? AND ((a.status = 'published' AND b.deleted_at IS NULL) OR (a.status = 'private' AND (s.owner_uuid = ? OR (? = 1 AND s.status = 'submitted'))))`, [number, uuid, editor ? 1 : 0]);
      return rows[0] || null;
    },
    async getPhotoComments(photoId) {
      return pool.query("SELECT c.id, c.author_uuid AS authorUuid, u.display_name AS authorName, c.body, c.created_at AS createdAt, c.updated_at AS updatedAt FROM photo_comments c LEFT JOIN iserv_identities u ON u.user_uuid = c.author_uuid WHERE c.photo_id = ? AND c.deleted_at IS NULL ORDER BY c.id LIMIT 500", [id(photoId)]);
    },
    async getPhotoCommentHistory(commentId) {
      return pool.query('SELECT r.id, r.action, r.body, r.recorded_at AS recordedAt, u.display_name AS changedBy FROM photo_comment_revisions r LEFT JOIN iserv_identities u ON u.user_uuid = r.changed_by WHERE r.comment_id = ? ORDER BY r.id DESC LIMIT 200', [id(commentId)]);
    },
    async reviewPhotoSet(user, setId, selected, existingAlbumId, newTitle, eventDate, description) {
      const uuid = actor(user), number = id(setId), day = date(eventDate), desc = note(description);
      if (!Array.isArray(selected) || selected.length > 300) throw new Error('Ungültige Fotoauswahl.');
      const chosen = new Set(selected.map(id));
      if (chosen.size !== selected.length) throw new Error('Doppelte Fotoauswahl.');
      const targetId = existingAlbumId ? id(existingAlbumId) : null;
      const label = targetId ? null : title(newTitle);
      return transact(async (conn) => {
        const sets = await conn.query("SELECT title, status FROM photo_sets WHERE id = ? FOR UPDATE", [number]);
        if (!sets.length || sets[0].status !== 'submitted') return null;
        const photos = await conn.query("SELECT id FROM photo_assets WHERE set_id = ? AND status = 'private' ORDER BY id FOR UPDATE", [number]);
        if (chosen.size && [...chosen].some((photoId) => !photos.some((photo) => photo.id === photoId))) throw new Error('Ungültige Fotoauswahl.');
        let albumId = targetId;
        if (chosen.size) {
          if (albumId) {
            const albums = await conn.query('SELECT id FROM photo_albums WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [albumId]);
            if (!albums.length) throw new Error('Album nicht gefunden.');
          } else {
            const result = await conn.query('INSERT INTO photo_albums (title, event_date, description, created_by) VALUES (?, ?, ?, ?)', [label, day, desc, uuid]);
            albumId = Number(result.insertId);
            await audit(conn, uuid, 'photo_album.create', 'photo_album', albumId, label);
          }
          const last = await conn.query('SELECT COALESCE(MAX(sequence_number),0) AS n FROM photo_assets WHERE album_id = ?', [albumId]);
          let sequence = Number(last[0].n);
          for (const photo of photos) if (chosen.has(photo.id)) {
            sequence++;
            await conn.query("UPDATE photo_assets SET album_id = ?, sequence_number = ?, status = 'published', published_at = UTC_TIMESTAMP(6) WHERE id = ?", [albumId, sequence, photo.id]);
            await audit(conn, uuid, 'photo.publish', 'photo', photo.id);
          }
        }
        for (const photo of photos) if (!chosen.has(photo.id)) {
          await conn.query("UPDATE photo_assets SET status = 'rejected', deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?", [uuid, photo.id]);
          await audit(conn, uuid, 'photo.reject', 'photo', photo.id);
        }
        await conn.query("UPDATE photo_sets SET status = 'reviewed', reviewed_at = UTC_TIMESTAMP(6), reviewed_by = ? WHERE id = ?", [uuid, number]);
        await audit(conn, uuid, 'photo_set.review', 'photo_set', number, sets[0].title);
        return albumId || 0;
      }, true);
    },
    async editPhotoAlbum(user, albumId, name, eventDate, description, coverPhotoId) {
      const uuid = actor(user), number = id(albumId), label = title(name), day = date(eventDate), desc = note(description);
      const coverId = coverPhotoId ? id(coverPhotoId) : null;
      return transact(async (conn) => {
        const rows = await conn.query('SELECT id, cover_photo_id AS coverPhotoId FROM photo_albums WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [number]);
        if (!rows.length) return false;
        if (coverId) {
          const covers = await conn.query("SELECT id FROM photo_assets WHERE id = ? AND album_id = ? AND status = 'published' FOR UPDATE", [coverId, number]);
          if (!covers.length) throw new Error('Titelbild gehört nicht zu diesem Album.');
        }
        await conn.query('UPDATE photo_albums SET title = ?, event_date = ?, description = ?, cover_photo_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?', [label, day, desc, coverId, number]);
        await audit(conn, uuid, 'photo_album.edit', 'photo_album', number, label);
        if (coverId !== (rows[0].coverPhotoId ? Number(rows[0].coverPhotoId) : null)) {
          await audit(conn, uuid, coverId ? 'photo.cover_select' : 'photo_album.cover_reset', coverId ? 'photo' : 'photo_album', coverId || number, label);
        }
        return true;
      }, true);
    },
    async editPhotoDate(user, photoId, capturedDate) {
      const uuid = actor(user), number = id(photoId), day = date(capturedDate);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT id FROM photo_assets WHERE id = ? AND status = 'published' FOR UPDATE", [number]);
        if (!rows.length) return false;
        await conn.query('UPDATE photo_assets SET captured_date = ? WHERE id = ?', [day, number]);
        await audit(conn, uuid, 'photo.date_edit', 'photo', number);
        return true;
      }, true);
    },
    async cancelPhotoSet(user, setId) {
      const uuid = actor(user), number = id(setId);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT title FROM photo_sets WHERE id = ? AND owner_uuid = ? AND status = 'open' FOR UPDATE", [number, uuid]);
        if (!rows.length) return false;
        await conn.query("UPDATE photo_sets SET status = 'reviewed', reviewed_at = UTC_TIMESTAMP(6), reviewed_by = ? WHERE id = ?", [uuid, number]);
        await conn.query("UPDATE photo_assets SET status = 'rejected', deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE set_id = ? AND status = 'private'", [uuid, number]);
        await audit(conn, uuid, 'photo_set.cancel', 'photo_set', number, rows[0].title);
        return true;
      }, true);
    },
    async addPhotoComment(user, photoId, body) {
      const uuid = actor(user), number = id(photoId), content = note(body, 2000);
      if (!content) throw new Error('Kommentar fehlt.');
      return transact(async (conn) => {
        const rows = await conn.query("SELECT a.id FROM photo_assets a JOIN photo_albums b ON b.id = a.album_id WHERE a.id = ? AND a.status = 'published' AND b.deleted_at IS NULL FOR UPDATE", [number]);
        if (!rows.length) return null;
        const result = await conn.query('INSERT INTO photo_comments (photo_id, author_uuid, body) VALUES (?, ?, ?)', [number, uuid, content]);
        await conn.query("INSERT INTO photo_comment_revisions (comment_id, body, changed_by, action) VALUES (?, ?, ?, 'create')", [result.insertId, content, uuid]);
        await audit(conn, uuid, 'photo_comment.create', 'photo_comment', result.insertId);
        return Number(result.insertId);
      }, true);
    },
    async editPhotoComment(user, commentId, photoId, body) {
      const uuid = actor(user), number = id(commentId), imageId = id(photoId), content = note(body, 2000);
      if (!content) throw new Error('Kommentar fehlt.');
      return transact(async (conn) => {
        const rows = await conn.query("SELECT c.id FROM photo_comments c JOIN photo_assets a ON a.id = c.photo_id JOIN photo_albums b ON b.id = a.album_id WHERE c.id = ? AND c.photo_id = ? AND c.author_uuid = ? AND c.deleted_at IS NULL AND a.status = 'published' AND b.deleted_at IS NULL FOR UPDATE", [number, imageId, uuid]);
        if (!rows.length) return false;
        await conn.query('UPDATE photo_comments SET body = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?', [content, number]);
        await conn.query("INSERT INTO photo_comment_revisions (comment_id, body, changed_by, action) VALUES (?, ?, ?, 'edit')", [number, content, uuid]);
        await audit(conn, uuid, 'photo_comment.edit', 'photo_comment', number);
        return true;
      }, true);
    },
    async deletePhotoComment(user, commentId, photoId, editor = false) {
      const uuid = actor(user), number = id(commentId), imageId = id(photoId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT author_uuid AS authorUuid, body FROM photo_comments WHERE id = ? AND photo_id = ? AND deleted_at IS NULL FOR UPDATE', [number, imageId]);
        if (!rows.length || (!editor && rows[0].authorUuid !== uuid)) return false;
        await conn.query('UPDATE photo_comments SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, number]);
        await conn.query("INSERT INTO photo_comment_revisions (comment_id, body, changed_by, action) VALUES (?, ?, ?, 'delete')", [number, rows[0].body, uuid]);
        await audit(conn, uuid, 'photo_comment.delete', 'photo_comment', number);
        return true;
      }, true);
    },
    async deletePublishedPhoto(user, photoId) {
      const uuid = actor(user), number = id(photoId);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT id FROM photo_assets WHERE id = ? AND status = 'published' FOR UPDATE", [number]);
        if (!rows.length) return false;
        await conn.query("UPDATE photo_assets SET status = 'deleted', deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?", [uuid, number]);
        await audit(conn, uuid, 'photo.delete', 'photo', number);
        return true;
      }, true);
    },
    async deletePhotoAlbum(user, albumId) {
      const uuid = actor(user), number = id(albumId);
      return transact(async (conn) => {
        const rows = await conn.query('SELECT title FROM photo_albums WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [number]);
        if (!rows.length) return false;
        await conn.query('UPDATE photo_albums SET deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE id = ?', [uuid, number]);
        await conn.query("UPDATE photo_assets SET status = 'deleted', deleted_at = UTC_TIMESTAMP(6), deleted_by = ? WHERE album_id = ? AND status = 'published'", [uuid, number]);
        await audit(conn, uuid, 'photo_album.delete', 'photo_album', number, rows[0].title);
        return true;
      }, true);
    },
    async restoreDeletedPhoto(user, photoId) {
      const uuid = actor(user), number = id(photoId);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT a.id FROM photo_assets a JOIN photo_albums b ON b.id = a.album_id WHERE a.id = ? AND a.status = 'deleted' AND a.deleted_at > UTC_TIMESTAMP(6) - INTERVAL 7 DAY AND b.deleted_at IS NULL FOR UPDATE", [number]);
        if (!rows.length) return false;
        await conn.query("UPDATE photo_assets SET status = 'published', deleted_at = NULL, deleted_by = NULL WHERE id = ?", [number]);
        await audit(conn, uuid, 'photo.restore', 'photo', number);
        return true;
      }, true);
    },
    async restoreDeletedPhotoAlbum(user, albumId) {
      const uuid = actor(user), number = id(albumId);
      return transact(async (conn) => {
        const rows = await conn.query("SELECT title, DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f') AS deletedAt, deleted_by AS deletedBy FROM photo_albums WHERE id = ? AND deleted_at > UTC_TIMESTAMP(6) - INTERVAL 7 DAY FOR UPDATE", [number]);
        if (!rows.length) return false;
        await conn.query("UPDATE photo_assets SET status = 'published', deleted_at = NULL, deleted_by = NULL WHERE album_id = ? AND status = 'deleted' AND deleted_at >= ? AND deleted_by = ?", [number, rows[0].deletedAt, rows[0].deletedBy]);
        await conn.query('UPDATE photo_albums SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [number]);
        await audit(conn, uuid, 'photo_album.restore', 'photo_album', number, rows[0].title);
        return true;
      }, true);
    },
    async expiredPhotoFiles() {
      return pool.query("SELECT id FROM photo_assets WHERE status = 'rejected' OR (status = 'deleted' AND deleted_at <= UTC_TIMESTAMP(6) - INTERVAL 7 DAY) ORDER BY id LIMIT 100");
    },
    async purgeExpiredPhoto(photoId, removeFiles) {
      const number = id(photoId);
      if (typeof removeFiles !== 'function') throw new Error('Dateibereinigung fehlt.');
      return transact(async (conn) => {
        const rows = await conn.query("SELECT stored_name AS storedName FROM photo_assets WHERE id = ? AND (status = 'rejected' OR (status = 'deleted' AND deleted_at <= UTC_TIMESTAMP(6) - INTERVAL 7 DAY)) FOR UPDATE", [number]);
        if (!rows.length) return false;
        await removeFiles(rows[0].storedName);
        await conn.query("UPDATE photo_assets SET status = 'purged' WHERE id = ?", [number]);
        await writeAudit(conn, null, 'photo.purge', 'photo', number);
        return true;
      }, true);
    },
  };
}
