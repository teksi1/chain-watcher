(() => {
  const config = window.CHAIN_WATCHER_PAGES_CONFIG || {};
  const appUrl = String(config.appUrl || '').trim();
  const validAppUrl = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#].*)?$/.test(appUrl);

  const setup = document.getElementById('setup');
  const loader = document.getElementById('loader');
  const frame = document.getElementById('chain-watcher');
  const pagesOrigin = document.getElementById('pages-origin');

  if (pagesOrigin) {
    pagesOrigin.textContent = window.location.origin;
  }

  if (!setup || !loader || !frame) {
    console.error('Chain Watcher Pages wrapper: required elements are missing.');
    return;
  }

  function hideLoader() {
    loader.classList.add('hidden');
  }

  function setFrameHeight(height) {
    const safeHeight = Number(height);

    if (!Number.isFinite(safeHeight) || safeHeight < 400) return;

    // Add a small buffer so desktop browsers do not clip the bottom edge.
    frame.style.height = `${Math.ceil(safeHeight + 24)}px`;
  }

  function isAllowedMessageOrigin(origin) {
    return (
      origin === 'https://script.google.com' ||
      /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/i.test(origin)
    );
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'CHAIN_WATCHER_HEIGHT') return;

    // Only accept height messages from the Apps Script iframe.
    if (event.source !== frame.contentWindow) return;
    if (!isAllowedMessageOrigin(event.origin)) return;

    setFrameHeight(event.data.height);
    hideLoader();
  });

  if (!validAppUrl) {
    hideLoader();
    setup.classList.remove('hidden');
    return;
  }

  // Give the iframe a safe starting height before the Apps Script app reports its real height.
  frame.style.minHeight = '100vh';
  frame.style.height = `${Math.max(window.innerHeight, 700)}px`;

  frame.addEventListener('load', hideLoader, { once: true });

  frame.classList.remove('hidden');
  frame.src = appUrl;

  // A cached iframe can finish before some browsers report its load event.
  // Never leave the launch screen covering an otherwise usable app forever.
  window.setTimeout(hideLoader, 15000);
})();
