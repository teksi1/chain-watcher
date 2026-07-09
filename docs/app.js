(() => {
    const API_CONFIG = window.CHAIN_WATCHER_API_CONFIG || {};
    const API_URL = String(API_CONFIG.apiUrl || '').trim();
    const API_TIMEOUT_MS = Number(API_CONFIG.timeoutMs || 30000);
    let apiRequestCounter = 0;
    if (window.__CHAIN_WATCHER_EMBED_DENIED__) return;
    const STATUS_OPTIONS = ['Online', 'Watching', 'DUMP', 'Offline'];
    const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
    const SESSION_STORAGE_KEY = 'chainWatcherMemberSession';
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
      bindEvents();
      bindLayoutPublisher();
      loadData(true).finally(scheduleAutoRefresh);
    });

    function bindEvents() {
      bindInternalNavigation();

      const resourcesMenu = document.querySelector('.nav-resources');
      if (resourcesMenu) {
        resourcesMenu.querySelectorAll('a').forEach((link) => {
          link.addEventListener('click', () => resourcesMenu.removeAttribute('open'));
        });
        document.addEventListener('click', (event) => {
          if (resourcesMenu.open && !resourcesMenu.contains(event.target)) resourcesMenu.removeAttribute('open');
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
        const data = await server('getAppData', state.sessionToken);
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
        clearRememberedSession();
        state.sessionToken = '';
        openIdentityGate();
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
        localStorage.removeItem('chainWatcherMember');
      } catch (ignore) {
        // The first-party cookie remains as a fallback.
      }
      document.cookie = `${SESSION_STORAGE_KEY}=${encodeURIComponent(token)}; Max-Age=${30 * 86400}; Path=/; SameSite=Lax; Secure`;
    }

    function clearRememberedSession() {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.removeItem('chainWatcherMember');
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
        const result = await server('confirmMemberIdentity', state.pendingConfirmationToken);
        state.sessionToken = result.sessionToken;
        rememberSession(result.sessionToken);
        applyData(result.data);
        toast(`Identity locked to ${result.data.auth.member.name}.`);
      } catch (error) {
        setIdentityError(error && error.message ? error.message : String(error));
      } finally {
        setLoading(false);
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
      if (!API_URL) {
        return Promise.reject(new Error('Chain Watcher API URL is missing from config.js.'));
      }

      return new Promise((resolve, reject) => {
        const callbackName = `__cwApiCallback_${Date.now()}_${apiRequestCounter += 1}`;
        const script = document.createElement('script');
        const url = new URL(API_URL);
        let finished = false;
        let timer = null;

        function cleanup() {
          if (finished) return;
          finished = true;
          window.clearTimeout(timer);
          try { delete window[callbackName]; } catch (ignore) { window[callbackName] = undefined; }
          if (script.parentNode) script.parentNode.removeChild(script);
        }

        window[callbackName] = (payload) => {
          cleanup();
          if (payload && payload.ok) {
            resolve(payload.result);
            return;
          }
          reject(new Error(payload && payload.error ? payload.error : 'Chain Watcher API request failed.'));
        };

        script.onerror = () => {
          cleanup();
          reject(new Error('Chain Watcher API script request failed. Check the deployed Apps Script /exec URL and deployment access.'));
        };

        timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('Chain Watcher API request timed out.'));
        }, Number.isFinite(API_TIMEOUT_MS) && API_TIMEOUT_MS >= 5000 ? API_TIMEOUT_MS : 30000);

        url.searchParams.set('cwApi', '1');
        url.searchParams.set('fn', functionName);
        url.searchParams.set('args', JSON.stringify(args));
        url.searchParams.set('callback', callbackName);
        url.searchParams.set('_', String(Date.now()));

        script.async = true;
        script.referrerPolicy = 'no-referrer';
        script.src = url.toString();
        document.head.appendChild(script);
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
        }, 30000);
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
