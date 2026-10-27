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
    'about into than then there their they them many much he she his her if so not no any all some please tell show give find ' +
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
    PMO: 'Project Management Office', SGR: 'Stage Gate Review', PLC: 'Project Life Cycle', CPPP: 'Capital Projects Portfolio Plan',
    RFP: 'Request for Proposal', RFQ: 'Request for Quotation', IPC: 'Interim Payment Certificate', VO: 'Variation Order',
    NCR: 'Non-Conformance Report', VE: 'Value Engineering', QRA: 'Quantitative Risk Analysis', PMP: 'Project Management Plan',
    DLP: 'Defects Liability Period', TC: 'Testing and Commissioning'
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
    var secProcs = {};
    (index.processes || []).forEach(function (p) { (secProcs[p.sec] = secProcs[p.sec] || []).push(p); });
    function procOf(c) {
      if (c.pr && procById[c.pr]) return procById[c.pr];
      if (secProcs[c.s] && secProcs[c.s].length === 1 && c.s > 1) return secProcs[c.s][0];   // e.g. Section 2 has a single process
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
      navigate(query, res);
      res.total = res.groups.reduce(function (z, g) { return z + g.count; }, 0);
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


    /* ---- navigation: "Which procedure covers X?" -> the process whose title is X ---- */
    var NAV_RX = /^\s*(which (pmm )?(procedure|process|section)|what should i check|where (can i|do i) find|where (is|are)|what (procedure|process)|which (pmm )?procedure covers)\b/i;
    var NAV_DROP = new Set(['pmm', 'v3', 'procedure', 'procedures', 'process', 'processes', 'requirement', 'requirements', 'covered', 'covers', 'cover', 'described',
      'find', 'check', 'section', 'manual', 'refer', 'applicable', 'relevant', 'details', 'detail', 'information', 'rules', 'guidance', 'steps', 'step']);
    function titleSim(qs, ts) {
      if (!qs.length || !ts.length) return 0;
      var hit = 0, used = {};
      qs.forEach(function (q, k) {
        for (var j = 0; j < ts.length; j++) {
          if (used[j]) continue;
          var t = ts[j];
          if (t === q || (q.length >= 5 && dl(q, t, q.length >= 7 ? 2 : 1) <= (q.length >= 7 ? 2 : 1)) || (q.length >= 3 && k === qs.length - 1 && t.indexOf(q) === 0)) { used[j] = 1; hit++; break; }
        }
      });
      return (hit / ts.length + hit / qs.length) / 2;
    }
    function navigate(query, res) {
      var nav = NAV_RX.test(query);
      var topic = contentStems(norm(query).replace(/\([^)]*\)/g, ' $& ').replace(/[()]/g, ' ')).filter(function (w) { return !NAV_DROP.has(w); });
      var acr0 = {}; // acronym words in the query count as their full form too ("lifecycle (plc)")
      if (!topic.length) return;
      var scored = [];
      procList.forEach(function (p) {
        if (p.pseudo) return;
        var sim = titleSim(topic, procTok[p.id] || []);
        if (sim >= (nav ? 0.62 : 0.8)) scored.push({ p: p, sim: sim });
      });
      if (!scored.length) return;
      scored.sort(function (a, b) { return b.sim - a.sim; });
      var top = scored[0].sim, base = res.groups.length ? res.groups[0].score : 1;
      scored.filter(function (x) { return x.sim >= top - 0.05; }).slice(0, 2).forEach(function (x) {
        var g = res.groups.filter(function (g) { return g.id === x.p.id; })[0];
        if (!g) {
          var ids = (byProc[x.p.id] || []).slice(0, 4);
          g = groupize(ids.map(function (ix) { return { i: ix, score: base * 0.2, cov: 1, matched: [], missing: [] }; }), false, null)[0];
          if (!g) return; res.groups.push(g);
        }
        g.score = Math.max(g.score, base) * (1.5 + 2 * x.sim); g.titleMatch = x.sim;
      });
      res.groups.sort(function (a, b) { return b.score - a.score; });
    }


    /* ---- the PMM expert's own questions and answers (verified cards) ----
     * Matching understands typos, plural/singular (stems), joined words via stems, abbreviations
     * (RFP = Request for Proposal) and related wording (synonym groups) at a slightly lower weight.
     * Returns the best match plus other possible answers. */
    var EXP_SYN = {};
    SYN_GROUPS.concat([['invoice', 'ipc'], ['snag', 'punch'], ['permit', 'license', 'licence'], ['tender', 'bid', 'bidding'],
      ['variation', 'vo'], ['schedule', 'programme']]).forEach(function (g, gi) {
      g.forEach(function (w) { var s = stem(w); if (EXP_SYN[s] === undefined) EXP_SYN[s] = gi; });
    });
    var EXP_OPT = new Set(['who', 'whom', 'whose', 'when', 'where', 'why', 'long', 'many', 'much', 'soon', 'often']);   // question words: count only when both sides have them
    var NO_EXPAND = new Set(['nwc', 'pmm', 'v3']);    // names, not abbreviations a user would spell out
    var JOIN = [[/\bhand over\b/g, 'handover'], [/\bkick off\b/g, 'kickoff'], [/\bclose out\b/g, 'closeout'], [/\btake over\b/g, 'takeover'],
      [/\bsign off\b/g, 'signoff'], [/\bstart up\b/g, 'startup'], [/\bset up\b/g, 'setup'], [/\bcash flow\b/g, 'cashflow'], [/\blife cycle\b/g, 'lifecycle']];
    function expertStems(text) {                       // [{s: stem, w: word as written, o: optional}]
      var out = [], seen = {}, t = norm(text).replace(/[()\/-]/g, ' ').replace(/\s+/g, ' ');
      JOIN.forEach(function (j) { t = t.replace(j[0], j[1]); });
      function add(st, w, o) { if (st && !seen[st] && !NAV_DROP.has(st)) { seen[st] = 1; out.push({ s: st, w: w, o: !!o }); } }
      words(t).forEach(function (w) {
        if (STOP.has(w) || (w.length < 2 && !/\d/.test(w))) return;
        if (EXP_OPT.has(w)) { add(w, w, true); return; }
        add(stem(w), w);
        var a = acr[w];
        if (a && w.length <= 6 && !NAV_DROP.has(w) && !NO_EXPAND.has(w))     // "rfp" also counts as "request for proposal"
          words(a.f).forEach(function (fw) { if (!STOP.has(fw)) add(stem(fw), fw); });
      });
      return out;
    }
    function near(a, b) {                              // one or two letters off, depending on length
      var m = a.length >= 7 ? 2 : 1;
      return a.length >= 5 && dl(a, b, m) <= m;
    }
    function expSim(qs, ts) {
      if (!qs.length || !ts.length) return 0;
      var hit = 0, used = {}, qn = 0, tn = 0, optHit = 0;
      qs.forEach(function (q, k) {
        var best = 0, bj = -1;
        for (var j = 0; j < ts.length; j++) {
          if (used[j]) continue;
          var t = ts[j], v = 0;
          if (t.s === q.s) v = 1;
          else if (q.o || t.o) v = 0;
          else if (near(q.s, t.s) || near(q.w, t.w)) v = 0.95;                                           // typo
          else if (q.s.length >= 3 && k === qs.length - 1 && t.s.indexOf(q.s) === 0) v = 0.9;             // still typing
          else if (EXP_SYN[q.s] !== undefined && EXP_SYN[q.s] === EXP_SYN[t.s]) v = 0.85;                  // related word
          if (v > best) { best = v; bj = j; if (v === 1) break; }
        }
        if (bj >= 0) { used[bj] = 1; hit += best; if (q.o) optHit++; }
      });
      qs.forEach(function (q) { if (!q.o) qn++; }); ts.forEach(function (t) { if (!t.o) tn++; });
      qn += optHit; tn += optHit;                                                                         // question words count only when matched
      if (!qn || !tn) return 0;
      return (hit / tn + hit / qn) / 2;
    }
    var EXPERT = (index.expert || []).map(function (e) {
      return { q: e.q, a: e.a, qa: e.q_ar || '', aa: e.a_ar || '', ref: e.ref, sheet: e.sheet, type: questionType(norm(e.q).trim()), st: expertStems(e.q) };
    });
    function expertCard(x) {
      var codes = (x.e.ref.match(/PMM-\d{3}-[A-Z]{3}-\d{3}/g) || []).filter(function (c, i, a) { return a.indexOf(c) === i && procById[c]; });
      return { q: x.e.q, a: x.e.a, qa: x.e.qa, aa: x.e.aa, ref: x.e.ref, sim: x.sim, proc: codes[0] || '' };
    }
    function expertAll(query, max) {
      var out = { best: null, others: [] };
      if (!EXPERT.length) return out;
      var qs = expertStems(query);
      if (qs.length < 2) return out;
      var qt = questionType(norm(query).trim()), strict = { count: 1, who: 1, when: 1 }, scored = [];
      EXPERT.forEach(function (e) {
        var sim = expSim(qs, e.st);
        if (sim < 0.5) return;
        var typeOk = !(strict[qt] && e.type !== qt) && !(strict[e.type] && qt !== e.type && sim < 0.9);   // a "how many" question must not get a "where is" answer
        var lenOk = Math.abs(e.st.length - qs.length) <= Math.max(3, qs.length);
        scored.push({ e: e, sim: sim, typeOk: typeOk, lenOk: lenOk });
      });
      scored.sort(function (a, b) { return b.sim - a.sim; });
      var seen = {};
      scored.forEach(function (x) {
        var k1 = 'q' + x.e.q.toLowerCase(), k2 = 'a' + x.e.a.toLowerCase();
        if (seen[k1] || seen[k2]) return;
        if (!out.best && x.typeOk && x.lenOk && x.sim >= 0.8) { out.best = expertCard(x); seen[k1] = seen[k2] = 1; return; }
        if (out.others.length < (max || 3) && x.sim >= 0.6 && (x.typeOk || qt === 'general' || x.sim >= 0.75)) { out.others.push(expertCard(x)); seen[k1] = seen[k2] = 1; }
      });
      return out;
    }
    function expertMatch(query) { return expertAll(query).best; }

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

    /* ====================================================================
     * Answer layer: understands the kind of question (how many / who / when /
     * what is / yes-no / list) and returns the best-fit statement, not just
     * a pile of passages. Rule-based and fully offline; every answer is shown
     * with the PMM sentence it came from.
     * ==================================================================== */
    var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
      thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
    var NUMRX = '(?:\\d{1,3}|' + Object.keys(NUMW).join('|') + ')';
    var SENT_CACHE = {};
    function sentencesOf(c) {
      if (SENT_CACHE[c.i]) return SENT_CACHE[c.i];
      var out = [], parent = '';
      c.t.split('\n').forEach(function (line) {
        var isMark = /^\s*(\d{1,2}[.)]|[a-z][.)]|[ivx]{1,4}[.)]|[\u2022\-\u25cf])\s/.test(line);
        var clean = line.replace(/\s+/g, ' ').trim();
        if (!isMark && /:\s*$/.test(clean)) parent = clean; else if (!isMark) parent = '';
        line.replace(/([.;!?])\s+(?=[A-Z0-9(])/g, '$1\u0001').split('\u0001').forEach(function (x) {
          x = x.replace(/\s+/g, ' ').trim(); if (x.length < 18) return;
          if (isMark && parent && parent.length < 90 && !/^(policies|procedures|steps|the following)/i.test(parent) && !/this process/i.test(parent)) x = parent.replace(/:\s*$/, ':') + ' ' + x.replace(/^(\d{1,2}[.)]|[a-z][.)]|[ivx]{1,4}[.)]|[\u2022\-\u25cf])\s*/, '');
          out.push(x);
        });
      });
      return (SENT_CACHE[c.i] = out);
    }
    function ctxLabel(c) { return (c.h || '').replace(/^\d[\d.]*\s+(PMM-\S+\s*)?/, '').replace(/\s*\([^)]*\)\s*$/, '').trim(); }
    function toNum(w) { w = String(w).toLowerCase(); return /^\d/.test(w) ? parseInt(w, 10) : NUMW[w]; }
    function questionType(nq) {
      if (/\b(how many|number of|how much)\b/.test(nq)) return 'count';
      if (/\b(who|whom)\b/.test(nq) || /\bresponsible for\b/.test(nq)) return 'who';
      if (/\bhow (long|often|soon|frequently)\b|\bwhen\b|\bdeadline\b|\btime limit\b|\bwithin how\b/.test(nq)) return 'when';
      if (/^\s*(what is|what are|what does|define|meaning of|what do you mean)\b/.test(nq) && !/^\s*what are the (steps|stages|types|policies|requirements|deliverables|documents)\b/.test(nq)) return 'define';
      if (/^\s*(is|are|can|could|must|should|does|do|shall|may|will|has|have)\b/.test(nq)) return 'yesno';
      if (/\b(list|what are the|which|name the|types of|kinds of|steps (of|in|for)|stages of)\b/.test(nq)) return 'list';
      return 'general';
    }
    function focusStemsFor(nq) {
      var m = nq.match(/\b(?:how many|number of|how much)\s+(.+)$/); if (!m) return [];
      var words = [], stopAt = /^(are|is|do|does|did|can|should|must|will|shall|there|in|of|for|to|per|within|during|exist|exists|have|has|be|been|required|needed|available|that|which)$/;
      var ws = m[1].replace(/[?.!,]/g, '').split(/\s+/);
      for (var i = 0; i < ws.length; i++) { if (stopAt.test(ws[i])) break; if (!STOP.has(ws[i])) words.push(ws[i]); if (words.length >= 3) break; }
      return words.map(stem);
    }
    function plural(n, label) { return label.toLowerCase().replace(/\s+\d+$/, ''); }

    function countCandidates(chunkIdx, focus, strict) {
      var items = [], seen = {};
      chunkIdx.forEach(function (ix) {
        var c = chunks[ix], p = procOf(c);
        // (1) enumerated labels such as "Stage Gate 1 ... Stage Gate 8"
        var labels = {}, re = /([A-Z][A-Za-z&\-]*(?:\s[A-Z][A-Za-z&\-]*){0,3})\s(\d{1,2})\b/g, m;
        while ((m = re.exec(c.t))) {
          var lw = m[1].split(' '), lab = lw.slice(-2).join(' '), ls = contentStems(lab);
          if (lw.length >= 2 && contentStems(lw[lw.length - 1]).every(function (x) { return focus.indexOf(x) < 0; })) { lab = lw[lw.length - 1]; ls = contentStems(lab); }
          if (!ls.some(function (s) { return focus.indexOf(s) >= 0; })) continue;
          (labels[lab] = labels[lab] || {})[parseInt(m[2], 10)] = 1;
        }
        Object.keys(labels).forEach(function (lab) {
          var nums = Object.keys(labels[lab]).map(Number).sort(function (a, b) { return a - b; }), n = 0;
          while (n < nums.length && nums[n] === n + 1) n++;
          if (n >= 2 && n === nums.length) {
            var key = 'e|' + n + '|' + lab + '|' + ctxLabel(c);
            if (!seen[key]) { seen[key] = 1; items.push({ n: n, noun: lab.toLowerCase() + 's', ctx: ctxLabel(c), p: c.p, i: ix, kind: 'enum', quote: lab + ' 1 \u2026 ' + lab + ' ' + n, proc: p.id }); }
          }
        });
        // (2) statements such as "consists of eight stages"
        sentencesOf(c).forEach(function (s) {
          var r = new RegExp('\\b(at least|minimum of|maximum of|up to|more than|at most)?\\s*(' + NUMRX + ')\\s+((?:[a-z\\-]+\\s+){0,2}?)([a-z\\-]{3,})\\b', 'ig'), mm;
          while ((mm = r.exec(s))) {
            var noun = mm[4], pre = s.slice(Math.max(0, mm.index - 12), mm.index).toLowerCase();
            var before = s.charAt(Math.max(0, mm.index + mm[0].indexOf(mm[2]) - 1));
            if (/[\w\-.\/]/.test(before) || /^0\d/.test(mm[2])) continue;
            if (/(section|page|figure|table|stage|step|gate|item|point)\s*$/.test(pre) && /^\d/.test(mm[2])) continue;
            if (focus.indexOf(stem(noun.toLowerCase())) < 0) continue;
            var n2 = toNum(mm[2]); if (!n2) continue;
            if (n2 < 2 && !/\b(only|single|one)\b/i.test(mm[0])) continue;
            var key2 = 's|' + n2 + '|' + noun.toLowerCase() + '|' + ctxLabel(c);
            if (!seen[key2]) { seen[key2] = 1; items.push({ n: n2, noun: noun.toLowerCase(), qual: (mm[1] || '').trim(), ctx: ctxLabel(c), p: c.p, i: ix, kind: 'stmt', quote: s, proc: p.id }); }
          }
        });
      });
      return items;
    }


    /* ---- duration questions: "how many days / how long / within how many days / deadline" ---- */
    var DUR_Q = /\b(how many (calendar |working |business )?(days|weeks|months|hours)|how long|within how many|how soon|how much time|time limit|deadline|by when|how many (calendar |working )?day)\b/;
    var DUR_WORDS = new Set(['day', 'days', 'calendar', 'working', 'business', 'long', 'many', 'soon', 'deadline', 'allowed', 'allow', 'take', 'takes', 'much', 'week', 'weeks', 'month', 'months', 'hour', 'hours', 'time', 'limit', 'period', 'have', 'must', 'should', 'cited', 'under', 'procedure']);
    var DURATION_RX = /\b(?:within|in|no later than|not (?:to )?exceed(?:ing)?|a maximum of|maximum of|at least|before|after)?\s*(\d{1,3})\s+(calendar |working |business )?(days?|weeks?|months?|hours?)\b/i;
    var DUR_SENT = null;
    function durationSentences() {
      if (DUR_SENT) return DUR_SENT; DUR_SENT = [];
      chunks.forEach(function (c, ix) {
        if (c.k === 'Workflow') return;
        sentencesOf(c).forEach(function (st) { if (DURATION_RX.test(st)) DUR_SENT.push({ ix: ix, s: st }); });
      });
      return DUR_SENT;
    }
    function durationAnswer(query, res, C) {
      var cc = C.filter(function (cn) { return !DUR_WORDS.has(cn.raw); });
      // "Project Management Plan (PMP)": the acronym and its spelled-out words are one idea, count it once
      cc.filter(function (cn) { return cn.status === 'acronym'; }).forEach(function (cn) {
        var ex = {}; cn.alts.forEach(function (a) { if (a.via === 'acronym') a.stems.forEach(function (t) { ex[terms[t]] = 1; }); });
        var drop = cc.filter(function (o) { return o !== cn && o.status !== 'acronym' && ex[stem(o.raw)]; });
        if (drop.length >= 2) cc = cc.filter(function (o) { return drop.indexOf(o) < 0; });
      });
      if (!cc.length) return null;
      var procQ = /\b(procedure|process)\b/.test(norm(query)) && /\b(take|takes|long|complete|completed|finish)\b/.test(norm(query));
      var wsum = 0, wts = cc.map(function (cn) { var m = 0; cn.alts.forEach(function (a) { a.stems.forEach(function (t) { m = Math.max(m, idf(t)); }); }); wsum += m; return m; });
      var cand = [];
      durationSentences().forEach(function (d) {
        var c = chunks[d.ix], p = procOf(c);
        var ids = new Set(); words(d.s).forEach(function (w) { if (!STOP.has(w)) { var t = vocab.get(stem(w)); if (t !== undefined) ids.add(t); } });
        var hs = new Set(contentStems((c.h || '') + ' ' + (p.pseudo ? '' : p.title)).map(function (x) { return vocab.get(x); }));
        var sentHit = 0, total = 0;
        cc.forEach(function (cn, k) {
          var inS = 0, inH = 0;
          cn.alts.forEach(function (a) { if (a.stems.every(function (t) { return ids.has(t); })) inS = Math.max(inS, a.w); else if (a.stems.every(function (t) { return hs.has(t); })) inH = Math.max(inH, a.w); });
          var ownProc = procQ && /\bthis (procedure|process)\b[^.]{0,40}\b(completed|performed)\b/i.test(d.s);
          if (inS) { sentHit += wts[k] * inS; total += wts[k] * inS; } else if (inH) { total += wts[k] * inH * (ownProc ? 1 : 0.6); if (ownProc) sentHit += wts[k] * inH; }
        });
        var cov = total / wsum; if (cov < 0.55) return;
        var sc = cov + 0.35 * (sentHit / wsum);
        if (procQ && /\bthis (procedure|process)\b[^.]{0,40}\b(completed|performed)\b/i.test(d.s)) sc *= 1.5;
        if (/\b(shall|must|should)\b/i.test(d.s)) sc *= 1.05;
        if (c.k === 'Policy' || c.k === 'Procedure') sc *= 1.04;
        cand.push({ ix: d.ix, s: d.s, sc: sc, proc: p.id, label: p.title, p: c.p });
      });
      if (!cand.length) return null;
      cand.sort(function (a, b) { return b.sc - a.sc; });
      var best = cand[0], picks = [best];
      cand.slice(1).forEach(function (x) { if (picks.length < 3 && x.sc >= best.sc * 0.93 && x.s !== best.s) picks.push(x); });
      function phrase(st) {
        var m = DURATION_RX.exec(st); if (!m) return '';
        var tail = st.slice(m.index + m[0].length).match(/^\s*((?:from|of|after|following|since|before)\b[^.;]{0,90})/i);
        var pre = (m[0].match(/^\s*(within|in|no later than|not (?:to )?exceed(?:ing)?|a maximum of|maximum of|at least|before|after)\b/i) || [])[1];
        var core = m[1] + ' ' + (m[2] ? m[2].trim() + ' ' : '') + m[3];
        var kind = m[2] ? '' : ' (working days unless the PMM says calendar days)';
        var txt = (pre ? pre.charAt(0).toUpperCase() + pre.slice(1) + ' ' : '') + core + (tail ? ' ' + tail[1].trim() : '');
        if (!pre) txt = core + (tail ? ' ' + tail[1].trim() : '');
        return txt.replace(/^./, function (z) { return z.toUpperCase(); }) + kind;
      }
      var heads = picks.map(function (x) { return phrase(x.s); });
      var headline = picks.length > 1 && heads[0] !== heads[1] ? heads.map(function (h, i) { return h + ' \u2013 ' + picks[i].label; }).join('   \u00b7   ') : heads[0];
      return { type: 'duration', headline: headline, note: picks.length > 1 && heads[0] !== heads[1] ? 'Similar timelines appear in more than one process; check which one applies.' : '',
        evidence: picks.map(function (x) { return { i: x.ix, p: x.p, text: x.s, proc: x.proc, label: x.label }; }), confidence: best.sc >= 0.95 ? 'high' : 'medium' };
    }

    function answer(query, res) {
      var nq = ' ' + norm(query).trim() + ' ';
      var type = questionType(nq.trim());
      if (type === 'general' && !/\?\s*$/.test(query.trim())) return null;
      res = res || search(query);
      if (!res.interp || !res.interp.concepts.length || res.direct) return null;
      var C = res.interp.concepts;
      var topIdx = []; res.groups.slice(0, 8).forEach(function (g) { g.items.slice(0, 6).forEach(function (it) { topIdx.push(it.i); }); });
      if (!topIdx.length) return null;

      if (DUR_Q.test(nq)) { var da = durationAnswer(query, res, C); if (da) return da; }
      /* --- count --- */
      if (type === 'count') {
        var fw = (nq.match(/\b(?:how many|number of|how much)\s+(.+)$/) || [0, ''])[1].replace(/[?.!,]/g, '').split(/\s+/), focus = [], primary = true;
        var stopAt = /^(are|is|do|does|did|can|should|must|will|shall|there|in|of|for|to|per|within|during|exist|exists|have|has|be|been|required|needed|available|that|which|each|every|the|a|an)$/;
        var fcount = 0;
        for (var fi = 0; fi < fw.length && fcount < 3; fi++) {
          if (stopAt.test(fw[fi])) { if (fcount) break; else continue; }
          fcount++;
          C.forEach(function (cn) { if (cn.raw === fw[fi]) cn.alts.forEach(function (a) { if (a.w >= 0.78 && a.stems.length === 1) focus.push(terms[a.stems[0]]); }); });
        }
        if (!focus.length) focus = C.map(function (c) { return stem(c.raw); });
        var fids = focus.map(function (f) { return vocab.get(f); }).filter(function (x) { return x !== undefined; });
        var pool = topIdx.slice();
        for (var ci = 0; ci < N && pool.length < 400; ci++) { if (pool.indexOf(ci) < 0 && fids.some(function (t) { return docToks[ci].indexOf(t) >= 0; })) pool.push(ci); }
        var items = countCandidates(pool, focus);
        if (!items.length) { // fall back to the other words of the question (e.g. "stages")
          focus = C.map(function (c) { return stem(c.raw); }); primary = false; items = countCandidates(pool, focus);
        }
        if (!items.length) return null;
        // prefer enumerations (exact), then statements; keep one per context
        var qs = C.map(function (c) { return stem(c.raw); });
        items.forEach(function (it) { var ls = contentStems(it.noun + ' ' + it.ctx); it.cov = qs.filter(function (q) { return ls.indexOf(q) >= 0; }).length; });
        items.sort(function (a, b) { return (b.cov - a.cov) || ((a.kind === 'enum' ? 0 : 1) - (b.kind === 'enum' ? 0 : 1)) || (pool.indexOf(a.i) - pool.indexOf(b.i)); });
        var maxCov = items.length ? items[0].cov : 0; items = items.filter(function (it) { return it.cov === maxCov; });
        var chosen = [], used = {};
        items.forEach(function (it) { var k = it.ctx + '|' + it.n; if (!used[k] && chosen.length < 4) { used[k] = 1; chosen.push(it); } });
        var same = chosen.every(function (x) { return x.n === chosen[0].n; });
        var parts = chosen.map(function (x) { return x.n + ' ' + x.noun + (x.ctx ? ' (' + x.ctx + ')' : ''); });
        var head = same && chosen.length > 1 ? chosen[0].n + ' ' + chosen[0].noun : parts.join('  \u00b7  ');
        return { type: 'count', headline: head, note: primary ? '' : 'The PMM counts these differently from your wording; closest related counts shown.',
          evidence: chosen.map(function (x) { return { i: x.i, p: x.p, text: x.quote, proc: x.proc, label: x.ctx }; }), confidence: primary ? 'high' : 'medium' };
      }

      /* --- sentence-level ranking for every other type --- */
      var cands = [];
      topIdx.forEach(function (ix, rank) {
        var c = chunks[ix], p = procOf(c);
        var headStems = new Set(contentStems((c.h || '') + ' ' + (p.pseudo ? '' : p.title)).map(function (s) { return vocab.get(s); }));
        sentencesOf(c).forEach(function (s) {
          var ids = new Set(); words(s).forEach(function (w) { if (!STOP.has(w)) { var t = vocab.get(stem(w)); if (t !== undefined) ids.add(t); } });
          var hit = 0, sc = 0;
          C.forEach(function (cn) {
            var best = 0;
            cn.alts.forEach(function (a) { if (a.stems.every(function (t) { return ids.has(t); })) best = Math.max(best, a.w * a.stems.reduce(function (z, t) { return z + idf(t); }, 0)); else if (a.stems.every(function (t) { return headStems.has(t); })) best = Math.max(best, a.w * 0.35 * a.stems.reduce(function (z, t) { return z + idf(t); }, 0)); });
            if (best > 0) { hit++; sc += best; }
          });
          var cov = hit / C.length; if (cov < 0.5) return;
          sc *= (0.35 + 0.65 * cov * cov);
          if (type === 'when' && /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(calendar |working |business )?(days?|weeks?|months?|hours?|years?)\b|\b(monthly|weekly|quarterly|annual(ly)?|daily)\b/i.test(s)) sc *= 1.5;
          if (type === 'who' && /\b(shall|responsible|is the|are the|approves?|chair)/i.test(s)) sc *= 1.3;
          if (type === 'who' && /^\s*who (is|are)\b/.test(nq) && /\b(is|are) the [A-Z]/.test(s)) sc *= 1.5;
          if (type === 'define' && /\b(is|are|means|refers to|defined as|consists of)\b/i.test(s)) sc *= 1.25;
          if (type === 'yesno' && /\b(shall|must|should|not|may|cannot|only|required|prohibited)\b/i.test(s)) sc *= 1.25;
          if (c.k === 'Workflow') sc *= 0.6;
          sc *= 1 - Math.min(rank, 30) * 0.004;
          cands.push({ s: s, sc: sc, cov: cov, i: ix, p: c.p, proc: p.id, label: p.pseudo ? p.title : p.title });
        });
      });
      if (!cands.length) return null;
      cands.sort(function (a, b) { return b.sc - a.sc; });
      var top = cands.filter(function (x, k) { return k < 3 && x.sc >= cands[0].sc * 0.55; });
      var s0 = top[0].s, headline = '';

      if (type === 'when') {
        var wantFreq = /how often|frequen/.test(nq), freqRx = /\b(monthly|weekly|quarterly|annual(ly)?|daily|every|each|per)\b/i;
        var dm = (wantFreq && !freqRx.test(s0)) ? null : s0.match(/\b(at least|within|no later than|before|every|each|up to)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(calendar |working |business )?(days?|weeks?|months?|hours?|years?)\b|\b(monthly|weekly|quarterly|annual(?:ly)?|daily)\b/i);
        if (dm) headline = dm[0].trim().replace(/^./, function (ch) { return ch.toUpperCase(); });
      } else if (type === 'who') {
        var m1 = s0.match(/^(?:The |A |An )?([A-Z][A-Za-z&\/\- ]{2,70}?)\s+(?:shall|must|is responsible|will|approves?|should)\b/);
        var m2 = s0.match(/\b(?:is|are) the ([A-Z][A-Za-z&\/\- ]{2,70}?)(?:[.,;]|$)/);
        var roles = []; top.forEach(function (x) { var q = x.s.match(/\b(?:is|are) the ([A-Z][A-Za-z&\/\- ]{2,70}?)(?:[.,;]|$)/); if (q && roles.indexOf(q[1].trim()) < 0 && roles.length < 2) roles.push(q[1].trim()); });
        if (roles.length) headline = roles.join('  \u00b7  '); else if (m2) headline = m2[1].trim(); else if (m1) headline = m1[1].trim();
      } else if (type === 'define') {
        headline = s0.length > 230 ? s0.slice(0, 227) + '\u2026' : s0;
      } else if (type === 'yesno') {
        if (/\b(must not|shall not|not allowed|prohibited|cannot|may not)\b/i.test(s0)) headline = 'Not allowed \u2013 the PMM says:';
        else if (/\b(shall|must|required|mandatory)\b/i.test(s0)) headline = 'Required \u2013 the PMM says:';
        else headline = 'The PMM says:';
      } else if (type === 'list') {
        var c0 = chunks[top[0].i], lines = c0.t.split('\n').filter(function (l) { return /^\s*(\d{1,2}[.)]|[a-z][.)]|[\u2022\-])\s/.test(l); });
        if (lines.length >= 2) { headline = lines.length + ' items'; return { type: 'list', headline: headline, items: lines.slice(0, 14).map(function (l) { return l.replace(/^\s*(\d{1,2}[.)]|[a-z][.)]|[\u2022\-])\s*/, ''); }),
          evidence: [{ i: top[0].i, p: top[0].p, text: top[0].s, proc: top[0].proc, label: top[0].label }], confidence: top[0].cov === 1 ? 'high' : 'medium' }; }
      }
      return { type: type, headline: headline, evidence: top.map(function (x) { return { i: x.i, p: x.p, text: x.s, proc: x.proc, label: x.label }; }),
        confidence: top[0].cov === 1 ? 'high' : 'medium' };
    }

    /* Top passages to hand to the on-device language model (or to show as sources). */
    function passages(query, res, n) {
      n = n || 4; res = res || search(query);
      var all = []; (res.groups || []).slice(0, 8).forEach(function (g) { g.items.slice(0, 3).forEach(function (it) { all.push(it); }); });
      all.sort(function (a, b) { return b.score - a.score; });
      var perProc = {}, out = [];
      all.forEach(function (it) {
        if (out.length >= n) return;
        var c = chunks[it.i], p = procOf(c); perProc[p.id] = (perProc[p.id] || 0) + 1; if (perProc[p.id] > 2) return;
        var sents = sentencesOf(c), text = '', hl = new Set((res.hl || []));
        var first = 0; for (var k = 0; k < sents.length; k++) { if (contentStems(sents[k]).some(function (x) { return hl.has(x); })) { first = k; break; } }
        for (var j = first; j < sents.length && text.length < 620; j++) text += (text ? ' ' : '') + sents[j];
        if (!text) text = c.t.slice(0, 620);
        out.push({ i: it.i, p: c.p, proc: p.id, label: p.pseudo ? p.title : p.title, h: c.h || '', text: text });
      });
      return out;
    }

    return {
      expert: expertMatch, experts: expertAll, passages: passages, answer: answer, search: search, suggest: suggest, interpret: interpret, related: related,
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
