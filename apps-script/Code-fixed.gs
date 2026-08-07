/**
 * Chain Watcher v2.8.4
 * Google Apps Script web app backed by a Google Sheet.
 */

const APP = Object.freeze({
  NAME: 'Chain Watcher',
  VERSION: '2.8.4',
  AUTHOR: 'CEO [4228347]',
  TIME_ZONE: 'GMT',
  DEFAULT_FACTION_ID: '45151',
  DEFAULT_START: '2026-07-14T12:00:00.000Z',
  DEFAULT_END: '2026-07-17T12:00:00.000Z',
  STATUS_OPTIONS: ['Online', 'Watching', 'DUMP', 'Offline'],
  ALLOWED_SLOT_MINUTES: [15, 30, 60],
  ALLOWED_REFRESH_MINUTES: [1, 5, 10, 15, 30],
  MAX_SLOTS: 1500,
  MAX_MANUAL_MEMBERS: 25,
  DISCORD_HORIZON_HOURS: 6,
  DISCORD_NAMES_PER_STATUS: 6,
  MEMBER_SESSION_DAYS: 30,
  IDENTITY_CONFIRM_MINUTES: 10,
  CUSTOM_KEY_URL: 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=UnbrokenChain&user=basic',
  REPORT_SHEET_PREFIX: 'CW_',
});

const SHEETS = Object.freeze({
  CONFIG: 'Config',
  MEMBERS: 'Members',
  AVAILABILITY: 'Availability',
  AUDIT: 'Audit Log',
  LOGS: 'Logs',
});

const HEADERS = Object.freeze({
  CONFIG: ['Key', 'Value'],
  MEMBERS: [
    'Member ID', 'Name', 'Position', 'Level', 'Active', 'Torn activity',
    'Last action UTC', 'Last action relative', 'Torn state', 'State detail', 'Updated UTC', 'Manual',
  ],
  AVAILABILITY: ['Member ID', 'Slot UTC', 'Status', 'Updated UTC'],
  AUDIT: ['Timestamp UTC', 'Member ID', 'Member', 'Action', 'Details'],
  LOGS: [
    'TimestampUtc',
    'TimestampTct',
    'Level',
    'Category',
    'Action',
    'ActorId',
    'ActorName',
    'TargetId',
    'TargetName',
    'Source',
    'Outcome',
    'Message',
    'RequestId',
    'AppVersion',
    'DetailsJson',
  ],
});

