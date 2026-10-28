import { describe, it, expect } from 'vitest';

import {
  getMediaKind,
  getMimeType,
  getViewableFileKind,
  isBrowserPreviewableFile,
  isAudioFile,
  isHtmlFile,
  isImageFile,
  isMediaFile,
  isPdfFile,
  isUnsupportedBinaryFile,
  isVideoFile,
} from '../../src/shared/image-utils';

describe('image-utils', () => {
  describe('isImageFile', () => {
    it('returns true for supported image extensions', () => {
      expect(isImageFile('photo.png')).toBe(true);
      expect(isImageFile('photo.jpg')).toBe(true);
      expect(isImageFile('photo.jpeg')).toBe(true);
      expect(isImageFile('photo.gif')).toBe(true);
      expect(isImageFile('photo.webp')).toBe(true);
      expect(isImageFile('photo.ico')).toBe(true);
      expect(isImageFile('photo.bmp')).toBe(true);
    });

    it('returns false for non-image extensions', () => {
      expect(isImageFile('file.txt')).toBe(false);
      expect(isImageFile('file.ts')).toBe(false);
      expect(isImageFile('file.pdf')).toBe(false);
      expect(isImageFile('file.svg')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isImageFile('photo.PNG')).toBe(true);
      expect(isImageFile('photo.Jpg')).toBe(true);
      expect(isImageFile('photo.JPEG')).toBe(true);
    });

    it('handles paths with directories', () => {
      expect(isImageFile('/path/to/photo.png')).toBe(true);
      expect(isImageFile('relative/path/photo.gif')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isImageFile('')).toBe(false);
    });

    it('returns false when extension appears mid-filename', () => {
      expect(isImageFile('photo.png.txt')).toBe(false);
    });
  });

  describe('isMediaFile', () => {
    it('detects audio and video files', () => {
      expect(isAudioFile('sound.MP3')).toBe(true);
      expect(isVideoFile('clip.WebM')).toBe(true);
      expect(isVideoFile('clip.avi')).toBe(true);
      expect(isVideoFile('clip.mkv')).toBe(true);
      expect(isMediaFile('sound.MP3')).toBe(true);
      expect(isMediaFile('clip.WebM')).toBe(true);
    });

    it('keeps image detection separate from media detection', () => {
      expect(isImageFile('asset.PNG')).toBe(true);
      expect(isMediaFile('asset.PNG')).toBe(false);
    });

    it('returns media kind for supported media files', () => {
      expect(getMediaKind('sound.mp3')).toBe('audio');
      expect(getMediaKind('clip.mp4')).toBe('video');
      expect(getMediaKind('notes.txt')).toBeNull();
    });
  });

  describe('isHtmlFile', () => {
    it('detects HTML files case-insensitively', () => {
      expect(isHtmlFile('index.html')).toBe(true);
      expect(isHtmlFile('page.HTM')).toBe(true);
      expect(isHtmlFile('/path/to/page.HTML')).toBe(true);
    });

    it('returns false for non-HTML files', () => {
      expect(isHtmlFile('template.html.txt')).toBe(false);
      expect(isHtmlFile('component.tsx')).toBe(false);
      expect(isHtmlFile('')).toBe(false);
    });
  });

  describe('isBrowserPreviewableFile', () => {
    it('detects files that can be rendered by the browser preview', () => {
      expect(isBrowserPreviewableFile('index.html')).toBe(true);
      expect(isBrowserPreviewableFile('page.HTM')).toBe(true);
      expect(isBrowserPreviewableFile('asset.svg')).toBe(true);
      expect(isBrowserPreviewableFile('/path/to/asset.SVG')).toBe(true);
      expect(isBrowserPreviewableFile('document.PDF')).toBe(true);
    });

    it('returns false for files handled by other preview panes', () => {
      expect(isBrowserPreviewableFile('photo.png')).toBe(false);
      expect(isBrowserPreviewableFile('clip.webm')).toBe(false);
      expect(isBrowserPreviewableFile('')).toBe(false);
    });
  });

  describe('binary preview handling', () => {
    it('identifies browser-only PDFs and unsupported HEIC images case-insensitively', () => {
      expect(isPdfFile('document.PDF')).toBe(true);
      expect(isPdfFile('document.pdf.txt')).toBe(false);
      expect(isUnsupportedBinaryFile('photo.HEIC')).toBe(true);
      expect(isUnsupportedBinaryFile('photo.heif')).toBe(true);
      expect(isUnsupportedBinaryFile('photo.jpg')).toBe(false);
    });
  });

  describe('getMimeType', () => {
    it('returns correct MIME type for each supported image extension', () => {
      expect(getMimeType('photo.png')).toBe('image/png');
      expect(getMimeType('photo.jpg')).toBe('image/jpeg');
      expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(getMimeType('photo.gif')).toBe('image/gif');
      expect(getMimeType('photo.webp')).toBe('image/webp');
      expect(getMimeType('photo.ico')).toBe('image/x-icon');
      expect(getMimeType('photo.bmp')).toBe('image/bmp');
    });

    it('returns correct MIME type for supported media extensions', () => {
      expect(getMimeType('sound.mp3')).toBe('audio/mpeg');
      expect(getMimeType('sound.wav')).toBe('audio/wav');
      expect(getMimeType('clip.mp4')).toBe('video/mp4');
      expect(getMimeType('clip.avi')).toBe('video/x-msvideo');
      expect(getMimeType('clip.mkv')).toBe('video/x-matroska');
      expect(getMimeType('clip.webm')).toBe('video/webm');
    });

    it('returns application/octet-stream for unknown extensions', () => {
      expect(getMimeType('file.txt')).toBe('application/octet-stream');
    });

    it('returns text/html for supported HTML extensions', () => {
      expect(getMimeType('index.html')).toBe('text/html');
      expect(getMimeType('page.htm')).toBe('text/html');
    });

    it('returns image/svg+xml for SVG browser previews', () => {
      expect(getMimeType('asset.svg')).toBe('image/svg+xml');
    });

    it('returns application/pdf for PDF browser previews', () => {
      expect(getMimeType('document.PDF')).toBe('application/pdf');
    });

    it('is case-insensitive', () => {
      expect(getMimeType('photo.PNG')).toBe('image/png');
      expect(getMimeType('photo.JPG')).toBe('image/jpeg');
      expect(getMimeType('clip.WEBM')).toBe('video/webm');
    });

    it('handles paths with directories', () => {
      expect(getMimeType('/path/to/photo.png')).toBe('image/png');
    });

    it('returns application/octet-stream for empty string', () => {
      expect(getMimeType('')).toBe('application/octet-stream');
    });
  });

  describe('getViewableFileKind', () => {
    it.each([
      ['/tmp/shot.PNG', 'image'],
      ['diagram.svg', 'svg'],
      ['playwright-report/index.html', 'html'],
      ['report.htm', 'html'],
      ['paper.pdf', 'pdf'],
      ['NOTES.md', 'markdown'],
      ['guide.markdown', 'markdown'],
      ['take.mp3', 'audio'],
      ['run.webm', 'video'],
      ['build.log', 'text'],
      ['results.json', 'text'],
      ['events.jsonl', 'text'],
      ['table.csv', 'text'],
      ['notes.txt', 'text'],
    ])('shows %s as %s', (filePath, kind) => {
      expect(getViewableFileKind(filePath)).toBe(kind);
    });

    it('has no view for source code or unknown types', () => {
      expect(getViewableFileKind('src/app.ts')).toBeNull();
      expect(getViewableFileKind('main.py')).toBeNull();
      expect(getViewableFileKind('archive.zip')).toBeNull();
      expect(getViewableFileKind('LICENSE')).toBeNull();
    });
  });
});
