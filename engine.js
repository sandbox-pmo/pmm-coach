/*  PMM Coach – search engine
 *  Offline, dependency-free. Works in browsers, Electron, mobile web-views and Node.
 *
 *  What it does
 *   - understands each word as a "concept": exact match, light stemming, acronym expansion,
 *     typo repair (edit distance incl. swapped letters), joined/split words, and a small
 *     project-management synonym set
 *   - ranks requirement text by weighted BM25 across the text, the heading and the process title,
 *     rewards chunks that cover more of the concepts, and rewards words that sit close together or
 *     in the same order - but never requires that order
 *   - groups hits into PMM processes so a "collection of requirements" comes back together
 *   - explains how it read the query (corrections, expansions, intent) so the user can verify it
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PMMEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STOP = new Set(('a an the of to in on for and or is are was were be been being am do does did doing what which ' +
    'how i we you it its this that these those with by as at from my our me us can could would will shall should ' +
    'about into than then there their they them he she his her if so not no any all some please tell show give find ' +
    'need want like get got have has had having need needs also just very more most other such via per etc').split(' '));
  // words that describe what the user wants rather than the topic itself
  var INTENT_WORDS = new Set(['who', 'whom', 'whose', 'when', 'how', 'requirement', 'requirements', 'required', 'require',
    'requires', 'mandatory', 'must', 'shall', 'steps', 'step', 'responsible', 'responsibility', 'responsibilities',
    'obligation', 'obligations', 'rule', 'rules', 'policy', 'policies', 'often', 'frequently', 'long']);
  var KEEP_SHORT = new Set(['ve', 'qa', 'qc', 'pm', 'wbs', 'ncr', 'rfi', 'hse', 'ehs', 'eia', 'vo', 'cr', 'ca']);

  // domain acronyms that the PMM text does not spell out in brackets
  var EXTRA_ACR = {
    QA: 'Quality Assurance', QC: 'Quality Control', HSE: 'Health Safety and Environment', EHS: 'Health Safety and Environment',
    RFI: 'Request for Information', KPI: 'Key Performance Indicator', SOW: 'Scope of Work', PM: 'Project Manager',
    IAC: 'Initial Acceptance Certificate', FAC: 'Final Acceptance Certificate', EOT: 'Extension of Time',
    CR: 'Change Request', BOQ: 'Bill of Quantities', EVM: 'Earned Value Management', SPI: 'Schedule Performance Index',
    CPI: 'Cost Performance Index', RACI: 'Responsible Accountable Consulted Informed', PMIS: 'Project Management Information System',
    PMF: 'Project Management Form', MOF: 'Ministry of Finance', GRC: 'Governance Risk and Compliance', SLA: 'Service Level Agreement',
    NOC: 'No Objection Certificate', DBB: 'Design Bid Build', EPC: 'Engineering Procurement Construction', LL: 'Lessons Learned',
    PMO: 'Project Management Office', SGR: 'Stage Gate Review', PLC: 'Project Life Cycle', CPPP: 'Capital Projects Portfolio Plan'
  };

  // loose concept groups: each group is treated as "about the same thing" at a lower weight
  var SYN_GROUPS = [
    ['approve', 'approval', 'authorize', 'authorise', 'endorse', 'signoff', 'sanction'],
    ['delay', 'late', 'slippage', 'overrun', 'behind'],
    ['cost', 'budget', 'expense', 'spend', 'expenditure'],
    ['schedule', 'programme', 'program', 'timeline', 'baseline'],
    ['change', 'variation', 'amendment', 'modification'],
    ['close', 'closure', 'closeout', 'completion', 'closing'],
    ['handover', 'turnover', 'takeover', 'handing'],
    ['kickoff', 'kick'],
    ['training', 'competence', 'competency', 'capability', 'skill'],
    ['safety', 'hse', 'ehs', 'hazard'],
    ['environment', 'environmental', 'eia'],
    ['report', 'reporting', 'status', 'progress'],
    ['submittal', 'submission', 'submit'],
    ['claim', 'dispute'],
    ['stakeholder', 'party', 'parties'],
    ['audit', 'inspection', 'review', 'assessment'],
    ['lesson', 'knowledge', 'experience'],
    ['contractor', 'vendor', 'supplier', 'bidder'],
    ['consultant', 'supervisor', 'engineer'],
    ['document', 'record', 'file', 'documentation'],
    ['meeting', 'workshop', 'session'],
    ['mitigate', 'mitigation', 'response', 'treatment'],
    ['issue', 'problem', 'concern'],
    ['test', 'testing', 'commissioning', 'trial'],
    ['plan', 'planning', 'strategy'],
    ['deadline', 'duration', 'timeframe', 'period']
  ];

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019\u201c\u201d]/g, "'");
  }

  var IRREG = { analyses: 'analysi', analysis: 'analysi', processes: 'process', policies: 'polici', policy: 'polici',
    data: 'data', criteria: 'criteri', criterion: 'criteri', matrices: 'matrix', matrix: 'matrix', indices: 'index' };

  function stem(w) {
    if (!w) return w;
    if (IRREG[w]) return IRREG[w];
    if (w.length <= 3 || /^\d/.test(w)) return w;
    if (w.length > 4 && w.slice(-3) === 'ies') w = w.slice(0, -3) + 'y';
    else if (w.slice(-4) === 'sses') w = w.slice(0, -2);
    else if (/(ss|us|is)$/.test(w)) { /* keep */ }
    else if (w.slice(-1) === 's') w = w.slice(0, -1);
    var sfx = ['ational', 'ations', 'ation', 'ators', 'ator', 'ments', 'ment', 'ingly', 'ings', 'ing', 'ions', 'ion',
      'ities', 'ity', 'ness', 'ables', 'able', 'ibles', 'ible', 'ives', 'ive', 'ally', 'edly', 'ed', 'ers', 'er', 'ly', 'al'];
    for (var i = 0; i < sfx.length; i++) {
      var s = sfx[i];
      if (w.length - s.length >= 4 && w.slice(-s.length) === s) { w = w.slice(0, -s.length); break; }
    }
    if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 4 && w.slice(-1) === 'e') w = w.slice(0, -1);
    w = w.replace(/ific$/, 'if').replace(/ify$/, 'if');
    return w;
  }

  function words(s) { return norm(s).replace(/\b([a-z])\s?&\s?([a-z])\b/g, '$1$2').match(/[a-z0-9]+/g) || []; }
  function contentStems(s) {
    var out = [], ws = words(s);
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (STOP.has(w)) continue;
      if (w.length < 2 && !/\d/.test(w)) continue;
      out.push(stem(w));
    }
    return out;
  }

  // Damerau-Levenshtein (optimal string alignment) with an early cut-off
  function dl(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i; var rowMin = i;
      for (j = 1; j <= lb; j++) {
        var c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1))
          v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur; cur = new Array(lb + 1);
    }
    return prev[lb];
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ------------------------------------------------------------------ */
  function create(index) {
    var t0 = Date.now();
    var chunks = index.chunks, N = chunks.length;
    var procById = {}, secTitle = {};
    (index.sections || []).forEach(function (s) { secTitle[s.n] = s.title; });
    (index.processes || []).forEach(function (p) { procById[p.id] = p; });
    function procOf(c) {
      if (c.pr && procById[c.pr]) return procById[c.pr];
      var id = 'SEC-' + c.s;
      if (!procById[id]) procById[id] = { id: id, sec: c.s, abbr: '', title: (secTitle[c.s] || 'General') + ' (general)', num: String(c.s), page: c.p, pseudo: true };
      return procById[id];
    }

    // acronym dictionary: PMM-derived first, then extras
    var acr = {};
    Object.keys(index.acr || {}).forEach(function (k) { acr[norm(k).replace(/[^a-z0-9]/g, '')] = { a: k, f: index.acr[k] }; });
    Object.keys(EXTRA_ACR).forEach(function (k) { var n = norm(k); if (!acr[n]) acr[n] = { a: k, f: EXTRA_ACR[k] }; });

    // ---- inverted index ---------------------------------------------------
    var vocab = new Map(), terms = [], surface = [], posting = [], df = [];
    function tid(st, raw) {
      var id = vocab.get(st);
      if (id === undefined) { id = terms.length; vocab.set(st, id); terms.push(st); surface.push({}); posting.push([]); df.push(0); }
      if (raw) surface[id][raw] = (surface[id][raw] || 0) + 1;
      return id;
    }
    var docToks = new Array(N), docLen = new Float32Array(N), avgLen = 0, procTok = {};
    var i, j;
    for (i = 0; i < N; i++) {
      var c = chunks[i], p = procOf(c);
      var body = [], ws = words(c.t);
      for (j = 0; j < ws.length; j++) {
        var w = ws[j];
        if (STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
        body.push(tid(stem(w), w));
      }
      docToks[i] = Int32Array.from(body); docLen[i] = body.length; avgLen += body.length;
      var tf = new Map();
      body.forEach(function (t) { tf.set(t, (tf.get(t) || 0) + 1); });
      var hw = contentStems((c.h || '').replace(/^\d+(\.\d+)*\s+/, '') + ' ' + (p.pseudo ? '' : p.title));
      hw.forEach(function (s) { var t = tid(s, null); tf.set(t, (tf.get(t) || 0) + 2.2); });
      tf.forEach(function (v, t) { posting[t].push(i, v); df[t]++; });
    }
    avgLen /= Math.max(N, 1);
    var V = terms.length;
    var bestSurface = terms.map(function (_, t) {
      var m = surface[t], b = null, n = -1; for (var k in m) if (m[k] > n) { n = m[k]; b = k; } return b || terms[t];
    });
    function idf(t) { return Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)); }

    // per-process search aids (title tokens)
    var procList = Object.keys(procById).map(function (k) { return procById[k]; });
    procList.forEach(function (p) { procTok[p.id] = contentStems(p.title); });
    var byProc = {};
    chunks.forEach(function (c, ix) { var id = procOf(c).id; (byProc[id] = byProc[id] || []).push(ix); });

    // ---- word resolution ----------------------------------------------------
    function maxEdits(n) { return n <= 3 ? 0 : n <= 5 ? 1 : 2; }

    function fuzzy(raw, st, isLast) {
      var out = [], md = maxEdits(raw.length >= 4 ? raw.length : st.length), t, k;
      if (md > 0) {
        // pass 1: the typed word against every written form found in the PMM
        for (t = 0; t < V; t++) {
          var best = 9, forms = surface[t];
          for (k in forms) {
            if (Math.abs(k.length - raw.length) > md) continue;
            var d1 = dl(raw, k, md);
            if (d1 < best) best = d1;
          }
          if (best <= md && !(best === 2 && raw.charAt(0) !== bestSurface[t].charAt(0)))
            out.push({ t: t, d: best, w: 1 - 0.22 * best, via: 'typo' });
        }
        // pass 2 (fallback): stems against stems, slightly penalised
        if (!out.length) {
          for (t = 0; t < V; t++) {
            var ts = terms[t];
            if (Math.abs(ts.length - st.length) > md) continue;
            var d2 = dl(st, ts, md);
            if (d2 <= md && !(d2 === 2 && st.charAt(0) !== ts.charAt(0))) out.push({ t: t, d: d2 + 0.4, w: 1 - 0.22 * d2 - 0.1, via: 'typo' });
          }
        }
      }
      if (st.length >= 3 && (isLast || !out.length)) {
        for (var t2 = 0; t2 < V; t2++) {
          if (terms[t2] !== st && terms[t2].indexOf(st) === 0 && df[t2] >= 2)
            out.push({ t: t2, d: 0.5, w: isLast ? 0.82 : 0.6, via: 'prefix' });
        }
      }
      out.sort(function (a, b) { return (a.d - b.d) || (df[b.t] - df[a.t]); });
      var seen = {}, res = [];
      out.forEach(function (o) { if (!seen[o.t] && res.length < 4) { seen[o.t] = 1; res.push(o); } });
      return res;
    }

    function splitWord(raw) {
      if (raw.length < 6) return null;
      var best = null;
      for (var k = 3; k <= raw.length - 3; k++) {
        var a = raw.slice(0, k), b = raw.slice(k), sa = vocab.get(stem(a)), sb = vocab.get(stem(b));
        if (sa !== undefined && sb !== undefined && df[sa] > 1 && df[sb] > 1) {
          var sc = Math.min(df[sa], df[sb]);
          if (!best || sc > best.sc) best = { a: a, b: b, ta: sa, tb: sb, sc: sc };
        }
      }
      return best;
    }

    function synonymsFor(raw, st) {
      var res = [];
      SYN_GROUPS.forEach(function (g) {
        if (g.indexOf(raw) >= 0 || g.some(function (x) { return stem(x) === st; })) {
          g.forEach(function (x) { var s2 = stem(x); if (s2 !== st && vocab.has(s2)) res.push(s2); });
        }
      });
      return res;
    }

    /* Interpret a query: returns concepts with alternatives */
    function interpret(q, literal) {
      var rawWords = norm(q).match(/[a-z0-9&]+/g) || [];
      var concepts = [], notes = [], intents = [], expansions = [], corrections = [];
      var toks = [];
      rawWords.forEach(function (w) { toks.push(w); });
      // intent from the whole sentence
      var nq = ' ' + norm(q) + ' ';
      if (/\b(who|whom|whose|responsible|responsibility|owner|accountable|approver|approves?)\b/.test(nq)) intents.push('who');
      if (/\b(when|deadline|timeline|frequency|how often|within|how long|time limit|monthly|weekly|quarterly|annually)\b/.test(nq)) intents.push('when');
      if (/\b(requirements?|required|mandatory|must|shall|obligation|compliance|comply)\b/.test(nq)) intents.push('req');
      if (/\b(polic(y|ies)|rules?)\b/.test(nq)) intents.push('policy');
      if (/\b(how|steps?|procedure|workflow|process flow)\b/.test(nq)) intents.push('how');
      if (/\b(forms?|templates?|checklists?)\b/.test(nq)) intents.push('form');
      if (/\b(objectives?|purpose|goals?|aim)\b/.test(nq)) intents.push('objective');
      if (/\b(what is|what does|stands for|meaning of|define|definition)\b/.test(nq)) intents.push('define');

      var content = toks.filter(function (w) { return !STOP.has(w); });
      var nonIntent = content.filter(function (w) { return !INTENT_WORDS.has(w); });
      var useIntentAsWord = nonIntent.length === 0;

      var qi = 0;
      content.forEach(function (w, idx) {
        if (!useIntentAsWord && INTENT_WORDS.has(w)) return;
        var clean = w.replace(/&/g, '');
        var isLast = idx === content.length - 1;
        var concept = { raw: w, alts: [], status: 'none', note: '' };
        var lit = literal === true || (Array.isArray(literal) && literal.indexOf(w) >= 0);
        // acronym (typed as the acronym itself, e.g. NCR or O&M)
        var ac = lit ? null : acr[clean];
        if (ac && (clean.length >= 2)) {
          var phr = contentStems(ac.f);
          concept.alts.push({ stems: phr.map(function (s) { return vocab.get(s); }).filter(function (x) { return x !== undefined; }), w: 0.92, via: 'acronym', label: ac.f });
          expansions.push({ from: ac.a, to: ac.f });
          concept.status = 'acronym';
        }
        var st = stem(clean), t = vocab.get(st);
        if (t !== undefined) {
          concept.alts.push({ stems: [t], w: 1, via: 'exact' }); if (concept.status !== 'acronym') concept.status = 'exact';
          if (!ac && !lit) synonymsFor(clean, st).slice(0, 5).forEach(function (s2) { concept.alts.push({ stems: [vocab.get(s2)], w: 0.5, via: 'synonym' }); });
          // when typing the last word, also allow completion
          if (!lit && isLast && clean.length >= 3) fuzzy(clean, st, true).filter(function (c) { return c.via === 'prefix' && df[c.t] >= 3; }).slice(0, 2)
            .forEach(function (c) { concept.alts.push({ stems: [c.t], w: 0.55, via: 'prefix' }); });
        } else if (lit) {
          notes.push(clean);
        } else {
          var f = fuzzy(clean, st, isLast);
          var typo = f.filter(function (x) { return x.via === 'typo'; });
          var pref = f.filter(function (x) { return x.via === 'prefix'; });
          if (typo.length) {
            concept.status = 'typo';
            typo.slice(0, 3).forEach(function (c) { concept.alts.push({ stems: [c.t], w: c.w, via: 'typo' }); });
            corrections.push({ from: clean, to: bestSurface[typo[0].t] });
          } else if (pref.length) {
            concept.status = 'prefix';
            pref.slice(0, 3).forEach(function (c) { concept.alts.push({ stems: [c.t], w: c.w, via: 'prefix' }); });
          } else {
            var sp = splitWord(clean);
            if (sp) {
              concept.status = 'split';
              concept.alts.push({ stems: [sp.ta, sp.tb], w: 0.95, via: 'split', label: sp.a + ' ' + sp.b });
              corrections.push({ from: clean, to: sp.a + ' ' + sp.b });
            }
          }
          if (concept.status === 'none' && !concept.alts.length) notes.push(clean);
        }
        if (concept.alts.length) concepts.push(concept);
        else if (!ac) concept.status = 'none', concepts.push(concept);
        qi++;
      });

      // joined words: "non conformance" -> nonconformance, "work break down"
      for (var k = 0; k < content.length - 1; k++) {
        var joined = content[k] + content[k + 1], tj = vocab.get(stem(joined));
        if (tj !== undefined && df[tj] >= 2) {
          concepts.forEach(function (cn) {
            if (cn.raw === content[k] || cn.raw === content[k + 1]) cn.alts.push({ stems: [tj], w: 0.7, via: 'joined' });
          });
        }
      }
      concepts = concepts.filter(function (cn) { return cn.alts.length; });
      return { concepts: concepts, unknown: notes, intents: intents, expansions: expansions, corrections: corrections, content: content };
    }

    /* ---- direct references: codes, section numbers, pages ---- */
    function directLookup(q) {
      var n = norm(q).trim(), m;
      var found = null;
      if ((m = n.match(/^pmm[\s-]*(\d{3})[\s-]*([a-z]{3})[\s-]*(\d{3})$/))) {
        var code = ('PMM-' + m[1] + '-' + m[2] + '-' + m[3]).toUpperCase();
        found = procList.filter(function (p) { return p.id === code; });
      } else if ((m = n.match(/^(?:pmm[\s-]*)?([a-z]{3})[\s-]*(\d{3})$/)) && index.abbr && index.abbr[m[1].toUpperCase()]) {
        found = procList.filter(function (p) { return p.abbr.toLowerCase() === m[1] && p.id.slice(-3) === m[2]; });
      }
      if (found && found.length) return { kind: 'process', label: 'Process ' + found[0].id, ids: [found[0].id] };
      if ((m = n.match(/^pmf[\s-]*(\d{3})[\s-]*([a-z]{3})[\s-]*(\d{3})(?:_\d{2})?$/))) {
        var fc = ('PMF-' + m[1] + '-' + m[2] + '-' + m[3]).toUpperCase();
        var idxs = [];
        chunks.forEach(function (c, ix) { if (c.f && c.f.some(function (x) { return x.indexOf(fc) === 0; })) idxs.push(ix); });
        if (idxs.length) return { kind: 'form', label: 'Form ' + fc + (index.forms && index.forms[fc] ? ' - ' + index.forms[fc] : ''), chunks: idxs };
      }
      if ((m = n.match(/^(?:section\s+|clause\s+|§\s*)?(\d{1,2}(?:\.\d{1,3}){1,5})$/))) {
        var num = m[1], idxs2 = [];
        chunks.forEach(function (c, ix) { if (c.h && (c.h.indexOf(num + ' ') === 0)) idxs2.push(ix); });
        if (!idxs2.length) chunks.forEach(function (c, ix) { if (c.h && c.h.indexOf(num + '.') === 0) idxs2.push(ix); });
        if (idxs2.length) return { kind: 'section', label: 'Section ' + num, chunks: idxs2 };
      }
      if ((m = n.match(/^(?:page|pg|p)\.?\s*(\d{1,3})$/))) {
        var pg = parseInt(m[1], 10), idxs3 = [];
        chunks.forEach(function (c, ix) { if (c.p === pg) idxs3.push(ix); });
        if (idxs3.length) return { kind: 'page', label: 'Page ' + pg, chunks: idxs3 };
      }
      return null;
    }

    /* ---- scoring ---- */
    var K1 = 1.2, B = 0.72;
    function bm(tfw, ix) { return tfw * (K1 + 1) / (tfw + K1 * (1 - B + B * docLen[ix] / avgLen)); }

    var RX_WHO = /(responsible|accountable|owner|approv|manager|director|committee|engineer|head)/i;
    var RX_WHEN = /\b(\d+\s*(?:calendar |working |business )?(?:days?|weeks?|months?|hours?)|monthly|weekly|quarterly|annual|daily|within|prior to|before|deadline)\b/i;

    function search(query, opts) {
      opts = opts || {};
      var t1 = Date.now();
      var res = { query: query, groups: [], interp: null, total: 0, took: 0, confidence: 'none', direct: null, hl: [], suggestions: [] };
      if (!norm(query).trim()) return res;

      var dir = directLookup(query);
      if (dir) {
        res.direct = dir; res.confidence = 'high';
        var ids = dir.ids ? (byProc[dir.ids[0]] || []) : dir.chunks;
        res.interp = { concepts: [], unknown: [], intents: [], expansions: [], corrections: [], direct: dir.label };
        res.groups = groupize(ids.map(function (ix) { return { i: ix, score: 1, cov: 1, matched: [], missing: [] }; }), true, null);
        res.total = ids.length; res.took = Date.now() - t1; return res;
      }

      var it = interpret(query, opts.literal);
      var C = it.concepts, nC = C.length;
      res.interp = it;
      if (!nC) { res.took = Date.now() - t1; res.confidence = 'none'; return res; }

      var total = new Map(), matchedBy = new Map(), hl = new Set();
      var cMatchPerChunk = [];
      C.forEach(function (cn, ci) {
        var best = new Map();
        cn.alts.forEach(function (alt) {
          alt.stems.forEach(function (t) { if (cn.status !== 'none') hl.add(terms[t]); });
          var acc = new Map(), cnt = new Map();
          alt.stems.forEach(function (t) {
            var pl = posting[t], iw = idf(t);
            for (var p = 0; p < pl.length; p += 2) {
              var ix = pl[p];
              acc.set(ix, (acc.get(ix) || 0) + iw * bm(pl[p + 1], ix));
              cnt.set(ix, (cnt.get(ix) || 0) + 1);
            }
          });
          var need = alt.stems.length <= 1 ? 1 : Math.ceil(alt.stems.length * 0.67), norm_ = Math.sqrt(Math.max(alt.stems.length, 1));
          acc.forEach(function (v, ix) {
            if (cnt.get(ix) < need) return;
            var val = alt.w * v / norm_;
            if (!best.has(ix) || best.get(ix) < val) best.set(ix, val);
          });
        });
        best.forEach(function (v, ix) {
          total.set(ix, (total.get(ix) || 0) + v);
          var arr = matchedBy.get(ix); if (!arr) { arr = []; matchedBy.set(ix, arr); } arr.push(ci);
        });
      });
      res.hl = Array.from(hl);

      var intents = it.intents;
      var cand = [];
      total.forEach(function (v, ix) {
        var m = matchedBy.get(ix), cov = m.length / nC;
        var s = v * (0.35 + 0.65 * cov * cov);
        var c = chunks[ix];
        if (intents.indexOf('req') >= 0 || intents.indexOf('policy') >= 0) { if (c.r) s *= 1.12; if (c.k === 'Policy') s *= 1.18; }
        if (intents.indexOf('objective') >= 0 && c.k === 'Objective') s *= 1.35;
        if (intents.indexOf('define') >= 0 && c.k === 'Objective') s *= 1.15;
        if (intents.indexOf('form') >= 0 && (c.f.length || c.k === 'Forms')) s *= 1.3;
        if (intents.indexOf('how') >= 0 && (c.k === 'Procedure' || c.k === 'Workflow')) s *= 1.15;
        if (intents.indexOf('who') >= 0 && RX_WHO.test(c.t)) s *= 1.15;
        if (intents.indexOf('when') >= 0 && RX_WHEN.test(c.t)) s *= 1.15;
        if (c.k === 'Workflow') s *= 0.7;
        cand.push({ i: ix, score: s, cov: cov, m: m });
      });
      cand.sort(function (a, b) { return b.score - a.score; });
      cand = cand.slice(0, 160);

      // proximity & order bonus for the best candidates
      if (nC > 1) {
        cand.slice(0, 80).forEach(function (cd) {
          if (cd.m.length < 2) return;
          var toks = docToks[cd.i], pos = [];
          for (var p = 0; p < toks.length; p++) {
            for (var q = 0; q < cd.m.length; q++) {
              var alts = C[cd.m[q]].alts, hit = false;
              for (var a = 0; a < alts.length && !hit; a++) if (alts[a].stems.indexOf(toks[p]) >= 0 && alts[a].w >= 0.5) hit = true;
              if (hit) pos.push([p, cd.m[q]]);
            }
          }
          var need = cd.m.length, cntc = {}, have = 0, lo = 0, bestSpan = 1e9;
          for (var hi = 0; hi < pos.length; hi++) {
            if (!cntc[pos[hi][1]]) have++; cntc[pos[hi][1]] = (cntc[pos[hi][1]] || 0) + 1;
            while (have === need) {
              bestSpan = Math.min(bestSpan, pos[hi][0] - pos[lo][0] + 1);
              cntc[pos[lo][1]]--; if (!cntc[pos[lo][1]]) have--; lo++;
            }
          }
          if (bestSpan < 1e9) {
            cd.score *= 1 + 0.45 / (1 + Math.max(bestSpan - need, 0) / 4);
            if (bestSpan === need) cd.score *= 1.08;
          }
        });
        cand.sort(function (a, b) { return b.score - a.score; });
      }

      if (opts.requirementsOnly) cand = cand.filter(function (c) { return chunks[c.i].r; });
      if (opts.section) cand = cand.filter(function (c) { return chunks[c.i].s === opts.section; });
      if (opts.process) cand = cand.filter(function (c) { return procOf(chunks[c.i]).id === opts.process; });
      if (opts.kind) cand = cand.filter(function (c) { return chunks[c.i].k === opts.kind; });

      var top = cand.length ? cand[0].score : 0;
      cand = cand.filter(function (c) { return c.score >= top * 0.22; });
      var items = cand.map(function (c) {
        return { i: c.i, score: c.score, cov: c.cov,
          matched: c.m.map(function (ci) { return C[ci].raw; }),
          missing: C.map(function (cn, ci) { return c.m.indexOf(ci) < 0 ? cn.raw : null; }).filter(Boolean) };
      });
      res.total = items.length;
      res.groups = groupize(items, false, C);
      var lead = items[0];
      var allExact = C.every(function (cn) { return cn.status === 'exact' || cn.status === 'typo' || cn.status === 'split' || cn.status === 'acronym'; });
      res.confidence = !lead ? 'none' : (lead.cov === 1 && allExact && it.unknown.length === 0) ? 'high' : lead.cov >= 0.5 ? 'medium' : 'low';
      res.took = Date.now() - t1;
      return res;
    }

    function groupize(items, keepOrder, C) {
      var g = {}, order = [];
      items.forEach(function (it) {
        var p = procOf(chunks[it.i]);
        if (!g[p.id]) { g[p.id] = { id: p.id, title: p.title, section: p.sec, sectionTitle: secTitle[p.sec] || '', page: p.page, pseudo: !!p.pseudo, num: p.num, items: [], score: 0 }; order.push(p.id); }
        g[p.id].items.push(it);
      });
      var out = order.map(function (id) {
        var gr = g[id]; gr.count = gr.items.length;
        if (!keepOrder) {
          gr.items.sort(function (a, b) { return b.score - a.score; });
          var s = gr.items.map(function (x) { return x.score; });
          var tb = 0;
          if (C) {
            var tt = procTok[id] || [], hit = 0;
            C.forEach(function (cn) { if (cn.alts.some(function (a) { return a.stems.every(function (t) { return tt.indexOf(terms[t]) >= 0; }); })) hit++; });
            tb = (hit / C.length) * s[0] * 0.5;
          }
          gr.score = s[0] + 0.3 * (s[1] || 0) + 0.15 * (s[2] || 0) + tb;
          gr.coverage = gr.items[0].cov;
        } else { gr.score = 1; gr.items.sort(function (a, b) { return a.i - b.i; }); }
        return gr;
      });
      if (!keepOrder) out.sort(function (a, b) { return b.score - a.score; });
      return out;
    }

    /* ---- autocomplete ---- */
    function suggest(query, limit) {
      limit = limit || 6;
      var q = norm(query).trim(); if (q.length < 2) return [];
      var it = interpret(q), out = [];
      // process-title matches (typo tolerant, last word may be a prefix)
      var qs = contentStems(q);
      if (qs.length) {
        var scored = [];
        procList.forEach(function (p) {
          if (p.pseudo) return;
          var tt = procTok[p.id], hit = 0;
          qs.forEach(function (s, k) {
            var ok = tt.some(function (x) { return x === s || (k === qs.length - 1 && s.length >= 3 && x.indexOf(s) === 0) || (s.length >= 4 && dl(s, x, s.length > 5 ? 2 : 1) <= (s.length > 5 ? 2 : 1)); });
            if (ok) hit++;
          });
          var codeHit = (p.id.toLowerCase().indexOf(q.replace(/\s+/g, '-')) >= 0) ? 1 : 0;
          if (hit || codeHit) scored.push({ p: p, s: hit / qs.length + codeHit + (hit && hit === tt.length ? 0.2 : 0) });
        });
        scored.sort(function (a, b) { return b.s - a.s || a.p.page - b.p.page; });
        scored.slice(0, 4).forEach(function (x) { out.push({ type: 'process', label: x.p.title, sub: x.p.id + ' · p.' + x.p.page, process: x.p.id }); });
      }
      // word completion of the last typed word
      var parts = q.split(/\s+/), last = parts[parts.length - 1];
      if (last.length >= 2 && !STOP.has(last)) {
        var ls = stem(last), comp = [];
        for (var t = 0; t < V; t++) {
          var bw = bestSurface[t];
          if (df[t] >= 3 && bw.length > last.length && bw.indexOf(last) === 0 && !STOP.has(bw)) comp.push({ w: bw, d: df[t] });
        }
        comp.sort(function (a, b) { return b.d - a.d; });
        comp.slice(0, 2).forEach(function (c) { out.push({ type: 'word', label: parts.slice(0, -1).concat(c.w).join(' '), sub: 'complete word' }); });
      }
      // acronym hints
      parts.forEach(function (w) { var a = acr[w.replace(/[^a-z0-9]/g, '')]; if (a && out.length < limit + 2) out.unshift({ type: 'acronym', label: a.a + ' = ' + a.f, sub: 'abbreviation', replace: [w, a.f] }); });
      return out.slice(0, limit);
    }

    function related(res, n) {
      n = n || 4; var gs = res.groups || [];
      return gs.slice(1, n + 1).map(function (g) { return { id: g.id, title: g.title, page: g.page }; });
    }

    return {
      search: search, suggest: suggest, interpret: interpret, related: related,
      stem: stem, norm: norm, words: words,
      chunk: function (i) { return chunks[i]; },
      process: function (id) { return procById[id]; },
      processOf: function (c) { return procOf(c); },
      chunksOfProcess: function (id) { return (byProc[id] || []).map(function (ix) { return chunks[ix]; }); },
      processes: function () { return procList.filter(function (p) { return !p.pseudo; }); },
      sections: function () { return index.sections || []; },
      meta: function () { return index.meta || {}; },
      formTitle: function (code) { return (index.forms || {})[code.replace(/_\d{2}$/, '')] || ''; },
      acronym: function (a) { var x = acr[norm(a).replace(/[^a-z0-9]/g, '')]; return x ? x.f : null; },
      buildMs: Date.now() - t0, size: { chunks: N, terms: V },
      highlight: function (text, hlStems) {
        var set = new Set(hlStems || []);
        return esc(text).replace(/[A-Za-z0-9]+/g, function (w) { return set.has(stem(norm(w))) && !STOP.has(norm(w)) ? '<mark>' + w + '</mark>' : w; });
      }
    };
  }

  return { create: create, norm: norm, stem: stem };
});