const DEFAULT_CONFIG = Object.freeze({
  VERSION: APP.VERSION,
  FACTION_ID: APP.DEFAULT_FACTION_ID,
  FACTION_NAME: 'Unbroken Valkyries',
  WEEKEND_START: APP.DEFAULT_START,
  WEEKEND_END: APP.DEFAULT_END,
  SLOT_MINUTES: '60',
  STATUS_REFRESH_MINUTES: '5',
  LAST_MEMBER_SYNC: '',
  LAST_STATUS_SYNC: '',
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Chain Watcher')
    .addItem('Asenna / korjaa rakenne', 'setupChainWatcher')
    .addItem('Aseta salaisuudet', 'configureSecrets')
    .addSeparator()
    .addItem('Synkronoi factionin jÃ¤senet', 'syncFactionMembers')
    .addItem('PÃ¤ivitÃ¤ Torn-tilat nyt', 'refreshTornStatus')
    .addItem('Luo 5 min pÃ¤ivitysajastin', 'installStatusTrigger')
    .addItem('Create current event report', 'createCurrentEventSheet')
    .addSeparator()
    .addItem('Avaa sivupaneeli', 'showSidebar')
    .addToUi();
}

function doGet(e) {
  if (e && e.parameter && e.parameter.cwApi === '1') {
    return handleApiGet_(e);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.embedAllowedOrigin = getEmbedAllowedOrigin_();

  // Keep iframe embedding allowed, but disable the custom embed guard.
  // Google Apps Script can run the web app inside Google's own wrapper/sandbox,
  // which may otherwise trigger a false "Embedding blocked" state even on /exec.
  template.embedGuardEnabled = false;

  return template.evaluate()
    .setTitle(`${APP.NAME} v.${APP.VERSION}, Made by ${APP.AUTHOR}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * API endpoint for the GitHub Pages frontend.
 *
 * The primary transport is a hidden iframe + POST + postMessage response. A
 * JSONP fallback is still kept for older published frontends because Apps
 * Script web apps cannot reliably return custom CORS headers.
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

function sanitizeJsonpCallback_(callback) {
  const value = String(callback || '').trim();
  if (/^[A-Za-z_$][0-9A-Za-z_$]{0,80}$/.test(value)) return value;
  // Keep the response valid JavaScript even for malformed requests.
  return 'ChainWatcherInvalidCallback';
}

function executeApiCall_(functionName, argsJson) {
  try {
    const api = getApiHandlers_();
    const name = String(functionName || '').trim();
    if (!Object.prototype.hasOwnProperty.call(api, name)) {
      throw new Error(`Unknown or blocked API function: ${name}`);
    }

    const args = JSON.parse(String(argsJson || '[]'));
    if (!Array.isArray(args)) throw new Error('API args must be an array.');

    const result = api[name].apply(null, args);
    return { ok: true, result };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logEvent_({
      level: 'ERROR',
      category: 'api',
      action: 'api_call_failed',
      source: 'backend',
      outcome: 'failure',
      message,
      details: {
        functionName,
      },
    });
    return {
      ok: false,
      error: message,
    };
  }
}

function getApiHandlers_() {
  return Object.freeze({
    getAppData,
    saveAvailability,
    verifyMemberApiKey,
    confirmMemberIdentity,
    confirmMemberIdentityFast,
    getAdminState,
    saveAdminSettings,
    changeAdminSecret,
    adminSyncMembers,
    adminRefreshStatuses,
    adminInstallStatusTrigger,
    adminInstallDiscordTrigger,
    adminSendDiscordUpdate,
    adminCreateEventSheet,
    adminExportEventCsv,
    adminAddManualMember,
    adminRemoveManualMember,
    adminGetLogs,
  });
}


function showSidebar() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.embedAllowedOrigin = '';
  template.embedGuardEnabled = false;
  const html = template.evaluate()
    .setTitle(`${APP.NAME} v.${APP.VERSION}`);
  SpreadsheetApp.getUi().showSidebar(html);
}

function setupChainWatcher() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Avaa Google Sheet ja suorita asennus siihen sidotusta Apps Script -projektista.');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureSessionSecret_();
  ensureSheets_(ss);
  const spreadsheetTimeZoneSet = setSpreadsheetTimeZoneIfAvailable_(ss);
  writeMissingDefaults_();
  formatSheets_(ss);

  showSpreadsheetAlertIfAvailable_(
    'Chain Watcher on asennettu',
    'Valitse seuraavaksi Chain Watcher â†’ Aseta salaisuudet. Sen jÃ¤lkeen synkronoi jÃ¤senet ja luo pÃ¤ivitysajastin.'
      + (spreadsheetTimeZoneSet ? '' : ' Google Sheetsin aikavyÃ¶hykettÃ¤ ei voitu vaihtaa, mutta Chain Watcher kÃ¤yttÃ¤Ã¤ silti TCT/UTC-aikaa oikein.'),
  );
  logEvent_({
    level: 'INFO',
    category: 'system',
    action: 'setup_chain_watcher',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Chain Watcher setup completed',
    details: {
      spreadsheetId: ss.getId(),
      spreadsheetTimeZoneSet,
    },
  });
  return { ok: true, spreadsheetId: ss.getId(), spreadsheetTimeZoneSet };
}

function setSpreadsheetTimeZoneIfAvailable_(ss) {
  try {
    ss.setSpreadsheetTimeZone(APP.TIME_ZONE);
    return true;
  } catch (error) {
    console.warn(`Spreadsheet timezone could not be changed to ${APP.TIME_ZONE}: ${error.message || error}`);
    return false;
  }
}

function showSpreadsheetAlertIfAvailable_(title, message) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(title, message, ui.ButtonSet.OK);
    return true;
  } catch (error) {
    // Apps Script editor, triggers and some deployment contexts have no Sheet UI.
    console.log(`${title}: ${message}`);
    return false;
  }
}

function configureSecrets() {
  ensureInstalled_();
  const ui = SpreadsheetApp.getUi();
  const admin = ui.prompt(
    'Admin-salasana',
    'SyÃ¶tÃ¤ vahva salasana web-sovelluksen admin-asetuksia varten. TyhjÃ¤ vastaus sÃ¤ilyttÃ¤Ã¤ nykyisen.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (admin.getSelectedButton() === ui.Button.OK && admin.getResponseText().trim()) {
    setAdminSecret_(admin.getResponseText().trim());
  }

  const api = ui.prompt(
    'Torn API -avain',
    'SyÃ¶tÃ¤ Public access -tasoinen Torn API -avain. Avain tallennetaan vain Script Propertiesiin. TyhjÃ¤ vastaus sÃ¤ilyttÃ¤Ã¤ nykyisen.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (api.getSelectedButton() === ui.Button.OK && api.getResponseText().trim()) {
    PropertiesService.getScriptProperties().setProperty('TORN_API_KEY', api.getResponseText().trim());
  }
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'configure_secrets',
    actorName: 'Sheet editor',
    source: 'spreadsheet_menu',
    outcome: 'success',
    message: 'Secrets configured from spreadsheet menu',
    details: {
      adminSecretProvided: admin.getSelectedButton() === ui.Button.OK && Boolean(admin.getResponseText().trim()),
      apiKeyProvided: api.getSelectedButton() === ui.Button.OK && Boolean(api.getResponseText().trim()),
    },
  });
  ui.alert('Salaisuudet tallennettu. API-avainta ei kirjoitettu taulukkoon.');
}

function testLoggingOnce() {
  logEvent_({
    level: 'INFO',
    category: 'system',
    action: 'logging_test',
    actorId: '4228347',
    actorName: 'CEO',
    source: 'backend',
    outcome: 'success',
    message: 'Logging test from Apps Script',
    details: {
      test: true,
      apiKeyProvided: true,
    },
  });
}

function syncFactionMembers() {
  ensureInstalled_();
  const result = syncFactionMembers_({ includeBasic: true });
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'menu_sync_members',
    actorName: 'Sheet editor',
    source: 'spreadsheet_menu',
    outcome: 'success',
    message: 'Faction members synced from spreadsheet menu',
    details: result,
  });
  try {
    SpreadsheetApp.getUi().alert(`${result.count} factionin jÃ¤sentÃ¤ synkronoitu.`);
  } catch (ignore) {
    // Trigger/web-app execution has no spreadsheet UI.
  }
  return result;
}

function refreshTornStatus() {
  ensureInstalled_();
  const result = syncFactionMembers_({ includeBasic: false, statusOnly: true });
  logEvent_({
    level: 'INFO',
    category: 'system',
    action: 'refresh_torn_status',
    source: 'trigger_or_menu',
    outcome: 'success',
    message: 'Torn statuses refreshed',
    details: result,
  });
  return result;
}

function installStatusTrigger() {
  ensureInstalled_();
  const config = getConfig_();
  const minutes = Number(config.STATUS_REFRESH_MINUTES || 5);
  installStatusTrigger_(minutes);
  try {
    SpreadsheetApp.getUi().alert(`Torn-tilat pÃ¤ivitetÃ¤Ã¤n nyt ${minutes} minuutin vÃ¤lein.`);
  } catch (ignore) {
    // No UI in web app execution.
  }
  return { minutes };
}

function getAppData(sessionToken) {
  ensureInstalled_();
  const config = getConfig_();
  const slots = generateSlots_(config);
  const members = getMembers_().filter((member) => member.active);
  const memberById = members.reduce((result, member) => {
    result[String(member.id)] = member;
    return result;
  }, {});
  const authenticatedMember = resolveSessionMember_(sessionToken, members);
  const identityVerified = Boolean(authenticatedMember);
  const selectedId = authenticatedMember ? String(authenticatedMember.id) : '';

  const slotSet = new Set(slots);
  const availabilityRows = identityVerified
    ? getAvailability_().filter((row) => slotSet.has(row.slotIso) && memberById[String(row.memberId)])
    : [];
  const coverage = buildCoverage_(slots, identityVerified ? members : [], availabilityRows);
  const selectedAvailability = {};
  availabilityRows.forEach((row) => {
    if (String(row.memberId) === selectedId) selectedAvailability[row.slotIso] = row.status;
  });

  const now = Date.now();
  const slotMs = Number(config.SLOT_MINUTES) * 60000;
  const currentCoverage = coverage.find((slot) => {
    const start = Date.parse(slot.iso);
    return start <= now && now < start + slotMs;
  }) || null;
  const currentMemberStatuses = identityVerified
    ? buildCurrentMemberStatuses_(currentCoverage, members, availabilityRows)
    : [];
  const liveCounts = { Online: 0, Idle: 0, Offline: 0, Unknown: 0 };
  (identityVerified ? members : []).forEach((member) => {
    const key = normalizeLiveStatus_(member.liveStatus);
    liveCounts[key] = (liveCounts[key] || 0) + 1;
  });
  const responded = new Set(availabilityRows.map((row) => String(row.memberId))).size;
  const props = PropertiesService.getScriptProperties();

  return {
    meta: {
      appName: APP.NAME,
      version: APP.VERSION,
      author: APP.AUTHOR,
      title: `${APP.NAME} v.${APP.VERSION}, Made by ${APP.AUTHOR}`,
      factionId: String(config.FACTION_ID || ''),
      factionName: config.FACTION_NAME || `Faction #${config.FACTION_ID}`,
      start: config.WEEKEND_START,
      end: config.WEEKEND_END,
      slotMinutes: Number(config.SLOT_MINUTES),
      refreshMinutes: Number(config.STATUS_REFRESH_MINUTES || 5),
      lastMemberSync: config.LAST_MEMBER_SYNC || '',
      lastStatusSync: config.LAST_STATUS_SYNC || '',
      apiConfigured: Boolean(props.getProperty('TORN_API_KEY')),
      adminConfigured: Boolean(props.getProperty('ADMIN_SECRET_HASH')),
      customKeyUrl: APP.CUSTOM_KEY_URL,
    },
    stats: {
      memberCount: identityVerified ? members.length : 0,
      responded,
      currentOnline: currentCoverage ? currentCoverage.onlineCount : 0,
      currentWatching: currentCoverage ? currentCoverage.watchingCount : 0,
      currentDump: currentCoverage ? currentCoverage.dumpCount : 0,
      tornOnline: liveCounts.Online || 0,
      tornIdle: liveCounts.Idle || 0,
      tornOffline: liveCounts.Offline || 0,
    },
    members: identityVerified ? members : [],
    selectedMemberId: selectedId,
    selectedAvailability,
    slots: coverage,
    currentMemberStatuses,
    auth: authenticatedMember ? {
      authenticated: true,
      member: { id: String(authenticatedMember.id), name: authenticatedMember.name },
    } : {
      authenticated: false,
      member: null,
    },
  };
}

function saveAvailability(sessionToken, updates) {
  ensureInstalled_();
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > APP.MAX_SLOTS) {
    throw new Error('The schedule is missing or contains too many updates.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const config = getConfig_();
    const validSlots = new Set(generateSlots_(config));
    const member = requireSessionMember_(sessionToken);

    const normalized = {};
    updates.forEach((update) => {
      const slotIso = toIso_(update.slot);
      const status = normalizeScheduleStatusOrEmpty_(update.status);
      if (!validSlots.has(slotIso)) throw new Error(`Aika ${slotIso} ei kuulu nykyiseen Chain Weekendiin.`);
      normalized[slotIso] = status;
    });

    const sheet = getSpreadsheet_().getSheetByName(SHEETS.AVAILABILITY);
    const existing = getAvailability_();
    const byKey = {};
    existing.forEach((row) => {
      byKey[`${row.memberId}|${row.slotIso}`] = row;
    });

    const changes = [];
    Object.keys(normalized).sort().forEach((slotIso) => {
      const key = `${member.id}|${slotIso}`;
      const previousStatus = byKey[key] && byKey[key].status ? byKey[key].status : '';
      const nextStatus = normalized[slotIso] || '';
      if (previousStatus !== nextStatus) {
        changes.push({
          slotUtc: slotIso,
          slotTct: formatLogSlot_(slotIso),
          from: previousStatus || 'Not set',
          to: nextStatus || 'Not set',
        });
      }
    });

    const now = new Date();
    Object.keys(normalized).forEach((slotIso) => {
      const key = `${member.id}|${slotIso}`;
      if (!normalized[slotIso]) {
        delete byKey[key];
        return;
      }
      byKey[key] = {
        memberId: String(member.id),
        slotIso,
        status: normalized[slotIso],
        updatedAt: now,
      };
    });

    const rows = Object.keys(byKey)
      .map((key) => byKey[key])
      .sort((a, b) => a.slotIso.localeCompare(b.slotIso) || String(a.memberId).localeCompare(String(b.memberId)))
      .map((row) => [String(row.memberId), new Date(row.slotIso), row.status, row.updatedAt || now]);
    rewriteDataRows_(sheet, rows, HEADERS.AVAILABILITY.length);
    formatAvailabilitySheet_(sheet);

    appendAudit_(
      member.id,
      member.name,
      'Availability saved',
      `${Object.keys(normalized).length} submitted slot(s), ${changes.length} changed`,
      { skipLog: true },
    );

    logEvent_({
      level: 'INFO',
      category: 'schedule',
      action: 'schedule_saved',
      actorId: String(member.id),
      actorName: String(member.name || ''),
      source: 'frontend',
      outcome: 'success',
      message: buildScheduleLogMessage_(changes, Object.keys(normalized).length),
      details: {
        submittedSlotCount: Object.keys(normalized).length,
        changedSlotCount: changes.length,
        changes,
      },
    });
  } finally {
    lock.releaseLock();
  }
  return getAppData(sessionToken);
}

function verifyMemberApiKey(apiKey) {
  ensureInstalled_();
  const key = String(apiKey || '').trim();
  if (key.length < 8 || key.length > 128) throw new Error('Enter a valid Torn custom API key.');

  const identity = fetchTornIdentity_(key);
  const member = getMembers_().find((item) => (
    isAuthorizedScheduleMember_(item) && String(item.id) === String(identity.id)
  ));
  if (!member) {
    throw new Error(`Torn user ${identity.name} [${identity.id}] is not an active faction member or an approved manual member.`);
  }

  const confirmationToken = createSignedToken_({
    purpose: 'identity-confirmation',
    memberId: String(member.id),
    expiresAt: Math.floor(Date.now() / 1000) + APP.IDENTITY_CONFIRM_MINUTES * 60,
  });
  appendAudit_(member.id, member.name, 'Identity API key verified', 'Awaiting member confirmation');
  return {
    confirmationToken,
    member: { id: String(member.id), name: member.name },
    factionName: getConfig_().FACTION_NAME,
  };
}

function confirmMemberIdentity(confirmationToken) {
  ensureInstalled_();
  const claims = parseSignedToken_(confirmationToken, 'identity-confirmation');
  const member = getMembers_().find((item) => (
    isAuthorizedScheduleMember_(item) && String(item.id) === String(claims.memberId)
  ));
  if (!member) throw new Error('This faction or manual membership is no longer active. Verify your API key again.');

  const now = Math.floor(Date.now() / 1000);
  const sessionToken = createSignedToken_({
    purpose: 'member-session',
    memberId: String(member.id),
    issuedAt: now,
    expiresAt: now + APP.MEMBER_SESSION_DAYS * 86400,
  });
  appendAudit_(member.id, member.name, 'Identity confirmed', `${APP.MEMBER_SESSION_DAYS}-day member session issued`);
  return {
    sessionToken,
    data: getAppData(sessionToken),
  };
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

function fetchTornIdentity_(apiKey) {
  const url = 'https://api.torn.com/v2/user/basic?striptags=true&comment=UnbrokenChainIdentity';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `ApiKey ${apiKey}` },
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`Torn API returned an invalid identity response (HTTP ${code}).`);
  }
  if (code < 200 || code >= 300 || body.error) {
    const apiError = body.error || {};
    const message = apiError.error || apiError.message || `HTTP ${code}`;
    logEvent_({
      level: 'WARN',
      category: 'identity',
      action: 'identity_api_key_verify_failed',
      source: 'backend',
      outcome: 'failure',
      message: `Torn API could not verify identity key: ${message}`,
      details: {
        httpStatus: code,
        apiKeyProvided: true,
      },
    });
    throw new Error(`Torn API could not verify this key: ${message}`);
  }

  const raw = body.basic || body.profile || body.user || body;
  const id = raw.id || raw.player_id || raw.playerId;
  const name = raw.name;
  if (!id || !name) throw new Error('Torn API did not return the key owner identity. Generate a key with user â†’ basic access.');
  return { id: String(id), name: String(name) };
}

