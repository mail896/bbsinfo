const visual = document.querySelector('[data-landing-animation]');
const replay = document.querySelector('[data-replay-animation]');
const shell = document.querySelector('[data-landing-shell]');

function restartAnimation(root, selector) {
  const element = root?.querySelector(selector);
  if (element) element.replaceWith(element.cloneNode(true));
}

if (visual && replay) {
  replay.addEventListener('click', () => {
    // A deliberate click also permits playback when the system requests reduced motion.
    visual.dataset.motion = 'explicit';
    if (shell) shell.dataset.motion = 'explicit';
    restartAnimation(visual, '.landing-flip');
    restartAnimation(visual, '.landing-announcements');
    restartAnimation(shell, '.landing-title');
  });
}
