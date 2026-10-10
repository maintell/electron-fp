// ponytail: 11 builtin templates as data; install() copies into a store as real Script (copy→edit→save→run lifecycle = store versioning).
'use strict';

// code = async main body; SDK globals only (browser/page/cookies/storage/download/upload/params/context + ScriptError); smart waits, no sleep/require
const TEMPLATES = [
  {
    key: 'open-website',
    name: 'Open Website',
    description: 'Navigate to a URL and log the page title.',
    category: 'navigation',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [{ name: 'url', type: 'string', required: true }],
    code: `
await browser.goto(params.url);
console.log('loaded title=' + (await browser.getTitle()));
`,
  },
  {
    key: 'login',
    name: 'Login',
    description: 'Fill credentials on a login form, wait for redirect, fail on error marker.',
    category: 'auth',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'loginUrl', type: 'string', required: true },
      { name: 'account', type: 'string', required: true },
      { name: 'password', type: 'secret', required: true },
      { name: 'accountSelector', type: 'string', required: false, default: '#username' },
      { name: 'passwordSelector', type: 'string', required: false, default: '#password' },
      { name: 'submitSelector', type: 'string', required: false, default: 'button[type="submit"]' },
      { name: 'statusSelector', type: 'string', required: false, default: '.status' },
    ],
    code: `
await browser.goto(params.loginUrl);
await page.waitForSelector(params.accountSelector);
await page.fill(params.accountSelector, params.account);
await page.fill(params.passwordSelector, params.password);
await page.click(params.submitSelector);
await page.waitForURL(/dashboard|error/);
const status = await page.getText(params.statusSelector);
if (/error|fail/i.test(status)) throw new ScriptError('login failed: ' + status);
console.log('login ok: ' + status);
`,
  },
  {
    key: 'form-submit',
    name: 'Form Submit',
    description: 'Fill fields from a JSON map and submit the form.',
    category: 'forms',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'fields', type: 'JSON', required: true },
      { name: 'submitSelector', type: 'string', required: false, default: 'button[type="submit"]' },
    ],
    code: `
await browser.goto(params.url);
await page.waitForSelector(params.submitSelector);
for (const key of Object.keys(params.fields)) {
  await page.fill(key, String(params.fields[key]));
}
await Promise.all([
  page.waitForNavigation().catch(() => {}),
  page.click(params.submitSelector),
]);
console.log('submitted url=' + (await browser.getCurrentUrl()));
`,
  },
  {
    key: 'data-extraction',
    name: 'Data Extraction',
    description: 'Collect text of up to 50 list items and log them as JSON.',
    category: 'data',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'itemSelector', type: 'string', required: true },
      { name: 'max', type: 'number', required: false, default: 50 },
    ],
    code: `
// adapter routes page.evaluate via isolated world by default; DOM-domain page.querySelector API is P1 (no new SDK surface here).
await browser.goto(params.url);
await page.waitForSelector(params.itemSelector);
const cap = Math.min(Number(params.max) || 50, 50);
const texts = await page.evaluate((sel, limit) => {
  const out = [];
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && i < limit; i++) {
    out.push((nodes[i].textContent || '').trim());
  }
  return out;
}, params.itemSelector, cap);
console.log(JSON.stringify(texts));
`,
  },
  {
    key: 'cookie-export',
    name: 'Cookie Export',
    description: 'Export all cookies of the current profile partition as JSON.',
    category: 'utility',
    permissions: { browser: true, cookies: true, filesystem: false, process: false },
    parameters: [],
    code: `
const all = await cookies.get();
console.log(JSON.stringify(all));
`,
  },
  {
    key: 'screenshot',
    name: 'Screenshot',
    description: 'Open a URL and save a screenshot.',
    category: 'utility',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'path', type: 'string', required: true },
      { name: 'fullPage', type: 'boolean', required: false, default: false },
    ],
    code: `
await browser.goto(params.url);
const buf = await browser.screenshot({ path: params.path, fullPage: params.fullPage === true });
console.log('screenshot ok path=' + params.path + ' bytes=' + buf.length);
`,
  },
  {
    key: 'page-monitor',
    name: 'Page Monitor',
    description: 'Wait for a marker element and compare its text against expected value.',
    category: 'monitoring',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'markerSelector', type: 'string', required: true },
      { name: 'expect', type: 'string', required: true },
    ],
    code: `
await browser.goto(params.url);
await page.waitForSelector(params.markerSelector);
const text = (await page.getText(params.markerSelector)).trim();
if (text === String(params.expect).trim()) {
  console.log('match: ' + text);
} else {
  console.log('mismatch: got="' + text + '" expect="' + params.expect + '"');
}
`,
  },
  {
    key: 'element-monitor',
    name: 'Element Monitor',
    description: 'Wait until a selector becomes visible; throw ScriptError on timeout.',
    category: 'monitoring',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'selector', type: 'string', required: true },
      { name: 'timeout', type: 'number', required: false, default: 10000 },
    ],
    code: `
await browser.goto(params.url);
try {
  await page.waitForSelector(params.selector, { state: 'visible', timeout: Number(params.timeout) || 10000 });
} catch (err) {
  throw new ScriptError('element not found: ' + params.selector);
}
console.log('element visible: ' + params.selector);
`,
  },
  {
    key: 'file-download',
    name: 'File Download',
    description: 'Wait for a download matching a pattern and save it to a path.',
    category: 'files',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'pattern', type: 'string', required: true },
      { name: 'path', type: 'string', required: true },
      { name: 'timeout', type: 'number', required: false, default: 30000 },
    ],
    code: `
await browser.goto(params.url);
const dl = await download.wait(params.pattern, { timeout: Number(params.timeout) || 30000 });
const saved = await download.save(dl, params.path);
console.log('saved ' + saved);
`,
  },
  {
    key: 'file-upload',
    name: 'File Upload',
    description: 'Attach files (JSON array of paths) to an input, submit, wait for done URL.',
    category: 'files',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'fileSelector', type: 'string', required: true },
      { name: 'files', type: 'JSON', required: true },
      { name: 'submitSelector', type: 'string', required: false, default: 'button[type="submit"]' },
    ],
    code: `
await browser.goto(params.url);
await page.waitForSelector(params.fileSelector);
await upload.setFiles(params.fileSelector, params.files);
await page.click(params.submitSelector);
await page.waitForURL(/done|success/);
console.log('upload done');
`,
  },
  {
    key: 'multi-step-workflow',
    name: 'Multi-step Workflow',
    description: 'Linear flow: goto, fill login-ish fields, click, read result text.',
    category: 'workflow',
    permissions: { browser: true, filesystem: false, process: false },
    parameters: [
      { name: 'url', type: 'string', required: true },
      { name: 'account', type: 'string', required: true },
      { name: 'password', type: 'secret', required: true },
      { name: 'accountSelector', type: 'string', required: false, default: '#username' },
      { name: 'passwordSelector', type: 'string', required: false, default: '#password' },
      { name: 'submitSelector', type: 'string', required: false, default: 'button[type="submit"]' },
      { name: 'resultSelector', type: 'string', required: false, default: '.result' },
    ],
    code: `
await browser.goto(params.url);
await page.waitForSelector(params.accountSelector);
await page.fill(params.accountSelector, params.account);
await page.fill(params.passwordSelector, params.password);
await page.click(params.submitSelector);
await page.waitForURL(/dashboard|error/);
const result = await page.getText(params.resultSelector);
console.log('workflow result: ' + result);
`,
  },
];

function installTemplates(store, { prefix = '[Template] ' } = {}) {
  const installed = [];
  let skipped = 0;
  const names = new Set(store.list().map((s) => s.name));
  for (const t of TEMPLATES) {
    const name = prefix + t.name;
    if (names.has(name)) {
      skipped += 1;
      continue;
    }
    const s = store.create({
      name,
      description: t.description,
      category: t.category,
      permissions: t.permissions,
      parameters: t.parameters,
    });
    store.addVersion(s.id, t.code);
    names.add(name);
    installed.push(s.id);
  }
  return { installed, skipped };
}

function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key);
}

module.exports = { TEMPLATES, installTemplates, getTemplate };
