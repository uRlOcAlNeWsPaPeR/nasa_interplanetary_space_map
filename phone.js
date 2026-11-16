/*
 * phone.js -- the phone layout.
 *
 * On narrow screens (and short, sideways screens) the side cards become one
 * bottom sheet with five tabs: Plan, Drive, Walk, Map and Info. The existing
 * panels are moved into it, so their own scripts keep working, and put back
 * where they were when the screen is wide again. Drag the sheet's top edge
 * (or tap a tab) to open it; tap the open tab to fold it away. Sideways, the
 * sheet is a panel on the right. Styles: phone.css. Wording: content.phone.
 *
 * Also keeps the screen awake while Ridgeback drives, on phones.
 */
(function () {
  "use strict";

  var PHONE_QUERY = "(max-width: 700px), (max-height: 520px)";
  var TOUCH = window.matchMedia("(pointer: coarse)").matches || /[?&]touch=1\b/.test(location.search);
  var DRAG_PX = 8;          // a press on the sheet's top must move this far to count as a drag
  var HALF = 0.46;          // sheet heights, as a share of the screen height
  var FULL = 0.9;
  var AWAKE_AFTER_STOP_S = 20;

  var mq = window.matchMedia(PHONE_QUERY);
  var body = document.body;
  function $(id) { return document.getElementById(id); }

  // The four right-hand panels and the tab each one belongs to.
  var PANEL_TAB = { "route-panel": "plan", "rover-panel": "drive", "walk-panel": "walk", "info-panel": "info" };
  var TABS = [
    { key: "plan", label: "Plan", panel: "route-panel",
      parts: function () { return [$("route-panel")]; } },
    { key: "drive", label: "Drive", panel: "rover-panel",
      parts: function () { return [document.querySelector('#rb-card .button-row[data-help="rover"]'), $("rover-panel")]; } },
    { key: "walk", label: "Walk", panel: "walk-panel",
      parts: function () { return [$("walk-panel")]; } },
    { key: "map", label: "Map", panel: null,
      parts: function () { return [$("minimap"), $("layer-panel")]; } },
    { key: "info", label: "Info", panel: "info-panel",
      parts: function () { return [$("info-panel"), document.querySelector("#rb-card .learn"), $("data-panel")]; } }
  ];
  function tab(key) { return TABS.filter(function (t) { return t.key === key; })[0]; }

  var sheet = null, head = null, tabButtons = [], panes = {};
  var active = false;
  var current = "plan";
  var moves = [];          // { el, mark } for everything moved into phone places
  var safeProbe = null;

  // ---- building the sheet ---------------------------------------------------

  function build() {
    if (sheet) return;
    sheet = document.createElement("section");
    sheet.id = "sheet";
    sheet.setAttribute("aria-label", "Panels");
    sheet.dataset.state = "half";
    head = document.createElement("div");
    head.id = "sheet-head";
    var handle = document.createElement("button");
    handle.id = "sheet-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", "Resize the panel");
    handle.addEventListener("click", function () {
      if (dragMoved) return;
      var s = sheet.dataset.state;
      setState(isLandscape() ? (s === "peek" ? "full" : "peek") : (s === "peek" ? "half" : s === "half" ? "full" : "peek"));
    });
    var bar = document.createElement("div");
    bar.id = "sheet-tabs";
    bar.setAttribute("role", "tablist");
    var bodyEl = document.createElement("div");
    bodyEl.id = "sheet-body";
    TABS.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.tab = t.key;
      b.textContent = t.label;
      b.addEventListener("click", function () {
        if (dragMoved) return;
        if (t.key === current && sheet.dataset.state !== "peek") { setState("peek"); return; }
        selectTab(t.key, true);
      });
      bar.appendChild(b);
      tabButtons.push(b);
      var pane = document.createElement("div");
      pane.className = "sheet-pane";
      pane.dataset.pane = t.key;
      pane.setAttribute("role", "tabpanel");
      bodyEl.appendChild(pane);
      panes[t.key] = pane;
    });
    head.appendChild(handle);
    head.appendChild(bar);
    sheet.appendChild(head);
    sheet.appendChild(bodyEl);
    body.appendChild(sheet);

    safeProbe = document.createElement("div");
    safeProbe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;" +
      "height:env(safe-area-inset-bottom,0px);padding-top:env(safe-area-inset-top,0px)";
    body.appendChild(safeProbe);

    head.addEventListener("pointerdown", startDrag);
  }

  // ---- moving panels in and back ----------------------------------------------

  // Move el into parent (before `before`), leaving a marker where it was. A
  // "?" help pop that follows el (help.js) goes with it.
  function move(el, parent, before) {
    if (!el) return;
    var mark = document.createComment("phone.js: back here on wide screens");
    el.parentNode.insertBefore(mark, el);
    var pop = helpPopAfter(el);
    parent.insertBefore(el, before || null);
    if (pop) parent.insertBefore(pop, el.nextSibling);
    moves.push({ el: el, mark: mark });
  }

  function helpPopAfter(el) {
    var next = el.nextElementSibling;
    return next && next.classList.contains("help-pop") ? next : null;
  }

  function restoreAll() {
    moves.reverse().forEach(function (m) {
      var pop = helpPopAfter(m.el);
      m.mark.parentNode.insertBefore(m.el, m.mark);
      if (pop) m.mark.parentNode.insertBefore(pop, m.mark);
      m.mark.parentNode.removeChild(m.mark);
    });
    moves = [];
  }

  function enter() {
    build();
    active = true;
    body.classList.add("phone");
    body.classList.remove("show-panels");
    var rbCard = $("rb-card");
    move($("risk-hud"), rbCard.parentNode, rbCard.nextSibling);
    TABS.forEach(function (t) {
      t.parts().forEach(function (el) { move(el, panes[t.key]); });
    });
    move($("guide-open"), $("sheet-tabs")); // "How to use" sits at the end of the tab bar
    var open = Object.keys(PANEL_TAB).filter(function (id) { return $(id) && $(id).open; })[0];
    selectTab(open ? PANEL_TAB[open] : "plan", false);
    setState(sheet.dataset.state || "half");
  }

  function leave() {
    active = false;
    restoreAll();
    body.classList.remove("phone", "landscape", "sheet-full");
    body.style.removeProperty("--sheet-h");
    body.style.removeProperty("--sheet-w");
    // The desktop always shows one of the right-hand panels.
    var anyOpen = Object.keys(PANEL_TAB).some(function (id) { return $(id) && $(id).open; });
    if (!anyOpen) clickDesktopTab("route-panel");
  }

  function apply() {
    var on = mq.matches;
    if (on && !active) enter();
    else if (!on && active) leave();
    if (!active) return;
    body.classList.toggle("landscape", isLandscape());
    setState(sheet.dataset.state);
  }

  function isLandscape() { return window.innerWidth > window.innerHeight; }

  // ---- tabs and heights -------------------------------------------------------

  function clickDesktopTab(panelId) {
    var b = document.querySelector('#tabs [data-tab="' + panelId + '"]');
    if (b) b.click();
  }

  function selectTab(key, open) {
    current = key;
    tabButtons.forEach(function (b) {
      var on = b.dataset.tab === key;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== key; });
    var t = tab(key);
    if (t.panel) clickDesktopTab(t.panel);
    else Object.keys(PANEL_TAB).forEach(function (id) { if ($(id)) $(id).open = false; });
    if (open && sheet.dataset.state === "peek") setState("half");
    if (key === "map" && window.MapUI && MapUI.redraw) MapUI.redraw();
  }

  function sizes() {
    var vh = window.innerHeight;
    var headH = head.offsetHeight;
    var safeB = safeProbe ? safeProbe.offsetHeight : 0;
    var safeT = safeProbe ? parseFloat(getComputedStyle(safeProbe).paddingTop) || 0 : 0;
    if (isLandscape()) {
      var tall = vh - 12 - safeT;
      return { peek: headH + 2, half: tall, full: tall };
    }
    return { peek: headH + safeB, half: Math.round(vh * HALF), full: Math.round(vh * FULL) };
  }

  function setState(state) {
    if (isLandscape() && state === "half") state = "full";
    sheet.dataset.state = state;
    var h = sizes()[state];
    sheet.style.height = h + "px";
    body.classList.toggle("sheet-full", state === "full");
    body.style.setProperty("--sheet-h", (isLandscape() ? 0 : h) + "px");
    body.style.setProperty("--sheet-w", (isLandscape() && state !== "peek" ? sheet.offsetWidth : 0) + "px");
  }

  // ---- dragging the sheet (upright screens) -------------------------------------

  var drag = null, dragMoved = false;

  function startDrag(e) {
    if (isLandscape() || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { id: e.pointerId, y: e.clientY, h: sheet.offsetHeight };
    dragMoved = false;
  }

  window.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = e.clientY - drag.y;
    if (!dragMoved && Math.abs(dy) < DRAG_PX) return;
    if (!dragMoved) {
      dragMoved = true;
      sheet.classList.add("is-dragging");
      sheet.dataset.state = "half"; // show the contents while dragging
    }
    var z = sizes();
    var h = Math.max(z.peek, Math.min(z.full, drag.h - dy));
    sheet.style.height = h + "px";
    body.style.setProperty("--sheet-h", h + "px");
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    if (!dragMoved) return;
    sheet.classList.remove("is-dragging");
    var h = sheet.offsetHeight, z = sizes();
    var best = ["peek", "half", "full"].reduce(function (a, b) {
      return Math.abs(z[b] - h) < Math.abs(z[a] - h) ? b : a;
    });
    setState(best);
    // The click that follows this pointerup must not also switch tabs.
    setTimeout(function () { dragMoved = false; }, 0);
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  // ---- follow the app -----------------------------------------------------------

  // A panel opened by another script (e.g. Walk here / Drive here) shows its tab.
  Object.keys(PANEL_TAB).forEach(function (id) {
    var p = $(id);
    if (!p) return;
    p.addEventListener("toggle", function () {
      if (active && p.open && PANEL_TAB[id] !== current) selectTab(PANEL_TAB[id], true);
    });
  });
  if (window.MapUI && MapUI.onChoose) {
    MapUI.onChoose(function (mode) {
      if (!active) return;
      if (mode === "walk") selectTab("walk", true);
      else if (mode === "drive") selectTab("drive", true);
    });
  }

  mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply);
  window.addEventListener("resize", function () { if (active) apply(); });
  window.addEventListener("orientationchange", function () { setTimeout(apply, 250); });
  apply();

  // ---- wording ------------------------------------------------------------------

  import("./content.js").then(function (mod) {
    var c = mod.content.phone;
    if (!c) return;
    tabButtons.forEach(function (b) { if (c.tabs[b.dataset.tab]) b.textContent = c.tabs[b.dataset.tab]; });
    TABS.forEach(function (t) { if (c.tabs[t.key]) t.label = c.tabs[t.key]; });
    if (sheet) {
      sheet.setAttribute("aria-label", c.sheet);
      $("sheet-handle").setAttribute("aria-label", c.handle);
    }
    var manual = document.querySelector("#rover-panel .manual-only.hint");
    if (manual && TOUCH) manual.textContent = c.manualHint;
  }).catch(function () {});

  // ---- keep the screen awake while driving ----------------------------------------

  var lock = null, asking = false, stillFor = 0;
  setInterval(function () {
    if (!navigator.wakeLock || !(TOUCH || active)) return;
    var rb = window.Ridgeback;
    var moving = !!(rb && rb.isMoving && rb.isMoving());
    stillFor = moving ? 0 : stillFor + 1;
    if (moving && !lock && !asking && document.visibilityState === "visible") {
      asking = true;
      navigator.wakeLock.request("screen").then(function (l) {
        lock = l;
        l.addEventListener("release", function () { lock = null; });
      }).catch(function () { /* not allowed right now: try again next time */ }).then(function () { asking = false; });
    } else if (lock && stillFor >= AWAKE_AFTER_STOP_S) {
      lock.release().catch(function () {});
      lock = null;
    }
  }, 1000);
})();
