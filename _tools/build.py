#!/usr/bin/env python3
"""Writes the studio pages from _tools/titles.py:

  /test/                 every game and app, the testers group and opt-in steps
  /games/                all games
  /games/<slug>/         one page per game (apps: /apps/<slug>/)
  /games/test/, /games/test/single-shot/, /apps/test/   redirects to /test/

Run from the repository root:  python3 _tools/build.py
(The _tools folder is not published: GitHub Pages skips folders starting with _.)
"""
import html
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from titles import TITLES, TESTERS_GROUP, SUPPORT  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://theramlakhan.com"
e = html.escape

MARK = ('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#FF6B5B"/>'
        '<circle cx="12" cy="12" r="4.2" fill="none" stroke="#FFF4E8" stroke-width="2.4"/></svg>')
ICON = {
    "play": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
    "down": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    "gp": '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.2 2.6c-.3.3-.4.7-.4 1.2v16.4c0 .5.1.9.4 1.2l9.3-9.4zM14.6 13.1l2.8 2.8-11 6.3c-.4.2-.8.3-1.1.2zM14.6 10.9 5.3 1.6c.3-.1.7 0 1.1.2l11 6.3zM18.6 8.9l3 1.7c.9.5.9 1.8 0 2.4l-3 1.7-3.1-2.9z"/></svg>',
    "share": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
    "link": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
}
STATUS_LABEL = {"soon": "Coming soon", "testing": "In testing", "live": "On Google Play"}


# --- Per-title helpers -------------------------------------------------------------

def page_dir(t):
    return f"/{'apps' if t['kind'] == 'app' else 'games'}/{t['slug']}/"


def has_page(t):
    return t.get("page", True)


def asset(t, name):
    """Absolute URL of a file in the title's folder, or '' if it isn't there."""
    path = os.path.join(ROOT, page_dir(t).strip("/"), name)
    return page_dir(t) + name if os.path.exists(path) else ""


def icon_html(t, cls="app-icon"):
    src = asset(t, "icon.svg") or asset(t, "icon.png")
    if src:
        return f'<img class="{cls}" src="{src}" alt="" width="72" height="72">'
    return (f'<span class="{cls} letter-icon" style="background:{t["accent"]}" aria-hidden="true">'
            f'{e(t["name"][0])}</span>')


def optin_url(t):
    return f"https://play.google.com/apps/testing/{t['package']}" if t.get("package") else ""


def install_url(t):
    return f"https://play.google.com/store/apps/details?id={t['package']}" if t.get("package") else ""


def soon_attr(t):
    return f' data-soon="{t["slug"]}"' if t["status"] == "soon" else ""


def optin_btn(t, cls="btn btn-accent btn-sm"):
    if t["status"] == "live":
        return ""
    href = optin_url(t) if t["status"] == "testing" else f"/test/#{t['slug']}"
    extra = " is-soon" if t["status"] == "soon" else ""
    return f'<a class="{cls}{extra}" href="{href}"{soon_attr(t)}>Opt in</a>'


def install_btn(t, cls="btn btn-sm", label="Install"):
    href = install_url(t) if t["status"] != "soon" else f"/test/#{t['slug']}"
    extra = " is-soon" if t["status"] == "soon" else ""
    return f'<a class="{cls}{extra}" href="{href}"{soon_attr(t)}>{ICON["gp"]}{label}</a>'


def badge(t):
    return f'<span class="badge {t["status"]}">{STATUS_LABEL[t["status"]]}</span>'


def client_data():
    out = []
    for t in TITLES:
        out.append({
            "slug": t["slug"], "name": t["name"], "kind": t["kind"], "status": t["status"],
            "web": t.get("web", ""), "optin": optin_url(t), "install": install_url(t),
            "icon_html": icon_html(t),
        })
    return json.dumps(out, ensure_ascii=False).replace("</", "<\\/")


# --- Page frame ------------------------------------------------------------------------

