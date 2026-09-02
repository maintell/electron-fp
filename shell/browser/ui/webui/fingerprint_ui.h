// Copyright (c) 2026 Microsoft, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE.

#ifndef ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_H_
#define ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_H_

#include <memory>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/web_ui_message_handler.h"

namespace content {
class BrowserContext;
}

namespace electron {

// Serves the live profile data to the page over WebUI IPC.
//
// A separate handler rather than making FingerprintUI itself a
// WebUIMessageHandler: WebUIMessageHandler is abstract, and mixing it into the
// controller turns the controller into an abstract type that can no longer be
// constructed by CreateWebUIControllerForURL.
class FingerprintUIMessageHandler : public content::WebUIMessageHandler {
 public:
  explicit FingerprintUIMessageHandler(content::BrowserContext* context)
      : context_(context) {}
  ~FingerprintUIMessageHandler() override = default;

  FingerprintUIMessageHandler(const FingerprintUIMessageHandler&) = delete;
  FingerprintUIMessageHandler& operator=(const FingerprintUIMessageHandler&) =
      delete;

  void RegisterMessages() override;

 private:
  void HandleRequestInspectorData(const base::ListValue& args);

  raw_ptr<content::BrowserContext> context_;
};

// Serves the fingerprint Inspector at electron://fingerprint/.
//
// The Inspector exists because a fingerprint is judged as a whole. Individual
// surfaces each have their own test, but nothing showed what a PROFILE looks
// like across all of them at once - or whether it contradicts itself. This page
// renders a profile's coverage per group and the result of the cross-layer
// consistency check, which is the thing no single-surface test can express.
//
// It is a first-class electron:// WebUI rather than a page inside the app so
// that it is (a) available to any app, including one that never opts in, and
// (b) served from a privileged origin the app's own code cannot rewrite. An
// inspector whose numbers the code under inspection can change is worthless as
// a diagnostic.
class FingerprintUI : public content::WebUIController {
 public:
  explicit FingerprintUI(content::WebUI* web_ui);
  ~FingerprintUI() override;

  FingerprintUI(const FingerprintUI&) = delete;
  FingerprintUI& operator=(const FingerprintUI&) = delete;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_H_
