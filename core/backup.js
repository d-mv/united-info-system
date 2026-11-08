/**
 * Export / import of everything UIS keeps in localStorage (`dashboard:` keys),
 * as one JSON file. Restoring replaces all UIS data.
 *
 * File: { app: 'uis', format: 1, exportedAt: ISO string, data: { key: value } }
 * Keys are stored without the `dashboard:` prefix.
 */
export const BACKUP_FORMAT = 1;

// Keys UIS writes look like 'config', 'app:todo', 'weather:cache'.
const KEY = /^[a-z0-9][a-z0-9:._-]*$/i;

export function buildBackup(storage, now = new Date()) {
  const data = {};
  for (const key of storage.keys().sort()) data[key] = storage.get(key, null);
  return { app: 'uis', format: BACKUP_FORMAT, exportedAt: now.toISOString(), data };
}

/** { _tag: 'Ok', value: backup } or { _tag: 'Err', error: message for the user }. */
export function parseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { _tag: 'Err', error: 'This file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.app !== 'uis') {
    return { _tag: 'Err', error: 'This is not a UIS backup file.' };
  }
  if (parsed.format !== BACKUP_FORMAT) {
    return { _tag: 'Err', error: `Backup format ${parsed.format} is not supported by this version.` };
  }
  const { data } = parsed;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { _tag: 'Err', error: 'The backup has no data.' };
  }
  if (!Object.keys(data).every(k => KEY.test(k))) {
    return { _tag: 'Err', error: 'The backup contains unexpected entries.' };
  }
  return { _tag: 'Ok', value: parsed };
}

/** Replace all UIS data with the backup's. Other sites' localStorage is untouched. */
export function restoreBackup(storage, backup) {
  for (const key of storage.keys()) {
    if (!(key in backup.data)) storage.remove(key);
  }
  for (const [key, value] of Object.entries(backup.data)) storage.set(key, value);
}

/** Download the backup as uis-backup-YYYY-MM-DD.json (browser only). */
export function downloadBackup(backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `uis-backup-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
