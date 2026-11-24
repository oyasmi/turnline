export function bindShortcuts(orb, field, actions) {
  let pointer;
  const cancel = () => {
    pointer = undefined;
    actions.release(false);
  };
  orb.addEventListener('pointerdown', event => {
    if (!actions.holdMode() || event.button !== 0 || !actions.press()) return;
    pointer = event.pointerId;
    orb.setPointerCapture(pointer);
    event.preventDefault();
  });
  orb.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer) return;
    pointer = undefined;
    actions.release(true);
  });
  orb.addEventListener('pointercancel', cancel);
  orb.addEventListener('lostpointercapture', event => {
    if (event.pointerId === pointer) cancel();
  });
  orb.addEventListener('contextmenu', event => {
    if (actions.holdMode()) event.preventDefault();
  });
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });

  const interactive = 'button, input, textarea, select, a, summary, [contenteditable]:not([contenteditable="false"])';
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Enter' && modifier && event.target === field) {
      event.preventDefault();
      field.form.requestSubmit();
      return;
    }
    if (event.key === 'Escape') {
      actions.escape();
      return;
    }
    if (modifier || event.altKey) return;
    const focusedControl = event.target.closest?.(interactive);
    if (focusedControl && !(event.key === ' ' && focusedControl === orb && actions.holdMode())) return;
    switch (event.key) {
      case ' ':
        if (actions.active()) {
          event.preventDefault();
          if (!event.repeat) actions.press();
        }
        break;
      case 'm':
      case 'M':
        if (!event.repeat && actions.active()) actions.mute(false);
        break;
      case '/':
        if (!field.disabled) {
          event.preventDefault();
          field.focus();
        }
        break;
      case '?':
        event.preventDefault();
        actions.help();
        break;
    }
  });
  window.addEventListener('keyup', event => {
    if (event.key === ' ' && actions.release(true)) event.preventDefault();
  });
}

export function updateMediaSession({ active, mic, hangUp, mute }) {
  const media = navigator.mediaSession;
  if (!media) return;
  try { media.setMicrophoneActive?.(mic); } catch {}
  for (const [action, handler] of [['hangup', hangUp], ['togglemicrophone', mute]]) {
    try { media.setActionHandler(action, active ? handler : null); } catch {}
  }
  if ('MediaMetadata' in window) media.metadata = active ? new MediaMetadata({ title: 'Turnline 通话中' }) : null;
}

export function vibrate(enabled) {
  if (enabled) navigator.vibrate?.(8);
}
