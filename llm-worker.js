/* On-device language model worker. Runs entirely in the browser; the only network use is the
 * one-time download of the (public) model files, which are then cached on the device. */
import { pipeline, TextStreamer, env } from './vendor/transformers.bundle.js';

const base = new URL('./vendor/', import.meta.url).href;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = base;
env.backends.onnx.wasm.numThreads = (self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1);

let gen = null, loaded = '', wasmReady = false;
// The runtime's WebAssembly is shipped gzip-compressed (6 MB instead of 28 MB) and unpacked here.
async function prepareWasm() {
  if (wasmReady) return;
  const res = await fetch(new URL('./vendor/ort-wasm-simd-threaded.jsep.wasm.gz', import.meta.url));
  if (!res.ok) throw new Error('The AI runtime files are missing from this build.');
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  env.backends.onnx.wasm.wasmBinary = new Uint8Array(buf);
  wasmReady = true;
}
const post = (m) => self.postMessage(m);

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.cmd === 'ping') return post({ evt: 'pong', webgpu: !!self.navigator.gpu });
    if (m.cmd === 'load') {
      if (gen && loaded === m.model + m.device) return post({ evt: 'ready', model: m.model });
      gen = null;
      await prepareWasm();
      const files = {};
      gen = await pipeline('text-generation', m.model, {
        dtype: m.dtype, device: m.device,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) { files[p.file] = { l: p.loaded || 0, t: p.total || 0 }; }
          let l = 0, t = 0; for (const k in files) { l += files[k].l; t += files[k].t; }
          post({ evt: 'progress', status: p.status, loaded: l, total: t, file: p.file || '' });
        }
      });
      loaded = m.model + m.device;
      return post({ evt: 'ready', model: m.model });
    }
    if (m.cmd === 'ask') {
      if (!gen) throw new Error('The model is not loaded yet.');
      const streamer = new TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t) => post({ evt: 'token', id: m.id, text: t }) });
      const out = await gen(m.messages, { max_new_tokens: m.maxTokens || 220, do_sample: false, repetition_penalty: 1.05, streamer });
      const last = out && out[0] && out[0].generated_text;
      const text = Array.isArray(last) ? (last[last.length - 1] || {}).content : String(last || '');
      return post({ evt: 'done', id: m.id, text: text || '' });
    }
    if (m.cmd === 'unload') { gen = null; loaded = ''; return post({ evt: 'unloaded' }); }
  } catch (err) {
    post({ evt: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
post({ evt: 'boot' });
