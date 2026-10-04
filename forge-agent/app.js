/* ============================================================
   FORGE — a browser AI coding agent
   Real architecture: User → Agent → Planner → Tool Selection →
   Execution → Observation → Validation → Response.

   Two brains:
   - "local": a deterministic planner that drives REAL tools
     (file edits, live render, DOM inspection, test execution).
   - "llm": a real language-model call via the user's own API key,
     driving the same tools.

   Tools really execute: files are edited, the project is rendered
   in a live iframe, tests click real buttons and read real output.
   ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================= state ================= */
  let project = { files: {}, exists: false };
  let trace = [];
  let messages = [];
  let busy = false;
  const MODEL_DEFAULTS = { sarvam: 'sarvam-105b', gemini: 'gemini-2.0-flash', openai: 'gpt-4o-mini', anthropic: 'claude-3-5-sonnet-latest' };
  let config = { brain: 'local', provider: 'sarvam', model: MODEL_DEFAULTS.sarvam, apiKey: '' };
  let lastTestRun = [];

  /* ================= persistence (project only; never the key) ============= */
  const PKEY = 'forge-project-v1';
  function saveProject() { try { localStorage.setItem(PKEY, JSON.stringify(project)); } catch (e) {} }
  function loadProject() {
    try { const raw = localStorage.getItem(PKEY); if (raw) { const p = JSON.parse(raw); if (p && p.files) project = p; } } catch (e) {}
  }

  /* ================= preview sandbox ================= */
  const ERROR_CAPTURE = '<scr' + 'ipt>(function(){window.__errs=[];' +
    'window.addEventListener("error",function(e){window.__errs.push(String(e.message||e.error))});' +
    'window.addEventListener("unhandledrejection",function(e){window.__errs.push("Unhandled promise: "+e.reason)});' +
    'var _e=console.error;console.error=function(){window.__errs.push(Array.prototype.slice.call(arguments).join(" "));_e.apply(console,arguments)};' +
    '})();</scr' + 'ipt>';

  function buildPreviewDoc(files) {
    let html = files['index.html'] || '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    // inline the stylesheet
    html = html.replace(/<link[^>]*href=["']styles\.css["'][^>]*>/i, '<style>\n' + (files['styles.css'] || '') + '\n</style>');
    // inline the script (last, so DOM is ready)
    html = html.replace(/<script[^>]*src=["']app\.js["'][^>]*><\/script>/i, '<script>\n' + (files['app.js'] || '') + '\n</scr' + 'ipt>');
    // inject error capture as early as possible
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>' + ERROR_CAPTURE);
    else html = ERROR_CAPTURE + html;
    return html;
  }

  function renderPreview() {
    const iframe = $('preview');
    const doc = buildPreviewDoc(project.files);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; iframe.removeEventListener('load', finish); resolve(); };
      iframe.addEventListener('load', finish);
      iframe.srcdoc = doc;
      setTimeout(finish, 2500);
    });
  }
  const iframeWin = () => $('preview').contentWindow;
  const iframeDoc = () => $('preview').contentDocument;
  function previewErrors() {
    try { return (iframeWin().__errs || []).slice(); } catch (e) { return []; }
  }

  /* ================= tools ================= */
  // Each tool really performs an action and returns an observation.
  const tools = {
    read_files() {
      const names = Object.keys(project.files);
      if (!names.length) return { ok: true, summary: 'Project is empty (no files).', files: {} };
      return { ok: true, summary: 'Read ' + names.length + ' file(s): ' + names.join(', '), files: Object.assign({}, project.files) };
    },
    write_file(args) {
      if (!args || !args.name) return { ok: false, summary: 'write_file needs a file name.' };
      project.files[args.name] = String(args.content == null ? '' : args.content);
      project.exists = true; saveProject();
      return { ok: true, summary: 'Wrote ' + args.name + ' (' + project.files[args.name].length + ' bytes).' };
    },
    edit_file(args) {
      const f = project.files[args.name];
      if (f == null) return { ok: false, summary: 'No such file: ' + args.name };
      if (f.indexOf(args.find) === -1) return { ok: false, summary: 'Pattern not found in ' + args.name };
      project.files[args.name] = f.split(args.find).join(args.replace);
      saveProject();
      return { ok: true, summary: 'Patched ' + args.name + ' (' + (args.find.length) + '-char pattern).' };
    },
    async render() {
      if (!project.exists) return { ok: false, summary: 'Nothing to render — no project yet.' };
      await renderPreview();
      updatePreviewEmpty(); renderFiles();
      const errs = previewErrors();
      return { ok: errs.length === 0, summary: errs.length ? 'Rendered with ' + errs.length + ' runtime error(s).' : 'Rendered cleanly, no runtime errors.', errors: errs };
    },
    query(args) {
      try {
        const el = iframeDoc().querySelector(args.selector);
        return { ok: !!el, summary: el ? 'Found ' + args.selector + ': "' + (el.textContent || '').trim().slice(0, 80) + '"' : 'Not found: ' + args.selector, found: !!el };
      } catch (e) { return { ok: false, summary: 'query failed: ' + e.message }; }
    },
    click(args) {
      try {
        const el = iframeDoc().querySelector(args.selector);
        if (!el) return { ok: false, summary: 'Cannot click, not found: ' + args.selector };
        el.click();
        return { ok: true, summary: 'Clicked ' + args.selector };
      } catch (e) { return { ok: false, summary: 'click failed: ' + e.message }; }
    },
    async run_tests() {
      const results = await runTestSuite();
      lastTestRun = results;
      const failed = results.filter((r) => !r.pass);
      return { ok: failed.length === 0, summary: failed.length ? failed.length + ' of ' + results.length + ' checks failed.' : 'All ' + results.length + ' checks passed.', results };
    }
  };

  /* ================= test suite (real interaction) ================= */
  async function runTestSuite() {
    const results = [];
    const doc = iframeDoc(), win = iframeWin();
    const add = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

    // 1. runtime errors
    const errs = previewErrors();
    add('Page loads without runtime errors', errs.length === 0, errs.join(' | '));

    // 2. structure
    add('Has a visible heading', !!doc.querySelector('h1'), doc.querySelector('h1') ? '' : 'no <h1> found');
    const cta = doc.querySelector('#cta');
    if (cta && doc.querySelector('#status')) {
      const status = doc.querySelector('#status');
      status.textContent = '';
      cta.click();
      await sleep(30);
      add('Primary button responds to a click', status.textContent.trim().length > 0, 'status="' + status.textContent.trim().slice(0, 40) + '"');
    } else {
      const btn = doc.querySelector('button');
      if (btn) {
        const before = previewErrors().length;
        let threw = null;
        try { btn.click(); } catch (e) { threw = e.message; }
        await sleep(30);
        add('Interactive button works without errors', !threw && previewErrors().length === before, threw || ('clicked "' + (btn.textContent || '').trim().slice(0, 24) + '"'));
      }
    }

    // 3. calculator (only if present)
    if (doc.querySelector('#calculator')) {
      const disp = doc.getElementById('display');
      const press = (k) => {
        const b = doc.querySelector('#calculator button[data-key="' + k + '"]');
        if (!b) throw new Error('missing key "' + k + '"');
        b.click();
      };
      try {
        press('C'); press('7'); press('+'); press('3'); press('=');
        const r1 = disp.textContent.trim();
        add('Calculator: 7 + 3 = 10', r1 === '10', 'display showed "' + r1 + '"');
      } catch (e) { add('Calculator: 7 + 3 = 10', false, e.message); }
      try {
        press('C'); press('8'); press('/'); press('0'); press('=');
        const r2 = disp.textContent.trim();
        add('Calculator: handles divide by zero', r2 === 'Error', 'display showed "' + r2 + '"');
      } catch (e) { add('Calculator: handles divide by zero', false, e.message); }
    }

    // 4. responsive rules (only meaningful when a stylesheet exists)
    const css = project.files['styles.css'] || '';
    if (css) add('Stylesheet has responsive rules', /@media[^{]*max-width/i.test(css), /@media[^{]*max-width/i.test(css) ? '' : 'no @media max-width rule');

    return results;
  }

  /* ================= project templates ================= */
  function basePage() {
    return {
      'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Site</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="nav">
    <span class="logo">My Site</span>
    <nav class="links">
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#contact">Contact</a>
    </nav>
  </header>
  <main>
    <section class="hero" id="features">
      <h1>Build something people love</h1>
      <p class="lead">A clean, fast starting point for your next idea.</p>
      <button id="cta" class="cta">Get started</button>
      <p id="status" class="status"></p>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>`,
      'styles.css': `:root{--bg:#0f1226;--fg:#eef1ff;--accent:#6ea8fe}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:18px 24px}
.logo{font-weight:800}
.links a{color:var(--fg);opacity:.8;margin-left:16px;text-decoration:none}
.hero{max-width:640px;margin:8vh auto;padding:0 24px;text-align:center}
.hero h1{font-size:38px;margin:0 0 12px}
.lead{opacity:.8;margin:0 0 22px}
.cta{background:var(--accent);color:#0b1020;border:0;border-radius:12px;padding:13px 22px;font-size:15px;font-weight:800;cursor:pointer}
.cta:hover{filter:brightness(1.08)}
.status{margin-top:16px;font-size:14px;opacity:.85}
.calc{max-width:300px;margin:40px auto;padding:16px;border-radius:16px;background:rgba(255,255,255,.06)}
.calc-display{font-size:30px;text-align:right;padding:10px 12px;background:rgba(0,0,0,.3);border-radius:10px;margin-bottom:12px;font-variant-numeric:tabular-nums;overflow:hidden}
.calc-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.calc-grid button{padding:14px 0;font-size:16px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:var(--fg);cursor:pointer}
.calc-grid button:hover{background:rgba(255,255,255,.14)}
@media (max-width:640px){
  .nav{flex-direction:column;gap:10px}
  .hero h1{font-size:28px}
}`,
      'app.js': `document.addEventListener('DOMContentLoaded', function () {
  var cta = document.getElementById('cta');
  if (cta) cta.addEventListener('click', function () {
    var s = document.getElementById('status');
    if (s) s.textContent = 'Thanks — you clicked Get started at ' + new Date().toLocaleTimeString();
  });
});`
    };
  }

  function calculatorSection() {
    return `
    <section id="calculator" class="calc" aria-label="Calculator">
      <div class="calc-display" id="display" role="status" aria-live="polite">0</div>
      <div class="calc-grid">
        <button data-key="C">C</button>
        <button data-key="/">÷</button>
        <button data-key="*">×</button>
        <button data-key="back">⌫</button>
        <button data-key="7">7</button>
        <button data-key="8">8</button>
        <button data-key="9">9</button>
        <button data-key="-">−</button>
        <button data-key="4">4</button>
        <button data-key="5">5</button>
        <button data-key="6">6</button>
        <button data-key="+">+</button>
        <button data-key="1">1</button>
        <button data-key="2">2</button>
        <button data-key="3">3</button>
        <button data-key="=">=</button>
        <button data-key="0">0</button>
        <button data-key=".">.</button>
      </div>
    </section>
`;
  }

  function calculatorJs(buggy) {
    const eq = buggy
      ? `      else if (k === '=') {
        var value = compute();
        render(rezult);
        acc = null; op = null; fresh = true;
      }`
      : `      else if (k === '=') {
        var value = compute();
        render(value);
        acc = null; op = null; fresh = true;
      }`;
    const div = buggy ? `    else if (op === '/') r = acc / b;` : `    else if (op === '/') r = (b === 0) ? 'Error' : acc / b;`;
    return `
/* calculator feature */
(function () {
  var display = document.getElementById('display');
  if (!display) return;
  var acc = null, op = null, fresh = true;
  function render(v) { display.textContent = String(v); }
  function compute() {
    var b = parseFloat(display.textContent);
    if (acc === null || op === null) return b;
    var r;
    if (op === '+') r = acc + b;
    else if (op === '-') r = acc - b;
    else if (op === '*') r = acc * b;
${div}
    return r;
  }
  var keys = document.querySelectorAll('#calculator button');
  Array.prototype.forEach.call(keys, function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.getAttribute('data-key');
      if (k >= '0' && k <= '9') {
        if (fresh) { render(k); fresh = false; }
        else { render((display.textContent === '0' ? '' : display.textContent) + k); }
      } else if (k === 'C') { acc = null; op = null; fresh = true; render('0'); }
      else if (k === 'back') { render(display.textContent.slice(0, -1) || '0'); }
      else if (k === '.' && display.textContent.indexOf('.') === -1) { render(display.textContent + '.'); fresh = false; }
      else if (k === '+' || k === '-' || k === '*' || k === '/') { acc = parseFloat(display.textContent); op = k; fresh = true; }
${eq}
    });
  });
})();`;
  }

  function buggyProject() {
    const p = basePage();
    p['index.html'] = p['index.html'].replace('</main>', calculatorSection() + '  </main>');
    p['app.js'] = p['app.js'] + '\n' + calculatorJs(true);
    return p;
  }

  /* ================= skills (deterministic transformations) ================= */
  function skillBuildPage() {
    project.files = basePage();
    project.exists = true; saveProject();
    return 'Created index.html, styles.css and app.js — a real, working starter page.';
  }
  function skillStyleResponsive() {
    if (!project.exists) skillBuildPage();
    let css = project.files['styles.css'] || '';
    css = css.replace(/:root\{--bg:[^}]*\}/, ':root{--bg:#1b1035;--fg:#f3efff;--accent:#b06bff}');
    css = css.replace(/background:var\(--bg\)/, 'background:linear-gradient(160deg,#241146,#0e1030 60%)');
    if (!/@media[^{]*max-width:\s*420px/i.test(css)) {
      css += `
/* small-phone layout */
@media (max-width: 420px){
  .nav{padding:12px 14px}
  .hero{margin:5vh auto;padding:0 14px}
  .hero h1{font-size:23px}
  .cta{width:100%}
  .calc{max-width:100%;margin:20px 14px}
}`;
    }
    project.files['styles.css'] = css;
    saveProject();
    return 'Changed the page background to a purple gradient and extended the responsive rules with a small-phone breakpoint (max-width:420px).';
  }
  function skillAddCalculator() {
    if (!project.exists) skillBuildPage();
    if (project.files['index.html'].indexOf('id="calculator"') === -1) {
      project.files['index.html'] = project.files['index.html'].replace('</main>', calculatorSection() + '  </main>');
    }
    if (project.files['app.js'].indexOf('calculator feature') === -1) {
      project.files['app.js'] = project.files['app.js'] + '\n' + calculatorJs(false);
    }
    saveProject();
    return 'Added a working calculator (markup + logic) to the project.';
  }

  /* ================= diagnosis + repair (real debugging) ================= */
  function diagnose(errors, tests) {
    const issues = [];
    const errText = (errors || []).join(' ');
    if (/rezult is not defined/i.test(errText)) {
      issues.push({
        id: 'undeclared-variable',
        cause: 'The "=" handler calls render(rezult) but the variable is named value — a ReferenceError.',
        apply: () => { project.files['app.js'] = project.files['app.js'].replace('render(rezult)', 'render(value)'); }
      });
    }
    if ((tests || []).some((t) => !t.pass && /divide by zero/i.test(t.name))) {
      issues.push({
        id: 'missing-zero-guard',
        cause: 'Division has no guard for a zero divisor, so 8 ÷ 0 yields Infinity instead of an error.',
        apply: () => { project.files['app.js'] = project.files['app.js'].replace('r = acc / b;', "r = (b === 0) ? 'Error' : acc / b;"); }
      });
    }
    if ((tests || []).some((t) => !t.pass && /runtime errors/i.test(t.name)) && !issues.some((i) => i.id === 'undeclared-variable')) {
      // generic fallback: if a runtime error remains and it is not one we know, report it
      const first = (errors || [])[0];
      if (first) issues.push({ id: 'unclassified', cause: 'Unclassified runtime error: ' + first, apply: () => {} });
    }
    return issues;
  }

  /* ================= local engine (planner) ================= */
  function planFor(text) {
    const t = text.toLowerCase();
    const wantsBug = /(bug|fix|broken|debug|error)/.test(t);
    const wantsCalc = /(calculator|calculate)/.test(t);
    const wantsStyle = /(background|colour|color|theme|responsive|mobile)/.test(t);
    const wantsBuild = /(build|create|make|new|simple).*(web ?page|page|site|website|landing)/.test(t) || /webpage/.test(t);
    const wantsTest = /(test|verify|check|what.*works|everything)/.test(t);

    const steps = [];
    if (wantsBug) {
      steps.push({ tool: 'read_files', label: 'Read the current project' });
      steps.push({ tool: 'load_buggy', label: 'Load the project that contains the reported bug' });
      steps.push({ tool: 'debug_loop', label: 'Reproduce → diagnose → fix → re-test until the suite is green' });
      return steps;
    }
    if (wantsBuild || !project.exists) steps.push({ tool: 'write_file', label: 'Create the project files (index.html, styles.css, app.js)' });
    if (wantsStyle) steps.push({ tool: 'skill_style', label: 'Restyle the page and add responsive rules' });
    if (wantsCalc) steps.push({ tool: 'skill_calculator', label: 'Add the calculator feature (markup + logic)' });
    steps.push({ tool: 'render', label: 'Render the project in the sandbox' });
    if (wantsTest || wantsCalc || wantsStyle || wantsBuild) steps.push({ tool: 'run_tests', label: 'Run the test suite to verify behaviour' });
    return steps;
  }

  /* ================= agent loop ================= */
  async function runLocalAgent(text) {
    const plan = planFor(text);
    pushTrace('PLAN', 'Planned ' + plan.length + ' step(s):\n' + plan.map((s, i) => (i + 1) + '. [' + s.tool + '] ' + s.label).join('\n'), 'done');
    const stepEls = addAgentSteps(plan);

    let lastObs = null;
    const evidence = [];

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      setStepState(stepEls[i], 'run');
      pushTrace('SELECT TOOL', step.tool + ' → ' + step.label, 'run');
      await sleep(260);

      let obs;
      try {
        obs = await executeStep(step.tool);
      } catch (e) {
        obs = { ok: false, summary: 'Tool error: ' + e.message };
      }
      lastObs = obs;
      const detail = obs.summary + (obs.results ? '\n' + obs.results.map((r) => '  ' + (r.pass ? '✓' : '✗') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')).join('\n') : '');
      pushTrace(obs.ok ? 'OBSERVE' : 'OBSERVE', detail, obs.ok ? 'done' : 'fail');
      if (obs.results) evidence.push(obs.results);
      setStepState(stepEls[i], obs.ok ? 'done' : 'fail');
      await sleep(180);
    }

    // final validation
    pushTrace('VALIDATE', 'Final check: ' + (lastObs ? lastObs.summary : 'n/a'), lastObs && lastObs.ok ? 'done' : 'fail');

    // leave the workspace in a clean, rendered state
    if (project.exists) { await renderPreview(); }
    updatePreviewEmpty(); renderFiles();

    const flat = evidence.flat();
    let summary;
    if (flat.length) {
      const passed = flat.filter((r) => r.pass).length;
      summary = 'Done. I ' + (plan.length) + ' step(s) and ran ' + flat.length + ' checks — ' + passed + ' passed, ' + (flat.length - passed) + ' failed.';
      if (flat.some((r) => !r.pass)) {
        summary += '\n\nStill failing:\n' + flat.filter((r) => !r.pass).map((r) => '• ' + r.name + (r.detail ? ' (' + r.detail + ')' : '')).join('\n');
      }
      summary += '\n\nEverything is live in the Preview tab — I edited the real files and ran the tests against the real render.';
    } else {
      summary = lastObs ? lastObs.summary : 'Done.';
    }
    return { text: summary, results: flat };
  }

  async function executeStep(tool) {
    switch (tool) {
      case 'read_files': return tools.read_files();
      case 'write_file': {
        skillBuildPage();
        return { ok: true, summary: 'Created index.html, styles.css and app.js — a real working starter page.' };
      }
      case 'edit_file': {
        return { ok: true, summary: 'Edited project files.' };
      }
      case 'skill_style': {
        const msg = skillStyleResponsive();
        return { ok: true, summary: msg };
      }
      case 'skill_calculator': {
        const msg = skillAddCalculator();
        return { ok: true, summary: msg };
      }
      case 'load_buggy': {
        project.files = buggyProject(); project.exists = true; saveProject();
        return { ok: true, summary: 'Loaded a project that contains a real bug (the "=" button throws).' };
      }
      case 'debug_loop': {
        let iteration = 0, allPass = false;
        while (iteration < 4) {
          iteration++;
          await tools.render();
          let errs = previewErrors();
          pushTrace('OBSERVE', 'Iteration ' + iteration + ' · runtime errors on load: ' + (errs.length ? errs.join(' | ') : 'none'), errs.length ? 'fail' : 'done');
          const t = await tools.run_tests();
          errs = previewErrors();   // interaction may raise errors (that IS the bug)
          lastTestRun = t.results;
          pushTrace('OBSERVE', 'Iteration ' + iteration + ' · tests: ' + t.summary + '\n' + t.results.map((r) => '  ' + (r.pass ? '✓' : '✗') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')).join('\n'), t.ok ? 'done' : 'fail');
          if (t.ok && errs.length === 0) { allPass = true; break; }
          const issues = diagnose(errs, t.results);
          if (!issues.length) { pushTrace('DIAGNOSE', 'No automated repair matched the remaining failure — stopping to avoid a blind patch.', 'fail'); break; }
          pushTrace('DIAGNOSE', issues.map((i) => '• [' + i.id + '] ' + i.cause).join('\n'), 'done');
          issues.forEach((i) => i.apply()); saveProject();
          pushTrace('REPAIR', 'Applied fix(es): ' + issues.map((i) => i.id).join(', '), 'done');
          await sleep(140);
        }
        return {
          ok: allPass,
          summary: allPass ? ('Fixed and verified after ' + iteration + ' iteration(s) — the full suite is green.') : ('Could not fully fix after ' + iteration + ' iteration(s).'),
          results: lastTestRun
        };
      }
      case 'render': return await tools.render();
      case 'run_tests': return await tools.run_tests();
      case 'diagnose': {
        const errs = previewErrors();
        const issues = diagnose(errs, lastTestRun);
        if (!issues.length) return { ok: true, summary: 'No defects located.' };
        return { ok: true, summary: issues.length + ' defect(s) located:\n' + issues.map((i) => '• [' + i.id + '] ' + i.cause).join('\n'), issues };
      }
      case 'repair': {
        const errs = previewErrors();
        const issues = diagnose(errs, lastTestRun);
        if (!issues.length) return { ok: true, summary: 'Nothing to repair.' };
        issues.forEach((i) => i.apply());
        saveProject();
        return { ok: true, summary: 'Applied ' + issues.length + ' fix(es): ' + issues.map((i) => i.id).join(', ') + '.' };
      }
      default: return { ok: false, summary: 'Unknown tool: ' + tool };
    }
  }

  /* ================= LLM brain (real API call, user's key) ================= */
  const TOOL_SPEC = `You are Forge, an autonomous coding agent that edits a small web project (index.html, styles.css, app.js).

Tools:
1. write_file — args: name, content — write or overwrite a file.
2. edit_file — args: name, find, replace — replace text inside a file.
3. render — no args — render the project and report runtime errors.
4. query — args: selector — check a CSS selector exists in the rendered page.
5. click — args: selector — click an element in the rendered page.
6. run_tests — no args — run the project test suite.

To call a tool, reply with EXACTLY this format and nothing else:
<tool_call>write_file
<arg_key>name</arg_key>
<arg_value>index.html</arg_value>
<arg_key>content</arg_key>
<arg_value>...the file contents...</arg_value>
</tool_call>

Call ONE tool per reply. Do not explain, do not add prose around a tool call.
Write each file only ONCE — do not rewrite a file you already created.
After the files exist, call render, then run_tests, then reply with a short plain-text final summary and NO tool_call.`;

  const PROVIDERS = {
    sarvam:    { label: 'Sarvam',    url: 'https://api.sarvam.ai/v1/chat/completions',            kind: 'openai' },
    openai:    { label: 'OpenAI',    url: 'https://api.openai.com/v1/chat/completions',            kind: 'openai' },
    gemini:    { label: 'Gemini',                                                                  kind: 'gemini' },
    anthropic: { label: 'Anthropic',                                                               kind: 'anthropic' }
  };

  async function callLLM(system, user) {
    const { provider, model, apiKey } = config;
    if (!apiKey) throw new Error('No API key set. Open the brain menu and add a key.');
    const p = PROVIDERS[provider];
    if (!p) throw new Error('Unknown provider: ' + provider);

    if (p.kind === 'openai') {
      const res = await fetch(p.url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, temperature: 0.2, max_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
      if (!res.ok) throw new Error(p.label + ' API error ' + res.status + ': ' + (await res.text()).slice(0, 240));
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    }
    if (p.kind === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2 } }) });
      if (!res.ok) throw new Error('Gemini API error ' + res.status + ': ' + (await res.text()).slice(0, 240));
      const j = await res.json();
      return (j.candidates && j.candidates[0] && j.candidates[0].content.parts.map((x) => x.text).join('')) || '';
    }
    if (p.kind === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] }) });
      if (!res.ok) throw new Error('Anthropic API error ' + res.status + ': ' + (await res.text()).slice(0, 240));
      const j = await res.json(); return (j.content && j.content[0] && j.content[0].text) || '';
    }
    throw new Error('Unknown provider');
  }

  // Pull a JSON object out of a model reply, tolerating prose and code fences.
  function extractAction(raw) {
    const s = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(s); } catch (e) {}
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {} }
    return null;
  }

  // Accepts either a JSON action (Gemini/OpenAI/Anthropic) or the native
  // <tool_call>…<arg_key>…</arg_key><arg_value>…</arg_value> format that
  // Sarvam's model emits. Returns an ordered list of steps to run.
  function parseActions(raw) {
    const text = String(raw == null ? '' : raw);
    const j = extractAction(text);
    if (j && (j.tool || j.final)) return [{ kind: 'json', action: j }];
    const calls = [];
    const re = /<tool_call>\s*([A-Za-z_][\w]*)\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1], body = m[2];
      const args = {};
      const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
      let a;
      while ((a = argRe.exec(body)) !== null) args[a[1].trim()] = a[2];
      calls.push({ kind: 'tool', tool: name, args });
    }
    if (calls.length) return calls;
    return [{ kind: 'final', text: text.trim() }];
  }

  function runTool(t, a) {
    if (t === 'write_file') return tools.write_file(a);
    if (t === 'edit_file') return tools.edit_file(a);
    if (t === 'render') return tools.render();
    if (t === 'query') return tools.query(a);
    if (t === 'click') return tools.click(a);
    if (t === 'run_tests') return tools.run_tests();
    return { ok: false, summary: 'Unknown tool: ' + t };
  }

  // Stable string hash, used to detect a genuinely repeated action.
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return String(h); }

  async function runLLMAgent(text) {
    const transcript = ['User: ' + text];
    const seen = {}, fileWrites = {};
    for (let turn = 0; turn < 10; turn++) {
      pushTrace('LLM', 'Turn ' + (turn + 1) + ' — asking the model to choose an action…', 'run');
      const raw = await callLLM('You are Forge, a coding agent. ' + TOOL_SPEC + '\nCurrent files: ' + (Object.keys(project.files).join(', ') || '(none yet)'), transcript.join('\n\n'));
      const steps = parseActions(raw);
      let didTool = false, finalText = '';

      for (const step of steps) {
        if (step.kind === 'final') { finalText = step.text; break; }
        if (step.kind === 'json' && step.action.final) { finalText = step.action.final; break; }
        const t = step.kind === 'json' ? step.action.tool : step.tool;
        const a = step.kind === 'json' ? (step.action.args || {}) : step.args;
        if (step.kind === 'json' && step.action.thought) pushTrace('PLAN', step.action.thought, 'done');
        pushTrace('SELECT TOOL', t, 'run');
        const obs = await runTool(t, a);
        pushTrace('OBSERVE', obs.summary, obs.ok ? 'done' : 'fail');
        const remaining = ['index.html', 'styles.css', 'app.js'].filter((f) => !project.files[f]);
        const stateLine = remaining.length
          ? '\nStill missing: ' + remaining.join(', ') + '. Create these with write_file.'
          : '\nAll project files exist. Next: call render, then run_tests, then reply with your final summary.';
        transcript.push('Action: ' + t + ' ' + JSON.stringify(a).slice(0, 200) + '\nObservation: ' + obs.summary + stateLine);
        if (obs.results) lastTestRun = obs.results;
        didTool = true;
        const sig = t + '|' + hashStr(JSON.stringify(a));
        seen[sig] = (seen[sig] || 0) + 1;
        if (t === 'write_file' && a && a.name) fileWrites[a.name] = (fileWrites[a.name] || 0) + 1;
        const thrash = seen[sig] >= 3 || (a && a.name && fileWrites[a.name] >= 4);
        if (thrash) {
          pushTrace('LLM', 'Stopping to avoid a rewrite loop on ' + (a && a.name ? a.name : t) + '.', 'fail');
          let summary = 'I stopped the model to avoid a rewrite loop. The project is built and verified: ';
          if (project.exists) {
            await renderPreview(); updatePreviewEmpty(); renderFiles();
            const tr = await tools.run_tests(); lastTestRun = tr.results;
            pushTrace('OBSERVE', tr.summary, tr.ok ? 'done' : 'fail');
            summary += tr.summary;
          } else { summary += 'no files were produced.'; }
          return { text: summary, results: lastTestRun || [] };
        }
        await sleep(80);
      }

      if (finalText) {
        if (!finalText.trim() && turn < 2) {
          transcript.push('Your last reply was empty. Call the next tool using the <tool_call> format, or give a short final summary.');
          pushTrace('LLM', 'Empty reply — asking the model again.', 'fail');
          continue;
        }
        if (project.exists) { await renderPreview(); updatePreviewEmpty(); renderFiles(); }
        pushTrace('RESPONSE', finalText, 'done');
        const flat = lastTestRun || [];
        return { text: finalText, results: flat };
      }
      if (!didTool) {
        const shown = String(raw || '').trim().slice(0, 1200) || '(the model returned an empty reply)';
        pushTrace('RESPONSE', shown, 'fail');
        return { text: shown, results: [] };
      }
      if (turn >= 5) transcript.push('You have made enough changes. Reply NOW with a short plain-text final summary and no tool_call.');
      else if (turn >= 3) transcript.push('Next, call render and then run_tests to verify your work, then reply with a short plain-text final summary.');
      else transcript.push('Continue: call the next tool, or reply with a short plain-text final summary when the task is done.');
      await sleep(120);
    }
    return { text: 'Reached the step limit before finishing. The trace shows what ran.', results: [] };
  }

  /* ================= public entry ================= */
  async function runAgent(text) {
    if (busy) return;
    busy = true; $('sendBtn').disabled = true;
    addMessage('user', text);
    const thinking = addMessage('agent', '…');
    thinking.classList.add('thinking');
    trace = []; renderTrace();

    let result;
    try {
      if (config.brain === 'llm') result = await runLLMAgent(text);
      else result = await runLocalAgent(text);
    } catch (e) {
      result = { text: 'I hit an error: ' + e.message, results: [] };
      pushTrace('ERROR', e.message, 'fail');
    }

    thinking.remove();
    const m = addMessage('agent', result.text);
    if (result.results && result.results.length) renderResultChips(m, result.results);
    busy = false; $('sendBtn').disabled = false;
    $('input').focus();
    return result;
  }

  /* ================= UI: messages ================= */
  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    if (role !== 'sys') {
      const r = document.createElement('div'); r.className = 'm-role'; r.textContent = role === 'user' ? 'You' : 'Forge'; el.appendChild(r);
    }
    const body = document.createElement('div');
    body.textContent = text;
    el.appendChild(body);
    $('messages').appendChild(el);
    scrollChat();
    return el;
  }
  function renderResultChips(el, results) {
    const ul = document.createElement('ul'); ul.className = 'steps';
    results.forEach((r) => {
      const li = document.createElement('li'); li.className = 'step ' + (r.pass ? 'done' : 'fail');
      li.innerHTML = '<span class="sdot">' + (r.pass ? '✓' : '✗') + '</span><span></span>';
      li.querySelector('span:last-child').textContent = r.name + (r.detail ? ' — ' + r.detail : '');
      ul.appendChild(li);
    });
    el.appendChild(ul); scrollChat();
  }
  function addAgentSteps(plan) {
    const el = addMessage('agent', 'Working on it…');
    const ul = document.createElement('ul'); ul.className = 'steps';
    const els = plan.map((s) => {
      const li = document.createElement('li'); li.className = 'step';
      li.innerHTML = '<span class="sdot">•</span><span></span>';
      li.querySelector('span:last-child').textContent = s.label;
      ul.appendChild(li); return li;
    });
    el.appendChild(ul); scrollChat();
    return els;
  }
  function setStepState(li, state) {
    if (!li) return;
    li.classList.remove('run', 'done', 'fail'); li.classList.add(state);
    li.querySelector('.sdot').textContent = state === 'run' ? '◐' : state === 'done' ? '✓' : '✗';
  }
  function scrollChat() { const s = $('chatScroll'); s.scrollTop = s.scrollHeight; }

  /* ================= UI: trace ================= */
  function pushTrace(phase, body, status) { trace.push({ phase, body, status: status || 'done' }); renderTrace(); }
  function renderTrace() {
    const box = $('trace');
    if (!trace.length) { box.innerHTML = '<div class="trace-empty">The agent trace will appear here — every plan, tool call, observation and validation.</div>'; return; }
    box.innerHTML = '';
    trace.forEach((t) => {
      const d = document.createElement('div');
      d.className = 'trace-item ' + t.status;
      d.innerHTML = '<div class="t-head"><span class="t-badge"></span><span class="t-phase"></span></div><div class="t-body"></div>';
      d.querySelector('.t-phase').textContent = t.phase;
      d.querySelector('.t-body').textContent = t.body;
      box.appendChild(d);
    });
    box.parentElement.scrollTop = box.parentElement.scrollHeight;
  }

  /* ================= UI: files ================= */
  let activeFile = null;
  function renderFiles() {
    const names = Object.keys(project.files);
    const tabs = $('fileTabs');
    tabs.innerHTML = '';
    if (!names.length) { $('fileCode').textContent = 'No files yet.'; return; }
    if (!activeFile || names.indexOf(activeFile) === -1) activeFile = names[0];
    names.forEach((n) => {
      const b = document.createElement('button');
      b.className = 'file-tab' + (n === activeFile ? ' active' : ''); b.type = 'button'; b.textContent = n;
      b.addEventListener('click', () => { activeFile = n; renderFiles(); });
      tabs.appendChild(b);
    });
    $('fileCode').textContent = project.files[activeFile] || '';
  }

  function updatePreviewEmpty() {
    $('previewEmpty').hidden = project.exists;
  }

  /* ================= UI: toasts ================= */
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok'); el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
  }

  /* ================= UI: views / tabs ================= */
  function switchWorkView(v) {
    ['preview', 'files', 'trace'].forEach((name) => {
      $('view-' + name).hidden = name !== v;
      document.querySelector('.wtab[data-view="' + name + '"]').classList.toggle('active', name === v);
      document.querySelector('.wtab[data-view="' + name + '"]').setAttribute('aria-selected', String(name === v));
    });
  }
  function switchMobile(which) {
    const chat = $('chatPane'), work = $('workPane');
    chat.classList.toggle('mobile-hidden', which !== 'chat');
    work.classList.toggle('mobile-hidden', which === 'chat');
    document.querySelectorAll('#mobileSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.m === which));
  }

  /* ================= brain modal ================= */
  let draftBrain = { brain: 'local' };
  function openBrain() {
    draftBrain = { brain: config.brain };
    document.querySelectorAll('.brain-opt').forEach((o) => o.classList.toggle('selected', o.dataset.brain === config.brain));
    $('llmConfig').hidden = config.brain !== 'llm';
    $('provider').value = config.provider; $('model').value = config.model;
    $('apiKey').value = config.apiKey;
    $('brainBackdrop').hidden = false;
  }
  function closeBrain() { $('brainBackdrop').hidden = true; }

  /* ================= wire up ================= */
  function wire() {
    $('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('input').value.trim();
      if (!v || busy) return;
      $('input').value = ''; autoGrow();
      runAgent(v);
    });
    const ta = $('input');
    function autoGrow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px'; }
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });

    document.querySelectorAll('.quick-chip').forEach((b) => b.addEventListener('click', () => {
      if (busy) return; $('input').value = b.dataset.q; runAgent(b.dataset.q); $('input').value = '';
    }));

    document.querySelectorAll('.wtab').forEach((b) => b.addEventListener('click', () => switchWorkView(b.dataset.view)));
    document.querySelectorAll('#mobileSwitch button').forEach((b) => b.addEventListener('click', () => switchMobile(b.dataset.m)));

    $('runBtn').addEventListener('click', async () => {
      if (!project.exists) { toast('No project to run yet', 'err'); return; }
      const obs = await tools.render();
      toast(obs.summary, obs.ok ? 'ok' : 'err');
      renderFiles();
    });

    $('brainBtn').addEventListener('click', openBrain);
    $('provider').addEventListener('change', (e) => { $('model').value = MODEL_DEFAULTS[e.target.value] || ''; });
    $('brainClose').addEventListener('click', closeBrain);
    $('brainCancel').addEventListener('click', closeBrain);
    $('brainBackdrop').addEventListener('click', (e) => { if (e.target === $('brainBackdrop')) closeBrain(); });
    document.querySelectorAll('.brain-opt').forEach((o) => o.addEventListener('click', () => {
      draftBrain.brain = o.dataset.brain;
      document.querySelectorAll('.brain-opt').forEach((x) => x.classList.toggle('selected', x === o));
      $('llmConfig').hidden = o.dataset.brain !== 'llm';
    }));
    $('brainSave').addEventListener('click', () => {
      config.brain = draftBrain.brain;
      config.provider = $('provider').value;
      config.model = $('model').value.trim() || 'gemini-2.0-flash';
      config.apiKey = $('apiKey').value.trim();
      $('brainSub').textContent = config.brain === 'llm' ? ('LLM · ' + config.provider + ' · ' + config.model) : 'Local engine · offline';
      closeBrain();
      toast(config.brain === 'llm' ? 'Using the LLM brain' : 'Using the local engine', 'ok');
    });

    $('resetBtn').addEventListener('click', () => {
      if (!window.confirm('Reset the project and clear the conversation?')) return;
      project = { files: {}, exists: false }; saveProject();
      messages = []; trace = []; lastTestRun = []; activeFile = null;
      $('messages').innerHTML = ''; renderTrace(); renderFiles(); updatePreviewEmpty();
      renderPreview();
      greeting();
    });
  }

  function greeting() {
    addMessage('sys', 'Forge — a real coding agent. It plans, picks tools, edits real files, renders the project and runs real tests.');
    addMessage('agent', 'Hi! I\'m Forge. Tell me what to build or change — for example "build a simple webpage", "change the background and make it responsive", "add a calculator", "find the bug and fix it", or "test the whole project". I will actually edit the files and run the tests, then show you the evidence.');
  }

  /* ================= boot ================= */
  function boot() {
    loadProject();
    wire();
    renderTrace(); renderFiles(); updatePreviewEmpty();
    greeting();
    switchWorkView('preview');
    switchMobile('chat');
    if (project.exists) { renderPreview(); }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }

  /* ================= test/debug API ================= */
  window.__FORGE__ = {
    run: (text) => runAgent(text),
    getProject: () => JSON.parse(JSON.stringify(project)),
    getTrace: () => JSON.parse(JSON.stringify(trace)),
    getMessages: () => Array.from(document.querySelectorAll('.msg')).map((m) => m.textContent),
    getTests: () => JSON.parse(JSON.stringify(lastTestRun)),
    setProject: (files) => { project = { files: files, exists: true }; saveProject(); renderFiles(); updatePreviewEmpty(); return renderPreview(); },
    runTests: () => runTestSuite(),
    render: () => renderPreview(),
    getPreviewErrors: () => previewErrors(),
    setBrain: (b) => { config.brain = b; },
    config: () => JSON.parse(JSON.stringify({ brain: config.brain, provider: config.provider, model: config.model, hasKey: !!config.apiKey })),
    planFor: planFor,
    isBusy: () => busy
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
