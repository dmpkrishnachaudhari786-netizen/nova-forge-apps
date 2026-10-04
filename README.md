# Nova & Forge — two working web apps

Live (GitHub Pages):
- Nova Alarm: https://dmpkrishnachaudhari786-netizen.github.io/nova-forge-apps/nova-alarm/
- Forge: https://dmpkrishnachaudhari786-netizen.github.io/nova-forge-apps/forge-agent/

Both apps are self-contained, offline-capable PWAs written in plain HTML/CSS/JS
(no build step, no frameworks) so they run well on a low-end Android phone.

## Nova Alarm
A premium smart alarm clock: create/edit/delete alarms, enable-disable, labels,
repeat days, one-time alarms, live countdown, 12/24-hour format, a real ringing
screen with real sound (Web Audio), vibration and notifications, snooze,
dismiss, history, missed-alarm recovery, duplicate prevention, invalid-time
validation, localStorage persistence, dark/light theme and an offline service
worker.

## Forge
A browser AI coding agent following User -> Agent -> Planner -> Tool Selection
-> Execution -> Observation -> Validation -> Response. Two brains: a
deterministic offline local engine, and an optional real LLM (Gemini / OpenAI /
Anthropic) using your own API key (kept in the browser tab only). Real tools:
write_file, edit_file, render (live sandboxed iframe), query, click, run_tests.

## Verification
Tested in a real headless Chromium browser (Puppeteer):
- Nova Alarm: 34/34 automated checks passed
- Forge: 27/27 automated checks passed (including the five required tasks)

## Run locally
    python3 -m http.server 8000
    # open http://localhost:8000/
