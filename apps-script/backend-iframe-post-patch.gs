/**
 * Chain Watcher backend patch: reliable iframe+POST API transport and fast
 * identity confirmation.
 *
 * 1. Add `confirmMemberIdentityFast` to getApiHandlers_(), next to the existing
 *    confirmMemberIdentity entry:
 *
 *      confirmMemberIdentity,
 *      confirmMemberIdentityFast,
 *
 * 2. Add doPost(e), replace handleApiGet_(e) with this handleApiGet_ wrapper,
 *    and paste the helper functions below near the current JSONP helpers.
 *
 * The GitHub Pages frontend posts API calls into a hidden iframe. The Apps
 * Script response posts the payload back to the parent page. This avoids CORS,
 * avoids script-tag load failures, and keeps the Torn API key out of script src
 * URLs.
 */

function doPost(e) {
  if (e && e.parameter && e.parameter.cwApi === '1') {
    return handleApiRequest_(e);
  }
  return ContentService
    .createTextOutput('Chain Watcher API endpoint')
    .setMimeType(ContentService.MimeType.TEXT);
}

function handleApiGet_(e) {
  return handleApiRequest_(e);
}

function handleApiRequest_(e) {
  const payload = executeApiCall_(e.parameter.fn || '', e.parameter.args || '[]');
  if (String(e.parameter.transport || '') === 'frame') {
    return createFrameApiResponse_(e, payload);
  }

  const callback = sanitizeJsonpCallback_(e.parameter.callback || '');
  const body = `${callback}(${JSON.stringify(payload)});`;
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function createFrameApiResponse_(e, payload) {
  const requestId = String(e.parameter.requestId || '').replace(/[^0-9A-Za-z_$-]/g, '').slice(0, 120);
  const origin = normalizeEmbedOrigin_(e.parameter.origin || 'https://teksi1.github.io');
  const message = {
    source: 'chain-watcher-api',
    requestId,
    payload,
  };
  const html = [
    '<!doctype html><meta charset="utf-8">',
    '<script>',
    '(function(){',
    'var message=',
    safeScriptJson_(message),
    ';',
    'var origin=',
    safeScriptJson_(origin),
    ';',
    'try{window.top.postMessage(message,origin);}catch(ignore){}',
    'try{window.parent.postMessage(message,origin);}catch(ignore){}',
    '}());',
    '</script>',
  ].join('');

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function safeScriptJson_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function confirmMemberIdentityFast(confirmationToken) {
  ensureInstalled_();
  const claims = parseSignedToken_(confirmationToken, 'identity-confirmation');
  const member = getMembers_().find((item) => (
    isAuthorizedScheduleMember_(item) && String(item.id) === String(claims.memberId)
  ));
  if (!member) throw new Error('This faction or manual membership is no longer active. Verify your API key again.');

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + APP.MEMBER_SESSION_DAYS * 86400;
  const sessionToken = createSignedToken_({
    purpose: 'member-session',
    memberId: String(member.id),
    issuedAt: now,
    expiresAt,
  });
  appendAudit_(member.id, member.name, 'Identity confirmed', `${APP.MEMBER_SESSION_DAYS}-day member session issued`);
  return {
    sessionToken,
    expiresAt,
    member: { id: String(member.id), name: member.name },
  };
}
