-- V1.2.1: editorially selected album cover; existing albums keep the first published image.
ALTER TABLE photo_albums
  ADD COLUMN cover_photo_id INT UNSIGNED NULL AFTER description,
  ADD CONSTRAINT photo_album_cover_photo FOREIGN KEY (cover_photo_id) REFERENCES photo_assets(id) ON DELETE RESTRICT;
