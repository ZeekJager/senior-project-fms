// Sets the theme before the first paint, so there is no flash of the wrong one. A file of its own, loaded blocking from <head>, rather
// than an inline script: the web app's Content-Security-Policy allows scripts from its own origin only (FMS-103, docs/security.md).
try {
  var t = localStorage.getItem('fms-theme')
  if (t !== 'light' && t !== 'dark') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
