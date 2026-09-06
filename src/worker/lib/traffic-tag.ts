// Standalone browser code: no application dependencies or visitor cookies.
export const TRAFFIC_TAG = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__belkiTraffic) return;
  var key = script.getAttribute('data-site');
  if (!key) return;
  window.__belkiTraffic = true;
  var base = new URL(script.src).origin + '/api/traffic/';
  var storageKey = 'belki-traffic:' + key;
  var timeout = 30 * 60 * 1000;
  var session = null, page = null, config = null, lastTick = Date.now();
  var currentUrl = '', lastActivityWrite = 0;
  var pending = Array.isArray(window.belki && window.belki.q) ? window.belki.q : [];
  function id() { return crypto.randomUUID(); }
  function save() {
    try {
      if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
      else sessionStorage.removeItem(storageKey);
    } catch (_) { /* Storage unavailable: attribute this document only. */ }
  }
  function expire() {
    if (session && Date.now() - session.activity > timeout) {
      session = null; page = null; save();
    }
  }
  function tick() {
    var now = Date.now();
    expire();
    if (page && document.visibilityState === 'visible') page.visible += Math.max(0, Math.min(now - lastTick, 15000));
    lastTick = now;
  }
  function emit(type, event, closing) {
    expire();
    if (!session || !page || !config) return;
    var body = JSON.stringify({
      key: key, id: id(), sessionId: session.id, pageId: page.id,
      utm: session.utm, startedAt: session.started, activityAt: session.activity,
      entryPath: session.entry, path: page.path, visibleMs: Math.round(page.visible),
      type: type, event: event || undefined
    });
    if (closing && navigator.sendBeacon && navigator.sendBeacon(base + 'collect', body)) return;
    fetch(base + 'collect', { method: 'POST', body: body, credentials: 'omit', keepalive: true }).catch(function () {});
  }
  function visit() {
    if (!config || currentUrl === location.href) return;
    tick(); emit('page', null, false);
    expire();
    var url = new URL(location.href);
    var previous = currentUrl ? new URL(currentUrl) : null;
    currentUrl = location.href;
    var raw = url.searchParams.get('utm_source');
    // Retained query parameters on SPA navigation are not a new campaign entry.
    var changedCampaign = raw !== null && (!previous || raw !== previous.searchParams.get('utm_source'));
    if (changedCampaign) {
      var utm = raw.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(config.aliases, utm)) {
        // Reloading the same tagged document keeps its existing session.
        if (previous || !session || session.utm !== utm) {
          session = { id: id(), utm: utm, started: Date.now(), activity: Date.now(), entry: url.pathname };
        }
      } else session = null;
    }
    if (!session) { page = null; save(); return; }
    session.activity = Date.now(); save();
    // Query/hash-only changes do not create another page view.
    if (previous && previous.pathname === url.pathname && page && !changedCampaign) return;
    page = { id: id(), path: url.pathname, visible: 0 };
    lastTick = Date.now();
    emit('page', null, false);
  }
  function activity() {
    expire();
    if (!session || Date.now() - lastActivityWrite < 1000) return;
    session.activity = Date.now(); lastActivityWrite = session.activity; save();
  }
  window.belki = { track: function (name) {
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) return;
    if (!config) { if (pending.length < 30) pending.push(name); return; }
    activity(); tick(); emit('event', name, false);
  } };
  fetch(base + 'config/' + encodeURIComponent(key), { credentials: 'omit' })
    .then(function (response) { if (!response.ok) throw new Error(); return response.json(); })
    .then(function (value) {
      config = value;
      try {
        var stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        if (stored && typeof stored.id === 'string' && typeof stored.entry === 'string' &&
            typeof stored.started === 'number' && typeof stored.activity === 'number' &&
            stored.activity <= Date.now() && Object.prototype.hasOwnProperty.call(config.aliases, stored.utm)) session = stored;
      } catch (_) {}
      visit();
      pending.splice(0).forEach(function (name) { window.belki.track(name); });
      ['pointerdown', 'keydown', 'scroll'].forEach(function (name) { addEventListener(name, activity, { passive: true }); });
      ['pushState', 'replaceState'].forEach(function (name) {
        var original = history[name];
        history[name] = function () { var result = original.apply(this, arguments); visit(); return result; };
      });
      addEventListener('popstate', visit);
      addEventListener('pageshow', function (e) {
        if (e.persisted) { currentUrl = ''; page = null; lastTick = Date.now(); visit(); }
      });
      document.addEventListener('visibilitychange', function () {
        // At hidden, account for the last visible interval before resetting the clock.
        if (document.visibilityState === 'hidden' && page) page.visible += Math.max(0, Math.min(Date.now() - lastTick, 15000));
        lastTick = Date.now(); emit('page', null, true);
      });
      addEventListener('pagehide', function () { tick(); emit('page', null, true); });
      setInterval(function () { tick(); if (document.visibilityState === 'visible') emit('page', null, false); }, 15000);
    }).catch(function () { pending.length = 0; });
})();`;
