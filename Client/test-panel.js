#!/usr/bin/env node
// Verify fingerprint panel is NOT covered by the BrowserView when open.
// Simulates Client's main-process logic: open panel => BrowserView shrinks.
'use strict';

const { app, BrowserWindow, BrowserView } = require('electron');

// The geometry under test comes from layout.js - the SAME module main.js uses.
// This file used to re-implement resizeActiveView(), and the copy had drifted:
// it renamed TOP_HEIGHT and dropped the STATUS_HEIGHT subtraction. Asserting
// against a re-implementation can only be accidentally right, and stays right
// only while nobody touches either side.
const { PANEL_WIDTH, viewBounds } = require('./layout');

const WIN_W = 1400, WIN_H = 900;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WIN_W, height: WIN_H, webPreferences: { sandbox: false } });
  await win.loadFile(__dirname + '/renderer/index.html');
  await new Promise(r => setTimeout(r, 400));

  // Simulate the Client tab: a BrowserView covering the window
  const view = new BrowserView({ webPreferences: { sandbox: false } });
  win.addBrowserView(view);

  let panelOpen = false;
  // Thin adapter: the shared function is pure, so this only supplies the
  // window's live content size. There is no geometry left to drift.
  function resizeActiveView() {
    const [w, h] = win.getContentSize();
    view.setBounds(viewBounds(w, h, panelOpen));
  }
  resizeActiveView();

  const contentW = win.getContentSize()[0]; // actual content width

  // Panel closed: BrowserView covers full width => panel area IS covered
  const boundsClosed = view.getBounds();
  const coversWhenClosed = boundsClosed.x + boundsClosed.width >= contentW - 2; // reaches right edge

  // Open panel (what setPanelState(true) triggers in main process)
  panelOpen = true;
  resizeActiveView();
  const boundsOpen = view.getBounds();
  const rightEdge = boundsOpen.x + boundsOpen.width;
  const panelStartX = contentW - PANEL_WIDTH;
  const notCoveredWhenOpen = rightEdge <= panelStartX + 2; // BrowserView ends before panel starts

  console.log(`contentW = ${contentW}`);
  console.log(`Panel CLOSED: BrowserView right edge = ${boundsClosed.x + boundsClosed.width}`);
  console.log(`Panel OPEN:   BrowserView right edge = ${rightEdge} (panel starts at x=${panelStartX})`);
  console.log(`  => panel area covered when closed: ${coversWhenClosed ? 'YES (bad)' : 'no'}`);
  console.log(`  => panel area covered when open:   ${notCoveredWhenOpen ? 'NO (good, clickable)' : 'YES (bad)'}`);

  const ok = coversWhenClosed && notCoveredWhenOpen;
  console.log(ok ? '\nPASS: panel is revealed & clickable when open' : '\nFAIL: panel still covered');

  win.close();
  app.exit(ok ? 0 : 1);
});

setTimeout(() => { console.error('timeout'); app.exit(2); }, 10000);
