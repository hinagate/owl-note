function ensureProgress() {
  let root = document.getElementById('pdf-progress');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'pdf-progress';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.className = 'pdf-progress-label';
  const track = document.createElement('div');
  track.className = 'pdf-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const bar = document.createElement('div');
  bar.className = 'pdf-progress-bar';
  track.appendChild(bar);
  root.append(label, track);
  document.body.appendChild(root);
  return root;
}

export function updatePdfProgress({ percent = null, label = 'Creating PDF…' } = {}) {
  const root = ensureProgress();
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  root.querySelector('.pdf-progress-label').textContent = value === null ? label : `${label} ${value}%`;
  const track = root.querySelector('.pdf-progress-track');
  const bar = root.querySelector('.pdf-progress-bar');
  if (value === null) {
    track.removeAttribute('aria-valuenow');
    track.classList.add('indeterminate');
    bar.style.width = '35%';
  } else {
    track.setAttribute('aria-valuenow', String(value));
    track.classList.remove('indeterminate');
    bar.style.width = `${value}%`;
  }
  root.hidden = false;
  return root;
}

export function hidePdfProgress() {
  const root = document.getElementById('pdf-progress');
  if (root) root.hidden = true;
}