function normalizeEmbedOrigin_(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  const match = input.match(/^(https:\/\/[a-z0-9.-]+(?::\d+)?)(?:[\/?#].*)?$/i);
  if (!match) throw new Error('GitHub Pages origin must be an HTTPS address, for example https://username.github.io');
  return match[1].toLowerCase();
}

function getEmbedAllowedOrigin_() {
  const stored = PropertiesService.getScriptProperties().getProperty('EMBED_ALLOWED_ORIGIN');
  try {
    return normalizeEmbedOrigin_(stored);
  } catch (error) {
    console.warn(`Ignoring invalid EMBED_ALLOWED_ORIGIN: ${error.message}`);
    return '';
  }
}

function ensureSessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('MEMBER_SESSION_SECRET');
  if (!secret) {
    secret = `${Utilities.getUuid()}${Utilities.getUuid()}`;
    props.setProperty('MEMBER_SESSION_SECRET', secret);
  }
  return secret;
}

function createSignedToken_(claims) {
  const payload = Object.assign({ version: 1 }, claims || {});
  const encoded = Utilities.base64EncodeWebSafe(
    JSON.stringify(payload),
    Utilities.Charset.UTF_8,
  ).replace(/=+$/g, '');
  const signature = Utilities.computeHmacSha256Signature(
    encoded,
    ensureSessionSecret_(),
    Utilities.Charset.UTF_8,
  );
  const encodedSignature = Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '');
  return `${encoded}.${encodedSignature}`;
}

function parseSignedToken_(token, expectedPurpose) {
  const value = String(token || '').trim();
  if (!value || value.length > 2048) throw new Error('Your member session is missing or invalid. Verify your Torn API key again.');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('Your member session is invalid. Verify your Torn API key again.');

  const expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(
      parts[0],
      ensureSessionSecret_(),
      Utilities.Charset.UTF_8,
    ),
  ).replace(/=+$/g, '');
  if (!timingSafeEqual_(parts[1], expectedSignature)) {
    throw new Error('Your member session signature is invalid. Verify your Torn API key again.');
  }

  let claims;
  try {
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    throw new Error('Your member session could not be read. Verify your Torn API key again.');
  }
  if (claims.version !== 1 || claims.purpose !== expectedPurpose || !claims.memberId) {
    throw new Error('Your member session has the wrong scope. Verify your Torn API key again.');
  }
  if (!Number.isFinite(Number(claims.expiresAt)) || Number(claims.expiresAt) <= Math.floor(Date.now() / 1000)) {
    throw new Error('Your member session has expired. Verify your Torn API key again.');
  }
  return claims;
}

function resolveSessionMember_(sessionToken, members) {
  try {
    const claims = parseSignedToken_(sessionToken, 'member-session');
    return (members || []).find((member) => (
      isAuthorizedScheduleMember_(member) && String(member.id) === String(claims.memberId)
    )) || null;
  } catch (error) {
    return null;
  }
}

function isAuthorizedScheduleMember_(member) {
  // Faction members and admin-approved manual members both live in Members.
  // Former faction members are retained for history but have active = false.
  return Boolean(member && member.active);
}

function requireSessionMember_(sessionToken) {
  const members = getMembers_();
  const member = resolveSessionMember_(sessionToken, members);
  if (!member) throw new Error('Identity verification is required before editing a Chain Watch schedule.');
  return member;
}

function getAdminState(secret, options) {
  assertAdmin_(secret);
  if (!(options && options.silent)) logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_login_success',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin state unlocked',
  });
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const manualMembers = getMembers_()
    .filter((member) => member.manual)
    .map((member) => ({
      id: member.id,
      name: member.name,
      liveStatus: member.liveStatus,
      lastActionRelative: member.lastActionRelative,
    }));
  return {
    factionId: String(config.FACTION_ID),
    factionName: config.FACTION_NAME,
    start: config.WEEKEND_START,
    end: config.WEEKEND_END,
    slotMinutes: Number(config.SLOT_MINUTES),
    refreshMinutes: Number(config.STATUS_REFRESH_MINUTES || 5),
    apiConfigured: Boolean(props.getProperty('TORN_API_KEY')),
    discordConfigured: Boolean(props.getProperty('DISCORD_WEBHOOK_URL')),
    discordTriggerInstalled: hasTrigger_('sendDiscordChainWebhook'),
    discordLastPostHour: props.getProperty('DISCORD_LAST_POST_HOUR') || '',
    embedOrigin: getEmbedAllowedOrigin_(),
    manualMembers,
  };
}

function saveAdminSettings(settings, secret) {
  assertAdmin_(secret);
  settings = settings || {};
  const oldConfig = getConfig_();
  const factionId = String(settings.factionId || '').trim();
  if (!/^\d+$/.test(factionId)) throw new Error('Faction ID must be a positive number.');

  const start = toIso_(settings.start);
  const end = toIso_(settings.end);
  const slotMinutes = Number(settings.slotMinutes);
  const refreshMinutes = Number(settings.refreshMinutes || 5);
  validateWeekend_(start, end, slotMinutes);
  if (!APP.ALLOWED_REFRESH_MINUTES.includes(refreshMinutes)) {
    throw new Error(`Refresh interval must be ${APP.ALLOWED_REFRESH_MINUTES.join(', ')} minutes.`);
  }

  const factionChanged = String(oldConfig.FACTION_ID) !== factionId;
  const eventChanged = (
    factionChanged
    || String(oldConfig.WEEKEND_START) !== start
    || String(oldConfig.WEEKEND_END) !== end
    || Number(oldConfig.SLOT_MINUTES) !== slotMinutes
  );
  let archivedReport = null;
  if (eventChanged && getMembers_().length && oldConfig.WEEKEND_START && oldConfig.WEEKEND_END) {
    archivedReport = createEventSheet_({
      start: oldConfig.WEEKEND_START,
      end: oldConfig.WEEKEND_END,
      slotMinutes: Number(oldConfig.SLOT_MINUTES),
    });
  }

  setConfigValues_({
    FACTION_ID: factionId,
    FACTION_NAME: factionChanged ? `Faction #${factionId}` : oldConfig.FACTION_NAME,
    WEEKEND_START: start,
    WEEKEND_END: end,
    SLOT_MINUTES: String(slotMinutes),
    STATUS_REFRESH_MINUTES: String(refreshMinutes),
  });
  if (String(settings.apiKey || '').trim()) {
    PropertiesService.getScriptProperties().setProperty('TORN_API_KEY', String(settings.apiKey).trim());
  }
  if (String(settings.discordWebhookUrl || '').trim()) {
    PropertiesService.getScriptProperties().setProperty(
      'DISCORD_WEBHOOK_URL',
      normalizeDiscordWebhookUrl_(settings.discordWebhookUrl),
    );
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'embedOrigin')) {
    const embedOrigin = normalizeEmbedOrigin_(settings.embedOrigin);
    const props = PropertiesService.getScriptProperties();
    if (embedOrigin) props.setProperty('EMBED_ALLOWED_ORIGIN', embedOrigin);
    else props.deleteProperty('EMBED_ALLOWED_ORIGIN');
  }
  installStatusTrigger_(refreshMinutes);
  appendAudit_('', 'Admin', 'Settings updated', `${start} â€“ ${end}, faction ${factionId}`);
  const adminState = getAdminState(secret, { silent: true });
  adminState.archivedReport = archivedReport;
  return adminState;
}

