(() => {
  const config = window.CHAIN_WATCHER_PAGES_CONFIG || {};
  const appUrl = String(config.appUrl || '').trim();
  const validAppUrl = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#].*)?$/.test(appUrl);
  const setup = document.getElementById('setup');
  const loader = document.getElementById('loader');
  const frame = document.getElementById('chain-watcher');
  const directLink = document.getElementById('direct-link');
  document.getElementById('pages-origin').textContent = window.location.origin;

  if (!validAppUrl) {
    loader.classList.add('hidden');
    setup.classList.remove('hidden');
    return;
  }

  frame.src = appUrl;
  directLink.href = appUrl;
  frame.classList.remove('hidden');
  directLink.classList.remove('hidden');
  frame.addEventListener('load', () => loader.classList.add('hidden'), { once: true });
})();
