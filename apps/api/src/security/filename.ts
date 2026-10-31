/* eslint-disable no-control-regex -- stripping control characters from file names is the point of this module */
const MAX_NAME_LENGTH = 180;

/**
 * Sanitize a client-supplied filename for display and download naming only.
 * The result is never used to build a filesystem path.
 */
export function sanitizeFilename(raw: string, fallback = 'file'): string {
  // multer decodes multipart names as latin1; recover UTF-8 names when that is what was sent
  let name = raw;
  if (/[À-ÿ]/.test(name) && !/[^\u0000-ÿ]/.test(name)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  }
  name = name.replace(/\0/g, '').split(/[\\/]/).pop() as string;
  name = name
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .normalize('NFC')
    .trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name.length > MAX_NAME_LENGTH) {
    const ext = extensionOf(name);
    const base = name.slice(0, name.length - (ext ? ext.length + 1 : 0));
    name = base.slice(0, MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0)) + (ext ? `.${ext}` : '');
  }
  return name || fallback;
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

export function baseNameOf(filename: string): string {
  const ext = extensionOf(filename);
  return ext ? filename.slice(0, -(ext.length + 1)) : filename;
}