function changeAdminSecret(currentSecret, newSecret) {
  assertAdmin_(currentSecret);
  if (String(newSecret || '').trim().length < 10) {
    throw new Error('The new admin password must contain at least 10 characters.');
  }
  setAdminSecret_(String(newSecret).trim());
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_secret_changed',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin password changed',
  });
  return { ok: true };
}

function adminSyncMembers(secret) {
  assertAdmin_(secret);
  const result = syncFactionMembers_({ includeBasic: true });
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_sync_members',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin synced members',
    details: result,
  });
  return result;
}

function adminRefreshStatuses(secret) {
  assertAdmin_(secret);
  const result = syncFactionMembers_({ includeBasic: false, statusOnly: true });
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_refresh_statuses',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin refreshed Torn statuses',
    details: result,
  });
  return result;
}

function adminInstallStatusTrigger(secret) {
  assertAdmin_(secret);
  const minutes = Number(getConfig_().STATUS_REFRESH_MINUTES || 5);
  installStatusTrigger_(minutes);
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_install_status_trigger',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin installed status trigger',
    details: { minutes },
  });
  return { ok: true, minutes };
}

function adminInstallDiscordTrigger(secret) {
  assertAdmin_(secret);
  installDiscordTrigger_();
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_install_discord_trigger',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin installed Discord hourly trigger',
    details: { horizonHours: APP.DISCORD_HORIZON_HOURS },
  });
  return getAdminState(secret, { silent: true });
}

function adminSendDiscordUpdate(secret) {
  assertAdmin_(secret);
  const result = postDiscordChainUpdate_({ force: true, source: 'admin' });
  logEvent_({
    level: 'INFO',
    category: 'admin',
    action: 'admin_send_discord_update',
    actorName: 'Admin',
    source: 'backend',
    outcome: 'success',
    message: 'Admin sent Discord Chain Watcher update',
    details: result,
  });
  return result;
}

function sendDiscordChainWebhook() {
  return postDiscordChainUpdate_({ force: false, source: 'trigger' });
}

/**
 * Creates or refreshes a readable report tab for the requested date range.
 * The range is independent from the active event, so an admin can also
 * regenerate a report for an older Chain Weekend without changing Config.
 */
function adminCreateEventSheet(range, secret) {
  assertAdmin_(secret);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const result = createEventSheet_(range);
    appendAudit_('', 'Admin', 'Event report created', `${result.sheetName}: ${result.start} â€“ ${result.end}`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Returns a UTF-8 CSV export to the authenticated admin browser. */
function adminExportEventCsv(range, secret) {
  assertAdmin_(secret);
  const report = getEventReport_(range);
  const csv = eventReportToCsv_(report);
  appendAudit_('', 'Admin', 'Event CSV exported', `${report.start} â€“ ${report.end}`);
  return {
    fileName: `${eventReportSheetName_(report)}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    contentBase64: Utilities.base64Encode(`\uFEFF${csv}`, Utilities.Charset.UTF_8),
    memberCount: report.members.length,
    slotCount: report.slots.length,
  };
}

/** Spreadsheet-menu shortcut for editors of the backing Sheet. */
function createCurrentEventSheet() {
  ensureInstalled_();
  const result = createEventSheet_({});
  SpreadsheetApp.getUi().alert(
    'Chain Watch report created',
    `${result.sheetName}\n${result.memberCount} members, ${result.slotCount} time slots`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

function adminAddManualMember(tornId, secret) {
  assertAdmin_(secret);
  const id = String(tornId || '').trim();
  if (!/^\d+$/.test(id) || Number(id) < 1) throw new Error('Enter a valid numeric Torn user ID.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existing = getMembers_();
    const existingMember = existing.find((member) => String(member.id) === id);
    const manualCount = existing.filter((member) => member.manual && String(member.id) !== id).length;
    if ((!existingMember || !existingMember.manual) && manualCount >= APP.MAX_MANUAL_MEMBERS) {
      throw new Error(`A maximum of ${APP.MAX_MANUAL_MEMBERS} manual members is supported.`);
    }

    const profile = normalizeTornProfile_(fetchTornUserProfile_(id), id);
    profile.manual = true;
    profile.active = true;
    if (existingMember && existingMember.position) profile.position = existingMember.position;

    const updated = existing.filter((member) => String(member.id) !== id);
    updated.push(profile);
    writeMembers_(updated);
    appendAudit_(id, profile.name, 'Manual member added', 'Profile refreshes with scheduled status updates');
    return getAdminState(secret, { silent: true });
  } finally {
    lock.releaseLock();
  }
}

function adminRemoveManualMember(tornId, secret) {
  assertAdmin_(secret);
  const id = String(tornId || '').trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const existing = getMembers_();
    const member = existing.find((item) => String(item.id) === id && item.manual);
    if (!member) throw new Error('Manual member was not found.');
    writeMembers_(existing.filter((item) => String(item.id) !== id), { dropIds: [id] });
    appendAudit_(id, member.name, 'Manual member removed', 'Availability history was preserved');
    return getAdminState(secret, { silent: true });
  } finally {
    lock.releaseLock();
  }
}

function adminGetLogs(filters, secret) {
  assertAdmin_(secret);
  return getReadableLogs_(filters || {});
}

function syncFactionMembers_(options) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const config = getConfig_();
    const factionId = String(config.FACTION_ID);
    const membersResponse = fetchTorn_(factionId, 'members');
    const factionMembers = normalizeTornMembers_(membersResponse);
    if (!factionMembers.length) throw new Error('Torn API did not return any faction members.');

    const factionIds = new Set(factionMembers.map((member) => String(member.id)));
    const existingManual = getMembers_().filter((member) => member.manual);
    const manualMembers = [];
    existingManual.filter((member) => !factionIds.has(String(member.id))).forEach((member) => {
      try {
        const refreshed = normalizeTornProfile_(fetchTornUserProfile_(member.id), member.id);
        refreshed.manual = true;
        refreshed.active = true;
        manualMembers.push(refreshed);
      } catch (error) {
        console.warn(`Manual member ${member.id} refresh failed: ${error.message}`);
        manualMembers.push(member);
      }
    });
    const members = factionMembers.concat(manualMembers);

    let factionName = config.FACTION_NAME;
    if (options && options.includeBasic) {
      const basicResponse = fetchTorn_(factionId, 'basic');
      const basic = basicResponse.basic || basicResponse.faction || basicResponse;
      factionName = basic.name || factionName || `Faction #${factionId}`;
    }
    writeMembers_(members);
    const nowIso = new Date().toISOString();
    const changes = {
      FACTION_NAME: factionName,
      LAST_STATUS_SYNC: nowIso,
    };
    if (!(options && options.statusOnly)) changes.LAST_MEMBER_SYNC = nowIso;
    setConfigValues_(changes);
    return { count: members.length, manualCount: existingManual.length, factionName, syncedAt: nowIso };
  } finally {
    lock.releaseLock();
  }
}

function fetchTorn_(factionId, selection) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('TORN_API_KEY');
  if (!apiKey) throw new Error('The Torn API key has not been configured. Use Chain Watcher â†’ Aseta salaisuudet in Google Sheets.');
  const url = `https://api.torn.com/v2/faction/${encodeURIComponent(factionId)}/${selection}`
    + '?striptags=true&comment=ChainWatcher';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `ApiKey ${apiKey}` },
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`Torn API returned an invalid response (HTTP ${code}).`);
  }
  if (code < 200 || code >= 300 || body.error) {
    const apiError = body.error || {};
    const message = apiError.error || apiError.message || JSON.stringify(apiError) || `HTTP ${code}`;
    logEvent_({
      level: 'ERROR',
      category: 'torn_api',
      action: 'torn_api_failed',
      source: 'backend',
      outcome: 'failure',
      message: `Torn API: ${message}`,
      details: {
        factionId,
        selection,
        httpStatus: code,
      },
    });
    throw new Error(`Torn API: ${message}`);
  }
  return body;
}

function fetchTornUserProfile_(userId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('TORN_API_KEY');
  if (!apiKey) throw new Error('The Torn API key has not been configured.');
  const url = `https://api.torn.com/v2/user/${encodeURIComponent(String(userId))}/profile`
    + '?striptags=true&comment=ChainWatcher';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `ApiKey ${apiKey}` },
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`Torn API returned an invalid profile response (HTTP ${code}).`);
  }
  if (code < 200 || code >= 300 || body.error) {
    const apiError = body.error || {};
    const message = apiError.error || apiError.message || JSON.stringify(apiError) || `HTTP ${code}`;
    logEvent_({
      level: 'ERROR',
      category: 'torn_api',
      action: 'torn_user_profile_failed',
      targetId: String(userId || ''),
      source: 'backend',
      outcome: 'failure',
      message: `Torn API: ${message}`,
      details: {
        userId: String(userId || ''),
        httpStatus: code,
      },
    });
    throw new Error(`Torn API: ${message}`);
  }
  return body;
}

