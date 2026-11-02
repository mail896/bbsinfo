// Apply the saved choice before the stylesheet renders to avoid a light flash.
const themeStorageKey = 'bbsinfo-theme';
let savedTheme = 'system';
try {
  const value = localStorage.getItem(themeStorageKey);
  if (value === 'light' || value === 'dark') savedTheme = value;
} catch {
  // Browser privacy settings can deny storage; the system theme still works.
}

function applyTheme(choice) {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = choice;
  document.dispatchEvent(new CustomEvent('bbsinfo:themechange'));
}

window.bbsInfoTheme = {
  isDark: () => savedTheme === 'dark' || (savedTheme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches),
};

applyTheme(savedTheme);

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (savedTheme === 'system') document.dispatchEvent(new CustomEvent('bbsinfo:themechange'));
});

document.addEventListener('DOMContentLoaded', () => {
  const select = document.querySelector('[data-theme-choice]');
  if (!select) return;
  select.value = savedTheme;
  select.addEventListener('change', () => {
    const choice = ['system', 'light', 'dark'].includes(select.value) ? select.value : 'system';
    savedTheme = choice;
    applyTheme(choice);
    try {
      if (choice === 'system') localStorage.removeItem(themeStorageKey);
      else localStorage.setItem(themeStorageKey, choice);
    } catch {
      // The chosen mode remains active for this page even without storage.
    }
  });
});
