(() => {
    const API_CONFIG = window.CHAIN_WATCHER_API_CONFIG || window.CHAIN_WATCHER_CONFIG || {};
    const API_URL = String(API_CONFIG.apiUrl || '').trim();
    const API_TIMEOUT_MS = Number(API_CONFIG.timeoutMs || 30000);
    const IDENTITY_CONFIRM_TIMEOUT_MS = 180000;
    let apiRequestCounter = 0;
    if (window.__CHAIN_WATCHER_EMBED_DENIED__) return;
    const STATUS_OPTIONS = ['Online', 'Watching', 'DUMP', 'Offline'];
    const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
    const SESSION_STORAGE_KEY = 'chainWatcherMemberSession';
    const SESSION_BACKUP_KEY = 'chainWatcherMemberSessionBackup';
    const state = {
      data: null,
      sessionToken: readSessionToken(),
      pendingConfirmationToken: '',
      pendingMember: null,
      selectedMemberId: '',
      schedule: {},
      savedSchedule: {},
      dirty: new Set(),
      adminSecret: '',
      loadingCount: 0,
      toastTimer: null,
      autoRefreshTimer: null,
      loadingWatchdogTimer: null,
      layoutPublishTimer: null,
      logSearchTimer: null,
      activityLog: null,
      coverageFilter: 'future',
      memberStatusFilter: 'all',
      initialHashScrolled: false,
    };

    const $ = (id) => document.getElementById(id);

    function on(id, eventName, handler) {
      const element = $(id);
      if (!element) {
        console.warn(`Chain Watcher: missing element #${id}`);
        return;
      }
      element.addEventListener(eventName, handler);
    }

    function getHashTarget(hash) {
      if (!hash || hash === '#') return null;
      const id = decodeURIComponent(hash.slice(1));
      return document.getElementById(id) || document.querySelector(hash);
    }

    let infoReturnFocus = null;

    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('cw-js-ready');
      loadWarReports();
      bindEvents();
      bindLayoutPublisher();
      loadData(true).finally(scheduleAutoRefresh);
    });

    function bindEvents() {
      bindInternalNavigation();

      const resourceMenus = Array.from(document.querySelectorAll('.nav-resources'));
      if (resourceMenus.length) {
        document.addEventListener('click', (event) => {
          const menuLink = event.target.closest('.nav-resource-menu a');
          if (menuLink) {
            const linkMenu = menuLink.closest('.nav-resources');
            if (linkMenu) linkMenu.removeAttribute('open');
          }
          resourceMenus.forEach((menu) => {
            if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open');
          });
        });
      } else {
        console.warn('Chain Watcher: missing .nav-resources menu');
      }

      on('info-open', 'click', openInfoModal);
      on('info-open-guide', 'click', openInfoModal);
      on('my-bookings-edit', 'click', focusSchedulePanel);
      on('info-close', 'click', closeInfoModal);
      on('info-modal', 'click', (event) => {
        const modal = $('info-modal');
        if (modal && event.target === modal) closeInfoModal();
      });
      document.addEventListener('keydown', (event) => {
        const modal = $('info-modal');
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeInfoModal();
      });
      on('refresh-button', 'click', () => loadData(true));
      on('jump-current-button', 'click', jumpToCurrentSlot);
      on('save-button', 'click', saveSchedule);
      on('member-search', 'input', renderRoster);
      on('identity-verify', 'click', verifyIdentity);
      on('identity-api-key', 'keydown', (event) => {
        if (event.key === 'Enter') verifyIdentity();
      });
      on('identity-confirm', 'click', confirmIdentity);
      on('identity-back', 'click', resetIdentityFlow);
      on('identity-logout', 'click', changeIdentity);
      on('admin-unlock', 'click', unlockAdmin);
      on('admin-secret', 'keydown', (event) => {
        if (event.key === 'Enter') unlockAdmin();
      });
      on('admin-save', 'click', saveAdmin);
      on('admin-sync', 'click', () => runAdminAction('adminSyncMembers', 'Members synced.'));
      on('admin-status', 'click', () => runAdminAction('adminRefreshStatuses', 'Torn statuses refreshed.'));
      on('admin-trigger', 'click', () => runAdminAction('adminInstallStatusTrigger', 'Refresh trigger installed.'));
      on('admin-report-sheet', 'click', createEventReportSheet);
      on('admin-export-csv', 'click', downloadEventCsv);
      on('admin-add-member', 'click', addManualMember);
      on('admin-refresh-logs', 'click', () => loadActivityLog(true));
      on('log-category-filter', 'change', () => loadActivityLog(true));
      on('log-outcome-filter', 'change', () => loadActivityLog(true));
      on('log-search', 'input', queueActivityLogRefresh);
      on('manual-member-id', 'keydown', (event) => {
        if (event.key === 'Enter') addManualMember();
      });

      document.addEventListener('click', (event) => {
        const filterButton = event.target.closest('[data-coverage-filter]');
        if (filterButton) {
          state.coverageFilter = filterButton.dataset.coverageFilter || 'future';
          renderCoverageCalendar();
          scheduleLayoutPublish();
          return;
        }

        const statusFilterButton = event.target.closest('[data-status-filter]');
        if (statusFilterButton) {
          state.memberStatusFilter = statusFilterButton.dataset.statusFilter || 'all';
          renderMemberStatusList();
          scheduleLayoutPublish();
          return;
        }

        const commandButton = event.target.closest('[data-command-action]');
        if (!commandButton) return;
        if (commandButton.dataset.commandAction === 'current') jumpToCurrentSlot();
        if (commandButton.dataset.commandAction === 'next-gap') jumpToNextGap();
        if (commandButton.dataset.commandAction === 'coverage') focusCoverageBoard();
      });
      }

    async function loadWarReports() {
      const menu = $('war-report-menu');
      if (!menu) return;
      try {
        const response = await fetch('reports.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reports = await response.json();
        if (!Array.isArray(reports)) throw new Error('reports.json must contain an array.');
        const validReports = reports.map(normalizeWarReport).filter(Boolean);
        if (!validReports.length) return;
        menu.replaceChildren(...validReports.map(createWarReportLink));
      } catch (error) {
        console.warn('Chain Watcher: could not load WAR reports list.', error);
      }
    }

    function normalizeWarReport(report) {
      if (!report || typeof report !== 'object') return null;
      const title = String(report.title || '').trim();
      const file = String(report.file || '').trim();
      if (!title || !isSafeReportPath(file)) return null;
      return {
        title,
        file,
        description: String(report.description || formatWarReportDate(report.date) || 'War matchup report').trim(),
      };
    }

    function isSafeReportPath(file) {
      return /^reports\/[A-Za-z0-9._-]+\.html$/.test(file);
    }

    function formatWarReportDate(value) {
      const text = String(value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
      const date = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }

    function createWarReportLink(report) {
      const link = document.createElement('a');
      link.href = report.file;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      const title = document.createElement('strong');
      title.textContent = report.title;
      const description = document.createElement('span');
      description.textContent = report.description;

      link.append(title, description);
      return link;
    }

    function scheduleAutoRefresh() {
      window.clearTimeout(state.autoRefreshTimer);
      const refreshMinutes = state.data && state.data.meta
        ? Number(state.data.meta.refreshMinutes || 2)
        : 2;
      const delayMs = Math.max(60000, Math.min(10, refreshMinutes || 2) * 60000);

      state.autoRefreshTimer = window.setTimeout(async () => {
        if (!state.dirty.size && !document.hidden) await loadData(false);
        scheduleAutoRefresh();
      }, delayMs);
    }


    function bindLayoutPublisher() {
      window.addEventListener('resize', scheduleLayoutPublish);
      window.addEventListener('load', scheduleLayoutPublish);
      if ('ResizeObserver' in window) {
        const app = $('app');
        if (app) {
          const observer = new ResizeObserver(scheduleLayoutPublish);
          observer.observe(app);
        }
      }
    }

    function scheduleLayoutPublish() {
      window.clearTimeout(state.layoutPublishTimer);
      state.layoutPublishTimer = window.setTimeout(publishLayoutHeight, 80);
    }

    function publishLayoutHeight() {
      const app = $('app');
      const height = Math.ceil(Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0,
        app ? app.scrollHeight + 56 : 0,
      ));

      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'CHAIN_WATCHER_HEIGHT',
            source: 'Chain Watcher',
            height,
          }, '*');
        }
      } catch (ignore) {}
    }

    function setAuthBodyState(authenticated) {
      document.body.classList.toggle('cw-authenticated', Boolean(authenticated));
      document.body.classList.toggle('cw-unauthenticated', !authenticated);
    }

    function bindInternalNavigation() {
      document.querySelectorAll('a.nav-brand[href^="#"], a.nav-section-link[href^="#"]').forEach((link) => {
        link.setAttribute('target', '_self');
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const selector = link.getAttribute('href');
          const target = getHashTarget(selector);
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          try {
            window.history.replaceState(null, '', selector);
          } catch (ignore) {}
        });
      });
    }

    function scrollToInitialHash() {
      if (state.initialHashScrolled || !window.location.hash) return;
      const target = getHashTarget(window.location.hash);
      if (!target) return;
      state.initialHashScrolled = true;
      window.setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }

    function openInfoModal() {
      infoReturnFocus = document.activeElement;
      $('info-modal').classList.remove('hidden');
      $('info-modal').setAttribute('aria-hidden', 'false');
      document.body.classList.add('info-modal-open');
      $('info-close').focus();
      scheduleLayoutPublish();
    }

    function closeInfoModal() {
      $('info-modal').classList.add('hidden');
      $('info-modal').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('info-modal-open');
      if (infoReturnFocus && typeof infoReturnFocus.focus === 'function') infoReturnFocus.focus();
      infoReturnFocus = null;
      scheduleLayoutPublish();
    }

    async function loadData(showOverlay) {
      if (showOverlay) setLoading(true);
      try {
        let data = await server('getAppData', state.sessionToken);
        if (state.sessionToken && !(data.auth && data.auth.authenticated)) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          data = await server('getAppData', state.sessionToken);
        }
        applyData(data);
      } catch (error) {
        showError(error);
      } finally {
        if (showOverlay) setLoading(false);
      }
    }

    function applyData(data) {
      state.data = data;
      state.selectedMemberId = String(data.selectedMemberId || '');
      state.schedule = {};
      state.savedSchedule = {};
      data.slots.forEach((slot) => {
        const status = data.selectedAvailability[slot.iso] || '';
        state.schedule[slot.iso] = status;
        state.savedSchedule[slot.iso] = status;
      });
      state.dirty.clear();
      document.body.classList.add('cw-data-loaded');
      const authenticated = Boolean(data.auth && data.auth.authenticated);
      setAuthBodyState(authenticated);
      if (authenticated) closeIdentityGate();
      else {
        if (state.sessionToken) {
          openIdentityGate('Your saved member session could not be confirmed. Try refreshing once, or verify your API key again.');
        } else {
          clearRememberedSession();
          openIdentityGate();
        }
      }
      renderAll();
    }

    function renderAll() {
      renderHeader();
      renderNotice();
      renderCommandStrip();
      renderStats();
      renderMemberPicker();
      renderSchedule();
      renderMyBookings();
      renderCoverageCalendar();
      renderCoverage();
      renderRoster();
      renderDirtyState();
      scrollToInitialHash();
      scheduleLayoutPublish();
    }

    function renderHeader() {
      const { meta } = state.data;
      $('app-title').textContent = meta.appName || 'Chain Watcher';
      $('event-title').innerHTML = `
        <span class="faction-line">${escapeHtml(meta.factionName)}</span>
        <span><strong>TCT:</strong> ${escapeHtml(formatRange(meta.start, meta.end))}</span>
        <span class="local-time-line"><strong>Your local time (${escapeHtml(LOCAL_TIME_ZONE)}):</strong> ${escapeHtml(formatLocalRange(meta.start, meta.end))}</span>
      `;
      const sync = $('sync-state');
      if (meta.lastStatusSync) {
        sync.textContent = `Torn API: ${formatDateTime(meta.lastStatusSync)} TCT`;
        sync.classList.add('good');
      } else {
        sync.textContent = 'Torn API: not synced yet';
        sync.classList.remove('good');
      }
      const authenticated = state.data.auth && state.data.auth.authenticated;
      const member = authenticated ? state.data.auth.member : null;
      $('identity-member-pill').textContent = member ? `${member.name} [${member.id}]` : '';
      $('identity-member-pill').classList.toggle('hidden', !member);
      $('identity-logout').classList.toggle('hidden', !member);
      const profileLink = $('profile-nav-link');
      profileLink.href = member ? `https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.id)}` : '#';
      profileLink.classList.toggle('hidden', !member);
      $('profile-nav-name').textContent = member ? member.name : 'My profile';
    }

    function renderNotice() {
      const problems = [];
      if (!state.data.meta.adminConfigured) problems.push('The admin password has not been configured. Complete the initial setup in Google Sheets.');
      if (!state.data.meta.apiConfigured) problems.push('The Torn API key has not been configured, so members and live statuses cannot be refreshed.');
      const notice = $('notice');
      notice.textContent = problems.join(' ');
      notice.classList.toggle('hidden', !problems.length);
    }

    function renderCommandStrip() {
      const slots = state.data.slots || [];
      const slotMinutes = Number(state.data.meta.slotMinutes || 0);
      const step = slotMinutes * 60000;
      const now = Date.now();
      const current = findCurrentSlot(slots, step, now);
      const futureSlots = slots.filter((slot) => Date.parse(slot.iso) + step > now);
      const nextGap = findNextGapSlot(slots, step, now);
      const uncoveredFuture = futureSlots.filter((slot) => coverageTotal(slot) === 0).length;
      const thinFuture = futureSlots.filter((slot) => coverageTotal(slot) === 1).length;
      const savedStatuses = new Set(['Online', 'Watching', 'DUMP']);
      const savedSlots = slots.filter((slot) => savedStatuses.has(state.savedSchedule[slot.iso])).length;
      const savedMinutes = savedSlots * slotMinutes;
      const currentTotal = current ? coverageTotal(current) : 0;

      $('command-strip').innerHTML = `
        <button class="command-card ${current ? coverageLevel(currentTotal) : ''}" type="button" data-command-action="current" ${current ? '' : 'disabled'}>
          <span>Current slot</span>
          <strong>${current ? escapeHtml(formatCompact(current.iso)) : 'Outside event'}</strong>
          <small>${current ? `${currentTotal} ready now` : 'No active slot'}</small>
        </button>
        <button class="command-card ${nextGap ? 'gap' : 'strong'}" type="button" data-command-action="next-gap" ${nextGap ? '' : 'disabled'}>
          <span>Next gap</span>
          <strong>${nextGap ? escapeHtml(formatCompact(nextGap.iso)) : 'None'}</strong>
          <small>${nextGap ? 'Needs coverage' : 'No future empty slots'}</small>
        </button>
        <button class="command-card gap" type="button" data-command-action="coverage">
          <span>Future gaps</span>
          <strong>${uncoveredFuture}</strong>
          <small>${thinFuture} thin slots</small>
        </button>
        <button class="command-card" type="button" data-command-action="coverage">
          <span>My saved time</span>
          <strong>${escapeHtml(formatDuration(savedMinutes))}</strong>
          <small>${savedSlots} saved slot${savedSlots === 1 ? '' : 's'}</small>
        </button>
      `;
    }

    function renderStats() {
      const stats = state.data.stats;
      const cards = [
        ['Faction members', stats.memberCount, `${stats.responded} submitted a schedule`, 'rgba(198,154,82,.34)'],
        ['Torn Online', stats.tornOnline, `${stats.tornIdle} idle`, 'rgba(143,200,214,.3)'],
        ['Torn Offline', stats.tornOffline, 'Latest API status', 'rgba(207,115,115,.28)'],
      ];
      $('stats').innerHTML = cards.map(([label, value, note, color]) => `
        <article class="stat-card" style="--card-accent:${color}">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value">${escapeHtml(String(value))}</div>
          <div class="stat-note">${escapeHtml(note)}</div>
        </article>
      `).join('');
    }

    function renderMemberPicker() {
      const select = $('member-select');
      const member = state.data.auth && state.data.auth.authenticated ? state.data.auth.member : null;
      select.innerHTML = member
        ? `<option value="${escapeAttr(member.id)}">${escapeHtml(member.name)} [${escapeHtml(member.id)}] — identity locked</option>`
        : '<option value="">Verify your Torn identity first</option>';
      select.value = state.selectedMemberId;
      select.disabled = true;
    }

    function renderSchedule() {
      const groups = groupByDay(state.data.slots);
      const now = Date.now();
      const step = state.data.meta.slotMinutes * 60000;
      const locked = !(state.data.auth && state.data.auth.authenticated);
      $('schedule').innerHTML = groups.map((group) => `
        <section class="day-card">
          <header class="day-header">
            <div class="day-title">${escapeHtml(formatDay(group.day))}</div>
            <div class="bulk-actions">
              ${STATUS_OPTIONS.map((status) => `<button class="bulk-button" type="button" data-day="${escapeAttr(group.day)}" data-bulk-status="${status}" ${locked ? 'disabled' : ''}>All ${status}</button>`).join('')}
              <button class="bulk-button" type="button" data-day="${escapeAttr(group.day)}" data-bulk-status="" ${locked ? 'disabled' : ''}>Clear day</button>
            </div>
          </header>
          ${group.slots.map((slot) => {
            const status = state.schedule[slot.iso] || '';
            const start = Date.parse(slot.iso);
            const current = start <= now && now < start + step;
            return `
            <div class="slot-row ${current ? 'current' : ''}" data-schedule-slot="${escapeAttr(slot.iso)}">
                <div class="slot-times">
                  <time class="slot-time" datetime="${escapeAttr(slot.iso)}">${escapeHtml(formatTime(slot.iso))} <small>TCT</small></time>
                  <span class="slot-local">${escapeHtml(formatLocalSlot(slot.iso))} <small>Your local</small></span>
                </div>
                <div class="status-control" role="group" aria-label="TCT ${escapeAttr(formatDateTime(slot.iso))}; local ${escapeAttr(formatLocalDateTime(slot.iso))}">
                  ${STATUS_OPTIONS.map((option) => `<button type="button" class="status-button ${option.toLowerCase()} ${status === option ? 'active' : ''}" data-slot="${escapeAttr(slot.iso)}" data-status="${option}" ${locked ? 'disabled' : ''}>${option}</button>`).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </section>
      `).join('');

      $('schedule').querySelectorAll('[data-slot]').forEach((button) => {
        button.addEventListener('click', () => setSlotStatus(button.dataset.slot, button.dataset.status));
      });
      $('schedule').querySelectorAll('[data-bulk-status]').forEach((button) => {
        button.addEventListener('click', () => setDayStatus(button.dataset.day, button.dataset.bulkStatus));
      });
    }

    function renderMyBookings() {
      const authenticated = state.data.auth && state.data.auth.authenticated;
      const member = authenticated ? state.data.auth.member : null;
      const slotMinutes = Number(state.data.meta.slotMinutes || 0);
      const bookedStatuses = new Set(['Online', 'Watching', 'DUMP']);
      const bookedSlots = (state.data.slots || []).filter((slot) => bookedStatuses.has(state.savedSchedule[slot.iso]));
      const blocks = groupBookedSlots(bookedSlots, slotMinutes);
      const totalMinutes = bookedSlots.length * slotMinutes;
      const pendingCount = state.dirty.size;

      $('my-bookings-member').textContent = member ? `Signed in as ${member.name} [${member.id}]` : 'Verify your identity to view your saved times.';
      $('my-bookings-total').textContent = formatDuration(totalMinutes);
      $('my-bookings-meta').textContent = bookedSlots.length
        ? `${bookedSlots.length} saved slot${bookedSlots.length === 1 ? '' : 's'} across ${blocks.length} time block${blocks.length === 1 ? '' : 's'}`
        : 'No saved Online, Watching or DUMP times';
      $('my-bookings-pending').textContent = pendingCount
        ? `${pendingCount} unsaved change${pendingCount === 1 ? '' : 's'} — save your schedule to update this list.`
        : '';
      $('my-bookings-pending').classList.toggle('hidden', !pendingCount);

      $('my-bookings-list').innerHTML = blocks.length ? blocks.map((block) => `
        <button class="booking-block ${block.status.toLowerCase()}" type="button" data-booked-slot="${escapeAttr(block.start)}">
          <span class="booking-status">${escapeHtml(block.status)}</span>
          <span class="booking-time"><strong>${escapeHtml(formatBookedRange(block.start, block.end, 'UTC'))}</strong><small>TCT</small></span>
          <span class="booking-local"><strong>${escapeHtml(formatBookedRange(block.start, block.end, LOCAL_TIME_ZONE))}</strong><small>Your local time</small></span>
        </button>
      `).join('') : '<p class="my-bookings-empty">Nothing booked yet. Choose your times below and press Save schedule.</p>';

      $('my-bookings-list').querySelectorAll('[data-booked-slot]').forEach((button) => {
        button.addEventListener('click', () => focusScheduleSlot(button.dataset.bookedSlot));
      });
    }

    function groupBookedSlots(slots, slotMinutes) {
      const blocks = [];
      const step = slotMinutes * 60000;
      slots.forEach((slot) => {
        const status = state.savedSchedule[slot.iso];
        const startMs = Date.parse(slot.iso);
        const previous = blocks[blocks.length - 1];
        if (previous && previous.status === status && Date.parse(previous.end) === startMs) {
          previous.end = new Date(startMs + step).toISOString();
          previous.slotCount += 1;
          return;
        }
        blocks.push({ status, start: slot.iso, end: new Date(startMs + step).toISOString(), slotCount: 1 });
      });
      return blocks;
    }

    function focusSchedulePanel() {
      const panel = document.querySelector('.schedule-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderCoverageCalendar() {
      const slots = state.data.slots || [];
      const now = Date.now();
      const step = state.data.meta.slotMinutes * 60000;
      const futureSlots = slots.filter((slot) => Date.parse(slot.iso) + step > now);
      const summaryBase = futureSlots.length ? futureSlots : slots;
      const slotTotals = summaryBase.map((slot) => coverageTotal(slot));
      const uncovered = slotTotals.filter((total) => total === 0).length;
      const thin = slotTotals.filter((total) => total === 1).length;
      const strongest = slotTotals.length ? Math.max(...slotTotals) : 0;
      const nextGap = findNextGapSlot(slots, step, now);
      const visibleSlots = getVisibleCoverageSlots(slots, step, now);

      document.querySelectorAll('[data-coverage-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.coverageFilter === state.coverageFilter);
      });

      $('coverage-calendar-summary').innerHTML = `
        <div class="coverage-summary-card gap"><strong>${uncovered}</strong><span>future uncovered</span></div>
        <div class="coverage-summary-card thin"><strong>${thin}</strong><span>future thin</span></div>
        <div class="coverage-summary-card strong"><strong>${strongest}</strong><span>best future coverage</span></div>
        <div class="coverage-summary-card next-gap"><strong>${nextGap ? escapeHtml(formatCompact(nextGap.iso)) : 'None'}</strong><span>next upcoming gap · TCT</span></div>
      `;

      if (!visibleSlots.length) {
        $('coverage-calendar').innerHTML = '<p class="coverage-empty">No slots match this filter.</p>';
        return;
      }

      $('coverage-calendar').innerHTML = groupByDay(visibleSlots).map((group) => `
        <section class="coverage-calendar-day">
          <header>
            <h3>${escapeHtml(formatDay(group.day))}</h3>
            <span>${group.slots.length} visible slot${group.slots.length === 1 ? '' : 's'}</span>
          </header>
          <div class="coverage-heat-grid">
            ${group.slots.map((slot) => {
              const online = Number(slot.onlineCount || 0);
              const watching = Number(slot.watchingCount || 0);
              const dump = Number(slot.dumpCount || 0);
              const total = online + watching + dump;
              const start = Date.parse(slot.iso);
              const current = start <= now && now < start + step;
              const past = start + step <= now;
              const level = coverageLevel(total);
              return `
                <button class="coverage-heat-cell ${level} ${current ? 'current' : ''} ${past ? 'past' : ''}" type="button" data-coverage-target="${escapeAttr(slot.iso)}" aria-label="${escapeAttr(formatDateTime(slot.iso))} TCT: ${total} ready; ${online} online, ${watching} watching, ${dump} DUMP">
                  <span class="heat-cell-times">
                    <strong>${escapeHtml(formatTime(slot.iso))} <small>TCT</small></strong>
                    <span>${escapeHtml(formatLocalTime(slot.iso))} <small>local</small></span>
                  </span>
                  <span class="heat-cell-total">${total}<small> ready</small></span>
                  <span class="heat-cell-breakdown"><i class="online">O ${online}</i><i class="watching">W ${watching}</i><i class="dump">D ${dump}</i></span>
                </button>
              `;
            }).join('')}
          </div>
        </section>
      `).join('');

      $('coverage-calendar').querySelectorAll('[data-coverage-target]').forEach((button) => {
        button.addEventListener('click', () => focusScheduleSlot(button.dataset.coverageTarget));
      });
    }

    function getVisibleCoverageSlots(slots, step, now) {
      return slots.filter((slot) => {
        const total = coverageTotal(slot);
        const isFuture = Date.parse(slot.iso) + step > now;
        if (state.coverageFilter === 'all') return true;
        if (state.coverageFilter === 'gaps') return isFuture && total === 0;
        if (state.coverageFilter === 'thin') return isFuture && total === 1;
        return isFuture;
      });
    }

    function findCurrentSlot(slots, step, now) {
      return (slots || []).find((slot) => {
        const start = Date.parse(slot.iso);
        return start <= now && now < start + step;
      }) || null;
    }

    function findNextGapSlot(slots, step, now) {
      return (slots || []).find((slot) => Date.parse(slot.iso) + step > now && coverageTotal(slot) === 0) || null;
    }

    function jumpToCurrentSlot() {
      if (!state.data) return;
      const step = state.data.meta.slotMinutes * 60000;
      const current = findCurrentSlot(state.data.slots || [], step, Date.now());
      if (current) focusScheduleSlot(current.iso);
      else focusCoverageBoard();
    }

    function jumpToNextGap() {
      if (!state.data) return;
      const step = state.data.meta.slotMinutes * 60000;
      const nextGap = findNextGapSlot(state.data.slots || [], step, Date.now());
      if (nextGap) focusScheduleSlot(nextGap.iso);
      else focusCoverageBoard();
    }

    function focusCoverageBoard() {
      const panel = $('coverage-section');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function coverageTotal(slot) {
      return Number(slot.onlineCount || 0) + Number(slot.watchingCount || 0) + Number(slot.dumpCount || 0);
    }

    function coverageLevel(total) {
      if (total <= 0) return 'gap';
      if (total === 1) return 'thin';
      if (total <= 3) return 'covered';
      return 'strong';
    }

    function focusScheduleSlot(slotIso) {
      const row = [...document.querySelectorAll('[data-schedule-slot]')]
        .find((item) => item.dataset.scheduleSlot === slotIso);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('coverage-focus');
      window.setTimeout(() => row.classList.remove('coverage-focus'), 1800);
    }

    function renderCoverage() {
      const now = Date.now();
      const step = state.data.meta.slotMinutes * 60000;
      $('coverage').innerHTML = state.data.slots.map((slot) => {
        const start = Date.parse(slot.iso);
        const current = start <= now && now < start + step;
        const dumpCount = Number(slot.dumpCount || 0);
        const dumpNames = slot.dumpNames || [];
        const hasCoverage = slot.onlineCount > 0 || slot.watchingCount > 0 || dumpCount > 0;
        return `
          <div class="coverage-row ${current ? 'current' : ''} ${hasCoverage ? 'has-coverage' : ''}">
            <div class="coverage-main">
              <div class="coverage-time">
                <span>${escapeHtml(formatCompact(slot.iso))} <small>TCT</small></span>
                <span class="coverage-local">${escapeHtml(formatLocalCompact(slot.iso))} <small>Your local</small></span>
              </div>
              <div class="coverage-counts">
                <span class="count-pill online">${slot.onlineCount} online</span>
                <span class="count-pill watching">${slot.watchingCount} watching</span>
                <span class="count-pill dump">${dumpCount} DUMP</span>
              </div>
            </div>
            ${hasCoverage ? `
              <div class="coverage-status-grid">
                <div class="coverage-status-block online">
                  <span class="coverage-status-label">Online · ${slot.onlineCount}</span>
                  <div class="coverage-names">${slot.onlineNames.length ? escapeHtml(slot.onlineNames.join(', ')) : 'Nobody'}</div>
                </div>
                <div class="coverage-status-block watching">
                  <span class="coverage-status-label">Watching · ${slot.watchingCount}</span>
                  <div class="coverage-names">${slot.watchingNames.length ? escapeHtml(slot.watchingNames.join(', ')) : 'Nobody'}</div>
                </div>
                <div class="coverage-status-block dump">
                  <span class="coverage-status-label">DUMP · ${dumpCount}</span>
                  <div class="coverage-names">${dumpNames.length ? escapeHtml(dumpNames.join(', ')) : 'Nobody'}</div>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }

    function renderMemberStatusList() {
      const container = $('member-status-list');
      if (!container || !state.data) return;
      const statuses = state.data.currentMemberStatuses || [];

      document.querySelectorAll('[data-status-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.statusFilter === state.memberStatusFilter);
      });

      if (!statuses.length) {
        container.innerHTML = '<p class="coverage-empty">No active time slot right now, or your identity has not been verified.</p>';
        return;
      }

      const visible = state.memberStatusFilter === 'all'
        ? statuses
        : statuses.filter((item) => item.status === state.memberStatusFilter);

      container.innerHTML = visible.length ? visible.map((item) => {
        const rowClass = String(item.status || 'Not set').toLowerCase().replace(/\s+/g, '-');
        return `
          <div class="member-status-row ${rowClass}">
            <span class="member-status-name">${escapeHtml(item.name)} <small>[${escapeHtml(item.id)}]</small></span>
            <span class="member-status-badge">${escapeHtml(item.status)}</span>
          </div>
        `;
      }).join('') : '<p class="coverage-empty">No members match this filter.</p>';
    }

    function renderRoster() {
      if (!state.data) return;
      const query = $('member-search').value.trim().toLowerCase();
      const members = state.data.members.filter((member) => (
        !query || member.name.toLowerCase().includes(query) || String(member.id).includes(query)
      ));
      $('roster').innerHTML = members.map((member) => `
        <div class="roster-row">
          <div>
            <a class="member-name" href="${escapeAttr(member.profileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(member.name)} [${escapeHtml(member.id)}]</a>
            <div class="member-meta">${escapeHtml(member.lastActionRelative || member.stateDetail || 'No last-action data')}</div>
          </div>
          <span class="badge ${member.liveStatus.toLowerCase()}">${escapeHtml(member.liveStatus)}</span>
        </div>
      `).join('') || '<p class="hint">No matching members.</p>';
    }

    function setSlotStatus(slotIso, status) {
      if (!(state.data.auth && state.data.auth.authenticated)) return openIdentityGate('Verify your Torn identity before editing a schedule.');
      state.schedule[slotIso] = state.schedule[slotIso] === status ? '' : status;
      state.dirty.add(slotIso);
      renderSchedule();
      renderDirtyState();
      renderMyBookings();
    }

    function setDayStatus(day, status) {
      if (!(state.data.auth && state.data.auth.authenticated)) return openIdentityGate('Verify your Torn identity before editing a schedule.');
      state.data.slots.filter((slot) => slot.iso.slice(0, 10) === day).forEach((slot) => {
        state.schedule[slot.iso] = status;
        state.dirty.add(slot.iso);
      });
      renderSchedule();
      renderDirtyState();
      renderMyBookings();
    }

    function renderDirtyState() {
      const count = state.dirty.size;
      $('dirty-state').textContent = count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'No unsaved changes';
      $('save-button').disabled = !count || !(state.data.auth && state.data.auth.authenticated);
    }

    async function saveSchedule() {
      if (!state.dirty.size) return;
      setLoading(true);
      try {
        const updates = [...state.dirty].map((slot) => ({ slot, status: state.schedule[slot] }));
        const data = await server('saveAvailability', state.sessionToken, updates);
        applyData(data);
        toast('Schedule saved.');
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (/identity verification|member session|session token/i.test(message)) {
          clearRememberedSession();
          state.sessionToken = '';
          openIdentityGate('Your saved identity has expired. Please verify your API key again.');
        }
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    function readSessionToken() {
      try {
        const stored = localStorage.getItem(SESSION_STORAGE_KEY);
        if (stored) return stored;
        const backup = localStorage.getItem(SESSION_BACKUP_KEY);
        if (backup) return backup;
      } catch (ignore) {
        // Try session storage and the first-party cookie below.
      }
      try {
        const sessionStored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (sessionStored) return sessionStored;
      } catch (ignore) {
        // Cookie fallback below.
      }
      const prefix = `${SESSION_STORAGE_KEY}=`;
      const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
      return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
    }

    function rememberSession(token) {
      try {
        localStorage.setItem(SESSION_STORAGE_KEY, token);
        localStorage.setItem(SESSION_BACKUP_KEY, token);
        localStorage.removeItem('chainWatcherMember');
      } catch (ignore) {
        // Session storage and the first-party cookie remain as fallbacks.
      }
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, token);
      } catch (ignore) {
        // The first-party cookie remains as a fallback.
      }
      document.cookie = `${SESSION_STORAGE_KEY}=${encodeURIComponent(token)}; Max-Age=${30 * 86400}; Path=/; SameSite=Lax; Secure`;
    }

    function clearRememberedSession() {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.removeItem(SESSION_BACKUP_KEY);
        localStorage.removeItem('chainWatcherMember');
      } catch (ignore) {
        // Continue with session storage and cookie removal.
      }
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      } catch (ignore) {
        // Continue with cookie removal.
      }
      document.cookie = `${SESSION_STORAGE_KEY}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
    }

    function setIdentityError(message) {
      const error = $('identity-error');
      if (!error) {
        if (message) console.warn(`Chain Watcher identity error: ${message}`);
        return;
      }
      error.textContent = message || '';
      error.classList.toggle('hidden', !message);
    }

    function openIdentityGate(message) {
      setAuthBodyState(false);
      document.body.classList.add('identity-gate-open');
      const gate = $('identity-gate');
      if (gate) gate.setAttribute('aria-hidden', 'false');

      if (!state.pendingConfirmationToken) {
        const keyStep = $('identity-key-step');
        const confirmStep = $('identity-confirm-step');
        if (keyStep) keyStep.classList.remove('hidden');
        if (confirmStep) confirmStep.classList.add('hidden');
      }

      setIdentityError(message || '');
      const apiKeyInput = $('identity-api-key');
      if (apiKeyInput) window.setTimeout(() => apiKeyInput.focus(), 40);
    }

    function closeIdentityGate() {
      setAuthBodyState(true);
      document.body.classList.remove('identity-gate-open');
      const gate = $('identity-gate');
      if (gate) gate.setAttribute('aria-hidden', 'true');
      setIdentityError('');
      const apiKeyInput = $('identity-api-key');
      if (apiKeyInput) apiKeyInput.value = '';
      state.pendingConfirmationToken = '';
      state.pendingMember = null;
    }

    function resetIdentityFlow() {
      state.pendingConfirmationToken = '';
      state.pendingMember = null;
      const confirmStep = $('identity-confirm-step');
      const keyStep = $('identity-key-step');
      const apiKeyInput = $('identity-api-key');
      if (confirmStep) confirmStep.classList.add('hidden');
      if (keyStep) keyStep.classList.remove('hidden');
      setIdentityError('');
      if (apiKeyInput) apiKeyInput.value = '';
    }

    async function verifyIdentity() {
      const apiKey = $('identity-api-key').value.trim();
      $('identity-api-key').value = '';
      if (!apiKey) return setIdentityError('Enter the custom Torn API key first.');
      setLoading(true);
      setIdentityError('');
      try {
        const result = await server('verifyMemberApiKey', apiKey);
        state.pendingConfirmationToken = result.confirmationToken;
        state.pendingMember = result.member;
        $('identity-confirm-name').textContent = `${result.member.name} [${result.member.id}]`;
        $('identity-key-step').classList.add('hidden');
        $('identity-confirm-step').classList.remove('hidden');
      } catch (error) {
        setIdentityError(error && error.message ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    }

    async function confirmIdentity() {
      if (!state.pendingConfirmationToken) return resetIdentityFlow();
      setLoading(true);
      setIdentityError('');
      try {
        const result = await confirmMemberSession(state.pendingConfirmationToken);
        state.sessionToken = result.sessionToken;
        rememberSession(result.sessionToken);
        if (result.data) {
          applyData(result.data);
        } else {
          await loadData(false);
        }
        const member = (state.data && state.data.auth && state.data.auth.member) || result.member || state.pendingMember;
        toast(`Identity locked to ${member ? member.name : 'member'}.`);
      } catch (error) {
        setIdentityError(error && error.message ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    }

    async function confirmMemberSession(confirmationToken) {
      try {
        return await serverWithTimeout(IDENTITY_CONFIRM_TIMEOUT_MS, 'confirmMemberIdentityFast', confirmationToken);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (!/Unknown or blocked API function|confirmMemberIdentityFast/i.test(message)) throw error;
        return serverWithTimeout(IDENTITY_CONFIRM_TIMEOUT_MS, 'confirmMemberIdentity', confirmationToken);
      }
    }

    async function changeIdentity() {
      if (state.dirty.size && !window.confirm('Discard unsaved schedule changes and change identity?')) return;
      clearRememberedSession();
      state.sessionToken = '';
      state.schedule = {};
      state.dirty.clear();
      resetIdentityFlow();
      openIdentityGate();
      await loadData(false);
    }

    async function unlockAdmin() {
      const secret = $('admin-secret').value;
      if (!secret) return toast('Enter the admin password.', true);
      setLoading(true);
      try {
        const admin = await server('getAdminState', secret);
        state.adminSecret = secret;
        populateAdmin(admin);
        $('admin-login').classList.add('hidden');
        $('admin-content').classList.remove('hidden');
        $('admin-secret').value = '';
        toast('Admin settings unlocked.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    function populateAdmin(admin) {
      $('admin-faction-id').value = admin.factionId;
      $('admin-start').value = toDateTimeInput(admin.start);
      $('admin-end').value = toDateTimeInput(admin.end);
      $('admin-slot-minutes').value = String(admin.slotMinutes);
      $('admin-refresh-minutes').value = String(admin.refreshMinutes);
      $('admin-api-key').value = '';
      $('admin-embed-origin').value = admin.embedOrigin || '';
      $('admin-api-state').textContent = admin.apiConfigured
        ? 'The Torn API key is stored in Script Properties.'
        : 'The Torn API key has not been configured.';
      $('admin-export-result').textContent = '';
      renderManualMembers(admin.manualMembers || []);
      loadActivityLog(false);
    }

    function queueActivityLogRefresh() {
      window.clearTimeout(state.logSearchTimer);
      state.logSearchTimer = window.setTimeout(() => loadActivityLog(false), 300);
    }

    function readLogFilters() {
      return {
        category: $('log-category-filter').value,
        outcome: $('log-outcome-filter').value,
        query: $('log-search').value.trim(),
        limit: 50,
        scanLimit: 1500,
      };
    }

    async function loadActivityLog(showSpinner) {
      if (!state.adminSecret) return;
      if (showSpinner) setLoading(true);
      try {
        const result = await server('adminGetLogs', readLogFilters(), state.adminSecret);
        state.activityLog = result;
        renderActivityLog(result);
      } catch (error) {
        const summary = $('activity-log-summary');
        const list = $('activity-log-list');
        if (summary) summary.textContent = error.message || String(error);
        if (list) list.innerHTML = '';
        if (showSpinner) showError(error);
      } finally {
        if (showSpinner) setLoading(false);
      }
    }

    function renderActivityLog(result) {
      const summary = $('activity-log-summary');
      const list = $('activity-log-list');
      if (!summary || !list) return;

      const entries = result && Array.isArray(result.entries) ? result.entries : [];
      if (!entries.length) {
        summary.textContent = result && result.scanned
          ? `No log entries matched the current filters. Scanned ${result.scanned} recent row(s).`
          : 'No log entries yet.';
        list.innerHTML = '';
        return;
      }

      const more = result.hasMore ? ` Showing latest ${entries.length}.` : '';
      summary.textContent = `${result.totalMatched || entries.length} matching log entr${(result.totalMatched || entries.length) === 1 ? 'y' : 'ies'} from ${result.scanned || entries.length} scanned row(s).${more}`;
      list.innerHTML = entries.map(renderLogEntry).join('');
    }

    function renderLogEntry(entry) {
      const level = String(entry.level || 'INFO').toLowerCase();
      const outcome = String(entry.outcome || 'success').toLowerCase();
      const actor = entry.actorName
        ? `${escapeHtml(entry.actorName)}${entry.actorId ? ` <small>[${escapeHtml(entry.actorId)}]</small>` : ''}`
        : 'System';
      const requestId = entry.requestId ? `<span>Request: <code>${escapeHtml(entry.requestId)}</code></span>` : '';
      const changed = Number(entry.changedSlotCount || (entry.changes ? entry.changes.length : 0));
      const changeSummary = changed
        ? `<strong>${changed}</strong> changed slot${changed === 1 ? '' : 's'}`
        : '';
      const scheduleDetails = entry.changes && entry.changes.length
        ? renderScheduleChanges(entry.changes)
        : '';

      return `
        <article class="activity-log-entry ${escapeAttr(level)} ${escapeAttr(outcome)}">
          <div class="activity-log-entry-main">
            <div>
              <div class="activity-log-meta">
                <span>${escapeHtml(entry.timestampTct || entry.timestampUtc || 'Unknown time')}</span>
                <span>${escapeHtml(entry.category || 'general')}</span>
                <span>${escapeHtml(entry.action || 'event')}</span>
              </div>
              <h4>${actor}</h4>
              <p>${escapeHtml(entry.message || 'No message')}</p>
            </div>
            <div class="activity-log-badges">
              <span class="log-badge ${escapeAttr(outcome)}">${escapeHtml(entry.outcome || 'success')}</span>
              <span class="log-badge">${escapeHtml(entry.source || 'backend')}</span>
            </div>
          </div>
          <div class="activity-log-foot">
            ${changeSummary ? `<span>${changeSummary}</span>` : ''}
            ${entry.submittedSlotCount ? `<span>${escapeHtml(entry.submittedSlotCount)} submitted slot(s)</span>` : ''}
            ${requestId}
          </div>
          ${scheduleDetails}
        </article>
      `;
    }

    function renderScheduleChanges(changes) {
      const visible = changes.slice(0, 120);
      const hiddenCount = Math.max(0, changes.length - visible.length);
      return `
        <details class="log-change-details">
          <summary>${changes.length} slot change${changes.length === 1 ? '' : 's'}</summary>
          <div class="log-change-list">
            ${visible.map((change) => `
              <div class="log-change-row">
                <span>${escapeHtml(change.slotTct || change.slotUtc || 'Unknown slot')}</span>
                <strong>${escapeHtml(change.from || 'Not set')} &rarr; ${escapeHtml(change.to || 'Not set')}</strong>
              </div>
            `).join('')}
            ${hiddenCount ? `<p class="hint">+${hiddenCount} more changes hidden in this view.</p>` : ''}
          </div>
        </details>
      `;
    }

    function renderManualMembers(members) {
      const container = $('manual-member-list');
      container.innerHTML = members.length ? members.map((member) => `
        <div class="manual-member-row">
          <div>
            <strong>${escapeHtml(member.name)} [${escapeHtml(member.id)}]</strong>
            <span>${escapeHtml(member.liveStatus || 'Unknown')}${member.lastActionRelative ? ` • ${escapeHtml(member.lastActionRelative)}` : ''}</span>
          </div>
          <button class="button button-ghost manual-remove" type="button" data-remove-manual="${escapeAttr(member.id)}">Remove</button>
        </div>
      `).join('') : '<p class="hint">No manually added members.</p>';
      container.querySelectorAll('[data-remove-manual]').forEach((button) => {
        button.addEventListener('click', () => removeManualMember(button.dataset.removeManual));
      });
    }

    async function addManualMember() {
      const id = $('manual-member-id').value.trim();
      if (!/^\d+$/.test(id)) return toast('Enter a valid numeric Torn user ID.', true);
      setLoading(true);
      try {
        const admin = await server('adminAddManualMember', id, state.adminSecret);
        $('manual-member-id').value = '';
        populateAdmin(admin);
        await loadData(false);
        toast('Manual member added and synced from Torn.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    async function removeManualMember(id) {
      if (!window.confirm(`Remove Torn user ${id} from the manual member list?`)) return;
      setLoading(true);
      try {
        const admin = await server('adminRemoveManualMember', id, state.adminSecret);
        populateAdmin(admin);
        await loadData(false);
        toast('Manual member removed.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    async function saveAdmin() {
      const payload = {
        factionId: $('admin-faction-id').value.trim(),
        start: fromDateTimeInput($('admin-start').value),
        end: fromDateTimeInput($('admin-end').value),
        slotMinutes: Number($('admin-slot-minutes').value),
        refreshMinutes: Number($('admin-refresh-minutes').value),
        apiKey: $('admin-api-key').value.trim(),
        embedOrigin: $('admin-embed-origin').value.trim(),
      };
      setLoading(true);
      try {
        const admin = await server('saveAdminSettings', payload, state.adminSecret);
        populateAdmin(admin);
        if (admin.archivedReport) showEventReportLink(admin.archivedReport, 'Previous event archived: ');
        await loadData(false);
        toast('Admin settings saved.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    function readEventRangeFromAdmin() {
      const startValue = $('admin-start').value;
      const endValue = $('admin-end').value;
      if (!startValue || !endValue) throw new Error('Enter both the event start and end time.');
      return {
        start: fromDateTimeInput(startValue),
        end: fromDateTimeInput(endValue),
        slotMinutes: Number($('admin-slot-minutes').value),
      };
    }

    async function createEventReportSheet() {
      setLoading(true);
      try {
        const result = await server('adminCreateEventSheet', readEventRangeFromAdmin(), state.adminSecret);
        showEventReportLink(result, 'Report ready: ');
        toast('Event report sheet created.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    function showEventReportLink(result, prefix) {
      const container = $('admin-export-result');
      container.textContent = prefix;
      const link = document.createElement('a');
      link.href = result.sheetUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${result.sheetName} (${result.memberCount} members, ${result.slotCount} slots)`;
      container.appendChild(link);
    }

    async function downloadEventCsv() {
      setLoading(true);
      try {
        const result = await server('adminExportEventCsv', readEventRangeFromAdmin(), state.adminSecret);
        const binary = window.atob(result.contentBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = result.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        $('admin-export-result').textContent = `Downloaded ${result.fileName} (${result.memberCount} members, ${result.slotCount} slots).`;
        toast('CSV export downloaded.');
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    async function runAdminAction(functionName, successMessage) {
      setLoading(true);
      try {
        const result = await server(functionName, state.adminSecret);
        if (result && result.meta) applyData(result);
        else await loadData(false);
        toast(successMessage);
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    function server(functionName, ...args) {
      return serverWithTimeout(API_TIMEOUT_MS, functionName, ...args);
    }

    function serverWithTimeout(timeoutMs, functionName, ...args) {
      return serverViaFramePost(timeoutMs, functionName, ...args);
    }

    function serverViaFramePost(timeoutMs, functionName, ...args) {
      if (!API_URL) {
        return Promise.reject(new Error('Chain Watcher API URL is missing from config.js.'));
      }

      return new Promise((resolve, reject) => {
        const requestId = `cw_api_${Date.now()}_${apiRequestCounter += 1}`;
        const iframeName = `${requestId}_frame`;
        const iframe = document.createElement('iframe');
        const form = document.createElement('form');
        let finished = false;
        let timer = null;
        let loadGraceTimer = null;

        function cleanup() {
          if (finished) return;
          finished = true;
          window.clearTimeout(timer);
          window.clearTimeout(loadGraceTimer);
          window.removeEventListener('message', onMessage);
          if (form.parentNode) form.parentNode.removeChild(form);
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }

        function onMessage(event) {
          const data = event && event.data;
          if (!data || data.source !== 'chain-watcher-api' || data.requestId !== requestId) return;
          cleanup();
          const payload = data.payload;
          if (payload && payload.ok) {
            resolve(payload.result);
            return;
          }
          reject(new Error(payload && payload.error ? payload.error : 'Chain Watcher API request failed.'));
        }

        iframe.onerror = () => {
          cleanup();
          reject(new Error('Chain Watcher API frame request failed. Check the deployed Apps Script /exec URL and deployment access.'));
        };

        iframe.onload = () => {
          if (finished) return;
          window.clearTimeout(loadGraceTimer);
          loadGraceTimer = window.setTimeout(() => {
            cleanup();
            reject(new Error('Chain Watcher API frame response did not return data. Deploy the Apps Script iframe transport patch.'));
          }, 2000);
        };

        timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('Chain Watcher API request timed out.'));
        }, Number.isFinite(timeoutMs) && timeoutMs >= 5000 ? timeoutMs : 30000);

        function addField(name, value) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }

        iframe.name = iframeName;
        iframe.hidden = true;
        iframe.style.display = 'none';
        form.method = 'post';
        form.action = API_URL;
        form.target = iframeName;
        form.acceptCharset = 'UTF-8';
        form.hidden = true;
        form.style.display = 'none';

        addField('cwApi', '1');
        addField('transport', 'frame');
        addField('requestId', requestId);
        addField('origin', window.location.origin);
        addField('fn', functionName);
        addField('args', JSON.stringify(args));
        addField('_', String(Date.now()));

        window.addEventListener('message', onMessage);
        document.body.appendChild(iframe);
        document.body.appendChild(form);
        form.submit();
      });
    }

    function setLoading(enabled) {
      state.loadingCount += enabled ? 1 : -1;
      state.loadingCount = Math.max(0, state.loadingCount);
      const active = state.loadingCount > 0;
      const loading = $('loading');

      if (loading) {
        loading.classList.toggle('hidden', !active);
        loading.setAttribute('aria-hidden', active ? 'false' : 'true');
      }
      document.body.classList.toggle('cw-loading', active);

      window.clearTimeout(state.loadingWatchdogTimer);
      if (active) {
        state.loadingWatchdogTimer = window.setTimeout(() => {
          state.loadingCount = 0;
          const stuckLoading = $('loading');
          if (stuckLoading) {
            stuckLoading.classList.add('hidden');
            stuckLoading.setAttribute('aria-hidden', 'true');
          }
          document.body.classList.remove('cw-loading');
        }, Math.max(30000, (Number.isFinite(API_TIMEOUT_MS) ? API_TIMEOUT_MS : 30000) + 5000));
      }

      scheduleLayoutPublish();
    }

    function toast(message, isError) {
      const element = $('toast');
      if (!element) {
        if (isError) console.error(message);
        else console.log(message);
        return;
      }
      element.textContent = message;
      element.classList.toggle('error', Boolean(isError));
      element.classList.add('show');
      window.clearTimeout(state.toastTimer);
      state.toastTimer = window.setTimeout(() => element.classList.remove('show'), 4200);
    }

    function showError(error) {
      console.error(error);
      toast(error && error.message ? error.message : String(error), true);
    }

    function groupByDay(slots) {
      const groups = [];
      slots.forEach((slot) => {
        const day = slot.iso.slice(0, 10);
        let group = groups[groups.length - 1];
        if (!group || group.day !== day) {
          group = { day, slots: [] };
          groups.push(group);
        }
        group.slots.push(slot);
      });
      return groups;
    }

    function formatRange(start, end) {
      return `${formatDateTime(start)} – ${formatDateTime(end)}`;
    }

    function formatLocalRange(start, end) {
      return `${formatLocalDateTime(start)} – ${formatLocalDateTime(end)}`;
    }

    function formatDateTime(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatCompact(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatLocalCompact(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: LOCAL_TIME_ZONE, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatDay(day) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }).format(new Date(`${day}T12:00:00Z`));
    }

    function formatTime(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatLocalSlot(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: LOCAL_TIME_ZONE, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatLocalTime(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: LOCAL_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatLocalDateTime(iso) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: LOCAL_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    }

    function formatBookedRange(startIso, endIso, timeZone) {
      const dateFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone, weekday: 'short', day: '2-digit', month: 'short',
      });
      const timeFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const startDate = dateFormatter.format(new Date(startIso));
      const endDate = dateFormatter.format(new Date(endIso));
      const startTime = timeFormatter.format(new Date(startIso));
      const endTime = timeFormatter.format(new Date(endIso));
      return startDate === endDate
        ? `${startDate} · ${startTime}–${endTime}`
        : `${startDate} ${startTime} – ${endDate} ${endTime}`;
    }

    function formatDuration(minutes) {
      if (!minutes) return '0 hours';
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      if (!hours) return `${remainder} min`;
      return remainder ? `${hours}h ${remainder}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    function toDateTimeInput(iso) {
      const date = new Date(iso);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    }

    function fromDateTimeInput(value) {
      if (!value) return '';
      return new Date(`${value}:00Z`).toISOString();
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
      }[character]));
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }
  })();