function normalizeTornMembers_(response) {
  const source = response && response.members ? response.members : [];
  const list = Array.isArray(source)
    ? source
    : Object.keys(source).map((id) => Object.assign({ id }, source[id]));
  return list.map((raw) => {
    const lastAction = raw.last_action || raw.lastAction || {};
    const state = raw.status || {};
    const id = raw.id || raw.player_id || raw.playerId;
    return {
      id: String(id),
      name: String(raw.name || `Member ${id}`),
      position: String(raw.position || raw.position_name || ''),
      level: Number(raw.level || 0),
      active: true,
      liveStatus: normalizeLiveStatus_(lastAction.status),
      lastActionTimestamp: Number(lastAction.timestamp || 0),
      lastActionRelative: String(lastAction.relative || ''),
      tornState: String(state.state || ''),
      stateDetail: String(state.description || state.details || ''),
    };
  }).filter((member) => member.id && member.id !== 'undefined')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeTornProfile_(response, fallbackId) {
  const raw = (response && (response.profile || response.user)) || response || {};
  const lastAction = raw.last_action || raw.lastAction || {};
  const state = raw.status || {};
  const id = raw.id || raw.player_id || raw.playerId || fallbackId;
  if (!id || !raw.name) throw new Error('Torn API profile response did not contain a valid user.');
  return {
    id: String(id),
    name: String(raw.name),
    position: 'Manual',
    level: Number(raw.level || 0),
    active: true,
    manual: true,
    liveStatus: normalizeLiveStatus_(lastAction.status),
    lastActionTimestamp: Number(lastAction.timestamp || 0),
    lastActionRelative: String(lastAction.relative || ''),
    tornState: String(state.state || ''),
    stateDetail: String(state.description || state.details || ''),
  };
}

function writeMembers_(members, options) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.MEMBERS);
  const existing = getMembers_();
  const dropIds = new Set(((options && options.dropIds) || []).map(String));
  const manualIds = new Set(existing.filter((member) => member.manual).map((member) => String(member.id)));
  const activeIds = new Set(members.map((member) => String(member.id)));
  const now = new Date();
  const rows = members.map((member) => memberToRow_(Object.assign({}, member, {
    active: member.active !== false,
    manual: Boolean(member.manual || manualIds.has(String(member.id))),
  }), now));
  existing.filter((member) => (
    !activeIds.has(String(member.id)) && !dropIds.has(String(member.id))
  )).forEach((member) => {
    rows.push(memberToRow_(Object.assign({}, member, { active: Boolean(member.manual) }), now));
  });
  rewriteDataRows_(sheet, rows, HEADERS.MEMBERS.length);
  formatMembersSheet_(sheet);
}

function memberToRow_(member, updatedAt) {
  let lastAction = '';
  if (member.lastActionTimestamp) lastAction = new Date(Number(member.lastActionTimestamp) * 1000);
  else if (member.lastActionAt) lastAction = new Date(member.lastActionAt);
  return [
    String(member.id), member.name, member.position || '', member.level || '', Boolean(member.active),
    normalizeLiveStatus_(member.liveStatus), lastAction, member.lastActionRelative || '',
    member.tornState || '', member.stateDetail || '', updatedAt, Boolean(member.manual),
  ];
}

function getMembers_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.MEMBERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.MEMBERS.length).getValues()
    .filter((row) => row[0] !== '')
    .map((row) => ({
      id: String(row[0]),
      name: String(row[1] || ''),
      position: String(row[2] || ''),
      level: Number(row[3] || 0),
      active: row[4] === true || String(row[4]).toLowerCase() === 'true',
      liveStatus: normalizeLiveStatus_(row[5]),
      lastActionAt: dateToIsoOrEmpty_(row[6]),
      lastActionRelative: String(row[7] || ''),
      tornState: String(row[8] || ''),
      stateDetail: String(row[9] || ''),
      updatedAt: dateToIsoOrEmpty_(row[10]),
      manual: row[11] === true || String(row[11]).toLowerCase() === 'true',
      profileUrl: `https://www.torn.com/profiles.php?XID=${encodeURIComponent(String(row[0]))}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getAvailability_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.AVAILABILITY);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.AVAILABILITY.length).getValues()
    .filter((row) => row[0] !== '' && row[1] !== '')
    .map((row) => ({
      memberId: String(row[0]),
      slotIso: toIso_(row[1]),
      status: normalizeScheduleStatus_(row[2]),
      updatedAt: row[3] instanceof Date ? row[3] : new Date(row[3] || 0),
    }));
}

function buildCoverage_(slots, members, availabilityRows) {
  const memberNames = members.reduce((result, member) => {
    result[String(member.id)] = member.name;
    return result;
  }, {});
  const bySlot = {};
  slots.forEach((iso) => {
    bySlot[iso] = { Online: [], Watching: [], DUMP: [] };
  });
  availabilityRows.forEach((row) => {
    if (!bySlot[row.slotIso] || !memberNames[String(row.memberId)]) return;
    if (['Online', 'Watching', 'DUMP'].includes(row.status)) {
      bySlot[row.slotIso][row.status].push(memberNames[String(row.memberId)]);
    }
  });
  return slots.map((iso) => {
    const onlineNames = bySlot[iso].Online.sort((a, b) => a.localeCompare(b));
    const watchingNames = bySlot[iso].Watching.sort((a, b) => a.localeCompare(b));
    const dumpNames = bySlot[iso].DUMP.sort((a, b) => a.localeCompare(b));
    return {
      iso,
      onlineCount: onlineNames.length,
      watchingCount: watchingNames.length,
      dumpCount: dumpNames.length,
      onlineNames,
      watchingNames,
      dumpNames,
    };
  });
}

function buildCurrentMemberStatuses_(currentCoverage, members, availabilityRows) {
  if (!currentCoverage) return [];
  const statusByMemberId = {};
  availabilityRows.forEach((row) => {
    if (row.slotIso === currentCoverage.iso) statusByMemberId[String(row.memberId)] = row.status;
  });
  const order = { Online: 0, Watching: 1, DUMP: 2, Offline: 3, 'Not set': 4 };
  return members
    .map((member) => ({
      id: String(member.id),
      name: member.name,
      status: statusByMemberId[String(member.id)] || 'Not set',
    }))
    .sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
}

function generateSlots_(config) {
  const start = toIso_(config.WEEKEND_START);
  const end = toIso_(config.WEEKEND_END);
  const minutes = Number(config.SLOT_MINUTES);
  validateWeekend_(start, end, minutes);
  const slots = [];
  const step = minutes * 60000;
  for (let timestamp = Date.parse(start); timestamp < Date.parse(end); timestamp += step) {
    slots.push(new Date(timestamp).toISOString());
    if (slots.length > APP.MAX_SLOTS) throw new Error('Chain Weekend contains too many time slots.');
  }
  return slots;
}

function validateWeekend_(start, end, slotMinutes) {
  if (!APP.ALLOWED_SLOT_MINUTES.includes(Number(slotMinutes))) {
    throw new Error(`Time slot length must be ${APP.ALLOWED_SLOT_MINUTES.join(', ')} minutes.`);
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('The Chain Weekend date is invalid.');
  if (endMs <= startMs) throw new Error('The end time must be after the start time.');
  if ((endMs - startMs) % (Number(slotMinutes) * 60000) !== 0) {
    throw new Error('The event duration must divide evenly into the selected time slots.');
  }
  const count = (endMs - startMs) / (Number(slotMinutes) * 60000);
  if (count > APP.MAX_SLOTS) throw new Error('Chain Weekend is too long.');
}

function installStatusTrigger_(minutes) {
  minutes = Number(minutes);
  if (!APP.ALLOWED_REFRESH_MINUTES.includes(minutes)) throw new Error('Apps Script does not support the selected refresh interval.');
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'refreshTornStatus')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('refreshTornStatus').timeBased().everyMinutes(minutes).create();
}

function installDiscordTrigger_() {
  if (!PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL')) {
    throw new Error('Discord webhook URL has not been configured.');
  }
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'sendDiscordChainWebhook')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('sendDiscordChainWebhook').timeBased().everyHours(1).create();
}

function hasTrigger_(handlerName) {
  return ScriptApp.getProjectTriggers()
    .some((trigger) => trigger.getHandlerFunction() === handlerName);
}

function normalizeDiscordWebhookUrl_(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._~-]+$/i.test(url)) {
    throw new Error('Enter a valid Discord webhook URL.');
  }
  return url;
}

function postDiscordChainUpdate_(options) {
  options = options || {};
  ensureInstalled_();
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) throw new Error('Discord webhook URL has not been configured.');

  const config = getConfig_();
  const now = new Date();
  const startMs = Date.parse(config.WEEKEND_START);
  const endMs = Date.parse(config.WEEKEND_END);
  const nowMs = now.getTime();
  const eventActive = nowMs >= startMs && nowMs < endMs;
  if (!options.force && !eventActive) {
    return { ok: true, skipped: true, reason: 'outside_event_window' };
  }

  const hourKey = Utilities.formatDate(now, APP.TIME_ZONE, 'yyyy-MM-dd HH:00');
  if (!options.force && props.getProperty('DISCORD_LAST_POST_HOUR') === hourKey) {
    return { ok: true, skipped: true, reason: 'already_posted_this_hour', hourKey };
  }

  const effectiveMs = eventActive ? nowMs : Math.min(Math.max(nowMs, startMs), Math.max(startMs, endMs - 1));
  const payload = buildDiscordChainPayload_(config, new Date(effectiveMs), {
    eventActive,
    preview: Boolean(options.force && !eventActive),
  });
  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`Discord webhook failed with HTTP ${code}: ${response.getContentText().slice(0, 220)}`);
  }

  if (!options.force) props.setProperty('DISCORD_LAST_POST_HOUR', hourKey);
  return { ok: true, statusCode: code, hourKey, preview: Boolean(options.force && !eventActive) };
}

function buildDiscordChainPayload_(config, displayNow, options) {
  const slots = generateSlots_(config);
  const slotMs = Number(config.SLOT_MINUTES) * 60000;
  const endMs = Date.parse(config.WEEKEND_END);
  const members = getMembers_().filter((member) => member.active);
  const slotSet = new Set(slots);
  const memberIds = new Set(members.map((member) => String(member.id)));
  const availabilityRows = getAvailability_().filter((row) => (
    slotSet.has(row.slotIso) && memberIds.has(String(row.memberId))
  ));
  const coverage = buildCoverage_(slots, members, availabilityRows);
  const current = coverage.find((slot) => {
    const start = Date.parse(slot.iso);
    return start <= displayNow.getTime() && displayNow.getTime() < start + slotMs;
  }) || coverage.find((slot) => Date.parse(slot.iso) >= displayNow.getTime()) || coverage[coverage.length - 1];
  const horizonEnd = Math.min(endMs, Date.parse(current.iso) + APP.DISCORD_HORIZON_HOURS * 3600000);
  const horizon = coverage.filter((slot) => {
    const timestamp = Date.parse(slot.iso);
    return timestamp >= Date.parse(current.iso) && timestamp < horizonEnd;
  });
  const currentLabel = current ? formatDiscordSlot_(current.iso) : 'No active slot';
  const titlePrefix = options && options.preview ? 'Preview: ' : '';
  return {
    username: 'Chain Watcher',
    content: `${titlePrefix}**Chain coverage update**`,
    embeds: [{
      title: `${titlePrefix}Chain Watcher coverage`,
      description: `${formatDiscordRange_(config.WEEKEND_START, config.WEEKEND_END)} TCT`,
      color: 12950130,
      fields: [
        {
          name: `Now: ${currentLabel} TCT`,
          value: current ? buildDiscordCurrentSummary_(current) : 'No active schedule slot.',
          inline: false,
        },
        {
          name: `Next ${APP.DISCORD_HORIZON_HOURS} hours`,
          value: buildDiscordScheduleTable_(horizon),
          inline: false,
        },
      ],
      footer: {
        text: `Updated ${Utilities.formatDate(new Date(), APP.TIME_ZONE, 'dd/MM HH:mm')} TCT`,
      },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

function buildDiscordCurrentSummary_(slot) {
  return [
    `🟢 **Online (${slot.onlineCount})**: ${discordNames_(slot.onlineNames)}`,
    `🟡 **Watching (${slot.watchingCount})**: ${discordNames_(slot.watchingNames)}`,
    `🟣 **DUMP (${slot.dumpCount})**: ${discordNames_(slot.dumpNames)}`,
  ].join('\n');
}

function buildDiscordScheduleTable_(slots) {
  if (!slots.length) return 'No upcoming slots in this window.';
  const rows = [
    ['TCT', 'Online', 'Watch', 'Dump'],
    ...slots.map((slot) => [
      Utilities.formatDate(new Date(slot.iso), APP.TIME_ZONE, 'HH:mm'),
      String(slot.onlineCount),
      String(slot.watchingCount),
      String(slot.dumpCount),
    ]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  const text = rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index], ' ')).join('  '))
    .join('\n');
  const names = slots.map(buildDiscordSlotNameSummary_).join('\n\n');
  return trimDiscordField_(`\`\`\`text\n${text}\n\`\`\`\n${names}`, 1000);
}

function buildDiscordSlotNameSummary_(slot) {
  const time = Utilities.formatDate(new Date(slot.iso), APP.TIME_ZONE, 'HH:mm');
  return [
    `**${time}**`,
    `🟢 ${discordNames_(slot.onlineNames, APP.DISCORD_NAMES_PER_STATUS)}`,
    `🟡 ${discordNames_(slot.watchingNames, APP.DISCORD_NAMES_PER_STATUS)}`,
    `🟣 ${discordNames_(slot.dumpNames, APP.DISCORD_NAMES_PER_STATUS)}`,
  ].join('\n');
}

function discordNames_(names, limit) {
  if (!names || !names.length) return 'none';
  limit = Number(limit || 10);
  const visible = names.slice(0, limit).join(', ');
  const more = names.length > limit ? ` +${names.length - limit} more` : '';
  return `${visible}${more}`;
}

function trimDiscordField_(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 22)).trimEnd()}\n...trimmed`;
}

function formatDiscordSlot_(iso) {
  return Utilities.formatDate(new Date(iso), APP.TIME_ZONE, 'dd/MM HH:mm');
}

function formatDiscordRange_(start, end) {
  return `${formatDiscordSlot_(start)} – ${formatDiscordSlot_(end)}`;
}

function normalizeEventReportRange_(range) {
  const config = getConfig_();
  range = range || {};
  const start = toIso_(range.start || config.WEEKEND_START);
  const end = toIso_(range.end || config.WEEKEND_END);
  const slotMinutes = Number(range.slotMinutes || config.SLOT_MINUTES);
  validateWeekend_(start, end, slotMinutes);
  return {
    WEEKEND_START: start,
    WEEKEND_END: end,
    SLOT_MINUTES: String(slotMinutes),
    FACTION_NAME: String(config.FACTION_NAME || `Faction #${config.FACTION_ID || ''}`),
  };
}

