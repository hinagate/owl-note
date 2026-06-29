export function classifyUrl(url) {
  if (/^https?:/i.test(url)) return 'web';
  if (/^file:/i.test(url)) return 'file';
  return 'other';
}

export function parseAttachmentInput(text) {
  const raw = String(text).trim();
  const sep = raw.indexOf(' | ');
  let label, href;
  if (sep !== -1) {
    label = raw.slice(0, sep).trim();
    href = raw.slice(sep + 3).trim();
  } else {
    href = raw;
    label = raw;
  }
  return { kind: classifyUrl(href), href, label };
}

export function canOpenFileUrls() {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(!!allowed));
    } catch {
      resolve(false);
    }
  });
}

export async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}
