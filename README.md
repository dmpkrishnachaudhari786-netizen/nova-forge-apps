# Two working apps — build, test and verification notes

Both apps are self-contained, offline-capable PWAs written in plain HTML/CSS/JS
(no build step, no frameworks) so they run well on a low-end Android phone.
Everything visible in the UI is real: no fake buttons, no fake data, no
simulated success.

---

## 1. Nova Alarm — `nova-alarm.zip`

A premium smart alarm clock.

**Run it:** unzip, then serve the folder over HTTP and open it in a browser.
For example, from inside the folder:

    python3 -m http.server 8000
    # then open http://localhost:8000/

(Opening `index.html` directly with `file://` works for the core features, but
the service worker / offline caching and install prompt need HTTP.)

**Features (all real):**
- Create / edit / delete alarms; enable-disable with a toggle
- Time picker with steppers + 12/24-hour format
- Labels, repeat days (per weekday), one-time alarms
- Live current time and a live "next alarm" countdown
- Ringing screen with **real sound** (Web Audio — no audio files), vibration,
  and a system notification
- Snooze (configurable) and Dismiss; keyboard shortcuts (Esc / S)
- Alarm history (dismissed / snoozed / missed)
- Missed-alarm recovery when you return to the app
- Duplicate-alarm prevention and invalid-time validation
- Persistence in `localStorage` (survives refresh)
- Dark / light theme, offline service worker, installable PWA

**Known limitation:** a web page cannot ring while it is fully closed. Keep the
tab open or install the PWA; missed alarms are recorded when you come back.

---

## 2. Forge — `forge-agent.zip`

A browser AI coding agent with the architecture
User → Agent → Planner → Tool Selection → Execution → Observation → Validation → Response.

**Run it:** same as above (`python3 -m http.server`, or any static host).

**Two brains:**
- **Local engine (default, offline):** a deterministic planner that drives real
  tools. Handles: build a webpage, restyle + make responsive, add a calculator,
  find & fix a bug, and test the whole project.
- **LLM (bring your own key):** 12 provider options — **Sarvam AI** (India),
  Google Gemini, OpenAI, Anthropic Claude, **DeepSeek**, **Kimi (Moonshot)**,
  **Groq**, **Mistral**, **OpenRouter**, **xAI Grok**, **Together AI**, and a
  **Custom (OpenAI-compatible)** option where you enter any base URL. The key
  stays in the browser tab and is sent only to the provider.

  Browser (CORS) note: Sarvam, Groq, OpenRouter, Gemini and Anthropic allow
  direct calls from a web page. Some providers (OpenAI, DeepSeek, Mistral, xAI,
  Kimi, Together) block browser calls for security — Forge detects that and
  shows a clear message instead of a cryptic error, and you can use *Custom*
  with your own proxy URL. Model names auto-fill when you pick a provider.

**Real tools (they actually run):**
- `write_file` / `edit_file` — edit the project files
- `render` — render the project live in a sandboxed iframe
- `query` / `click` — inspect and interact with the rendered page
- `run_tests` — click real buttons and read real output (e.g. calculator 7+3=10)

The **Agent trace** tab shows every plan, tool call, observation and validation
step with real results.

---

## Verification

Both apps were tested in a real headless Chromium browser (Puppeteer), driving
the actual UI and the actual sandbox.

- Nova Alarm: **34/34** automated checks passed
- Forge (local engine): **27/27** automated checks passed (including the five required tasks)
- Forge (providers UI): **6/6** checks passed (12 providers, per-provider model defaults, friendly CORS error)
- Forge (LLM brain, live Sarvam API): **5/5** checks passed — the model really
  wrote index.html, styles.css and app.js, rendered the page and ran the tests

Bugs found and fixed during testing:
- Overlays (`display:grid/flex`) ignored the `hidden` attribute, so invisible
  layers blocked every click — fixed with a global `[hidden]` rule.
- The alarm editor rewrote the time inputs whenever a repeat-day or sound chip
  was tapped, silently resetting a typed time — fixed by splitting the sync.
- Invalid time input was silently normalised before Save could validate it —
  validation is now explicit and shown to the user.
- Forge: the generated calculator had an extra brace (syntax error) — fixed.
- Forge: the debug loop read runtime errors before the tests ran, so it missed
  the very error the tests triggered — fixed.
- Forge: the "No project yet" overlay stayed on top of the live preview — fixed.
