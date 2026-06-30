// Client id/secret are injected at build time by esbuild `define`. In the test/Node
// environment those globals are undefined, so fall back to '' (Drive calls then fail
// fast with NeedsAuth rather than crashing imports).
const ID = typeof __OWL_DRIVE_CLIENT_ID__ !== 'undefined' ? __OWL_DRIVE_CLIENT_ID__ : '';
const SECRET = typeof __OWL_DRIVE_CLIENT_SECRET__ !== 'undefined' ? __OWL_DRIVE_CLIENT_SECRET__ : '';

export const OAUTH_CLIENT_ID = ID;
export const OAUTH_CLIENT_SECRET = SECRET;
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const ATTACH_FOLDER_NAME = 'OWL-Note Attachments';
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