function getEventReport_(range) {
  const reportRange = normalizeEventReportRange_(range);
  return buildEventReportData_(reportRange, getMembers_(), getAvailability_(), new Date());
}

function buildEventReportData_(reportRange, allMembers, allAvailability, generatedAt) {
  const slots = generateSlots_(reportRange);
  const slotSet = new Set(slots);
  const availability = allAvailability.filter((row) => slotSet.has(row.slotIso));
  const includedIds = new Set(
    allMembers.filter((member) => member.active).map((member) => String(member.id)),
  );
  availability.forEach((row) => includedIds.add(String(row.memberId)));

  const memberById = allMembers.reduce((result, member) => {
    result[String(member.id)] = member;
    return result;
  }, {});
  const members = [...includedIds].map((id) => memberById[id] || {
    id,
    name: `Former member ${id}`,
    active: false,
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (!members.length) throw new Error('No faction members are available for this report. Sync members first.');

  const statusByKey = {};
  availability.forEach((row) => {
    statusByKey[`${row.memberId}|${row.slotIso}`] = row.status;
  });
  const totals = slots.map(() => ({ Online: 0, Watching: 0, DUMP: 0, Offline: 0, 'Not set': 0 }));
  const statusRows = members.map((member) => ({
    member,
    statuses: slots.map((slot, index) => {
      const status = statusByKey[`${member.id}|${slot}`] || '';
      totals[index][status || 'Not set'] += 1;
      return status;
    }),
  }));

  return {
    factionName: reportRange.FACTION_NAME,
    start: reportRange.WEEKEND_START,
    end: reportRange.WEEKEND_END,
    slotMinutes: Number(reportRange.SLOT_MINUTES),
    generatedAt: new Date(generatedAt).toISOString(),
    slots,
    members,
    statusRows,
    totals,
  };
}

function createEventSheet_(range) {
  const report = getEventReport_(range);
  const ss = getSpreadsheet_();
  const sheetName = eventReportSheetName_(report);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const width = report.slots.length + 2;
  const memberStartRow = 5;
  const memberEndRow = memberStartRow + report.members.length - 1;
  const summaryStartRow = memberEndRow + 2;
  const summaryStates = ['Online', 'Watching', 'DUMP', 'Offline', 'Not set'];
  const totalRows = summaryStartRow + summaryStates.length - 1;
  ensureSheetSize_(sheet, totalRows, width);
  sheet.getDataRange().breakApart();
  sheet.clear();
  sheet.setConditionalFormatRules([]);

  const headers = ['#', 'Member', ...report.slots.map(formatEventSlot_)];
  const rows = [
    padReportRow_([`Chain Watch â€” ${report.factionName}`], width),
    padReportRow_(['Period (TCT / UTC)', `${formatEventDateTime_(report.start)} â€“ ${formatEventDateTime_(report.end)}`], width),
    padReportRow_(['Generated UTC', formatEventDateTime_(report.generatedAt)], width),
    headers,
    ...report.statusRows.map((row, index) => [
      index + 1,
      `${row.member.name} [${row.member.id}]`,
      ...row.statuses,
    ]),
    padReportRow_([], width),
    ...summaryStates.map((status) => [
      '',
      `Total ${status}`,
      ...report.slots.map((slot, index) => {
        const column = columnToLetter_(index + 3);
        return status === 'Not set'
          ? `=COUNTBLANK(${column}$${memberStartRow}:${column}$${memberEndRow})`
          : `=COUNTIF(${column}$${memberStartRow}:${column}$${memberEndRow},"${status}")`;
      }),
    ]),
  ];
  sheet.getRange(1, 1, rows.length, width).setValues(rows);
  sheet.getRange(1, 1, 1, width).setBackground('#11191c');
  // Keep the title merge completely inside the two frozen columns. Google
  // Sheets rejects a frozen-column boundary that cuts through a merged cell.
  sheet.getRange(1, 1, 1, 2).merge()
    .setFontColor('#e7d7b1')
    .setFontWeight('bold')
    .setFontSize(15)
    .setHorizontalAlignment('left');
  sheet.getRange(2, 1, 2, 1).setFontWeight('bold').setFontColor('#6b4f2a');
  sheet.getRange(4, 1, 1, width)
    .setBackground('#263238')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.getRange(memberStartRow, 1, report.members.length, width)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.getRange(memberStartRow, 2, report.members.length, 1).setHorizontalAlignment('left');
  sheet.getRange(summaryStartRow, 2, summaryStates.length, width - 1).setFontWeight('bold');

  const statusRange = sheet.getRange(memberStartRow, 3, report.members.length, report.slots.length);
  const statusStyles = [
    ['Online', '#c6efce', '#1f5132'],
    ['Watching', '#ead2a3', '#654817'],
    ['DUMP', '#ded1f2', '#4d3471'],
    ['Offline', '#f4cccc', '#7a2727'],
  ];
  sheet.setConditionalFormatRules(statusStyles.map((style) => (
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(style[0])
      .setBackground(style[1])
      .setFontColor(style[2])
      .setRanges([statusRange])
      .build()
  )));
  statusStyles.concat([['Not set', '#e5e7eb', '#374151']]).forEach((style, index) => {
    sheet.getRange(summaryStartRow + index, 2, 1, width - 1)
      .setBackground(style[1])
      .setFontColor(style[2]);
  });

  sheet.setFrozenRows(4);
  sheet.setFrozenColumns(2);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#b58a4a');
  sheet.setColumnWidth(1, 48);
  sheet.setColumnWidth(2, 210);
  sheet.setColumnWidths(3, report.slots.length, 82);
  sheet.setRowHeight(1, 36);
  sheet.setRowHeight(4, 44);
  if (report.members.length) sheet.setRowHeights(memberStartRow, report.members.length, 28);

  return {
    sheetName,
    sheetUrl: `${ss.getUrl()}#gid=${sheet.getSheetId()}`,
    start: report.start,
    end: report.end,
    memberCount: report.members.length,
    slotCount: report.slots.length,
  };
}

function eventReportToCsv_(report) {
  const rows = [
    [`Chain Watch â€” ${report.factionName}`],
    ['Period (TCT / UTC)', `${formatEventDateTime_(report.start)} â€“ ${formatEventDateTime_(report.end)}`],
    ['Generated UTC', formatEventDateTime_(report.generatedAt)],
    [],
    ['#', 'Member', ...report.slots.map(formatEventSlot_)],
    ...report.statusRows.map((row, index) => [
      index + 1,
      `${row.member.name} [${row.member.id}]`,
      ...row.statuses,
    ]),
    [],
    ...['Online', 'Watching', 'DUMP', 'Offline', 'Not set'].map((status) => [
      '',
      `Total ${status}`,
      ...report.totals.map((counts) => counts[status]),
    ]),
  ];
  return rows.map((row) => row.map(csvCell_).join(',')).join('\r\n');
}

function csvCell_(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function eventReportSheetName_(report) {
  const start = Utilities.formatDate(new Date(report.start), APP.TIME_ZONE, 'yyyyMMdd_HHmm');
  const end = Utilities.formatDate(new Date(report.end), APP.TIME_ZONE, 'yyyyMMdd_HHmm');
  return `${APP.REPORT_SHEET_PREFIX}${start}_${end}`;
}

function formatEventSlot_(iso) {
  return Utilities.formatDate(new Date(iso), APP.TIME_ZONE, 'dd/MM HH:mm');
}

function formatEventDateTime_(iso) {
  return Utilities.formatDate(new Date(iso), APP.TIME_ZONE, 'yyyy-MM-dd HH:mm');
}

function padReportRow_(values, width) {
  return values.concat(Array(Math.max(0, width - values.length)).fill('')).slice(0, width);
}

function columnToLetter_(column) {
  let result = '';
  for (let value = Number(column); value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(((value - 1) % 26) + 65) + result;
  }
  return result;
}

function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('The backing Google Sheet has not been configured. Run setupChainWatcher first.');
}

function ensureInstalled_() {
  const ss = getSpreadsheet_();
  ensureSheets_(ss);
  writeMissingDefaults_();
}

function ensureSheets_(ss) {
  ensureSheet_(ss, SHEETS.CONFIG, HEADERS.CONFIG);
  ensureSheet_(ss, SHEETS.MEMBERS, HEADERS.MEMBERS);
  ensureSheet_(ss, SHEETS.AVAILABILITY, HEADERS.AVAILABILITY);
  ensureSheet_(ss, SHEETS.AUDIT, HEADERS.AUDIT);
  ensureSheet_(ss, SHEETS.LOGS, HEADERS.LOGS);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function writeMissingDefaults_() {
  const config = getConfig_();
  const missing = {};
  if (config.VERSION !== APP.VERSION) missing.VERSION = APP.VERSION;
  Object.keys(DEFAULT_CONFIG).forEach((key) => {
    if (config[key] === undefined || config[key] === null || config[key] === '') {
      if (!['LAST_MEMBER_SYNC', 'LAST_STATUS_SYNC'].includes(key)) missing[key] = DEFAULT_CONFIG[key];
    }
  });
  if (Object.keys(missing).length) setConfigValues_(missing);
}

function getConfig_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.CONFIG);
  const result = {};
  if (!sheet || sheet.getLastRow() < 2) return result;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach((row) => {
    if (row[0]) result[String(row[0])] = String(row[1] || '');
  });
  return result;
}

function setConfigValues_(changes) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.CONFIG);
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues()
    : [];
  const values = {};
  existing.forEach((row) => { if (row[0]) values[String(row[0])] = String(row[1] || ''); });
  Object.keys(changes).forEach((key) => { values[key] = String(changes[key]); });
  const orderedKeys = Object.keys(DEFAULT_CONFIG).concat(Object.keys(values).filter((key) => !(key in DEFAULT_CONFIG)));
  const uniqueKeys = [...new Set(orderedKeys)].filter((key) => key in values);
  const rows = uniqueKeys.map((key) => [key, values[key]]);
  rewriteDataRows_(sheet, rows, 2);
  formatConfigSheet_(sheet);
}

