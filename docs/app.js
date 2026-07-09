(() => {
  const config = window.CHAIN_WATCHER_PAGES_CONFIG || {};
  const appUrl = String(config.appUrl || '').trim();
  const validAppUrl = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#].*)?$/.test(appUrl);

  const setup = document.getElementById('setup');
  const frameError = document.getElementById('frame-error');
  const loader = document.getElementById('loader');
  const frame = document.getElementById('chain-watcher');
  const pagesOrigin = document.getElementById('pages-origin');
  const configuredAppUrl = document.getElementById('configured-app-url');
  const openDirect = document.getElementById('open-direct');

  let receivedHeightMessage = false;
  let iframeLoaded = false;

  if (pagesOrigin) {
    pagesOrigin.textContent = window.location.origin;
  }

  if (configuredAppUrl) {
    configuredAppUrl.textContent = appUrl || '(missing)';
  }

  if (openDirect) {
    openDirect.href = appUrl || '#';
  }

  if (!setup || !loader || !frame) {
    console.error('Chain Watcher Pages wrapper: required elements are missing.');
    return;
  }

  function hideLoader() {
    loader.classList.add('hidden');
  }

  function showSetup() {
    hideLoader();
    frame.classList.add('hidden');
    if (frameError) frameError.classList.add('hidden');
    setup.classList.remove('hidden');
  }

  function showFrameError(reason) {
    // If the Apps Script app reported its height, the iframe is working.
    if (receivedHeightMessage) return;

    console.warn(`Chain Watcher Pages wrapper: iframe did not become ready (${reason}).`);

    hideLoader();
    frame.classList.add('hidden');
    setup.classList.add('hidden');
    if (frameError) frameError.classList.remove('hidden');
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

  function buildFrameUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.searchParams.set('cwWrapper', 'github-pages');
    url.searchParams.set('cwEmbedOrigin', window.location.origin);
    return url.toString();
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'CHAIN_WATCHER_HEIGHT') return;

    // Only accept height messages from the Apps Script iframe.
    if (event.source !== frame.contentWindow) return;
    if (!isAllowedMessageOrigin(event.origin)) return;

    receivedHeightMessage = true;
    setFrameHeight(event.data.height);
    setup.classList.add('hidden');
    if (frameError) frameError.classList.add('hidden');
    frame.classList.remove('hidden');
    hideLoader();
  });

  if (!validAppUrl) {
    showSetup();
    return;
  }

  // Give the iframe a safe starting height before the Apps Script app reports its real height.
  frame.style.minHeight = '100vh';
  frame.style.height = `${Math.max(window.innerHeight, 700)}px`;

  frame.addEventListener('load', () => {
    iframeLoaded = true;

    // Do not hide the loader immediately. A blocked Google iframe can still trigger
    // a load event while only showing "refused to connect". The real app will send
    // CHAIN_WATCHER_HEIGHT shortly after JavaScript starts.
    window.setTimeout(() => {
      if (!receivedHeightMessage) showFrameError('load event without height message');
    }, 5000);
  }, { once: true });

  frame.classList.remove('hidden');
  frame.src = buildFrameUrl(appUrl);

  // If the iframe never reports its real height, show a useful diagnostic instead
  // of leaving the user with Google's generic "refused to connect" page.
  window.setTimeout(() => {
    if (!receivedHeightMessage) {
      showFrameError(iframeLoaded ? 'timeout after load' : 'timeout before load');
    }
  }, 12000);
})();
