/** Bytes an icon may take as stored: projects.json holds it inline. */
export const MAX_PROJECT_ICON_BYTES = 48 * 1024;

/** The data URLs a project icon may be: base64 images an `<img>` shows without fetching. */
export const PROJECT_ICON_DATA_URL =
  /^data:image\/(?:png|jpeg|svg\+xml|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The longest data URL an icon of MAX_PROJECT_ICON_BYTES encodes to. */
export const MAX_PROJECT_ICON_DATA_URL_LENGTH =
  'data:image/svg+xml;base64,'.length + Math.ceil(MAX_PROJECT_ICON_BYTES / 3) * 4;