def head(title, desc, path, image="", accent="#FF6B5B", icon="/games/single-shot/icon.svg"):
    icon_type = "image/svg+xml" if icon.endswith(".svg") else "image/png"
    img = f'\n<meta property="og:image" content="{SITE}{image}">\n<meta name="twitter:card" content="summary_large_image">' if image else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{SITE}{path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ramlakhan">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{SITE}{path}">{img}
<meta name="theme-color" content="#FFF6EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15122F" media="(prefers-color-scheme: dark)">
<link rel="icon" href="{icon}" type="{icon_type}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/shared/studio.css">
<style>:root{{--accent:{accent}}}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
"""


def nav(current):
    def link(href, label, key):
        cur = ' aria-current="page"' if key == current else ""
        return f'<a href="{href}"{cur}>{label}</a>'
    return f"""<header class="nav"><div class="wrap">
  <a class="wordmark" href="/games/">{MARK}<span><b>ramlakhan</b> games</span></a>
  <nav aria-label="Main">{link("/games/", "Games", "games")}{link("/test/", "Play early", "test")}{link("/", "About", "about")}</nav>
</div></header>
"""


def footer():
    games = " · ".join(f'<a href="{page_dir(t)}">{e(t["name"])}</a>' for t in TITLES if t["kind"] == "game" and has_page(t))
    return f"""<dialog class="float" id="soon" aria-labelledby="soon-title">
  <div data-soon-icon></div>
  <h2 id="soon-title" data-soon-title>Coming soon</h2>
  <p data-soon-text></p>
  <div class="btn-row">
    <a class="btn btn-primary" href="{TESTERS_GROUP}">Join the testers group</a>
    <a class="btn" data-soon-web href="#" hidden>{ICON["play"]}Play in your browser</a>
    <button class="btn btn-text" type="button" data-close>Close</button>
  </div>
</dialog>
<footer class="footer"><div class="wrap">
  <p>{games}</p>
  <p><a href="/test/">Play early</a> · <a href="mailto:{SUPPORT}">{SUPPORT}</a> · <a href="/">theramlakhan.com</a></p>
  <p>© 2026 Ramlakhan Madheshiya</p>
</div></footer>
<script type="application/json" id="titles-data">{client_data()}</script>
<script src="/shared/studio.js" defer></script>
</body>
</html>
"""


def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote", rel)


# --- /test/ -------------------------------------------------------------------------------

def tile(t, for_test):
    feature = asset(t, "feature.jpg")
    img = f'<img class="feature" src="{feature}" alt="" width="1024" height="500" loading="lazy">' if feature else ""
    about = f'<a class="btn btn-text btn-sm" href="{page_dir(t)}">About</a>' if has_page(t) else ""
    if for_test:
        buttons = optin_btn(t) + install_btn(t) + about
    else:
        web = f'<a class="btn btn-sm" href="{t["web"]}">{ICON["play"]}Play in browser</a>' if t.get("web") else ""
        buttons = f'<a class="btn btn-primary btn-sm" href="{page_dir(t)}">About the game</a>' + web + install_btn(t, label="Google Play")
    return f"""<article class="card tile" id="{t['slug']}">
  <div class="tile-head">{icon_html(t)}<div>{badge(t)}<h3>{e(t['name'])}</h3><span class="genre">{e(t['genre'])}</span></div></div>
  {img}
  <p>{e(t['tagline'])}</p>
  <div class="btn-row">{buttons}</div>
</article>"""


def build_test():
    games = [t for t in TITLES if t["kind"] == "game"]
    apps = [t for t in TITLES if t["kind"] == "app"]
    testing = sum(t["status"] == "testing" for t in TITLES)
    soon = sum(t["status"] == "soon" for t in TITLES)
    chips = "".join(
        f'<button class="chip" type="button" data-pick="{t["slug"]}" aria-pressed="false">{icon_html(t, "app-icon")}'
        f'{e(t["name"])}{" <small>soon</small>" if t["status"] == "soon" else ""}</button>' for t in TITLES)
    first = next((t for t in TITLES if t["status"] == "testing"), TITLES[0])
    apps_html = "\n".join(tile(t, True) for t in apps) or '<div class="card empty">No apps in testing right now.</div>'
    body = f"""{nav("test")}
<main id="main" class="wrap">
  <section class="hero">
    <p class="eyebrow">Testers wanted</p>
    <h1>Play early</h1>
    <p class="lede">Every new game and app spends a few weeks in testing on Google Play before it launches. Testers get it first, for free, and help make it better. It takes about a minute.</p>
    <ul class="tags" style="justify-content:center"><li>{testing} in testing now</li><li>{soon} coming soon</li><li>Free · Android</li></ul>
  </section>

  <section class="card narrow" style="margin:0 auto" id="steps" aria-labelledby="steps-title">
    <h2 id="steps-title" class="sr-only" hidden>How to test</h2>
    <ol class="steps">
      <li class="step">
        <div class="step-num"><span>1</span></div>
        <div>
          <h3>Join the testers group</h3>
          <p>Use the Google account your phone uses for Google Play. <span class="once">You only do this once: it covers every game and app here.</span> On a phone, Google may ask you to open its desktop site before it shows the Join button.</p>
          <a class="btn btn-primary" href="{TESTERS_GROUP}">Join the group</a>
          <br><label class="tick"><input type="checkbox" data-tick="joined"> I've joined</label>
        </div>
      </li>
      <li class="step">
        <div class="step-num"><span>2</span></div>
        <div>
          <h3>Pick a game and opt in</h3>
          <p>Choose a game, tap <b>Opt in</b>, then <b>Become a tester</b> on the page that opens.</p>
          <div class="chips" role="group" aria-label="Choose a game or app">{chips}</div>
          <a class="btn btn-accent" id="optin" href="{optin_url(first)}">Opt in: {e(first['name'])}</a>
        </div>
      </li>
      <li class="step">
        <div class="step-num"><span>3</span></div>
        <div>
          <h3>Install it from Google Play</h3>
          <p>Tap Install, then keep it for two weeks and open it now and then. That's what lets it launch for everyone.</p>
          <a class="btn" id="install" href="{install_url(first)}">{ICON["gp"]}Install: {e(first['name'])}</a>
        </div>
      </li>
    </ol>
  </section>

  <section class="card narrow section" style="margin-left:auto;margin-right:auto" aria-labelledby="invite">
    <h2 id="invite">Invite a friend</h2>
    <p class="muted">Know someone with an Android phone? Every tester helps a game launch, and the link opens these same steps.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" id="invite-share" data-share data-url="{SITE}/test/" data-text="Play new games before they launch, free on Google Play:">{ICON["share"]}Share</button>
      <button class="btn" type="button" data-copy data-url="{SITE}/test/">{ICON["link"]}theramlakhan.com/test/</button>
    </div>
  </section>

  <section class="section" aria-labelledby="games">
    <div class="section-head"><h2 id="games">Games</h2><span class="muted">{len(games)} games</span></div>
    <div class="grid">
{chr(10).join(tile(t, True) for t in games)}
    </div>
  </section>

  <section class="section" aria-labelledby="apps">
    <div class="section-head"><h2 id="apps">Apps</h2><span class="muted">{len(apps)} {"app" if len(apps) == 1 else "apps"}</span></div>
    <div class="grid">
{apps_html}
    </div>
  </section>

  <section class="section narrow" style="margin-left:auto;margin-right:auto" aria-labelledby="faq">
    <h2 id="faq">Good to know</h2>
    <details><summary>Which phones can test?</summary><p>Android phones and tablets with Google Play. Testing isn't open on iPhone or iPad.</p></details>
    <details><summary>Do I have to join the group for every game?</summary><p>No. Join once and you can opt in to any game or app on this page, now and later.</p></details>
    <details><summary>The opt-in page says the test isn't available</summary><p>Google can take a few minutes to see a new member of the group. Wait a little and open it again, signed in with the same Google account you joined with.</p></details>
    <details><summary>What does "Coming soon" mean?</summary><p>That game isn't on Google Play yet. Join the group now, and you can opt in the day its test opens. Many of them can already be played in your browser from their page.</p></details>
    <details><summary>Do I have to pay?</summary><p>No. Everything is free to play, just as it will be at launch, and test purchases are not charged.</p></details>
    <details><summary>What happens at launch?</summary><p>Nothing changes for you. The game updates through Google Play, and your progress stays.</p></details>
    <details><summary>How do I send feedback?</summary><p>Write to <a href="mailto:{SUPPORT}?subject=Testing%20feedback">{SUPPORT}</a> with your phone model and what happened. A level that felt unfair, a button that confused you, a bug: all of it helps.</p></details>
    <details><summary>Can I stop testing?</summary><p>Any time. Open the game's Opt in link again and leave the program, or uninstall it.</p></details>
  </section>
</main>
"""
    write("test/index.html", head("Play early · ramlakhan games",
                                  "Test new games and apps by Ramlakhan Madheshiya before they launch on Google Play. Join once, free, Android.",
                                  "/test/", "/games/single-shot/feature.jpg") + body + footer())


# --- /games/ ----------------------------------------------------------------------------

def build_games_hub():
    games = [t for t in TITLES if t["kind"] == "game"]
    body = f"""{nav("games")}
<main id="main" class="wrap">
  <section class="hero">
    <p class="eyebrow">ramlakhan games</p>
    <h1>Calm, clever games.</h1>
    <p class="lede">Small, handmade puzzles and arcade games for quiet minutes. Fair rules, room to think, and no account to make.</p>
  </section>
  <div class="grid">
{chr(10).join(tile(t, False) for t in games)}
  </div>
  <section class="card section" style="text-align:center">
    <p class="eyebrow">Testers wanted</p>
    <h2>Play them before anyone else</h2>
    <p class="muted" style="max-width:520px;margin:0 auto 18px">Join the testers group once, then try any new game on Google Play before it launches. Free, Android only.</p>
    <a class="btn btn-accent" href="/test/">Become a tester</a>
  </section>
</main>
"""
    write("games/index.html", head("ramlakhan games · calm, clever games",
                                   "Calm, clever games by Ramlakhan Madheshiya: " + ", ".join(t["name"] for t in games) + ".",
                                   "/games/", "/games/single-shot/feature.jpg") + body + footer())


# --- /games/<slug>/ ---------------------------------------------------------------------

def build_title_page(t):
    d = page_dir(t)
    shots = []
    for i, alt in enumerate(t.get("shots", []), 1):
        src = asset(t, f"shot-{i}.jpg")
        if src:
            shots.append(f'<figure><img src="{src}" alt="{e(alt)}" width="562" height="1000" loading="lazy"><figcaption>{e(alt)}</figcaption></figure>')
    hero_shot = asset(t, "shot-1.jpg")
    feature = asset(t, "feature.jpg")
    if t["status"] == "testing":
        gp = f'<a class="btn btn-accent" href="/test/#{t["slug"]}">{ICON["gp"]}Join the test on Google Play</a>'
        status_note = "In closed testing on Google Play. Join the testers group to play it before launch."
    elif t["status"] == "soon":
        gp = install_btn(t, "btn btn-accent", "Google Play")
        status_note = "Coming soon to Google Play. Join the testers group to play it the day testing opens."
    else:
        gp = f'<a class="btn btn-accent" href="{install_url(t)}">{ICON["gp"]}Get it on Google Play</a>'
        status_note = ""
    web = f'<a class="btn btn-primary" href="{t["web"]}">{ICON["play"]}Play in your browser</a>' if t.get("web") else ""
    apk = f'<a class="btn btn-text" href="{t["apk"]}" download>{ICON["down"]}Android APK</a>' if t.get("apk") else ""
    facts = "".join(f"<li>{e(f)}</li>" for f in t.get("facts", []))
    about = "".join(f"<p>{e(p)}</p>" for p in t.get("about", []))
    feats = "".join(f'<div class="card"><h3><span class="dot"></span>{e(h)}</h3><p>{e(p)}</p></div>' for h, p in t.get("features", []))
    others = [o for o in TITLES if o["slug"] != t["slug"] and o["kind"] == t["kind"] and has_page(o)]
    more = "".join(f'<a class="card" href="{page_dir(o)}">{icon_html(o)}<div><b>{e(o["name"])}</b><span>{e(o["genre"])} · {STATUS_LABEL[o["status"]]}</span></div></a>' for o in others)
    links = []
    if t.get("help"):
        links.append(f'<a href="{t["help"]}">Help</a>')
    if t.get("privacy"):
        links.append(f'<a href="{t["privacy"]}">Privacy policy</a>')
    links.append(f'<a href="mailto:{SUPPORT}?subject={e(t["name"])}">{SUPPORT}</a>')
    test_card = "" if t["status"] == "live" else f"""
  <section class="card section" style="text-align:center">
    <p class="eyebrow">Play early</p>
    <h2>{e(status_note)}</h2>
    <div class="btn-row" style="justify-content:center;margin-top:16px">
      <a class="btn btn-primary" href="/test/#{t['slug']}">How to test</a>
      <button class="btn" type="button" data-share data-url="{SITE}{d}" data-text="{e(t['name'])}: {e(t['tagline'])}">{ICON["share"]}Share</button>
    </div>
  </section>"""
    body = f"""{nav("games")}
<main id="main" class="wrap">
  <section class="game-hero">
    <div>
      {icon_html(t, "app-icon lg")}
      <div class="meta">{badge(t)}<span class="muted">{e(t['genre'])}</span></div>
      <h1>{e(t['name'])}</h1>
      <p class="lede">{e(t['tagline'])}</p>
      <div class="btn-row">{gp}{web}{apk}</div>
      <ul class="tags">{facts}</ul>
    </div>
    <div class="phone-hero">{f'<img src="{hero_shot}" alt="{e(t["name"])} on a phone" width="562" height="1000">' if hero_shot else ""}</div>
  </section>

  <section class="section about" aria-labelledby="about">
    <h2 id="about">About the game</h2>
    {about}
    {f'<img class="feature-img" src="{feature}" alt="" width="1024" height="500" loading="lazy" style="margin-top:12px">' if feature else ""}
  </section>

  {f'<section class="section" aria-labelledby="shots"><h2 id="shots">Screenshots</h2><div class="shots">{"".join(shots)}</div></section>' if shots else ""}

  <section class="section" aria-labelledby="feat">
    <h2 id="feat">What's inside</h2>
    <div class="features">{feats}</div>
  </section>
{test_card}
  <section class="section" aria-labelledby="more">
    <h2 id="more">More {"apps" if t["kind"] == "app" else "games"}</h2>
    <div class="more">{more}</div>
    <div class="links">{"".join(links)}</div>
  </section>
</main>
"""
    write(d.strip("/") + "/index.html",
          head(f"{t['store_name']} · ramlakhan games", t["tagline"], d, feature or hero_shot, t["accent"],
               asset(t, "icon.svg") or asset(t, "icon.png") or "/games/single-shot/icon.svg") + body + footer())


# --- Redirects ------------------------------------------------------------------------------

def redirect(rel, to):
    write(rel, f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Moved to {SITE}{to}</title>
<link rel="canonical" href="{SITE}{to}">
<meta http-equiv="refresh" content="0; url={to}">
<script>location.replace("{to}" + (location.hash || ""));</script>
</head><body><p>This page moved to <a href="{to}">{SITE}{to}</a>.</p></body></html>
""")


if __name__ == "__main__":
    build_test()
    build_games_hub()
    for t in TITLES:
        if has_page(t):
            build_title_page(t)
    redirect("games/test/index.html", "/test/")
    redirect("games/test/single-shot/index.html", "/test/#single-shot")
    redirect("apps/test/index.html", "/test/#apps")
