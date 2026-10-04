/* ============================================================
   Nova Alarm — application logic (vanilla JS, no deps)
   Real functionality only: persistence, scheduling, sound,
   vibration, notifications, history, missed-alarm recovery.
   ============================================================ */
(function () {
  'use strict';

  const STORAGE_KEY = 'nova-alarm-v1';
  const APP_VERSION = '1.0.0';
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const $ = (id) => document.getElementById(id);

  /* ---------------- state ---------------- */
  const defaultState = () => ({
    alarms: [],
    history: [],
    settings: { format24: true, snooze: 5, sound: true, vibrate: true, wake: false, theme: 'dark' },
    lastTick: Date.now(),
    seq: 1
  });

  let state = defaultState();
  let ringingId = null;
  let audioCtx = null;
  let ringTimer = null;
  let vibTimer = null;
  let lastNotifiedKey = null;
  let wakeLock = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const s = defaultState();
      s.alarms = Array.isArray(parsed.alarms) ? parsed.alarms : [];
      s.history = Array.isArray(parsed.history) ? parsed.history : [];
      s.settings = Object.assign(s.settings, parsed.settings || {});
      s.lastTick = parsed.lastTick || Date.now();
      s.seq = parsed.seq || (s.alarms.length + 1);
      return s;
    } catch (e) {
      console.warn('State load failed, starting fresh', e);
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Storage is full — could not save', 'err');
    }
  }

  /* ---------------- time helpers ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  function formatTime(h, m, withSeconds) {
    const sec = withSeconds ? ':00' : '';
    if (state.settings.format24) {
      return pad(h) + ':' + pad(m) + sec;
    }
    const mer = h >= 12 ? 'PM' : 'AM';
    let hr = h % 12; if (hr === 0) hr = 12;
    return hr + ':' + pad(m) + sec + ' ' + mer;
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    return formatTime(d.getHours(), d.getMinutes(), false);
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Next timestamp strictly after `from` for given hour/min + repeat days.
  function nextOccurrence(h, m, days, from) {
    const base = new Date(from);
    for (let i = 0; i <= 8; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
      if (d.getTime() <= from) continue;
      if (!days || days.length === 0) return d.getTime();       // one-time
      if (days.indexOf(d.getDay()) !== -1) return d.getTime();  // repeat
    }
    return null;
  }

  function recomputeNext(alarm, from) {
    alarm.nextAt = nextOccurrence(alarm.hour, alarm.minute, alarm.days, from || Date.now());
    return alarm.nextAt;
  }

  function humanCountdown(ms) {
    if (ms <= 0) return 'now';
    const totalMin = Math.floor(ms / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    const s = Math.floor(ms / 1000);
    return s + 's';
  }

  function daysText(days) {
    if (!days || days.length === 0) return 'One-time';
    if (days.length === 7) return 'Every day';
    const wd = [1, 2, 3, 4, 5];
    const we = [0, 6];
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const s = days.slice().sort((a, b) => a - b);
    if (same(s, wd)) return 'Weekdays';
    if (same(s, we)) return 'Weekends';
    return s.map((d) => DAY_LABELS[d]).join(', ');
  }

  /* ---------------- rendering ---------------- */
  function renderClock() {
    const now = new Date();
    $('clockTime').textContent = formatTime(now.getHours(), now.getMinutes(), false) + ':' + pad(now.getSeconds());
    $('clockDate').textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    $('formatBtn').textContent = state.settings.format24 ? '24h' : '12h';
  }

  function renderNext() {
    const enabled = state.alarms.filter((a) => a.enabled && a.nextAt);
    let nearest = null;
    for (const a of enabled) if (nearest === null || a.nextAt < nearest) nearest = a.nextAt;
    const label = $('nextLabel'), count = $('nextCount'), dot = $('nextDot'), mini = $('nextMini');

    if (nearest === null) {
      label.textContent = 'No upcoming alarm';
      count.textContent = '';
      dot.classList.remove('live');
      mini.textContent = state.alarms.length ? 'All alarms off' : 'No alarms set';
      return;
    }
    const alarm = state.alarms.find((a) => a.nextAt === nearest);
    label.textContent = 'Next alarm at ' + fmtTs(nearest) + (alarm && alarm.label ? ' · ' + alarm.label : '');
    count.textContent = humanCountdown(nearest - Date.now());
    dot.classList.add('live');
    mini.textContent = 'Next in ' + humanCountdown(nearest - Date.now());
  }

  function renderAlarms() {
    const list = $('alarmList');
    const empty = $('emptyState');
    list.innerHTML = '';
    if (state.alarms.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const sorted = state.alarms.slice().sort((a, b) => {
      if (a.hour !== b.hour) return a.hour - b.hour;
      return a.minute - b.minute;
    });

    for (const a of sorted) {
      const card = document.createElement('div');
      card.className = 'alarm-card' + (a.enabled ? '' : ' off') + (ringingId === a.id ? ' ringing' : '');
      card.dataset.id = a.id;

      const main = document.createElement('div');
      main.className = 'alarm-main';
      main.setAttribute('role', 'button');
      main.tabIndex = 0;
      main.setAttribute('aria-label', 'Edit alarm ' + formatTime(a.hour, a.minute) + (a.label ? ', ' + a.label : ''));

      const time = document.createElement('div');
      time.className = 'alarm-time';
      time.textContent = formatTime(a.hour, a.minute, false);

      const sub = document.createElement('div');
      sub.className = 'alarm-sub';
      if (a.label) {
        const l = document.createElement('span'); l.className = 'alarm-label'; l.textContent = a.label; sub.appendChild(l);
      }
      const d = document.createElement('span'); d.className = 'alarm-days'; d.textContent = daysText(a.days); sub.appendChild(d);

      const missed = state.history.find((h) => h.alarmId === a.id && h.action === 'missed' && !h.seen);
      if (missed) {
        const p = document.createElement('span'); p.className = 'pill missed'; p.textContent = 'Missed'; sub.appendChild(p);
      }

      main.appendChild(time); main.appendChild(sub);
      main.addEventListener('click', () => openEditor(a.id));
      main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(a.id); } });

      const side = document.createElement('div');
      side.className = 'alarm-side';

      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.type = 'button';
      editBtn.setAttribute('aria-label', 'Edit alarm');
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditor(a.id); });

      const sw = document.createElement('label');
      sw.className = 'switch';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = a.enabled;
      cb.setAttribute('aria-label', 'Toggle alarm ' + formatTime(a.hour, a.minute));
      cb.addEventListener('change', () => toggleAlarm(a.id, cb.checked));
      const sl = document.createElement('span'); sl.className = 'slider';
      sw.appendChild(cb); sw.appendChild(sl);

      side.appendChild(editBtn); side.appendChild(sw);
      card.appendChild(main); card.appendChild(side);
      list.appendChild(card);
    }
  }

  function renderHistory() {
    const list = $('historyList');
    const empty = $('historyEmpty');
    list.innerHTML = '';
    if (state.history.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    const recent = state.history.slice().sort((a, b) => b.at - a.at).slice(0, 100);
    const icons = { dismissed: '✓', snoozed: '⏱', missed: '!' };
    for (const h of recent) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML =
        '<div class="history-badge ' + h.action + '">' + icons[h.action] + '</div>' +
        '<div class="history-body"><div class="history-title"></div><div class="history-meta"></div></div>' +
        '<div class="history-time"></div>';
      item.querySelector('.history-title').textContent = h.label || 'Alarm';
      item.querySelector('.history-meta').textContent =
        (h.action.charAt(0).toUpperCase() + h.action.slice(1)) + ' · ' + fmtDate(h.at);
      item.querySelector('.history-time').textContent = fmtTs(h.at);
      list.appendChild(item);
    }
  }

  function renderAll() {
    renderClock();
    renderAlarms();
    renderHistory();
    renderNext();
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, kind) {
    kind = kind || 'ok';
    const wrap = $('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const ico = kind === 'err' ? '!' : kind === 'warn' ? '!' : '✓';
    el.innerHTML = '<span class="t-ico">' + ico + '</span><span class="t-msg"></span>';
    el.querySelector('.t-msg').textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }

  /* ---------------- audio engine (Web Audio, no assets) ---------------- */
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function tone(ctx, freq, start, dur, type, peak) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(start); osc.stop(start + dur + 0.05);
  }

  function playBurst(sound) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime;
    if (sound === 'chime') {
      tone(ctx, 659.25, t, 0.9, 'sine', 0.35);
      tone(ctx, 880.00, t + 0.16, 0.9, 'sine', 0.30);
      tone(ctx, 987.77, t + 0.32, 1.0, 'sine', 0.26);
    } else if (sound === 'gentle') {
      tone(ctx, 523.25, t, 1.4, 'sine', 0.22);
      tone(ctx, 784.00, t + 0.05, 1.4, 'sine', 0.12);
    } else { // beep
      for (let i = 0; i < 2; i++) {
        tone(ctx, 880, t + i * 0.34, 0.2, 'square', 0.22);
        tone(ctx, 1180, t + i * 0.34 + 0.01, 0.18, 'square', 0.12);
      }
    }
  }

  function startRingingSound(sound) {
    stopRingingSound();
    if (!state.settings.sound) return;
    playBurst(sound);
    ringTimer = setInterval(() => playBurst(sound), sound === 'beep' ? 1300 : 1900);
  }
  function stopRingingSound() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  }
  function startVibration() {
    stopVibration();
    if (!state.settings.vibrate || !navigator.vibrate) return;
    const buzz = () => navigator.vibrate([500, 250, 500, 250]);
    buzz();
    vibTimer = setInterval(buzz, 1700);
  }
  function stopVibration() {
    if (vibTimer) { clearInterval(vibTimer); vibTimer = null; }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  /* ---------------- notifications ---------------- */
  function notificationSupported() { return 'Notification' in window; }
  function notifState() {
    if (!notificationSupported()) return 'unsupported';
    return Notification.permission; // 'granted' | 'denied' | 'default'
  }
  function updateNotifUi() {
    const btn = $('notifBtn'); const sub = $('notifSub');
    const st = notifState();
    if (st === 'granted') { btn.textContent = 'Enabled'; btn.disabled = true; sub.textContent = 'Notifications are on'; }
    else if (st === 'denied') { btn.textContent = 'Blocked'; btn.disabled = true; sub.textContent = 'Notifications blocked in browser settings'; }
    else if (st === 'unsupported') { btn.textContent = 'Unavailable'; btn.disabled = true; sub.textContent = 'This browser has no Notification support'; }
    else { btn.textContent = 'Enable'; btn.disabled = false; sub.textContent = 'Show a system notification when an alarm rings'; }
  }
  async function requestNotifications() {
    if (!notificationSupported()) { toast('Notifications not supported here', 'warn'); return; }
    try {
      const p = await Notification.requestPermission();
      updateNotifUi();
      toast(p === 'granted' ? 'Notifications enabled' : 'Notifications not enabled', p === 'granted' ? 'ok' : 'warn');
    } catch (e) { toast('Could not request permission', 'err'); }
  }
  function showNotification(alarm) {
    if (notifState() !== 'granted') return;
    try {
      const key = alarm.id + ':' + alarm.nextAt;
      if (lastNotifiedKey === key) return;
      lastNotifiedKey = key;
      const n = new Notification(alarm.label || 'Alarm', {
        body: formatTime(alarm.hour, alarm.minute) + ' — tap to open Nova Alarm',
        tag: 'nova-alarm-' + alarm.id,
        requireInteraction: true,
        icon: 'icon-192.png',
        badge: 'icon-192.png'
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* some platforms throw for non-persistent notifications */ }
  }

  /* ---------------- alarm operations ---------------- */
  function findAlarm(id) { return state.alarms.find((a) => a.id === id); }

  function toggleAlarm(id, on) {
    const a = findAlarm(id); if (!a) return;
    a.enabled = on;
    if (on) { recomputeNext(a); toast('Alarm on for ' + fmtTs(a.nextAt), 'ok'); }
    else { a.nextAt = null; toast('Alarm off', 'warn'); }
    save(); renderAlarms(); renderNext();
  }

  function addHistory(alarm, action, at) {
    state.history.unshift({
      id: 'h' + Date.now() + Math.random().toString(36).slice(2, 6),
      alarmId: alarm.id,
      label: alarm.label,
      action: action,
      at: at || Date.now(),
      seen: action !== 'missed'
    });
    if (state.history.length > 300) state.history.length = 300;
  }

  function fireAlarm(alarm) {
    if (ringingId) return; // one at a time
    ringingId = alarm.id;
    alarm.lastFiredAt = Date.now();
    showRing(alarm);
    startRingingSound(alarm.sound);
    startVibration();
    showNotification(alarm);
    if (document.hidden === false) document.title = '⏰ ' + (alarm.label || 'Alarm') + ' — Nova Alarm';
    save(); renderAlarms();
  }

  function showRing(alarm) {
    $('ringLabel').textContent = alarm.label || 'Alarm';
    $('ringTime').textContent = formatTime(alarm.hour, alarm.minute, false);
    $('ringNote').textContent = daysText(alarm.days) + ' · set for ' + formatTime(alarm.hour, alarm.minute, false);
    $('snoozeMin').textContent = state.settings.snooze;
    $('ringing').hidden = false;
    document.body.style.overflow = 'hidden';
    $('dismissBtn').focus();
  }

  function hideRing() {
    $('ringing').hidden = true;
    document.body.style.overflow = '';
    document.title = 'Nova Alarm — Smart Alarm Clock';
    ringingId = null;
    stopRingingSound();
    stopVibration();
    renderAlarms();
  }

  function resolveRing(action) {
    const alarm = findAlarm(ringingId);
    hideRing();
    if (!alarm) return;
    if (action === 'snooze') {
      alarm.nextAt = Date.now() + state.settings.snooze * 60000;
      addHistory(alarm, 'snoozed');
      toast('Snoozed for ' + state.settings.snooze + ' min', 'warn');
    } else {
      addHistory(alarm, 'dismissed');
      if (alarm.days.length === 0) { alarm.enabled = false; alarm.nextAt = null; }
      else { recomputeNext(alarm); }
      toast('Alarm dismissed', 'ok');
    }
    save(); renderAlarms(); renderNext();
  }

  function dismissRing() { resolveRing('dismiss'); }
  function snoozeRing() { resolveRing('snooze'); }

  /* ---------------- missed-alarm recovery ---------------- */
  function checkMissed() {
    const now = Date.now();
    let changed = false;
    for (const a of state.alarms) {
      if (!a.enabled || !a.nextAt) continue;
      if (a.nextAt <= now) {
        // It should have rung while the app was not running.
        addHistory(a, 'missed', a.nextAt);
        if (a.days.length === 0) { a.enabled = false; a.nextAt = null; }
        else { recomputeNext(a, now); }
        changed = true;
      }
    }
    if (changed) { save(); }
  }

  /* ---------------- tick loop ---------------- */
  function tick() {
    const now = Date.now();
    state.lastTick = now;

    // Fire any due alarms
    if (!ringingId) {
      for (const a of state.alarms) {
        if (a.enabled && a.nextAt && a.nextAt <= now) { fireAlarm(a); break; }
      }
    }
    renderClock();
    renderNext();
    // persist lastTick occasionally
    if (Math.floor(now / 1000) % 15 === 0) save();
  }

  /* ---------------- editor modal ---------------- */
  let editingId = null;
  let draft = { hour: 7, minute: 30, label: '', days: [], sound: 'beep' };

  function openEditor(id) {
    editingId = id || null;
    if (id) {
      const a = findAlarm(id);
      draft = { hour: a.hour, minute: a.minute, label: a.label || '', days: a.days.slice(), sound: a.sound || 'beep' };
      $('editorTitle').textContent = 'Edit alarm';
      $('editorDelete').hidden = false;
      $('editorSave').textContent = 'Save changes';
    } else {
      draft = { hour: 7, minute: 30, label: '', days: [], sound: 'beep' };
      $('editorTitle').textContent = 'New alarm';
      $('editorDelete').hidden = true;
      $('editorSave').textContent = 'Save alarm';
    }
    $('editorError').hidden = true;
    syncEditor();
    $('editorBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('hourInput').focus(), 60);
  }

  function closeEditor() {
    $('editorBackdrop').hidden = true;
    if ($('ringing').hidden) document.body.style.overflow = '';
    editingId = null;
  }

  function syncInputs() {
    $('hourInput').value = draft.hour;
    $('minuteInput').value = draft.minute;
    $('labelInput').value = draft.label;
  }
  // Updates only the non-time controls + preview. Never rewrites the time
  // inputs, so a typed time is not clobbered when a day/sound is tapped.
  // Effective hour/minute for preview: prefer a valid typed value, else draft.
  function currentHM() {
    const { h, m } = readTimeInputs();
    const vh = (!isNaN(h) && h >= 0 && h <= 23) ? h : draft.hour;
    const vm = (!isNaN(m) && m >= 0 && m <= 59) ? m : draft.minute;
    return { h: vh, m: vm };
  }
  function syncControls() {
    const cur = currentHM();
    $('timeDisplay').textContent = formatTime(cur.h, cur.m, false);
    const is24 = state.settings.format24;
    $('meridiem').hidden = is24;
    if (!is24) {
      const mer = cur.h >= 12 ? 'PM' : 'AM';
      document.querySelectorAll('.mer-btn').forEach((b) => b.classList.toggle('active', b.dataset.mer === mer));
    }
    document.querySelectorAll('.day').forEach((b) => b.classList.toggle('active', draft.days.indexOf(Number(b.dataset.day)) !== -1));
    document.querySelectorAll('.chip[data-sound]').forEach((b) => b.classList.toggle('active', b.dataset.sound === draft.sound));
  }
  function syncEditor() { syncInputs(); syncControls(); }

  // Raw values from the inputs; NaN when empty/invalid. Validation happens on save.
  function readTimeInputs() {
    const raw = $('hourInput').value.trim();
    const rawM = $('minuteInput').value.trim();
    const h = raw === '' ? NaN : Number(raw);
    const m = rawM === '' ? NaN : Number(rawM);
    return { h: h, m: m };
  }

  // Live preview only — never rewrites the user's input, so invalid values
  // remain visible and are caught by validation on save.
  function applyTimeFromInputs() {
    const { h, m } = readTimeInputs();
    const ph = isNaN(h) ? draft.hour : Math.max(0, Math.min(23, Math.trunc(h)));
    const pm = isNaN(m) ? draft.minute : Math.max(0, Math.min(59, Math.trunc(m)));
    $('timeDisplay').textContent = formatTime(ph, pm, false);
  }

  function saveEditor() {
    const { h, m } = readTimeInputs();
    const err = $('editorError');
    if (isNaN(h) || isNaN(m) || !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      err.textContent = 'Please enter a valid time (hours 00–23, minutes 00–59).';
      err.hidden = false;
      $('hourInput').focus();
      return;
    }
    draft.hour = h; draft.minute = m;

    const label = $('labelInput').value.trim().slice(0, 40);
    draft.label = label;

    // duplicate prevention: same time + same repeat set
    const key = (a) => a.hour + ':' + a.minute + '|' + a.days.slice().sort().join(',');
    const dupe = state.alarms.find((a) => a.id !== editingId && key(a) === key(draft));
    if (dupe) {
      err.textContent = 'An alarm at ' + formatTime(h, m) + ' with the same repeat days already exists.';
      err.hidden = false;
      return;
    }

    if (editingId) {
      const a = findAlarm(editingId);
      a.hour = draft.hour; a.minute = draft.minute; a.label = draft.label;
      a.days = draft.days.slice(); a.sound = draft.sound;
      if (a.enabled) recomputeNext(a);
      toast('Alarm updated', 'ok');
    } else {
      const alarm = {
        id: 'a' + (state.seq++),
        hour: draft.hour, minute: draft.minute, label: draft.label,
        days: draft.days.slice(), enabled: true, sound: draft.sound,
        createdAt: Date.now(), nextAt: null
      };
      recomputeNext(alarm);
      state.alarms.push(alarm);
      toast('Alarm set for ' + fmtTs(alarm.nextAt), 'ok');
    }
    save(); closeEditor(); renderAll();
  }

  function deleteAlarm() {
    if (!editingId) return;
    const a = findAlarm(editingId);
    if (!a) return;
    if (!window.confirm('Delete this alarm' + (a.label ? ' (“' + a.label + '”)' : '') + '?')) return;
    state.alarms = state.alarms.filter((x) => x.id !== editingId);
    save(); closeEditor(); renderAll();
    toast('Alarm deleted', 'warn');
  }

  /* ---------------- wake lock ---------------- */
  async function applyWakeLock() {
    try {
      if (state.settings.wake && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!state.settings.wake && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch (e) { /* not critical */ }
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', state.settings.theme === 'dark' ? '#0b1020' : '#f6f8ff');
  }

  /* ---------------- settings modal ---------------- */
  function openSettings() {
    $('snoozeSelect').value = String(state.settings.snooze);
    $('soundToggle').checked = state.settings.sound;
    $('vibrateToggle').checked = state.settings.vibrate;
    $('wakeToggle').checked = state.settings.wake;
    updateNotifUi();
    $('settingsBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSettings() {
    $('settingsBackdrop').hidden = true;
    if ($('ringing').hidden && $('editorBackdrop').hidden) document.body.style.overflow = '';
  }

  /* ---------------- tabs ---------------- */
  function switchTab(which) {
    const isAlarms = which === 'alarms';
    $('tabAlarms').classList.toggle('active', isAlarms);
    $('tabHistory').classList.toggle('active', !isAlarms);
    $('tabAlarms').setAttribute('aria-selected', String(isAlarms));
    $('tabHistory').setAttribute('aria-selected', String(!isAlarms));
    $('alarmsView').hidden = !isAlarms;
    $('historyView').hidden = isAlarms;
    $('clearHistoryBtn').hidden = isAlarms || state.history.length === 0;
    $('addBtn').style.display = isAlarms ? '' : 'none';
  }

  /* ---------------- install prompt ---------------- */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const wrap = $('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast ok';
    el.innerHTML = '<span class="t-ico">↓</span><span class="t-msg">Install Nova Alarm for offline use</span>';
    const btn = document.createElement('button');
    btn.className = 'ghost-btn'; btn.type = 'button'; btn.textContent = 'Install';
    btn.style.marginLeft = 'auto';
    btn.addEventListener('click', async () => {
      el.remove();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });
    el.appendChild(btn);
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 12000);
  });

  /* ---------------- wire up ---------------- */
  function wire() {
    $('addBtn').addEventListener('click', () => openEditor(null));
    $('themeBtn').addEventListener('click', () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme(); save();
    });
    $('formatBtn').addEventListener('click', () => {
      state.settings.format24 = !state.settings.format24;
      save(); renderAll();
      if (!$('editorBackdrop').hidden) syncEditor();
    });
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsBackdrop').addEventListener('click', (e) => { if (e.target === $('settingsBackdrop')) closeSettings(); });

    $('snoozeSelect').addEventListener('change', (e) => { state.settings.snooze = parseInt(e.target.value, 10); save(); });
    $('soundToggle').addEventListener('change', (e) => { state.settings.sound = e.target.checked; save(); if (e.target.checked) ensureAudio(); });
    $('vibrateToggle').addEventListener('change', (e) => { state.settings.vibrate = e.target.checked; save(); });
    $('wakeToggle').addEventListener('change', (e) => { state.settings.wake = e.target.checked; save(); applyWakeLock(); });
    $('notifBtn').addEventListener('click', requestNotifications);

    // editor
    $('editorClose').addEventListener('click', closeEditor);
    $('editorCancel').addEventListener('click', closeEditor);
    $('editorBackdrop').addEventListener('click', (e) => { if (e.target === $('editorBackdrop')) closeEditor(); });
    $('editorSave').addEventListener('click', saveEditor);
    $('editorDelete').addEventListener('click', deleteAlarm);
    $('hourInput').addEventListener('input', applyTimeFromInputs);
    $('minuteInput').addEventListener('input', applyTimeFromInputs);

    $('labelInput').addEventListener('input', (e) => { draft.label = e.target.value; });

    document.querySelectorAll('.step-btn').forEach((b) => b.addEventListener('click', () => {
      const dir = Number(b.dataset.dir);
      const cur = currentHM();
      if (b.dataset.step === 'hour') draft.hour = (cur.h + dir + 24) % 24;
      else draft.minute = (cur.m + dir * 5 + 60) % 60;
      syncEditor();
    }));
    document.querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => {
      const d = Number(b.dataset.day);
      const i = draft.days.indexOf(d);
      if (i === -1) draft.days.push(d); else draft.days.splice(i, 1);
      syncControls();
    }));
    $('onceBtn').addEventListener('click', () => { draft.days = []; syncControls(); });
    document.querySelectorAll('.mer-btn').forEach((b) => b.addEventListener('click', () => {
      const isPM = b.dataset.mer === 'PM';
      let h = currentHM().h % 12; if (isPM) h += 12;
      draft.hour = h; syncEditor();
    }));
    document.querySelectorAll('.chip[data-sound]').forEach((b) => b.addEventListener('click', () => {
      draft.sound = b.dataset.sound; syncControls();
    }));
    $('previewSound').addEventListener('click', () => { ensureAudio(); playBurst(draft.sound); });

    // ringing
    $('dismissBtn').addEventListener('click', dismissRing);
    $('snoozeBtn').addEventListener('click', snoozeRing);

    // tabs
    $('tabAlarms').addEventListener('click', () => switchTab('alarms'));
    $('tabHistory').addEventListener('click', () => switchTab('history'));
    $('clearHistoryBtn').addEventListener('click', () => {
      if (!window.confirm('Clear all alarm history?')) return;
      state.history = []; save(); renderHistory(); renderAlarms();
      $('clearHistoryBtn').hidden = true;
      toast('History cleared', 'warn');
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (!$('ringing').hidden) {
        if (e.key === 'Escape') { e.preventDefault(); dismissRing(); }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); snoozeRing(); }
      } else if (e.key === 'Escape') {
        if (!$('editorBackdrop').hidden) closeEditor();
        else if (!$('settingsBackdrop').hidden) closeSettings();
      }
    });

    // resume from background: recompute + check missed
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { checkMissed(); renderAll(); }
    });
    window.addEventListener('focus', () => { checkMissed(); renderAll(); });

    // unlock audio on first interaction
    const unlock = () => { ensureAudio(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    state = loadState();
    applyTheme();
    $('versionLine').textContent = 'Version ' + APP_VERSION + ' · offline-ready';
    wire();
    checkMissed();
    // recompute any missing nextAt (e.g. legacy state)
    for (const a of state.alarms) {
      if (a.enabled && !a.nextAt) recomputeNext(a);
    }
    save();
    renderAll();
    switchTab('alarms');
    setInterval(tick, 1000);
    tick();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
      });
    }
  }

  /* ---------------- test / debug API (used by automated tests) ---------------- */
  window.__NOVA__ = {
    getState: () => JSON.parse(JSON.stringify(state)),
    addAlarm: (hour, minute, opts) => {
      const a = Object.assign({ hour: hour, minute: minute, label: '', days: [], sound: 'beep', enabled: true }, opts || {});
      a.id = 'a' + (state.seq++);
      a.createdAt = Date.now(); a.nextAt = null;
      recomputeNext(a);
      state.alarms.push(a); save(); renderAll();
      return a;
    },
    fireIn: (seconds, opts) => {
      const a = Object.assign({ hour: 0, minute: 0, label: '', days: [], sound: 'beep', enabled: true }, opts || {});
      a.id = 'a' + (state.seq++);
      a.createdAt = Date.now();
      a.nextAt = Date.now() + seconds * 1000;          // precise, second-level target
      const d = new Date(a.nextAt);
      a.hour = d.getHours(); a.minute = d.getMinutes();
      state.alarms.push(a); save(); renderAll();
      return a;
    },
    toggleAlarm: toggleAlarm,
    nextOccurrence: nextOccurrence,
    formatTime: formatTime,
    isRinging: () => ringingId,
    getDraft: () => JSON.parse(JSON.stringify(draft)),
    editorOpen: () => !document.getElementById('editorBackdrop').hidden,
    version: APP_VERSION
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
