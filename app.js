/* PMM Coach – app logic. Everything runs on the device; nothing is sent anywhere. */
(function () {
  'use strict';
  var APP_VERSION = '1.0.0';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('pmmc.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('pmmc.' + k, JSON.stringify(v)); } catch (e) { /* storage may be unavailable */ } }
  };

  /* ---------- tiny IndexedDB key/value store (for an imported PMM index) ---------- */
  var IDB = {
    open: function () {
      return new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no idb'));
        var r = indexedDB.open('pmmcoach', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    },
    get: function (k) { return IDB.open().then(function (db) { return new Promise(function (res, rej) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }).catch(function () { return undefined; }); },
    set: function (k, v) { return IDB.open().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = function () { rej(t.error); }; }); }); },
    del: function (k) { return IDB.open().then(function (db) { return new Promise(function (res) { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; }); }).catch(function () {}); }
  };

  /* ---------- icons ---------- */
  var IC = {
    shield: 'M12 2l8 3v6c0 5-3.4 9.2-8 11-4.6-1.8-8-6-8-11V5z',
    hat: 'M12 2a10 10 0 100 20 10 10 0 000-20zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4z',
    check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    chart: 'M4 20V10h3v10zm6 0V4h3v16zm6 0v-7h3v7z',
    book: 'M18 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12V2zM6 4h5v8l-2.500-1.500L6 12V4z',
    gate: 'M4 21V3h2v18zm14 0V3h2v18zM8 8h8v2H8zm0 6h8v2H8z',
    swap: 'M7 7h10l-3-3 1.4-1.4L21 8l-5.6 5.4L14 12l3-3H7zm10 10H7l3 3-1.4 1.4L3 16l5.6-5.4L10 12l-3 3h10z',
    flag: 'M5 3h2v18H5zm4 1h10l-2 4 2 4H9z',
    doc: 'M6 2h8l6 6v14H6zm7 1.5V9h5.5z',
    search: 'M10.5 3a7.5 7.5 0 015.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1110.5 3zm0 2a5.5 5.5 0 100 11 5.5 5.5 0 000-11z',
    copy: 'M8 3h11v14H8zm2 2v10h7V5zM5 7h2v14h10v2H5z',
    open: 'M4 4h8v2H6v12h12v-6h2v8H4zm10 0h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14z',
    mark: 'M6 3h12v18l-6-4-6 4z',
    clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.4l3.5 2.1-1 1.7L11 13V7z',
    chat: 'M4 4h16v12H8l-4 4z',
    close: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6l5.6-5.6L5 6.4z'
  };
  function ico(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + IC[n] + '"/></svg>'; }

  /* ---------- state ---------- */
  var engine = null, meta = {}, RES = null, hlStems = [];
  var S = { q: '', literal: [], req: false, kind: '', sec: '', expanded: {}, showGroups: 10, suggestIdx: -1, sugg: [], seq: 0, lastFocus: null };
  var desktop = window.pmmDesktop || null;

  /* ---------- coach (mascot) ---------- */
  var POSE = { welcome: 'img/welcome.png', listening: 'img/listening.png', thinking: 'img/thinking.png', explaining: 'img/explaining.png', success: 'img/success.png', encourage: 'img/encourage.png' };
  var pose = 'welcome', curImg = 'A', restore = null, restoreTimer = null;
  Object.keys(POSE).forEach(function (k) { var im = new Image(); im.src = POSE[k]; });
  function setPose(p, html) {
    if (html != null) $('#bubbleText').innerHTML = html;
    if (p === pose) return;
    var a = $('#avA'), b = $('#avB'), cur = curImg === 'A' ? a : b, nxt = curImg === 'A' ? b : a;
    nxt.src = POSE[p]; nxt.classList.remove('off'); cur.classList.add('off');
    $('#avatar').classList.toggle('busy', p === 'thinking');
    curImg = curImg === 'A' ? 'B' : 'A'; pose = p;
  }
  function celebrate(msg) {
    clearTimeout(restoreTimer);
    var keep = { p: pose, h: $('#bubbleText').innerHTML };
    if (!restore) restore = keep;
    setPose('success', msg || "You're on track!");
    restoreTimer = setTimeout(function () { if (restore) { setPose(restore.p, restore.h); restore = null; } }, 2600);
  }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------- settings ---------- */
  function applyPrefs() {
    var th = LS.get('theme', 'system'), root = document.documentElement;
    if (th === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', th);
    var fs = { s: 15, m: 16, l: 18 }[LS.get('size', 'm')] || 16; root.style.setProperty('--fs', fs + 'px');
  }

  /* ---------- helpers ---------- */
  function secLabel(c) { return (c.h || '').replace(/^(\d[\d.]*)\s+(PMM-\S+\s*)?/, function (m, n, code) { return '\u00a7' + n + ' '; }).trim(); }
  function kindLabel(c) { return { Procedure: 'Procedure step', Policy: 'Policy', Objective: 'Objective', Forms: 'Forms & templates', Workflow: 'Workflow chart', Roles: 'Roles', 'Inputs/Outputs': 'Inputs & outputs', General: 'Content' }[c.k] || c.k; }
  function cite(c) {
    var p = engine.processOf(c);
    return 'NWC PMM ' + (meta.ver || '') + ' (' + (meta.ref || '') + ') \u2013 ' + (p.pseudo ? p.title : p.id + ' ' + p.title) + (c.h ? ' \u2013 ' + secLabel(c) : '') + ' \u2013 p.' + c.p;
  }
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return legacy(); });
    return Promise.resolve(legacy());
    function legacy() { var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); return ok; }
  }
  function savedList() { return LS.get('saved', []).filter(function (s) { var c = engine.chunk(s.i); return c && c.t.slice(0, 48) === s.tag; }); }
  function isSaved(i) { return savedList().some(function (s) { return s.i === i; }); }
  function toggleSave(i) {
    var l = savedList(), k = l.findIndex(function (s) { return s.i === i; });
    if (k >= 0) l.splice(k, 1); else { var c = engine.chunk(i); l.unshift({ i: i, tag: c.t.slice(0, 48) }); }
    LS.set('saved', l); updateSavedCount(); return k < 0;
  }
  function updateSavedCount() { var n = savedList().length, b = $('#savedCount'); b.textContent = n; b.hidden = !n; }
  function recents() { return LS.get('recent', []); }
  function pushRecent(q) {
    q = q.trim(); if (q.length < 2) return;
    var l = recents().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); }); l.unshift(q); LS.set('recent', l.slice(0, 10));
  }

  /* ---------- home ---------- */
  var TOPICS = [
    { t: 'Project risk management', d: 'Identify, analyse, respond to and review risks', q: 'risk management', ic: 'shield' },
    { t: 'Health, safety & environment', d: 'HSE planning, assurance and control', q: 'HSE assurance', ic: 'hat' },
    { t: 'Quality assurance & audit', d: 'QA, QC and PMM application audits', q: 'quality assurance audit', ic: 'check' },
    { t: 'Performance reporting', d: 'Design and construction progress reports', q: 'performance reporting', ic: 'chart' },
    { t: 'Training & knowledge', d: 'Team development and lessons learned', q: 'training lessons learned', ic: 'book' },
    { t: 'Stage gate reviews', d: 'Deliverables, committees and approvals', q: 'stage gate review', ic: 'gate' },
    { t: 'Variations & claims', d: 'Variation control, claims, time extensions', q: 'variation claims', ic: 'swap' },
    { t: 'Handover & close-out', d: 'Initial and final acceptance, closing', q: 'handover acceptance close', ic: 'flag' }
  ];
  var ASK = ['Who approves a variation order?', 'How often is the risk register reviewed?', 'What must be in the HSE plan?', 'NCR distribution steps',
    'Requirements for the lessons learned register', 'When is a stage gate review required?'];

  function renderHome() {
    var secs = engine.sections(), procs = engine.processes();
    var rec = recents();
    var h = '<div class="h-sec" id="installTile"' + (isStandalone() ? ' hidden' : '') + '><button class="topic" type="button" data-install-open style="width:100%"><span class="t-ic"><img src="img/favicon.png" alt="" width="28" height="28"></span><span class="t-txt"><b>Install PMM Coach</b><span class="t-d">Add it to your phone or Windows taskbar for one-tap access</span></span></button></div>' + '<div class="h-sec"><h2>Start with a topic</h2><div class="topics">' + TOPICS.map(function (t, i) {
      return '<button class="topic" type="button" data-topic="' + i + '"><span class="t-ic">' + ico(t.ic) + '</span><span class="t-txt"><b>' + esc(t.t) + '</b><span class="t-d">' + esc(t.d) + '</span></span></button>';
    }).join('') + '</div></div>';
    h += '<div class="h-sec"><h2>Try asking</h2><div class="ask">' + ASK.map(function (a) { return '<button type="button" data-ask="' + esc(a) + '">' + esc(a.replace(/[?]$/, '')) + '</button>'; }).join('') + '</div></div>';
    if (rec.length) h += '<div class="h-sec"><h2>Recent searches</h2><div class="chips">' + rec.map(function (r) { return '<button class="chip" type="button" data-ask="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div></div>';
    h += '<div class="h-sec"><h2>Browse the manual</h2><p class="sub">' + procs.length + ' processes in ' + secs.length + ' sections</p>' + secs.map(function (s) {
      var ps = procs.filter(function (p) { return p.sec === s.n; });
      return '<details class="sec"><summary><span class="sn">' + s.n + '</span><span>' + esc(s.title) + '</span></summary>' + (ps.length ? '<ul>' + ps.map(function (p) {
        return '<li><button type="button" data-ctx="' + esc(p.id) + '"><span>' + esc(p.title) + '</span><span class="pg">p.' + p.page + '</span></button></li>';
      }).join('') + '</ul>' : '<ul><li class="saved-note">General guidance for this section is searchable above.</li></ul>') + '</details>';
    }).join('') + '</div>';
    $('#home').innerHTML = h;
  }

  /* ---------- search ---------- */
  var debTimer = null, commitTimer = null;
  function setState(st) { $('#shell').dataset.state = st; $('#filters').hidden = st !== 'results'; $('#home').hidden = st === 'results'; $('#results').hidden = st !== 'results'; $('#understood').hidden = st !== 'results' }

  function showHome() {
    $('#answerBox').innerHTML = '';
    S.q = ''; S.literal = []; RES = null; setState('home'); $('#understood').hidden = true;
    setPose('welcome', 'How can I help you today?'); renderHome();
  }

  function runSearch(commit) {
    var q = $('#q').value; S.q = q;
    if (q.trim().length < 1) { showHome(); return; }
    var my = ++S.seq;
    var res = engine.search(q, { literal: S.literal.length ? S.literal : false, requirementsOnly: S.req, kind: S.kind, section: S.sec ? +S.sec : 0 });
    RES = res; hlStems = res.hl || []; S.expanded = {};
    try {
      res.ans = engine.answer(q, res);
      var ex = engine.experts ? engine.experts(q) : { best: engine.expert(q), others: [] };
      res.exp = ex.best; res.expOthers = ex.others || [];
    } catch (e) { res.ans = res.ans || null; res.exp = null; res.expOthers = []; }
    S.showGroups = res.ans ? 3 : 10;
    setState('results');
    renderUnderstood(res); renderResults(res);
    // coach: show "thinking" briefly, then settle on the outcome
    setPose('thinking', 'Let me analyze this.');
    setTimeout(function () { if (my === S.seq) settle(res); }, 380);
    clearTimeout(commitTimer);
    if (commit) pushRecent(q); else commitTimer = setTimeout(function () { if (res.total) pushRecent(q); }, 2200);
  }

  function settle(res) {
    var n = res.groups.length;
    if (res.direct) return setPose('explaining', 'Here\u2019s <b>' + esc(res.direct.label) + '</b>.');
    if (!res.total) {
      var unk = res.interp && res.interp.unknown && res.interp.unknown[0];
      return setPose('encourage', unk ? 'I couldn\u2019t match \u201c' + esc(unk) + '\u201d. Let\u2019s make progress together \u2013 try another word.' : 'Let\u2019s make progress together! Try fewer or different words.');
    }
    if (res.exp) return setPose('success', 'The PMM expert has an answer for this. It\u2019s in the first card.');
    if (res.ans && res.ans.headline && res.ans.type !== 'yesno') return setPose('explaining', 'Here\u2019s what the PMM says: <b>' + esc(res.ans.headline.length > 90 ? res.ans.headline.slice(0, 88) + '\u2026' : res.ans.headline) + '</b>');
    if (res.confidence === 'low') return setPose('encourage', 'Only part of your search matched. Let\u2019s make progress together \u2013 check what\u2019s missing below.');
    var g = res.groups[0];
    setPose('explaining', 'Found <b>' + res.total + '</b> match' + (res.total === 1 ? '' : 'es') + ' in <b>' + n + '</b> process' + (n === 1 ? '' : 'es') + '. Start with <b>' + esc(g.title) + '</b>.');
  }

  var INTENT = { who: 'who is responsible', when: 'timing or frequency', req: 'requirements (shall / must)', policy: 'policies', how: 'steps and procedures', form: 'forms and templates', objective: 'objectives', define: 'a definition' };

  function renderUnderstood(res) {
    var it = res.interp, el = $('#understood'), h = '';
    if (!it) { el.hidden = true; return; }
    if (it.direct) { el.innerHTML = '<div class="row"><span class="lead">Jumping straight to <em>' + esc(it.direct) + '</em></span></div>'; return; }
    var fixes = it.corrections.length || it.expansions.length;
    var shown = S.q.trim();
    if (it.corrections.length) {
      var map = {}; it.corrections.forEach(function (c) { map[c.from] = c.to; });
      shown = it.content.map(function (w) { return map[w.replace(/&/g, '')] || w; }).join(' ');
      h += '<div class="row"><span class="lead">Showing results for <em>' + esc(shown) + '</em></span>' +
        '<button type="button" class="linkbtn" data-literal="all">Search exactly as typed</button></div>';
    } else if (S.literal.length) {
      h += '<div class="row"><span class="lead">Searching exactly as typed</span><button type="button" class="linkbtn" data-literal="none">Allow corrections</button></div>';
    } else {
      h += '<div class="row"><span class="lead">Here\u2019s how I read that</span></div>';
    }
    var chips = it.concepts.map(function (c) {
      var syn = c.alts.filter(function (a) { return a.via === 'acronym' }); var raw = esc(c.raw.toUpperCase() === c.raw && c.raw.length < 6 ? c.raw.toUpperCase() : c.raw);
      if (c.status === 'typo') { var first = c.alts[0]; var to = RES && it.corrections.filter(function (x) { return x.from === c.raw.replace(/&/g, ''); })[0]; return '<button type="button" class="chip fix" data-literal-word="' + esc(c.raw) + '" title="Click to keep what you typed">' + raw + ' \u2192 <b>' + esc(to ? to.to : '') + '</b></button>'; }
      if (c.status === 'split') { var sp = c.alts[0].label; return '<span class="chip fix">' + raw + ' \u2192 <b>' + esc(sp) + '</b></span>'; }
      if (c.status === 'acronym') { return '<span class="chip fix">' + raw + ' = <b>' + esc(syn[0] ? syn[0].label : '') + '</b></span>'; }
      if (c.status === 'prefix') return '<span class="chip">' + raw + '\u2026</span>';
      if (c.status === 'none') return '<span class="chip warn">\u201c' + raw + '\u201d isn\u2019t in the PMM \u2013 ignored</span>';
      return '<span class="chip">' + raw + '</span>';
    }).join('');
    if (chips) h += '<div class="row">' + chips + '</div>';
    if (it.intents.length) h += '<div class="row"><span>Looking for</span>' + it.intents.map(function (k) { return '<span class="chip">' + esc(INTENT[k]) + '</span>'; }).join('') + '</div>';
    // related-wording note
    var rel = [];
    it.concepts.forEach(function (c) { var s = c.alts.filter(function (a) { return a.via === 'synonym'; }); if (s.length && rel.length < 3) rel.push(c.raw); });
    if (rel.length && !S.literal.length) h += '<div class="row" style="color:var(--muted)">Also matching related wording for: ' + rel.map(esc).join(', ') + '</div>';
    // ambiguity: several unrelated areas
    var bySec = {}, tot = 0;
    res.groups.slice(0, 8).forEach(function (g) { bySec[g.section] = (bySec[g.section] || 0) + g.count; tot += g.count; });
    var secs = Object.keys(bySec).sort(function (a, b) { return bySec[b] - bySec[a]; });
    var g0 = res.groups[0], g2 = res.groups[2];
    if (!S.sec && !res.ans && secs.length >= 3 && g2 && g2.score > g0.score * 0.6 && !res.direct) {
      var titles = {}; engine.sections().forEach(function (s) { titles[s.n] = s.title; });
      h += '<div class="clarify"><div class="row"><span class="lead">This touches several areas. Which one do you mean?</span></div><div class="row">' + secs.slice(0, 5).map(function (n) {
        return '<button class="chip" type="button" data-sec="' + n + '">' + esc((titles[n] || 'Section ' + n).replace(/^Project /, '')) + ' <span style="color:var(--muted)">' + bySec[n] + '</span></button>';
      }).join('') + '</div></div>';
    }
    el.innerHTML = h; el.hidden = false;
  }

  function itemHTML(it, res) {
    var c = engine.chunk(it.i), long = c.t.length > 420;
    var h = '<article class="item" data-i="' + it.i + '"><div class="i-meta"><span class="kind">' + esc(kindLabel(c)) + '</span>' + (c.r ? '<span class="kind req">Requirement</span>' : '') +
      (c.h ? '<span>' + esc(secLabel(c)) + '</span>' : '') + '<span>p.' + c.p + '</span></div>' +
      '<div class="i-text' + (long ? ' clamp' : '') + '">' + engine.highlight(c.t, hlStems) + '</div>';
    if (long) h += '<button type="button" class="linkbtn" data-more style="font-size:.8rem;margin-top:.2rem">Show more</button>';
    h += '<div class="i-foot">';
    c.f.slice(0, 3).forEach(function (f) { var t = engine.formTitle(f); h += '<button type="button" class="chip form" data-form="' + esc(f) + '" title="' + esc(t) + '">' + esc(f.replace(/^PMF-/, 'PMF-')) + (t ? ' \u00b7 ' + esc(t.length > 28 ? t.slice(0, 27) + '\u2026' : t) : '') + '</button>'; });
    if (c.f.length > 3) h += '<span class="chip form">+' + (c.f.length - 3) + ' forms</span>';
    if (it.missing && it.missing.length && it.cov < 1) h += '<span class="miss">Doesn\u2019t mention: ' + it.missing.map(esc).join(', ') + '</span>';
    h += '<span class="acts"><button class="act" type="button" data-copy="' + it.i + '" aria-label="Copy requirement with citation">' + ico('copy') + 'Copy</button>' +
      '<button class="act" type="button" data-save="' + it.i + '" aria-pressed="' + isSaved(it.i) + '" aria-label="Save requirement">' + ico('mark') + '<span>' + (isSaved(it.i) ? 'Saved' : 'Save') + '</span></button>' +
      '<button class="act" type="button" data-ctx="' + esc(engine.processOf(c).id) + '" data-focus="' + it.i + '" aria-label="Open in context">' + ico('open') + 'Context</button></span></div></article>';
    return h;
  }

  /* ---------- PMM expert answers ----------
   * Best match: light-red card, English and Arabic side by side, the straight answer first,
   * then the rest of the expert's requirement text. Other possible answers: English only. */
  function firstSentence(t) {
    var m = String(t || '').match(/^.+?[.!?\u061F;\u061B](?=\s|$)/);
    return m ? m[0].replace(/[;\u061B]$/, '.') : String(t || '');
  }
  function splitAnswer(t) {               // [straight answer, the rest]
    t = String(t || '').trim(); var d = firstSentence(t);
    return [d, t.slice(d.length).replace(/^[\s;\u061B]+/, '').trim()];
  }
  function ltr(h) {                        // keep codes such as PMM-014-PRO-100 or (WBS) readable inside Arabic text
    return h.replace(/[A-Za-z0-9]+(?:[-_.\/][A-Za-z0-9]+)+|[A-Z][A-Za-z0-9&]*[A-Z0-9]/g, function (m) { return '<bdi dir="ltr">' + m + '</bdi>'; });
  }
  function expertCol(lang, q, a) {
    var ar = lang === 'ar';
    if (!a) return '<div class="bx-col" lang="ar" dir="rtl"><p class="bx-missing">\u0627\u0644\u0646\u0635 \u0627\u0644\u0639\u0631\u0628\u064A \u063A\u064A\u0631 \u0645\u062A\u0648\u0641\u0631 \u0644\u0647\u0630\u0647 \u0627\u0644\u0625\u062C\u0627\u0628\u0629.</p></div>';
    var p = splitAnswer(a), hl = function (x) { return ar ? ltr(esc(x)) : engine.highlight(x, hlStems); };
    return '<div class="bx-col" lang="' + lang + '"' + (ar ? ' dir="rtl"' : '') + '>' +
      '<p class="bx-q">' + (ar ? ltr(esc(q)) : esc(q)) + '</p>' +
      '<p class="bx-direct">' + hl(p[0]) + '</p>' +
      (p[1] ? '<p class="bx-more">' + hl(p[1]) + '</p>' : '') + '</div>';
  }
  function expertHTML(x) {
    return '<section class="answer expert best-exp" aria-label="Best match from the PMM expert">' +
      '<div class="bx-tag"><span>Best match \u00b7 PMM expert</span><span lang="ar" dir="rtl">\u0623\u0641\u0636\u0644 \u0625\u062C\u0627\u0628\u0629</span></div>' +
      '<div class="bx-cols">' + expertCol('en', x.q, x.a) + expertCol('ar', x.qa || '', x.aa || '') + '</div>' +
      '<p class="a-note">Reference: ' + esc(x.ref) + (x.proc ? ' <button type="button" class="linkbtn" data-ctx="' + esc(x.proc) + '">Open the procedure</button>' : '') + '</p></section>';
  }
  function expertOthersHTML(list, hasBest) {
    if (!list || !list.length) return '';
    return '<section class="answer others" aria-label="Other possible answers"><div class="a-tag">' + (hasBest ? 'Other possible answers' : 'Possible answers from the PMM expert') + '</div><ul class="o-list">' +
      list.map(function (x) {
        return '<li><details><summary>' + esc(x.q) + '</summary><p>' + engine.highlight(x.a, hlStems) + '</p><p class="a-note">Reference: ' + esc(x.ref) +
          (x.proc ? ' <button type="button" class="linkbtn" data-ctx="' + esc(x.proc) + '">Open the procedure</button>' : '') + '</p></details></li>';
      }).join('') + '</ul></section>';
  }

  function answerHTML(a, afterExpert) {
    var h = '<section class="answer" aria-label="Answer"><div class="a-tag">' + (afterExpert ? 'Requirements from the PMM' : a.headline ? 'Answer' : 'Closest statements in the PMM') + '</div>';
    if (a.headline) h += '<p class="a-main">' + esc(a.headline) + '</p>';
    if (a.note) h += '<p class="a-note">' + esc(a.note) + '</p>';
    if (a.items) h += '<ol class="a-list">' + a.items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>';
    h += '<ul class="a-ev">' + a.evidence.map(function (e) {
      return '<li><span class="a-q">' + engine.highlight(e.text.length > 360 ? e.text.slice(0, 357) + '\u2026' : e.text, hlStems) + '</span><span class="a-src">' + esc(e.proc && e.proc.indexOf('SEC-') !== 0 ? e.proc + ' \u00b7 ' : '') + 'p.' + e.p +
        ' <button type="button" class="linkbtn" data-ctx="' + esc(e.proc) + '" data-focus="' + e.i + '">Open in context</button></span></li>';
    }).join('') + '</ul><p class="a-note">Best fit from the manual\u2019s wording. Confirm on the page before you rely on it. <button type="button" class="linkbtn" data-chat>Ask the Coach about this</button></p></section>';
    return h;
  }

  function renderResults(res) {
    var el = $('#results'), h = '';
    var active = S.req || S.kind || S.sec;
    if (!res.total) {
      $('#answerBox').innerHTML = '';
      h = '<div class="empty"><h3>' + (active ? 'No match with these filters' : 'No match for \u201c' + esc(S.q.trim()) + '\u201d') + '</h3>' +
        '<p>' + (active ? 'Try removing a filter, or search with fewer words.' : 'Use the key topic words, such as \u201crisk register\u201d. An abbreviation or its full name both work. I fix typos and ignore word order.') + '</p>' +
        (active ? '<p><button class="linkbtn" type="button" data-clear-filters>Clear filters</button></p>' : '') +
        '<div class="chips" style="margin-top:.8rem">' + TOPICS.slice(0, 6).map(function (t, i) { return '<button class="chip" type="button" data-topic="' + i + '">' + esc(t.t) + '</button>'; }).join('') + '</div></div>';
      el.innerHTML = h; return;
    }
    $('#answerBox').innerHTML = (res.exp ? expertHTML(res.exp) : '') + (res.ans ? answerHTML(res.ans, !!res.exp) : '') + expertOthersHTML(res.expOthers, !!res.exp);
    h += (res.ans ? '<h2 class="rel">Related passages</h2>' : '') + '<div class="summary" aria-live="polite"><span>' + res.total + ' match' + (res.total === 1 ? '' : 'es') + ' in ' + res.groups.length + ' process' + (res.groups.length === 1 ? '' : 'es') + '</span>' +
      (active ? '<button type="button" class="linkbtn" data-clear-filters>Clear filters</button>' : '<span>' + res.took + ' ms</span>') + '</div>';
    res.groups.slice(0, S.showGroups).forEach(function (g, gi) {
      var open = S.expanded[g.id], lim = open ? 15 : 3, items = g.items.slice(0, lim);
      var best = gi === 0 && res.groups.length > 1 && !res.direct && !res.exp;   // the expert card is the best match when there is one
      h += '<section class="group' + (best ? ' best' : '') + '"><div class="g-head"><h3 class="g-title"><button type="button" data-ctx="' + esc(g.id) + '">' + esc(g.title) + '</button></h3>' + (best ? '<span class="badge">Best match</span>' : '<span></span>') +
        '<div class="g-meta">' + (g.pseudo ? '' : '<span class="code">' + esc(g.id) + '</span>') + '<span>Section ' + g.section + ' \u00b7 ' + esc(g.sectionTitle.replace(/^Project /, '')) + '</span><span>p.' + g.page + '</span><span>' + g.count + ' match' + (g.count === 1 ? '' : 'es') + '</span></div></div>';
      h += items.map(function (it) { return itemHTML(it, res); }).join('');
      if (g.count > items.length) h += '<button type="button" class="more" data-expand="' + esc(g.id) + '">Show ' + Math.min(g.count - items.length, 15 - items.length) + ' more in this process</button>';
      else if (open && g.count > 15) h += '<button type="button" class="more" data-ctx="' + esc(g.id) + '">Open the full process</button>';
      h += '</section>';
    });
    if (res.groups.length > S.showGroups) h += '<button type="button" class="more" data-more-groups>Show more processes (' + (res.groups.length - S.showGroups) + ')</button>';
    el.innerHTML = h;
  }

  /* ---------- autocomplete ---------- */
  function renderSugg(list) {
    var ul = $('#sugg'); S.sugg = list; S.suggestIdx = -1;
    if (!list.length) { ul.hidden = true; $('#q').setAttribute('aria-expanded', 'false'); return; }
    ul.innerHTML = list.map(function (s, i) {
      var icn = { process: 'doc', word: 'search', acronym: 'book', recent: 'clock', form: 'doc' }[s.type] || 'search';
      return '<li role="option" id="sg' + i + '" data-i="' + i + '"><span class="s-ic">' + ico(icn) + '</span><span class="s-main"><span class="s-label">' + esc(s.label) + '</span><span class="s-sub">' + esc(s.sub || '') + '</span></span></li>';
    }).join('');
    ul.hidden = false; $('#q').setAttribute('aria-expanded', 'true');
  }
  function hideSugg() { $('#sugg').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); S.suggestIdx = -1; }
  function pickSugg(s) {
    hideSugg(); var q = $('#q');
    if (s.type === 'process') { openContext(s.process); return; }
    if (s.type === 'recent' || s.type === 'word') { q.value = s.label; }
    else if (s.type === 'acronym') { q.value = q.value.replace(new RegExp('\\b' + s.replace[0].replace(/[^a-z0-9]/gi, '.?') + '\\b', 'i'), s.replace[1]); }
    $('#btnClear').hidden = false; runSearch(true);
  }

  /* ---------- context drawer ---------- */
  function openLayer(id, html) {
    S.lastFocus = document.activeElement;
    var el = $(id); el.innerHTML = html; el.hidden = false; $('#scrim').hidden = false;
    document.body.style.overflow = 'hidden';
    var f = $('.close', el); if (f) f.focus();
    return el;
  }
  function closeLayers() {
    ['#drawer', '#sheet'].forEach(function (s) { $(s).hidden = true; });
    $('#scrim').hidden = true; document.body.style.overflow = '';
    if (S.lastFocus && S.lastFocus.focus) try { S.lastFocus.focus(); } catch (e) {}
  }

  function openContext(id, focusI) {
    var p = engine.process(id); if (!p) return;
    var chunks = engine.chunksOfProcess(id), blocks = [], last = null;
    chunks.forEach(function (c) { if (!last || last.h !== c.h) { last = { h: c.h, k: c.k, items: [] }; blocks.push(last); } last.items.push(c); });
    var procs = engine.processes(), idx = procs.findIndex(function (x) { return x.id === id; });
    var prev = procs[idx - 1], next = procs[idx + 1];
    var kinds = []; blocks.forEach(function (b) { if (kinds.indexOf(b.k) < 0 && b.k !== 'General') kinds.push(b.k); });
    var h = '<div class="d-head"><h2>' + (p.pseudo ? '' : '<span class="code">' + esc(p.id) + ' \u00b7 p.' + p.page + '</span>') + esc(p.title) + '</h2>' +
      '<button class="icon-btn close" type="button" data-close aria-label="Close">' + ico('close') + '</button></div>' +
      '<div class="d-nav"><label class="sr" for="dq">Search within this process</label><input id="dq" type="search" placeholder="Search within this process" style="flex:1;min-width:160px;border:1px solid var(--line-2);border-radius:999px;padding:.4rem .8rem;background:var(--field)">' +
      kinds.map(function (k) { return '<button class="chip" type="button" data-jump="' + esc(k) + '">' + esc(kindLabel({ k: k })) + '</button>'; }).join('') + '</div>' +
      '<div class="d-body" id="dBody">' + blocks.map(function (b) {
        return '<section class="d-sec" data-kind="' + esc(b.k) + '">' + (b.h ? '<h3>' + esc(secLabel({ h: b.h })) + '</h3>' : '') +
          b.items.map(function (c) {
            return '<div class="d-chunk' + (c.i === focusI ? ' focus' : '') + '" id="ck' + c.i + '" data-i="' + c.i + '"><div class="i-text">' + engine.highlight(c.t, hlStems) + '</div>' +
              '<div class="i-foot">' + c.f.map(function (f) { var t = engine.formTitle(f); return '<button class="chip form" type="button" data-form="' + esc(f) + '">' + esc(f) + (t ? ' \u00b7 ' + esc(t) : '') + '</button>'; }).join('') +
              '<span class="acts"><button class="act" type="button" data-copy="' + c.i + '">' + ico('copy') + 'Copy</button><button class="act" type="button" data-save="' + c.i + '" aria-pressed="' + isSaved(c.i) + '">' + ico('mark') + '<span>' + (isSaved(c.i) ? 'Saved' : 'Save') + '</span></button></span></div></div>';
          }).join('') + '</section>';
      }).join('') + '</div>' +
      '<div class="d-foot">' + (prev ? '<button class="btn" type="button" data-ctx="' + esc(prev.id) + '">\u2039 Previous process</button>' : '') +
      (next ? '<button class="btn" type="button" data-ctx="' + esc(next.id) + '">Next process \u203a</button>' : '') +
      '<button class="btn primary" type="button" data-copy-proc="' + esc(id) + '" style="margin-left:auto">Copy citation</button></div>';
    var el = openLayer('#drawer', h);
    if (focusI != null) { var t = $('#ck' + focusI, el); if (t) setTimeout(function () { t.scrollIntoView({ block: 'center' }); }, 30); }
    $('#dq', el).addEventListener('input', function (e) {
      var v = e.target.value.trim(), keep = null;
      if (v.length >= 2) { var r = engine.search(v, { process: id }); keep = {}; r.groups.forEach(function (g) { g.items.forEach(function (it) { keep[it.i] = 1; }); }); hlStems = r.hl || hlStems; }
      $$('.d-chunk', el).forEach(function (n) { n.style.display = !keep || keep[n.dataset.i] ? '' : 'none'; if (keep && keep[n.dataset.i]) n.querySelector('.i-text').innerHTML = engine.highlight(engine.chunk(+n.dataset.i).t, hlStems); });
      $$('.d-sec', el).forEach(function (s) { s.style.display = !keep || $$('.d-chunk', s).some(function (n) { return n.style.display !== 'none'; }) ? '' : 'none'; });
    });
  }


  /* ---------- chat ("Ask the Coach") ---------- */
  var CHAT = { msgs: [], busy: false, lastQ: '' };
  var WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  function chatSystemPrompt() {
    return 'You are PMM Coach, an assistant for the NWC Project Management Manual (PMM). Answer ONLY from the numbered passages provided. ' +
      'Be brief: at most four sentences. Cite the passages you used like [1] or [2]. If the passages do not contain the answer, say exactly: I could not find this in the PMM. ' +
      'Never invent numbers, roles or deadlines.';
  }
  function buildMessages(q, ps, ans) {
    var ctx = ps.map(function (p, k) { return '[' + (k + 1) + '] (' + (p.proc.indexOf('SEC-') === 0 ? 'PMM' : p.proc) + ', p.' + p.p + ') ' + p.text; }).join('\n\n');
    var ex = engine.expert(q); var hint = (ex ? 'Expert note: ' + ex.a + ' (' + ex.ref + ')\n\n' : '') + (ans && ans.headline && ans.type !== 'yesno' ? 'Verified finding from the manual: ' + ans.headline + '\n\n' : '');
    var hist = CHAT.msgs.filter(function (m) { return m.role === 'user' || (m.role === 'coach' && m.plain); }).slice(-4, -1).map(function (m) { return { role: m.role === 'user' ? 'user' : 'assistant', content: m.plain || m.text }; });
    return [{ role: 'system', content: chatSystemPrompt() }].concat(hist, [{ role: 'user', content: hint + 'Passages:\n' + ctx + '\n\nQuestion: ' + q }]);
  }
  function numbersCheck(answer, ps, ans) {
    var src = (ps.map(function (p) { return p.text; }).join(' ') + ' ' + (ans && ans.headline || '')).toLowerCase();
    Object.keys(WORDNUM).forEach(function (w) { src = src.replace(new RegExp('\\b' + w + '\\b', 'g'), String(WORDNUM[w])); });
    var txt = answer.replace(/\[\d+\]/g, ' ').toLowerCase();
    Object.keys(WORDNUM).forEach(function (w) { txt = txt.replace(new RegExp('\\b' + w + '\\b', 'g'), String(WORDNUM[w])); });
    var bad = []; (txt.match(/\b\d+(?:\.\d+)?\b/g) || []).forEach(function (n) { if (!new RegExp('(^|[^\\d.])' + n.replace('.', '\\.') + '([^\\d]|$)').test(src) && bad.indexOf(n) < 0) bad.push(n); });
    return bad;
  }
  function citeHTML(text, ps) {
    return esc(text).replace(/\[(\d+)\]/g, function (m, n) { var p = ps[+n - 1]; return p ? '<button type="button" class="cite" data-ctx="' + esc(p.proc) + '" data-focus="' + p.i + '" title="p.' + p.p + '">' + n + '</button>' : m; })
      .split(/\n+/).map(function (l) { return '<p>' + l + '</p>'; }).join('');
  }
  function srcHTML(ps) { return ps.length ? '<div class="src">' + ps.map(function (p, k) { return '<button type="button" data-ctx="' + esc(p.proc) + '" data-focus="' + p.i + '">' + (k + 1) + ' \u00b7 ' + esc(p.proc.indexOf('SEC-') === 0 ? 'Section ' + p.proc.slice(4) : p.proc) + ' \u00b7 p.' + p.p + '</button>'; }).join('') + '</div>' : ''; }
  function addMsg(role, html, pose) {
    var log = $('#chatLog'); var d = document.createElement('div'); d.className = 'msg ' + role;
    d.innerHTML = role === 'user' ? '<div class="bub">' + html + '</div>' : '<img class="ava" src="' + POSE[pose || 'explaining'] + '" alt=""><div class="bub">' + html + '</div>';
    log.appendChild(d); log.parentElement.scrollTop = log.parentElement.scrollHeight; return d;
  }
  function fallbackReply(ans, ps, q) {
    var h = ''; var ex = q ? engine.expert(q) : null;
    if (ex) h += '<div class="big">' + esc(ex.a) + '</div><div class="tip">Reference: ' + esc(ex.ref) + '</div>';
    if (ans && ans.headline) h += '<div class="big">' + esc(ans.headline) + '</div>';
    var ev = ans ? ans.evidence : [];
    if (ev.length) h += ev.slice(0, 2).map(function (e) { return '<div class="quote">' + esc(e.text.length > 300 ? e.text.slice(0, 297) + '\u2026' : e.text) + ' <span style="color:var(--muted)">p.' + e.p + '</span></div>'; }).join('');
    else if (ps.length) h += '<p>The closest passages in the manual:</p>' + ps.slice(0, 2).map(function (p) { return '<div class="quote">' + esc(p.text.length > 300 ? p.text.slice(0, 297) + '\u2026' : p.text) + ' <span style="color:var(--muted)">p.' + p.p + '</span></div>'; }).join('');
    return h;
  }
  function chatAsk(q) {
    if (CHAT.busy || !q.trim()) return;
    CHAT.busy = true; CHAT.msgs.push({ role: 'user', text: q }); addMsg('user', esc(q));
    var words = engine.words(q).filter(function (w) { return w.length > 2; });
    var qq = words.length < 3 && CHAT.lastQ ? CHAT.lastQ + ' ' + q : q; CHAT.lastQ = qq;
    var res = engine.search(qq), ans = null, ps = [];
    try { ans = engine.answer(qq, res); ps = engine.passages(qq, res, 4); } catch (e) {}
    hlStems = res.hl || [];
    var node = addMsg('coach', '<span class="typing"><i></i><i></i><i></i></span>', 'thinking'); var bub = node.querySelector('.bub'), img = node.querySelector('.ava');
    function finish(html, plain, pose) { bub.innerHTML = html; img.src = POSE[pose || 'explaining']; CHAT.msgs.push({ role: 'coach', text: html, plain: plain }); CHAT.busy = false; $('#chatLog').parentElement.scrollTop = 1e6; }
    if (!ps.length && !(ans && ans.evidence.length)) { return finish('<p>I could not find this in the PMM. Try different words, or name the process or topic.</p>', '', 'encourage'); }
    if (!(window.PMMLLM && PMMLLM.ready())) {
      var tip = PMMLLM && PMMLLM.enabled && PMMLLM.enabled() ? 'The on-device AI is still starting.' : 'Turn on the on-device AI in Settings for answers in plain words.';
      return finish(fallbackReply(ans, ps, q) + srcHTML(ans && ans.evidence.length ? ans.evidence : ps) + '<div class="tip">' + tip + '</div>', ans && ans.headline || '', ans && ans.headline ? 'success' : 'explaining');
    }
    var acc = '';
    PMMLLM.ask(buildMessages(q, ps, ans), function (t) { acc += t; bub.innerHTML = citeHTML(acc, ps); $('#chatLog').parentElement.scrollTop = 1e6; })
      .then(function (full) {
        full = (full || acc).trim(); var bad = numbersCheck(full, ps, ans);
        var html = citeHTML(full, ps) + srcHTML(ps) + (bad.length ? '<div class="warn">Check the number' + (bad.length > 1 ? 's' : '') + ' ' + bad.map(esc).join(', ') + ' against the cited pages. It does not appear in the passages I used.</div>' : '');
        finish(html, full, bad.length ? 'encourage' : 'success');
      })
      .catch(function (err) { finish(fallbackReply(ans, ps, q) + srcHTML(ps) + '<div class="warn">The on-device AI could not answer (' + esc(err.message) + '). Showing the closest passages instead.</div>', '', 'encourage'); });
  }
  function openChat(prefill) {
    var h = '<div class="d-head"><h2 id="drawerTitle">Ask the Coach</h2><button class="icon-btn close" type="button" data-close aria-label="Close">' + ico('close') + '</button></div>' +
      '<div class="d-body"><div class="chat-log" id="chatLog"></div></div>' +
      '<form class="chat-form" id="chatForm" autocomplete="off"><label class="sr" for="chatQ">Your question</label><input id="chatQ" type="text" placeholder="Ask about the PMM in your own words" enterkeyhint="send"><button class="btn primary" type="submit">Send</button></form>';
    var el = openLayer('#drawer', h);
    if (!CHAT.msgs.length) CHAT.msgs.push({ role: 'coach', text: '<p>Ask me about any requirement in the PMM, such as <b>how many stage gates are there</b> or <b>who approves a variation order</b>. I answer from the manual and show the pages.</p>' + (PMMLLM && PMMLLM.ready() ? '' : '<div class="tip">On-device AI is off, so I will show the closest statements. You can turn it on in Settings.</div>'), plain: '' });
    CHAT.msgs.forEach(function (m) { if (m.role === 'user') addMsg('user', esc(m.text)); else addMsg('coach', m.text, 'welcome'); });
    $('#chatForm', el).addEventListener('submit', function (e) { e.preventDefault(); var i = $('#chatQ', el), v = i.value; i.value = ''; chatAsk(v); });
    var qi = $('#chatQ', el); if (prefill) { qi.value = prefill; } setTimeout(function () { qi.focus(); }, 60);
    setPose('listening', 'I\u2019m listening.');
  }

  /* ---------- settings & saved sheets ---------- */
  function seg(name, opts, cur) { return '<div class="seg" data-seg="' + name + '">' + opts.map(function (o) { return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (o[0] === cur) + '">' + o[1] + '</button>'; }).join('') + '</div>'; }
  function openSettings() {
    var m = meta, h = '<div class="d-head"><h2 id="sheetTitle">Settings</h2><button class="icon-btn close" type="button" data-close aria-label="Close">' + ico('close') + '</button></div><div class="d-body">';
    h += '<div class="s-row"><div class="l"><b>Theme</b></div>' + seg('theme', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], LS.get('theme', 'system')) + '</div>';
    h += '<div class="s-row"><div class="l"><b>Text size</b></div>' + seg('size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], LS.get('size', 'm')) + '</div>';
    if (desktop) {
      var pr = desktop.prefs || {};
      h += '<div class="s-row"><div class="l"><b>Open when I sign in</b><span>Keeps the coach on standby in the tray</span></div>' + seg('login', [['1', 'On'], ['0', 'Off']], pr.openAtLogin ? '1' : '0') + '</div>';
      h += '<div class="s-row"><div class="l"><b>Summon shortcut</b><span>' + esc(pr.shortcut || 'Ctrl+Alt+P') + ' shows or hides the coach from anywhere</span></div></div>';
    }

    var L = window.PMMLLM, st = L ? L.state() : { phase: 'off' }, ck = L ? L.chosen() : 'standard';
    if (L) {
      h += '<div class="s-row" style="display:block"><div class="l"><b>On-device AI answers</b><span>Writes short answers from the manual in plain words. Runs on this device; the manual\u2019s text never leaves it. Downloads the model once, then works offline. Best on a computer: phones are slow.</span></div>' +
        '<div style="margin:.6rem 0">' + seg('ai', [['1', 'On'], ['0', 'Off']], L.enabled() ? '1' : '0') + '</div>' +
        '<div style="margin:.4rem 0">' + seg('aimodel', [['light', 'Light'], ['standard', 'Standard'], ['better', 'Better']], ck) + '</div>' +
        '<div class="ai-status" id="aiModelNote">' + esc(L.MODELS[ck].label) + (L.gpu() ? '' : '. This browser has no graphics acceleration, so Better is not available.') + '</div>' +
        '<div class="bar" id="aiBar" hidden><i></i></div><div class="ai-status" id="aiStatus"></div>' +
        '<div style="margin-top:.6rem;display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary" type="button" data-ai-load>Download and start</button><button class="btn danger" type="button" data-ai-remove>Remove downloaded model</button></div></div>';
    }
    h += '<div class="s-row"><div class="l"><b>PMM content</b><span>' + esc((m.doc || 'PMM') + ' ' + (m.ver || '') + ' \u00b7 ' + (m.ref || '') + ' \u00b7 issued ' + (m.issued || '?') + '<br>' + (m.chunks || 0) + ' searchable passages from ' + (m.pages || '?') + ' pages \u00b7 indexed ' + (m.built || '?')) + '</span></div></div>';
    h += '<div class="s-row"><div class="l"><b>Load a PMM index file</b><span>Use this when a new PMM issue is released. Your PMO team supplies the file.</span></div><button class="btn" type="button" data-import>Choose file</button></div>';
    if (S.imported) h += '<div class="s-row"><div class="l"><b>Stored copy of the manual</b><span>Remove it. You will need the access code again.</span></div><button class="btn" type="button" data-reset-index>Reset</button></div>';
    h += '<div class="s-row"><div class="l"><b>History and saved items</b><span>Stored only on this device</span></div><button class="btn danger" type="button" data-wipe>Clear</button></div>';
    h += '<p class="note">PMM Coach ' + APP_VERSION + ' is a search aid. The controlled PMM document remains the authority; always confirm a requirement against it before you rely on it. Everything runs on this device and nothing you type is sent anywhere.</p></div>';
    openLayer('#sheet', h); paintAI();
  }
  function paintAI() {
    var L = window.PMMLLM, s = $('#aiStatus'); if (!L || !s) return; var st = L.state(), bar = $('#aiBar');
    var txt = { off: L.enabled() ? 'Not started. Press Download and start.' : 'Off.', downloading: 'Preparing the model\u2026', ready: 'Ready. Answers are generated on this device.', error: st.error }[st.phase] || '';
    if (st.phase === 'downloading' && st.total) txt = 'Downloading ' + Math.round(st.loaded / 1048576) + ' of ' + Math.round(st.total / 1048576) + ' MB (once only)';
    s.textContent = txt; s.className = 'ai-status' + (st.phase === 'error' ? ' err' : '');
    bar.hidden = st.phase !== 'downloading'; if (st.total) $('i', bar).style.width = Math.min(100, Math.round(st.loaded / st.total * 100)) + '%';
  }
  function openSaved() {
    var l = savedList();
    var h = '<div class="d-head"><h2 id="sheetTitle">Saved requirements</h2><button class="icon-btn close" type="button" data-close aria-label="Close">' + ico('close') + '</button></div><div class="d-body">';
    if (!l.length) h += '<div class="empty"><h3>Nothing saved yet</h3><p>Tap Save on any requirement to keep it here, with its page reference.</p></div>';
    else h += l.map(function (s) {
      var c = engine.chunk(s.i), p = engine.processOf(c);
      return '<div class="saved-item"><div class="i-meta"><span class="kind">' + esc(kindLabel(c)) + '</span><span>' + esc(p.pseudo ? p.title : p.id) + '</span><span>p.' + c.p + '</span></div><div class="i-text clamp">' + esc(c.t) + '</div>' +
        '<div class="i-foot"><span class="acts"><button class="act" type="button" data-copy="' + s.i + '">' + ico('copy') + 'Copy</button><button class="act" type="button" data-ctx="' + esc(p.id) + '" data-focus="' + s.i + '">' + ico('open') + 'Context</button><button class="act" type="button" data-unsave="' + s.i + '">' + ico('close') + 'Remove</button></span></div></div>';
    }).join('');
    h += '</div>' + (l.length ? '<div class="d-foot"><button class="btn primary" type="button" data-copy-saved>Copy all with citations</button></div>' : '');
    openLayer('#sheet', h);
  }

  /* ---------- events ---------- */
  function bind() {
    if (bind.done) return; bind.done = true;
    var q = $('#q');
    q.addEventListener('focus', function () { if (!q.value) { renderSugg(recents().slice(0, 5).map(function (r) { return { type: 'recent', label: r, sub: 'Recent search' }; })); } setPose(pose === 'welcome' || pose === 'listening' ? 'listening' : pose, pose === 'welcome' ? 'I\u2019m listening.' : null); });
    q.addEventListener('input', function () {
      var v = q.value; $('#btnClear').hidden = !v;
      if (!v) { hideSugg(); clearTimeout(debTimer); showHome(); setPose('listening', 'I\u2019m listening.'); return; }
      S.literal = [];
      setPose('listening', 'I\u2019m listening.');
      renderSugg(v.trim().length >= 2 ? engine.suggest(v, 6) : []);
      clearTimeout(debTimer); debTimer = setTimeout(function () { runSearch(false); }, 240);
    });
    q.addEventListener('keydown', function (e) {
      var n = S.sugg.length;
      if (e.key === 'ArrowDown' && n && !$('#sugg').hidden) { e.preventDefault(); S.suggestIdx = (S.suggestIdx + 1) % n; markSugg(); }
      else if (e.key === 'ArrowUp' && n && !$('#sugg').hidden) { e.preventDefault(); S.suggestIdx = (S.suggestIdx - 1 + n) % n; markSugg(); }
      else if (e.key === 'Escape') { if (!$('#sugg').hidden) hideSugg(); else if (q.value) { q.value = ''; $('#btnClear').hidden = true; showHome(); } }
    });
    $('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault(); clearTimeout(debTimer);
      if (S.suggestIdx >= 0 && S.sugg[S.suggestIdx]) { pickSugg(S.sugg[S.suggestIdx]); return; }
      hideSugg(); S.literal = S.literal; runSearch(true);
      if (window.matchMedia('(pointer:coarse)').matches) q.blur();
    });
    $('#sugg').addEventListener('mousedown', function (e) { e.preventDefault(); var li = e.target.closest('li'); if (li) pickSugg(S.sugg[+li.dataset.i]); });
    $('#sugg').addEventListener('touchstart', function (e) { var li = e.target.closest('li'); if (li) { e.preventDefault(); pickSugg(S.sugg[+li.dataset.i]); } }, { passive: false });
    q.addEventListener('blur', function () { setTimeout(hideSugg, 120); if (pose === 'listening' && !q.value) setPose('welcome', 'How can I help you today?'); });
    $('#btnClear').addEventListener('click', function () { q.value = ''; $('#btnClear').hidden = true; hideSugg(); showHome(); q.focus(); });

    $('#fReq').addEventListener('change', function (e) { S.req = e.target.checked; runSearch(false); });
    $('#fKind').addEventListener('change', function (e) { S.kind = e.target.value; runSearch(false); });
    $('#fSec').addEventListener('change', function (e) { S.sec = e.target.value; runSearch(false); });

    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnChat').addEventListener('click', function () { openChat(''); });
    $('#btnInstall').addEventListener('click', openInstall);
    $('#btnSaved').addEventListener('click', openSaved);
    $('#scrim').addEventListener('click', closeLayers);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#scrim').hidden) closeLayers();
      if ((e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); q.focus(); q.select(); }
    });
    var fab = $('#fabTop');
    window.addEventListener('scroll', function () { fab.hidden = !(window.scrollY > 700 && $('#shell').dataset.state === 'results'); }, { passive: true });
    fab.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(function () { q.focus(); q.select(); }, 350); });
    var pin = $('#btnPin');
    if (desktop) {
      pin.hidden = false;
      pin.addEventListener('click', function () { var on = pin.getAttribute('aria-pressed') !== 'true'; pin.setAttribute('aria-pressed', on); desktop.setAlwaysOnTop(on); toast(on ? 'Pinned on top' : 'Unpinned'); });
      if (desktop.onFocusSearch) desktop.onFocusSearch(function () { q.focus(); q.select(); });
      if (desktop.onPinChanged) desktop.onPinChanged(function (on) { pin.setAttribute('aria-pressed', on); });
      if (desktop.getPrefs) desktop.getPrefs().then(function (p) { desktop.prefs = p; pin.setAttribute('aria-pressed', !!p.alwaysOnTop); }).catch(function () {});
    }

    document.addEventListener('click', function (e) {
      var t = e.target.closest('button, .chip'); if (!t) return;
      var d = t.dataset;
      if (d.topic != null) { q.value = TOPICS[+d.topic].q; $('#btnClear').hidden = false; S.literal = []; runSearch(true); window.scrollTo(0, 0); }
      else if (d.ask != null) { q.value = d.ask; $('#btnClear').hidden = false; S.literal = []; runSearch(true); window.scrollTo(0, 0); }
      else if (d.ctx != null) { var fo = d.focus != null ? +d.focus : undefined; if (!$('#sheet').hidden) { $('#sheet').hidden = true; } openContext(d.ctx, fo); }
      else if (d.expand != null) { S.expanded[d.expand] = true; renderResults(RES); }
      else if (d.moreGroups != null) { S.showGroups = 40; renderResults(RES); }
      else if (d.more != null) { var tx = t.previousElementSibling; tx.classList.toggle('clamp'); t.textContent = tx.classList.contains('clamp') ? 'Show more' : 'Show less'; }
      else if (d.literal != null) { S.literal = d.literal === 'all' ? true : []; if (d.literal === 'all') S.literal = (RES.interp.content || []).slice(); runSearch(false); }
      else if (d.literalWord != null) { S.literal = (S.literal || []).concat(d.literalWord); runSearch(false); }
      else if (d.sec != null) { S.sec = d.sec; $('#fSec').value = d.sec; runSearch(false); }
      else if (d.clearFilters != null) { S.req = false; S.kind = ''; S.sec = ''; $('#fReq').checked = false; $('#fKind').value = ''; $('#fSec').value = ''; runSearch(false); }
      else if (d.form != null) { q.value = d.form; $('#btnClear').hidden = false; closeLayers(); S.literal = []; runSearch(true); window.scrollTo(0, 0); }
      else if (d.copy != null) { var c = engine.chunk(+d.copy); copyText(c.t + '\n\n' + cite(c)).then(function (ok) { if (ok) { toast('Copied with page reference'); celebrate(); } }); }
      else if (d.copyProc != null) { var pp = engine.process(d.copyProc); copyText('NWC PMM ' + meta.ver + ' (' + meta.ref + ') \u2013 ' + pp.id + ' ' + pp.title + ' \u2013 p.' + pp.page).then(function () { toast('Citation copied'); }); }
      else if (d.copySaved != null) { copyText(savedList().map(function (s) { var c = engine.chunk(s.i); return c.t + '\n' + cite(c); }).join('\n\n---\n\n')).then(function () { toast('All saved items copied'); }); }
      else if (d.save != null) {
        var on = toggleSave(+d.save); $$('[data-save="' + d.save + '"]').forEach(function (b) { b.setAttribute('aria-pressed', on); var s = b.querySelector('span'); if (s) s.textContent = on ? 'Saved' : 'Save'; });
        toast(on ? 'Saved' : 'Removed from saved'); if (on) celebrate();
      }
      else if (d.unsave != null) { toggleSave(+d.unsave); openSaved(); }
      else if (d.jump != null) { var sec = $('.d-sec[data-kind="' + d.jump + '"]', $('#drawer')); if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      else if (d.close != null) closeLayers();
      else if (d.seg != null) { /* handled below */ }
      else if (t.parentElement && t.parentElement.dataset.seg) {
        var name = t.parentElement.dataset.seg, v = d.v;
        $$('button', t.parentElement).forEach(function (b) { b.setAttribute('aria-pressed', b === t); });
        if (name === 'theme' || name === 'size') { LS.set(name, v); applyPrefs(); }
        if (name === 'ai' && window.PMMLLM) { PMMLLM.setEnabled(v === '1'); paintAI(); }
        if (name === 'aimodel' && window.PMMLLM) { PMMLLM.choose(v); var nn = $('#aiModelNote'); if (nn) nn.textContent = PMMLLM.MODELS[v].label; }
        if (name === 'login' && desktop) { desktop.setPrefs({ openAtLogin: v === '1' }); desktop.prefs = Object.assign({}, desktop.prefs, { openAtLogin: v === '1' }); }
      }
      else if (d.chat != null) { openChat(S.q); }
      else if (d.installOpen != null) { openInstall(); }
      else if (d.doInstall != null) { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice.then(function () { deferredPrompt = null; refreshInstallUI(); }); } }
      else if (d.popup != null) { window.open(SITE_URL, 'pmmcoach_popup', 'popup=yes,width=480,height=780,left=80,top=60'); }
      else if (d.copyLink != null) { copyText(SITE_URL).then(function () { toast('Link copied'); }); }
      else if (d.aiLoad != null) { PMMLLM.setEnabled(true); PMMLLM.load(); paintAI(); }
      else if (d.aiRemove != null) { PMMLLM.remove().then(function () { try { localStorage.removeItem('pmmc.aiDownloaded'); } catch (e) {} toast('Downloaded model removed'); paintAI(); }); }
      else if (d.import != null) { $('#fileIdx').click(); }
      else if (d.resetIndex != null) { IDB.del('index').then(function () { location.reload(); }); }
      else if (d.wipe != null) { LS.set('recent', []); LS.set('saved', []); updateSavedCount(); toast('History and saved items cleared'); if (!RES) renderHome(); }
    });
    $('#fileIdx').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var txt = String(r.result).replace(/^\s*window\.PMM_INDEX\s*=\s*/, '').replace(/;\s*$/, ''), idx = JSON.parse(txt);
          if (!idx.chunks || !idx.chunks.length) throw new Error('not a PMM index');
          IDB.set('index', idx).then(function () { toast('Index loaded \u2013 restarting'); setTimeout(function () { location.reload(); }, 600); }, function () { toast('Could not store the index on this device'); });
        } catch (err) { toast('That file is not a PMM Coach index'); }
      };
      r.readAsText(f);
    });
  }
  function markSugg() { $$('#sugg li').forEach(function (li, i) { li.setAttribute('aria-selected', i === S.suggestIdx); if (i === S.suggestIdx) { li.scrollIntoView({ block: 'nearest' }); $('#q').setAttribute('aria-activedescendant', li.id); } }); }


  /* ---------- access code (the manual is shipped encrypted on the public site) ---------- */
  var SITE_URL = 'https://sandbox-pmo.github.io/pmm-coach/';
  function b64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  var lastEtag = '';
  function unlockWith(code) {
    var norm = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return fetch('pmm-index.enc', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('missing'); lastEtag = r.headers.get('etag') || r.headers.get('last-modified') || ''; return r.json(); }).then(function (enc) {
      return crypto.subtle.importKey('raw', new TextEncoder().encode(norm), 'PBKDF2', false, ['deriveKey'])
        .then(function (km) { return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']); })
        .then(function (key) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv), additionalData: new TextEncoder().encode('pmm-coach-v1') }, key, b64(enc.data)); })
        .then(function (plain) { return new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); })
        .then(function (txt) { return JSON.parse(txt); });
    });
  }
  function codeFromLink() { var m = /[#&]k=([A-Za-z0-9\-]+)/.exec(location.hash || ''); return m ? m[1] : ''; }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function showUnlock(msg) {
    S.locked = true; $('#searchForm').style.display = 'none'; setState('home');
    $('#home').innerHTML = '<div class="unlock"><h2>Welcome to PMM Coach</h2><p>Enter the access code from your PMO team. You only need to do this once on this device.</p>' +
      '<form id="unlockForm" autocomplete="off"><label class="sr" for="codeIn">Access code</label><input id="codeIn" type="text" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="19">' +
      '<button class="btn primary" type="submit">Unlock</button></form><p class="unlock-msg" id="unlockMsg" role="alert">' + esc(msg || '') + '</p>' +
      '<p class="note">Have an index file instead? <button type="button" class="linkbtn" data-import>Choose file</button></p></div>';
    setPose('welcome', 'Welcome! I just need your access code once.');
    $('#unlockForm').addEventListener('submit', function (e) { e.preventDefault(); var v = $('#codeIn').value; if (v.replace(/[^A-Za-z0-9]/g, '').length < 12) { $('#unlockMsg').textContent = 'The code has 12 letters and numbers.'; return; } doUnlock(v); });
    bind();
  }
  function doUnlock(code) {
    var m = $('#unlockMsg'); if (m) m.textContent = 'Unlocking\u2026'; setPose('thinking', 'Let me check that.');
    unlockWith(code).then(function (idx) {
      if (!idx || !idx.chunks) throw new Error('bad');
      return IDB.set('index', idx).catch(function () {}).then(function () { return IDB.set('access', { code: code, etag: lastEtag }).catch(function () {}); }).then(function () {
        if (!isIOS()) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
        S.locked = false; $('#searchForm').style.display = ''; start(idx, true);
      });
    }).catch(function () { showUnlock('That code did not work. Check it and try again, or ask your PMO team for the link.'); setPose('encourage', 'Let\u2019s try that again.'); });
  }

  /* ---------- install (Android, iPhone, Windows) ---------- */
  var deferredPrompt = null;
  function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true || !!window.pmmDesktop || !!window.Capacitor; }
  function platform() { var ua = navigator.userAgent; if (isIOS()) return 'ios'; if (/Android/.test(ua)) return 'android'; if (/Windows/.test(ua)) return 'windows'; return 'other'; }
  function refreshInstallUI() { var b = $('#btnInstall'); if (b) b.hidden = isStandalone(); var t = $('#installTile'); if (t) t.hidden = isStandalone(); }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; refreshInstallUI(); });
  window.addEventListener('appinstalled', function () { deferredPrompt = null; refreshInstallUI(); toast('PMM Coach installed'); closeLayers(); });
  function steps(list) { return '<ol class="steps">' + list.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>'; }
  function openInstall() {
    var p = platform(), btn = deferredPrompt ? '<p><button class="btn primary" type="button" data-do-install>Install PMM Coach</button></p>' : '';
    var ios = steps(['Open this page in <b>Safari</b> (not inside another app).', 'Tap the <b>Share</b> button (the square with an arrow).', 'Scroll and tap <b>Add to Home Screen</b>, then <b>Add</b>.', 'Open PMM Coach from your home screen. The first time, use the private link from your PMO team so it unlocks.']);
    var and = steps(['Open this page in <b>Chrome</b>.', 'Tap the menu <b>\u22ee</b>, then <b>Install app</b> (or <b>Add to Home screen</b>).', 'Tap <b>Install</b>. PMM Coach appears with your other apps.']);
    var win = steps(['Open this page in <b>Microsoft Edge</b> or Chrome.', 'Edge: menu <b>\u2026</b> &gt; <b>Apps</b> &gt; <b>Install this site as an app</b>. Chrome: menu <b>\u22ee</b> &gt; <b>Cast, save and share</b> &gt; <b>Install page as app</b>.', 'Tick <b>Pin to taskbar</b> when asked. PMM Coach then opens in its own window from the taskbar.']);
    function block(id, title, body) { return '<details class="inst"' + (p === id ? ' open' : '') + '><summary>' + title + '</summary>' + body + '</details>'; }
    var h = '<div class="d-head"><h2 id="sheetTitle">Install PMM Coach</h2><button class="icon-btn close" type="button" data-close aria-label="Close">' + ico('close') + '</button></div><div class="d-body">' +
      '<div class="inst-hero"><img src="img/icon-192.png" alt=""><p>Put the Coach on your phone or taskbar for one-tap access. It also works offline.</p></div>' + btn +
      block('android', 'Android', and) + block('ios', 'iPhone and iPad', ios) + block('windows', 'Windows computer', win +
        '<p><button class="btn" type="button" data-popup>Open as a popup window now</button></p>') +
      '<div class="inst-share"><img src="img/qr.png" alt="QR code for the PMM Coach link" width="132" height="132"><div><b>Share the app</b><p class="note" style="margin:.2rem 0">Scan to open on a phone, or send this link:</p><button type="button" class="linkbtn" data-copy-link>' + esc(SITE_URL) + '</button></div></div></div>';
    openLayer('#sheet', h);
  }

  /* ---------- the coach is always moving: gentle idle poses on the home screen ---------- */
  var IDLE = [['welcome', 'How can I help you today?'], ['explaining', 'Try: how many stage gates are there?'], ['success', 'Typos and word order are fine. I\u2019ll find it.'], ['listening', 'I\u2019m listening. Ask me anything about the PMM.']], idleI = 0;
  function startIdle() {
    setInterval(function () {
      if (document.hidden || S.locked || $('#shell').dataset.state !== 'home' || document.activeElement === $('#q') || !$('#sheet').hidden || !$('#drawer').hidden) return;
      idleI = (idleI + 1) % IDLE.length; setPose(IDLE[idleI][0], IDLE[idleI][1]);
    }, 4600);
  }

  /* ---------- boot ---------- */
  function noIndex() {
    $('#home').innerHTML = '<div class="empty"><h3>Load the PMM to get started</h3><p>This copy of PMM Coach was installed without the manual\u2019s content. Ask your PMO team for the PMM index file (pmm-index.json), then choose it below.</p><p><button class="btn primary" type="button" data-import>Choose index file</button></p></div>';
    $('#searchForm').style.display = 'none'; setPose('encourage', 'Let\u2019s make progress together! I just need the PMM index first.');
    bind();
  }
  function start(index, imported) {
    S.imported = imported;
    engine = PMMEngine.create(index); meta = engine.meta();
    var sel = $('#fSec'); engine.sections().forEach(function (s) { var o = document.createElement('option'); o.value = s.n; o.textContent = s.n + '. ' + s.title.replace(/^Project /, ''); sel.appendChild(o); });
    bind(); updateSavedCount(); setState('home'); renderHome();
    if (window.PMMLLM) {
      PMMLLM.on(function (st) { if (st.phase === 'ready') { try { localStorage.setItem('pmmc.aiDownloaded', '1'); } catch (e) {} } paintAI(); });
      var was = false; try { was = localStorage.getItem('pmmc.aiDownloaded') === '1'; } catch (e) {}
      if (PMMLLM.enabled() && was) PMMLLM.load();
    }
    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch(function () {});
    var url = new URLSearchParams(location.search).get('q'); if (url) { $('#q').value = url; $('#btnClear').hidden = false; runSearch(true); }
  }

  /* a newer encrypted manual was published: fetch it quietly (the code stays on this device only) */
  function checkUpdate(linkCode) {
    IDB.get('access').then(function (acc) {
      var code = (acc && acc.code) || linkCode; if (!code) return;
      return fetch('pmm-index.enc', { method: 'HEAD', cache: 'no-cache' }).then(function (r) {
        var e = r.headers.get('etag') || r.headers.get('last-modified') || ''; if (!r.ok || !e) return;
        if (acc && acc.etag === e) return;
        if (sessionStorage.getItem('pmmc.upd') === e) return;      // never loop
        sessionStorage.setItem('pmmc.upd', e);
        return unlockWith(code).then(function (idx) {
          if (!idx || !idx.chunks) return;
          return IDB.set('index', idx).then(function () { return IDB.set('access', { code: code, etag: lastEtag }); }).then(function () {
            toast('Manual updated'); setTimeout(function () { if (!isIOS()) { try { history.replaceState(null, '', location.pathname + location.search); } catch (x) {} } location.reload(); }, 900);
          });
        });
      });
    }).catch(function () {});
  }

  function afterStart() {
    refreshInstallUI(); startIdle();
    var qs = new URLSearchParams(location.search);
    if (qs.get('chat')) openChat('');
    if (qs.get('focus')) $('#q').focus();
    if (location.hash === '#install') openInstall();
    // installed desktop window: open at a compact "assistant" size once
    if (window.matchMedia && matchMedia('(display-mode: standalone)').matches && !window.pmmDesktop && !window.Capacitor && !(matchMedia('(pointer:coarse)').matches) && !LS.get('sized', false)) {
      try { window.resizeTo(480, 780); } catch (e) {} LS.set('sized', true);
    }
  }
  function boot() {
    applyPrefs();
    if (desktop && desktop.getPrefs) desktop.getPrefs().then(function (p) { desktop.prefs = p; }).catch(function () {});
    IDB.get('index').then(function (idx) {
      // a copy built into the app (Android/desktop) wins over an older stored copy
      var stamp = function (x) { return (x && x.meta && (x.meta.updated || x.meta.built)) || ''; };
      if (idx && idx.chunks && window.PMM_INDEX && stamp(window.PMM_INDEX) > stamp(idx)) idx = null;
      if (idx && idx.chunks) { start(idx, true); afterStart(); checkUpdate(codeFromLink()); return; }
      if (window.PMM_INDEX) { start(window.PMM_INDEX, false); afterStart(); return; }
      fetch('pmm-index.enc', { method: 'HEAD' }).then(function (r) {
        if (!r.ok) throw new Error('none');
        var code = codeFromLink();
        if (code) doUnlock(code); else showUnlock();
        afterStart();
      }).catch(function () { noIndex(); afterStart(); });
    });
  }
  boot();
})();
