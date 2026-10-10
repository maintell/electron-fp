# @fp-automation — external SDK for the electron-fp automation runtime

Thin loopback clients. **Zero browser logic**: every call is one loopback request
to the running automation runtime (`automation/runtime/*` via `automation/bin/serve.js`).

| Package | Dir | What |
|---|---|---|
| `@fp-automation/core` | `sdk/core` | transport (HTTP REST + WS push), types, error mapping, capability handshake |
| `@fp-automation/browser` | `sdk/browser` | page / cookies / storage / network / download / upload / dialog facade |
| `@fp-automation/tasks` | `sdk/tasks` | task/queue/schedule submit + poll-to-terminal |
| `@fp-automation/rpa` | `sdk/rpa` | RPA AST builder/serializer (same schema as `automation/runtime/rpa-ast.js`) |

## Quick start

```js
const { connect } = require('@fp-automation/core'); // or require('./sdk/core')
const client = await connect({ url: 'http://127.0.0.1:PORT', token: 'TOKEN' });
await client.status();                       // capability handshake done at connect()
await client.scripts.create({ name: 'demo' });
await client.close();
```

## Verify

```powershell
node sdk/core/test/smoke.js
node sdk/browser/test/smoke.js
node sdk/tasks/test/smoke.js
node sdk/rpa/test/smoke.js
node sdk/test/acceptance.js
```

Full manifest: `docs/automation-research/18-delivery-manifest.md`.
