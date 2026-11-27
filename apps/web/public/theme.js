/* global window, document */
/* Sets light or dark before the page draws, so it never flashes the wrong colours.
   The saved choice wins; otherwise follow the system. Kept in sync by src/lib/theme.ts. */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('tm-theme');
  } catch {
    /* storage blocked: fall back to the system */
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
