function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canShareFile(nav, file) {
  if (!nav?.share) return false;
  try { return !nav.canShare || nav.canShare({ files: [file] }); }
  catch { return false; }
}

// PDF creation is asynchronous and can outlive the click's transient user activation.
// This ready panel gives navigator.share a fresh, direct button click every time.
export function showPdfShareDialog({ file, title, download, navigatorImpl = navigator, onShared = () => {} }) {
  document.querySelector('.pdf-share-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'share-link-backdrop pdf-share-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'share-link-dialog pdf-share-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'pdf-share-title');

  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.id = 'pdf-share-title';
  heading.textContent = 'PDF ready';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'share-link-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close PDF share dialog');
  header.append(heading, closeButton);

  const fileRow = document.createElement('div');
  fileRow.className = 'pdf-share-file';
  const icon = document.createElement('span');
  icon.className = 'pdf-share-icon';
  icon.textContent = 'PDF';
  const details = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = file.name;
  const size = document.createElement('span');
  size.textContent = `${formatSize(file.size)} · PDF verified · Includes rendered photos`;
  details.append(name, size);
  fileRow.append(icon, details);

  const explanation = document.createElement('p');
  explanation.className = 'pdf-share-explanation';
  explanation.textContent = 'Choose Share PDF to select an app, or download a copy to this device.';
  const status = document.createElement('div');
  status.className = 'pdf-share-status';
  status.setAttribute('aria-live', 'polite');

  const footer = document.createElement('footer');
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'share-link-copy pdf-download-button';
  downloadButton.textContent = 'Download';
  const shareButton = document.createElement('button');
  shareButton.type = 'button';
  shareButton.className = 'share-link-done pdf-share-button';
  const supported = canShareFile(navigatorImpl, file);
  shareButton.textContent = supported ? 'Share PDF' : 'Download PDF';
  footer.append(downloadButton, shareButton);
  dialog.append(header, fileRow, explanation, status, footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const previouslyFocused = document.activeElement;
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
    previouslyFocused?.focus?.();
  }
  function doDownload() {
    download(file);
    status.textContent = 'PDF downloaded.';
  }
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeydown);
  downloadButton.addEventListener('click', doDownload);
  shareButton.addEventListener('click', () => {
    if (!supported) { doDownload(); return; }
    // No await or other work before navigator.share: this call is directly inside
    // the fresh click, preserving the browser's required user activation.
    let sharing;
    try {
      sharing = navigatorImpl.share({
        title: title || 'OWL-Note',
        files: [file],
      });
    } catch {
      status.textContent = 'Could not open the share menu. You can download the PDF instead.';
      return;
    }
    shareButton.disabled = true;
    shareButton.textContent = 'Sharing…';
    Promise.resolve(sharing).then(() => {
      onShared();
      close();
    }).catch((error) => {
      shareButton.disabled = false;
      shareButton.textContent = 'Share PDF';
      if (error?.name !== 'AbortError') status.textContent = 'Could not open the share menu. You can download the PDF instead.';
    });
  });
  shareButton.focus();
  return { close, shareButton, downloadButton, status };
}