function rewriteDataRows_(sheet, rows, width) {
  const previousRows = Math.max(0, sheet.getLastRow() - 1);
  if (previousRows) sheet.getRange(2, 1, previousRows, width).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
}

function formatSheets_(ss) {
  formatConfigSheet_(ss.getSheetByName(SHEETS.CONFIG));
  formatMembersSheet_(ss.getSheetByName(SHEETS.MEMBERS));
  formatAvailabilitySheet_(ss.getSheetByName(SHEETS.AVAILABILITY));
  formatAuditSheet_(ss.getSheetByName(SHEETS.AUDIT));
  formatLogsSheet_(ss.getSheetByName(SHEETS.LOGS));
}

function formatBaseSheet_(sheet, headers) {
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground('#172033')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 32);
}

function formatConfigSheet_(sheet) {
  formatBaseSheet_(sheet, HEADERS.CONFIG);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 320);
}

function formatMembersSheet_(sheet) {
  formatBaseSheet_(sheet, HEADERS.MEMBERS);
  sheet.setColumnWidth(1, 105);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidths(4, 2, 75);
  sheet.setColumnWidths(6, 5, 150);
  sheet.setColumnWidth(12, 85);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(2, 11, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

function formatAvailabilitySheet_(sheet) {
  formatBaseSheet_(sheet, HEADERS.AVAILABILITY);
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 175);
  sheet.setColumnWidth(3, 110);
  sheet.setColumnWidth(4, 175);
  if (sheet.getLastRow() > 1) {
    const count = sheet.getLastRow() - 1;
    sheet.getRange(2, 2, count, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 4, count, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    const validation = SpreadsheetApp.newDataValidation()
      .requireValueInList(APP.STATUS_OPTIONS, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 3, count, 1).setDataValidation(validation);
  }
}

function formatAuditSheet_(sheet) {
  formatBaseSheet_(sheet, HEADERS.AUDIT);
  sheet.setColumnWidth(1, 175);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 180);
  sheet.setColumnWidth(5, 360);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

function formatLogsSheet_(sheet) {
  formatBaseSheet_(sheet, HEADERS.LOGS);
  sheet.setTabColor('#7c3aed');
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(2, 175);
  sheet.setColumnWidth(3, 80);
  sheet.setColumnWidth(4, 120);
  sheet.setColumnWidth(5, 180);
  sheet.setColumnWidth(6, 110);
  sheet.setColumnWidth(7, 180);
  sheet.setColumnWidth(8, 110);
  sheet.setColumnWidth(9, 180);
  sheet.setColumnWidth(10, 110);
  sheet.setColumnWidth(11, 100);
  sheet.setColumnWidth(12, 260);
  sheet.setColumnWidth(13, 120);
  sheet.setColumnWidth(14, 130);
  sheet.setColumnWidth(15, 520);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

function appendAudit_(memberId, memberName, action, details, options) {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.AUDIT);
  sheet.appendRow([new Date(), String(memberId || ''), String(memberName || ''), String(action), String(details || '')]);

  if (options && options.skipLog) return;

  logEvent_({
    level: 'INFO',
    category: 'audit',
    action: normalizeLogAction_(action),
    actorId: String(memberId || ''),
    actorName: String(memberName || ''),
    source: 'backend',
    outcome: 'success',
    message: String(action || ''),
    details: {
      legacyAuditDetails: String(details || ''),
    },
  });
}

function ensureLogsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEETS.LOGS);

  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.LOGS);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.LOGS.length).setValues([HEADERS.LOGS]);
    formatLogsSheet_(sheet);
  }

  return sheet;
}

