// Standalone browser SDK, compiled to a static asset by build-analytics.mjs.
export const ANALYTICS_SDK = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__belkiAnalytics) return;
  var key = script.getAttribute('data-site');
  if (!key) return;
  var base;
  try {
    base = new URL(script.getAttribute('data-api') || script.src).origin;
    if (!/^https?:/.test(base)) return;
  } catch (_) { return; }
  window.__belkiAnalytics = true;
  var storageKey = 'belki-analytics:' + key;
  var outboxKey = storageKey + ':outbox:' + base;
  var testKey = storageKey + ':test';
  var timeout = 30 * 60000, queueTTL = 5 * 60000;
  var session = null, page = null, config = null, currentUrl = '';
  var lastTick = Date.now(), lastActivityWrite = 0, hidden = document.visibilityState === 'hidden';
  var loading = false, configAttempts = 0, stopped = false, configTimer = null;
  var outbox = [], running = {}, retryTimer = null;
  var backlog = [], test = read(testKey);
  var initial = new URL(location.href);
  var testToken = initial.searchParams.get('belki_test');
  if (testToken) {
    test = { token: testToken, expiresAt: Date.now() + 10 * 60000 };
    write(testKey, test);
    initial.searchParams.delete('belki_test');
    history.replaceState(history.state, '', initial.href);
  }
  if (test && (typeof test.token !== 'string' || test.expiresAt <= Date.now())) { test = null; write(testKey, null); }
  // Test sessions never read or overwrite real attribution or its retry queue.
  if (!test) {
    session = read(storageKey);
    if (!validSession(session) || Date.now() - session.activity > timeout) { session = null; write(storageKey, null); }
    var saved = read(outboxKey);
    if (Array.isArray(saved)) outbox = saved.filter(function (item) {
      return item && item.payload && item.payload.key === key && typeof item.payload.id === 'string' &&
        item.payload.activityAt <= Date.now() && item.expiresAt > Date.now() && item.attempts < 5;
    }).slice(0, 30);
  }
  var prior = window.belki && window.belki.q;
  if (Array.isArray(prior)) prior.slice(0, 30).forEach(function (item) {
    // Only the generated queue includes enough context to attribute early events.
    if (item && typeof item.name === 'string' && typeof item.url === 'string' && typeof item.at === 'number') {
      backlog.push({ type: 'event', name: item.name, url: item.url, at: item.at });
    }
  });
  function read(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function write(k, value) { try { if (value === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(value)); } catch (_) {} }
  function validSession(s) { return s && typeof s.id === 'string' && typeof s.entry === 'string' && typeof s.utm === 'string' &&
    typeof s.started === 'number' && typeof s.activity === 'number' && s.started <= s.activity && s.activity <= Date.now(); }
  function id() { return crypto.randomUUID(); }
  function save() { if (!test) write(storageKey, session); }
  function persist() { if (!test) write(outboxKey, outbox.length ? outbox : null); }
  function expire() {
    if (session && Date.now() - session.activity > timeout) { session = null; page = null; save(); }
  }
  function tick() {
    var now = Date.now();
    expire();
    if (page && !hidden) page.visible += Math.max(0, Math.min(now - lastTick, 30000));
    lastTick = now;
  }
  function remove(item) { outbox = outbox.filter(function (v) { return v !== item; }); persist(); }
  function schedule() {
    if (retryTimer || !outbox.length || stopped) return;
    retryTimer = setTimeout(function () { retryTimer = null; flush(false); }, 1000);
  }
  function flush(closing) {
    var now = Date.now();
    outbox = outbox.filter(function (item) { return item.expiresAt > now && item.attempts < 5; });
    persist();
    if (!config || stopped) return;
    outbox.slice().sort(function (a, b) { return Number(b.payload.type === 'event') - Number(a.payload.type === 'event'); }).forEach(function (item) {
      if (running[item.payload.id] || (!closing && (item.nextAt > now || Object.keys(running).length >= 4))) return;
      var body = JSON.stringify(item.payload);
      if (closing && navigator.sendBeacon && navigator.sendBeacon(base + '/v1/events', body)) {
        // Enqueued is not acknowledged: retain the same ID for the next document.
        return;
      }
      running[item.payload.id] = true;
      item.attempts++;
      item.nextAt = now + Math.min(30000, 1000 * Math.pow(2, item.attempts));
      persist();
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var deadline = controller ? setTimeout(function () { controller.abort(); }, 10000) : null;
      fetch(base + '/v1/events', { method: 'POST', body: body, credentials: 'omit', keepalive: true,
        signal: controller ? controller.signal : undefined }).then(function (response) {
        if (response.ok) remove(item);
        else if (response.status === 403 || response.status === 404 || response.status === 410) {
          stopped = true; outbox = []; session = null; page = null; save(); persist();
          if (test) write(testKey, null);
        } else if (response.status === 429) {
          var after = Number(response.headers && response.headers.get('Retry-After'));
          if (after > 0) item.nextAt = Date.now() + Math.min(after * 1000, queueTTL);
        } else if (response.status !== 408 && response.status < 500) remove(item);
      }).catch(function () {}).finally(function () {
        if (deadline) clearTimeout(deadline);
        delete running[item.payload.id]; persist(); schedule();
      });
    });
    schedule();
  }
  function emit(type, event, closing, at) {
    expire();
    if (!session || !page || !config || stopped) return;
    var payload = { key: key, id: id(), sessionId: session.id, pageId: page.id,
      utm: session.utm, startedAt: session.started, activityAt: session.activity,
      occurredAt: at || Date.now(), entryPath: session.entry, path: page.path,
      visibleMs: Math.round(page.visible), type: type, event: event || undefined,
      test: test ? test.token : undefined };
    // Only replace unsent page updates. In-flight payloads and conversion IDs are immutable.
    if (type === 'page') outbox = outbox.filter(function (item) {
      return item.payload.type !== 'page' || item.payload.pageId !== page.id || running[item.payload.id];
    });
    if (outbox.length >= 30) {
      var disposable = outbox.find(function (item) { return item.payload.type === 'page' && !running[item.payload.id]; });
      if (disposable) remove(disposable); else return;
    }
    outbox.push({ payload: payload, attempts: 0, nextAt: 0, expiresAt: Date.now() + queueTTL });
    persist(); flush(Boolean(closing));
  }
  function visit(href, at) {
    if (!config || currentUrl === href || stopped) return;
    tick(); emit('page', null, false, at);
    var url = new URL(href), previous = currentUrl ? new URL(currentUrl) : null;
    currentUrl = href;
    var raw = url.searchParams.get('utm_source');
    var changed = raw !== null && (!previous || raw !== previous.searchParams.get('utm_source'));
    if (test && !session) raw = 'chatgpt', changed = true;
    if (changed) {
      var utm = raw.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(config.aliases, utm)) {
        if (previous || !session || session.utm !== utm) session = { id: id(), utm: utm, started: at, activity: at, entry: url.pathname };
      } else session = null;
    }
    if (!session) { page = null; save(); return; }
    session.activity = Math.max(session.activity, at); save();
    if (previous && previous.pathname === url.pathname && page && !changed) return;
    page = { id: id(), path: url.pathname, visible: 0 };
    lastTick = Date.now(); emit('page', null, false, at);
  }
  function process(item) {
    if (item.at > Date.now() || Date.now() - item.at > queueTTL) return;
    visit(item.url, item.at);
    if (item.type === 'event' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.name)) {
      if (session) { session.activity = Math.max(session.activity, item.at); save(); }
      tick(); emit('event', item.name, false, item.at);
    }
  }
  function loadConfig() {
    if (config || loading || stopped || configAttempts >= 4) return;
    var candidate = test || session || outbox.length || backlog.some(function (item) { return new URL(item.url).searchParams.has('utm_source'); });
    if (!candidate) { backlog = []; return; }
    loading = true; configAttempts++;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var deadline = controller ? setTimeout(function () { controller.abort(); }, 10000) : null;
    fetch(base + '/v1/config/' + encodeURIComponent(key) + (test ? '?test=' + encodeURIComponent(test.token) : ''), { credentials: 'omit', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        if (!response.ok) { if (response.status < 500 && response.status !== 429) stopped = true; throw new Error(); }
        return response.json();
      }).then(function (value) {
        if (!value || !value.aliases) throw new Error();
        config = value;
        if (session && !Object.prototype.hasOwnProperty.call(config.aliases, session.utm)) { session = null; save(); }
        backlog.splice(0).sort(function (a, b) { return a.at - b.at; }).forEach(process);
        flush(false);
      }).catch(function () {
        if (stopped) { outbox = []; persist(); }
        else configTimer = setTimeout(function () { configTimer = null; loadConfig(); }, 1000 * Math.pow(2, configAttempts));
      }).finally(function () { if (deadline) clearTimeout(deadline); loading = false; });
  }
  function capture(type, name) {
    var item = { type: type, name: name, url: location.href, at: Date.now() };
    if (config) process(item);
    else { if (backlog.length < 60) backlog.push(item); if (!configTimer) loadConfig(); }
  }
  function activity() {
    expire();
    if (!session || Date.now() - lastActivityWrite < 1000) return;
    session.activity = Date.now(); lastActivityWrite = session.activity; save();
  }
  window.belki = { track: function (name) {
    if (typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) capture('event', name);
  } };
  ['pointerdown', 'keydown', 'scroll'].forEach(function (name) { addEventListener(name, activity, { passive: true }); });
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var result = original.apply(this, arguments); capture('page'); return result; };
  });
  addEventListener('popstate', function () { capture('page'); });
  addEventListener('pageshow', function (event) {
    if (event.persisted) { currentUrl = ''; page = null; lastTick = Date.now(); hidden = document.visibilityState === 'hidden'; capture('page'); }
  });
  document.addEventListener('visibilitychange', function () {
    tick(); hidden = document.visibilityState === 'hidden'; emit('page', null, hidden); if (!hidden) flush(false);
  });
  addEventListener('pagehide', function () { tick(); emit('page', null, true); flush(true); });
  addEventListener('online', function () { flush(false); if (!config) loadConfig(); });
  setInterval(function () { tick(); if (!hidden) emit('page'); }, 30000);
  capture('page');
})();`;
