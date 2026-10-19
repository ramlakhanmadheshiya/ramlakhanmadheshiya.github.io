/* Behaviour for /test/, /games/ and the game pages. Everything works without it
   (links fall back to /test/), this only adds the "Coming soon" card, the game
   picker on /test/, remembered step ticks and the share buttons. */
(function () {
  var data = document.getElementById("titles-data");
  var TITLES = data ? JSON.parse(data.textContent) : [];
  var bySlug = {};
  TITLES.forEach(function (t) { bySlug[t.slug] = t; });

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  // --- Coming soon card --------------------------------------------------------
  var dlg = document.getElementById("soon");
  function openSoon(slug) {
    var t = bySlug[slug];
    if (!dlg || !t) return;
    dlg.querySelector("[data-soon-icon]").innerHTML = t.icon_html;
    dlg.querySelector("[data-soon-title]").textContent = t.name + " is coming soon";
    dlg.querySelector("[data-soon-text]").textContent = t.kind === "app"
      ? "It isn't on Google Play yet. Join the testers group now and you can try it the day testing opens."
      : "It isn't on Google Play yet. Join the testers group now and you can play it the day testing opens.";
    var web = dlg.querySelector("[data-soon-web]");
    web.hidden = !t.web;
    if (t.web) web.href = t.web;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  }
  if (dlg) {
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || e.target.closest("[data-close]")) dlg.close ? dlg.close() : dlg.removeAttribute("open");
    });
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-soon]");
    if (!a || !a.getAttribute("data-soon")) return;
    e.preventDefault();
    openSoon(a.getAttribute("data-soon"));
  });

  // --- Toast -------------------------------------------------------------------
  var toastEl;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  // --- Share / copy --------------------------------------------------------------
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-share],[data-copy]");
    if (!b) return;
    var url = b.getAttribute("data-url") || location.href.split("#")[0];
    var text = b.getAttribute("data-text") || document.title;
    if (b.hasAttribute("data-share") && navigator.share) {
      navigator.share({ title: document.title, text: text, url: url }).catch(function () {});
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      function () { toast("Link copied"); },
      function () { window.prompt("Copy this link", url); });
  });

  // --- /test/ : step ticks ---------------------------------------------------------
  document.querySelectorAll("[data-tick]").forEach(function (box) {
    var key = "rl-test-" + box.getAttribute("data-tick");
    var step = box.closest(".step");
    box.checked = store(key) === "1";
    step.classList.toggle("done", box.checked);
    box.addEventListener("change", function () {
      store(key, box.checked ? "1" : "0");
      step.classList.toggle("done", box.checked);
    });
  });

  // --- /test/ : pick a title for steps 2 and 3 -----------------------------------------
  var chips = document.querySelectorAll("[data-pick]");
  if (!chips.length) return;
  var optin = document.getElementById("optin");
  var install = document.getElementById("install");
  var invite = document.getElementById("invite-share");

  function wire(a, href, soonSlug) {
    a.href = href;
    if (soonSlug) { a.setAttribute("data-soon", soonSlug); a.classList.add("is-soon"); }
    else { a.removeAttribute("data-soon"); a.classList.remove("is-soon"); }
  }

  function pick(slug, scroll) {
    var t = bySlug[slug];
    if (!t) return;
    chips.forEach(function (c) { c.setAttribute("aria-pressed", String(c.getAttribute("data-pick") === slug)); });
    var soon = t.status === "soon" ? slug : "";
    optin.textContent = t.status === "live" ? "No opt-in needed" : "Opt in: " + t.name;
    wire(optin, t.optin || "#", soon);
    optin.toggleAttribute("aria-disabled", t.status === "live");
    install.textContent = "Install: " + t.name;
    wire(install, t.install || "#", soon);
    if (invite) invite.setAttribute("data-url", location.origin + location.pathname + "#" + slug);
    document.querySelectorAll(".tile.highlight").forEach(function (el) { el.classList.remove("highlight"); });
    var tile = document.getElementById(slug);
    if (tile) tile.classList.add("highlight");
    if (scroll) document.getElementById("steps").scrollIntoView({ block: "start" });
  }

  chips.forEach(function (c) {
    c.addEventListener("click", function () {
      var slug = c.getAttribute("data-pick");
      history.replaceState(null, "", "#" + slug);
      pick(slug, false);
    });
  });
  document.querySelectorAll("[data-use]").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      var slug = b.getAttribute("data-use");
      history.replaceState(null, "", "#" + slug);
      pick(slug, true);
    });
  });

  var start = location.hash.slice(1);
  if (!bySlug[start]) {
    var first = TITLES.filter(function (t) { return t.status !== "soon"; })[0] || TITLES[0];
    start = first.slug;
  }
  pick(start, false);
  window.addEventListener("hashchange", function () { if (bySlug[location.hash.slice(1)]) pick(location.hash.slice(1), false); });
})();
