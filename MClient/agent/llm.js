'use strict';

// Minimal OpenAI-compatible chat client. Non-streaming only (stream:false).
// Receives a PLAINTEXT key from the engine on every call and never touches
// storage itself — key decrypt/config lives in engine.js. Uses global fetch
// (Node 18+ / Electron), no new dependencies. Retries a failed call once.

async function chatCompletion({ baseUrl, key, model, messages, tools, signal }) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({
    model,
    messages,
    ...(tools && tools.length ? { tools } : {}),
    stream: false,
  });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) { // initial try + 1 retry
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: 'Bearer ' + key } : {}),
        },
        body,
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('LLM HTTP ' + res.status + ': ' + String(text).slice(0, 300));
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e; // stop() aborts: never retry that
    }
  }
  throw lastErr;
}

module.exports = { chatCompletion };