function logEvent_(entry) {
  try {
    const ss = getSpreadsheet_();
    const sheet = ensureLogsSheet_(ss);
    const now = new Date();
    const requestId = entry && entry.requestId ? String(entry.requestId) : makeRequestId_();
    const safeDetails = sanitizeLogDetails_((entry && entry.details) || {});

    sheet.appendRow([
      now.toISOString(),
      Utilities.formatDate(now, 'Europe/Helsinki', 'yyyy-MM-dd HH:mm:ss'),
      String((entry && entry.level) || 'INFO').toUpperCase(),
      String((entry && entry.category) || ''),
      String((entry && entry.action) || ''),
      String((entry && entry.actorId) || ''),
      String((entry && entry.actorName) || ''),
      String((entry && entry.targetId) || ''),
      String((entry && entry.targetName) || ''),
      String((entry && entry.source) || 'backend'),
      String((entry && entry.outcome) || 'success'),
      String((entry && entry.message) || ''),
      requestId,
      String((entry && entry.appVersion) || getAppVersion_()),
      safeStringify_(safeDetails),
    ]);

    return requestId;
  } catch (error) {
    console.error(`Logging failed: ${error && error.message ? error.message : error}`);
    return '';
  }
}

function makeRequestId_() {
  return `req_${Utilities.getUuid().slice(0, 8)}`;
}

function getAppVersion_() {
  return `${APP.NAME} ${APP.VERSION}`;
}

function normalizeLogAction_(action) {
  return String(action || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown_action';
}

function getReadableLogs_(filters) {
  const normalized = normalizeLogFilters_(filters || {});
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.LOGS);

  if (!sheet || sheet.getLastRow() < 2) {
    return {
      entries: [],
      totalMatched: 0,
      scanned: 0,
      limit: normalized.limit,
      hasMore: false,
      generatedAt: new Date().toISOString(),
    };
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), HEADERS.LOGS.length);
  const scanCount = Math.min(normalized.scanLimit, lastRow - 1);
  const startRow = lastRow - scanCount + 1;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const rows = sheet.getRange(startRow, 1, scanCount, lastColumn).getValues();
  const indexes = {};
  headers.forEach((header, index) => { indexes[header] = index; });

  const entries = [];
  let totalMatched = 0;

  rows.reverse().forEach((row) => {
    const entry = logRowToEntry_(row, indexes);
    if (!matchesLogFilters_(entry, normalized)) return;

    totalMatched += 1;
    if (entries.length < normalized.limit) entries.push(entry);
  });

  return {
    entries,
    totalMatched,
    scanned: scanCount,
    limit: normalized.limit,
    hasMore: totalMatched > entries.length,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeLogFilters_(filters) {
  return {
    limit: clampNumber_(filters.limit, 10, 200, 50),
    scanLimit: clampNumber_(filters.scanLimit, 100, 5000, 1200),
    category: String(filters.category || 'all').trim().toLowerCase(),
    outcome: String(filters.outcome || 'all').trim().toLowerCase(),
    query: String(filters.query || '').trim().toLowerCase(),
  };
}

function clampNumber_(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function logRowToEntry_(row, indexes) {
  function value(header) {
    const index = indexes[header];
    return index === undefined ? '' : String(row[index] == null ? '' : row[index]);
  }

  const detailsRaw = value('DetailsJson');
  const details = parseLogDetails_(detailsRaw);
  const changes = Array.isArray(details.changes) ? details.changes.map((change) => ({
    slotUtc: String(change.slotUtc || ''),
    slotTct: String(change.slotTct || ''),
    from: String(change.from || 'Not set'),
    to: String(change.to || 'Not set'),
  })) : [];

  return {
    timestampUtc: value('TimestampUtc'),
    timestampTct: value('TimestampTct'),
    level: value('Level') || 'INFO',
    category: value('Category'),
    action: value('Action'),
    actorId: value('ActorId'),
    actorName: value('ActorName'),
    targetId: value('TargetId'),
    targetName: value('TargetName'),
    source: value('Source'),
    outcome: value('Outcome'),
    message: value('Message'),
    requestId: value('RequestId'),
    appVersion: value('AppVersion'),
    details,
    detailsRaw,
    submittedSlotCount: Number(details.submittedSlotCount || 0),
    changedSlotCount: Number(details.changedSlotCount || changes.length || 0),
    changes,
  };
}

function parseLogDetails_(detailsRaw) {
  const value = String(detailsRaw || '').trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return { parseError: 'DetailsJson could not be parsed', rawPreview: value.slice(0, 500) };
  }
}

function matchesLogFilters_(entry, filters) {
  if (filters.category !== 'all' && String(entry.category || '').toLowerCase() !== filters.category) return false;
  if (filters.outcome !== 'all' && String(entry.outcome || '').toLowerCase() !== filters.outcome) return false;

  if (filters.query) {
    const haystack = [
      entry.actorName,
      entry.actorId,
      entry.targetName,
      entry.targetId,
      entry.category,
      entry.action,
      entry.message,
      entry.requestId,
    ].join(' ').toLowerCase();
    if (!haystack.includes(filters.query)) return false;
  }

  return true;
}

function formatLogSlot_(iso) {
  return `${Utilities.formatDate(new Date(iso), APP.TIME_ZONE, 'yyyy-MM-dd HH:mm')} TCT`;
}

function buildScheduleLogMessage_(changes, submittedSlotCount) {
  if (!changes || !changes.length) {
    return `Schedule saved: ${submittedSlotCount} submitted slot(s), no status changes`;
  }

  const preview = changes.slice(0, 5)
    .map((change) => `${change.slotTct}: ${change.from} â†’ ${change.to}`)
    .join('; ');
  const suffix = changes.length > 5 ? `; +${changes.length - 5} more` : '';
  return `Schedule saved: ${changes.length} changed slot(s). ${preview}${suffix}`;
}

function safeStringify_(value) {
  try {
    const json = JSON.stringify(value || {});
    return json.length > 20000 ? `${json.slice(0, 20000)}...[truncated]` : json;
  } catch (error) {
    return '{"error":"Could not stringify log details"}';
  }
}

function sanitizeLogDetails_(details) {
  const blockedTerms = [
    'apikey',
    'tornapikey',
    'key',
    'password',
    'adminpassword',
    'adminsecret',
    'sessiontoken',
    'token',
    'secret',
    'authorization',
    'webhook',
    'discordwebhook',
    'webhookurl',
  ];

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(details || {}));
  } catch (error) {
    return { error: 'Could not clone log details' };
  }

  function scrub(value) {
    if (!value || typeof value !== 'object') return;

    const allowedBooleanFlags = new Set([
      'apikeyprovided',
      'adminsecretprovided',
      'secretprovided',
      'passwordprovided',
    ]);

    Object.keys(value).forEach((key) => {
      const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

      if (
        !allowedBooleanFlags.has(normalizedKey)
        && blockedTerms.some((blocked) => normalizedKey.includes(blocked))
      ) {
        value[key] = '[REDACTED]';
        return;
      }

      if (typeof value[key] === 'object') scrub(value[key]);
    });
  }

  scrub(clone);
  return clone;
}

function setAdminSecret_(secret) {
  if (String(secret || '').length < 10) throw new Error('The admin password must contain at least 10 characters.');
  const salt = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    ADMIN_SECRET_SALT: salt,
    ADMIN_SECRET_HASH: hashSecret_(String(secret), salt),
  });
}

function assertAdmin_(secret) {
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty('ADMIN_SECRET_SALT');
  const expected = props.getProperty('ADMIN_SECRET_HASH');
  if (!salt || !expected) {
    logEvent_({
      level: 'ERROR',
      category: 'admin',
      action: 'admin_secret_not_configured',
      source: 'backend',
      outcome: 'failure',
      message: 'Admin password has not been configured',
    });
    throw new Error('The admin password has not been configured in Google Sheets.');
  }
  const actual = hashSecret_(String(secret || ''), salt);
  if (!timingSafeEqual_(actual, expected)) {
    logEvent_({
      level: 'WARN',
      category: 'admin',
      action: 'admin_login_failed',
      source: 'backend',
      outcome: 'failure',
      message: 'Incorrect admin password',
      details: {
        secretProvided: Boolean(String(secret || '')),
      },
    });
    throw new Error('Incorrect admin password.');
  }
}

function hashSecret_(secret, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    `${salt}:${secret}`,
    Utilities.Charset.UTF_8,
  );
  return Utilities.base64EncodeWebSafe(bytes);
}

function timingSafeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function normalizeScheduleStatus_(status) {
  const match = APP.STATUS_OPTIONS.find((option) => option.toLowerCase() === String(status || '').trim().toLowerCase());
  if (!match) throw new Error(`Unknown availability status: ${status}`);
  return match;
}

function normalizeScheduleStatusOrEmpty_(status) {
  const value = String(status == null ? '' : status).trim();
  return value ? normalizeScheduleStatus_(value) : '';
}

function normalizeLiveStatus_(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'online') return 'Online';
  if (value === 'idle') return 'Idle';
  if (value === 'offline') return 'Offline';
  return 'Unknown';
}

function toIso_(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

function dateToIsoOrEmpty_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
