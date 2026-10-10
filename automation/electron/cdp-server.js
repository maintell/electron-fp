// ponytail: Electron-host wrapper that makes the CDP-WS bridge connectable in production.
// It wraps cdp-ws + the launcher and publishes the real per-profile ws URL (the same path/token
// convention cdp-ws advertises in GET /json/version) so a host can merge it into profile-manager.
'use strict';

const { createCdpWs } = require('../runtime/cdp-ws');

function createProfileCdpServer({ launcher, token, audit, host = '127.0.0.1', port = 0, onUrl, broker } = {}) {
  if (!launcher || typeof launcher.acquire !== 'function') throw new Error('launcher.acquire required');
  if (token == null || token === '') throw new Error('token required');

  const cdp = createCdpWs({
    resolve: (profileId) => {
      const h = launcher.acquire(profileId);
      return h && h.webContents ? { webContents: h.webContents } : undefined;
    },
    token,
    host,
    port,
    audit,
    broker,
  });

  let listener = null;
  let boundPort = port;

  // verbatim cdp-ws /json/version convention (do not paraphrase)
  function urlFor(profileId) {
    return (
      'ws://' + host + ':' + boundPort + '/api/cdp/' + encodeURIComponent(profileId) + '?token=' + encodeURIComponent(token)
    );
  }

  async function start() {
    if (listener) return { port: boundPort, baseUrl: 'ws://' + host + ':' + boundPort };
    listener = await cdp.start();
    boundPort = listener.port;
    publishAll(); // everything already launched becomes connectable immediately
    return { port: listener.port, baseUrl: 'ws://' + host + ':' + listener.port };
  }

  function publish(profileId) {
    if (typeof onUrl !== 'function') return false;
    onUrl(profileId, urlFor(profileId));
    return true;
  }

  function publishAll() {
    if (typeof launcher.list !== 'function') return 0;
    const ids = launcher.list();
    for (const id of ids) publish(id);
    return ids.length;
  }

  async function stop() {
    const l = listener;
    if (!l) return; // idempotent
    listener = null;
    await l.close();
  }

  return { start, urlFor, publish, publishAll, stop };
}

module.exports = { createProfileCdpServer };
