let activeClose = null;

async function copyText(input, button, copy) {
  try {
    await copy(input.value);
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = 'Copy link';
      button.classList.remove('copied');
    }, 1800);
  } catch {
    input.focus();
    input.select();
    button.textContent = 'Press Ctrl+C';
  }
}

// A deliberately explicit share surface: creating the Drive permission never copies
// behind the user's back. The user sees who can open it, the Viewer role, and the URL.
export function showShareLinkDialog(link, options = {}) {
  activeClose?.();
  const copy = options.copy || ((value) => navigator.clipboard.writeText(value));

  const backdrop = document.createElement('div');
  backdrop.className = 'share-link-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'share-link-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'share-link-title');

  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.id = 'share-link-title';
  heading.textContent = 'Share note';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'share-link-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close share dialog');
  header.append(heading, closeButton);

  const access = document.createElement('div');
  access.className = 'share-link-access';
  const icon = document.createElement('span');
  icon.className = 'share-link-access-icon';
  icon.textContent = '↗';
  icon.setAttribute('aria-hidden', 'true');
  const accessCopy = document.createElement('div');
  const accessTitle = document.createElement('strong');
  accessTitle.textContent = 'Anyone with the link';
  const accessDetail = document.createElement('span');
  accessDetail.textContent = 'No sign-in required';
  accessCopy.append(accessTitle, accessDetail);
  const role = document.createElement('span');
  role.className = 'share-link-role';
  role.textContent = 'Viewer';
  access.append(icon, accessCopy, role);

  const label = document.createElement('label');
  label.className = 'share-link-label';
  label.htmlFor = 'share-link-url';
  label.textContent = 'Google Drive link';
  const row = document.createElement('div');
  row.className = 'share-link-row';
  const input = document.createElement('input');
  input.id = 'share-link-url';
  input.type = 'text';
  input.readOnly = true;
  input.value = String(link);
  input.addEventListener('focus', () => input.select());
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'share-link-copy';
  copyButton.textContent = 'Copy link';
  copyButton.addEventListener('click', () => copyText(input, copyButton, copy));
  row.append(input, copyButton);

  const footer = document.createElement('footer');
  const driveLabel = document.createElement('span');
  driveLabel.textContent = 'Stored as a read-only PDF in Google Drive';
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.className = 'share-link-done';
  doneButton.textContent = 'Done';
  footer.append(driveLabel, doneButton);
  dialog.append(header, access, label, row, footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const previouslyFocused = document.activeElement;
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
    if (activeClose === close) activeClose = null;
    previouslyFocused?.focus?.();
  }
  activeClose = close;
  closeButton.addEventListener('click', close);
  doneButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeydown);
  copyButton.focus();
  return { close, input, copyButton };
}
