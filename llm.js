/* PMM Coach – on-device AI controller (main thread). Optional: the app works without it. */
(function () {
  'use strict';
  var MODELS = {
    light:    { id: 'onnx-community/SmolLM2-360M-Instruct', dtype: 'q4',    device: 'wasm',   mb: 250,  label: 'Light (about 250 MB, any device)' },
    standard: { id: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q4',    device: 'wasm',   mb: 400,  label: 'Standard (about 400 MB, any device)' },
    better:   { id: 'onnx-community/Qwen2.5-1.5B-Instruct', dtype: 'q4f16', device: 'webgpu', mb: 1000, label: 'Better (about 1 GB, needs a graphics-capable browser)' }
  };
  var worker = null, dogTimer = null, state = { phase: 'off', model: null, loaded: 0, total: 0, error: '' }, listeners = [], pending = {}, seq = 0;

  function emit() { listeners.forEach(function (f) { try { f(state); } catch (e) {} }); }
  function dog(on) { clearTimeout(dogTimer); if (on) dogTimer = setTimeout(function () { if (state.phase === 'downloading') { set({ phase: 'error', error: 'The model download did not start. Check your internet connection (needed once) and try again.' }); } }, 60000); }
  function set(p) { for (var k in p) state[k] = p[k]; emit(); }
  function gpu() { return !!(navigator.gpu); }

  function ensureWorker() {
    if (worker) return worker;
    try { worker = new Worker('llm-worker.js', { type: 'module' }); }
    catch (e) { set({ phase: 'error', error: 'This browser cannot run the on-device model.' }); return null; }
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.evt === 'progress') { dog(true); set({ phase: 'downloading', loaded: m.loaded, total: m.total }); }
      else if (m.evt === 'ready') { dog(false); set({ phase: 'ready', error: '' }); }
      else if (m.evt === 'token' && pending[m.id] && pending[m.id].onToken) pending[m.id].onToken(m.text);
      else if (m.evt === 'done' && pending[m.id]) { pending[m.id].resolve(m.text); delete pending[m.id]; }
      else if (m.evt === 'error') {
        if (m.id && pending[m.id]) { pending[m.id].reject(new Error(m.message)); delete pending[m.id]; }
        else { dog(false); set({ phase: 'error', error: friendly(m.message) }); }
      }
    };
    worker.onerror = function (e) { set({ phase: 'error', error: 'The on-device model could not start (' + (e.message || 'worker error') + ').' }); };
    return worker;
  }
  function friendly(msg) {
    if (/fetch|network|Failed to|Load failed|NetworkError/i.test(msg)) return 'The model could not be downloaded. Check your internet connection (needed once) and try again.';
    if (/webgpu|adapter/i.test(msg)) return 'This browser does not support the selected model. Choose the Standard or Light model.';
    return msg;
  }

  window.PMMLLM = {
    MODELS: MODELS,
    gpu: gpu,
    state: function () { return state; },
    on: function (f) { listeners.push(f); },
    enabled: function () { try { return localStorage.getItem('pmmc.ai') === '1'; } catch (e) { return false; } },
    chosen: function () { try { return localStorage.getItem('pmmc.aiModel') || 'standard'; } catch (e) { return 'standard'; } },
    choose: function (k) { try { localStorage.setItem('pmmc.aiModel', k); } catch (e) {} },
    setEnabled: function (on) { try { localStorage.setItem('pmmc.ai', on ? '1' : '0'); } catch (e) {} if (!on) { if (worker) worker.postMessage({ cmd: 'unload' }); set({ phase: 'off' }); } },
    ready: function () { return state.phase === 'ready'; },
    load: function () {
      var key = this.chosen(), m = MODELS[key]; if (!m) return;
      if (m.device === 'webgpu' && !gpu()) { set({ phase: 'error', error: 'The Better model needs WebGPU, which this browser does not have. Choose Standard.' }); return; }
      var w = ensureWorker(); if (!w) return;
      set({ phase: 'downloading', model: key, loaded: 0, total: 0, error: '' });
      dog(true);
      w.postMessage({ cmd: 'load', model: m.id, dtype: m.dtype, device: m.device });
    },
    ask: function (messages, onToken) {
      var w = ensureWorker(); if (!w || state.phase !== 'ready') return Promise.reject(new Error('The on-device model is not ready.'));
      var id = ++seq;
      return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject, onToken: onToken }; w.postMessage({ cmd: 'ask', id: id, messages: messages }); });
    },
    ping: function () { var w = ensureWorker(); return new Promise(function (res) { if (!w) return res(null); var h = function (e) { if (e.data && e.data.evt === 'pong') { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); w.postMessage({ cmd: 'ping' }); }); },
    remove: function () {
      if (worker) { worker.terminate(); worker = null; }
      set({ phase: 'off', loaded: 0, total: 0 });
      return (window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return /transformers/i.test(k); }).map(function (k) { return caches.delete(k); })); }) : Promise.resolve());
    }
  };
})();
