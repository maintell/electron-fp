// Copyright (c) 2017 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/electron_web_ui_controller_factory.h"

#include "base/memory/singleton.h"
#include "chrome/common/webui_url_constants.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui_controller.h"
#include "shell/browser/ui/devtools_ui.h"
#include "shell/browser/ui/webui/accessibility_ui.h"
#include "shell/browser/ui/webui/fingerprint_ui.h"

namespace electron {

namespace {

// Host of the fingerprint Inspector, served on the electron:// scheme.
//
// Not in chrome/common/webui_url_constants.h: that header enumerates Chrome's
// WebUI hosts, and listing this there would imply chrome://fingerprint works.
// It does not - only electron://fingerprint does.
constexpr char kElectronUIFingerprintHost[] = "fingerprint";

}  // namespace

// static
ElectronWebUIControllerFactory* ElectronWebUIControllerFactory::GetInstance() {
  return base::Singleton<ElectronWebUIControllerFactory>::get();
}

ElectronWebUIControllerFactory::ElectronWebUIControllerFactory() = default;

ElectronWebUIControllerFactory::~ElectronWebUIControllerFactory() = default;

content::WebUI::TypeID ElectronWebUIControllerFactory::GetWebUIType(
    content::BrowserContext* browser_context,
    const GURL& url) {
  // Host-only match, so the same controller serves any WebUI scheme that is
  // routed here. Scheme gating happens when the scheme is registered, not here.
  if (const std::string_view host = url.host();
      host == chrome::kChromeUIDevToolsHost ||
      host == chrome::kChromeUIAccessibilityHost ||
      host == kElectronUIFingerprintHost) {
    return this;
  }

  return content::WebUI::kNoWebUI;
}

bool ElectronWebUIControllerFactory::UseWebUIForURL(
    content::BrowserContext* browser_context,
    const GURL& url) {
  return GetWebUIType(browser_context, url) != content::WebUI::kNoWebUI;
}

std::unique_ptr<content::WebUIController>
ElectronWebUIControllerFactory::CreateWebUIControllerForURL(
    content::WebUI* web_ui,
    const GURL& url) {
  const std::string_view host = url.host();

  if (host == chrome::kChromeUIDevToolsHost) {
    auto* browser_context = web_ui->GetWebContents()->GetBrowserContext();
    return std::make_unique<DevToolsUI>(browser_context, web_ui);
  }

  if (host == chrome::kChromeUIAccessibilityHost)
    return std::make_unique<ElectronAccessibilityUI>(web_ui);

  if (host == kElectronUIFingerprintHost)
    return std::make_unique<FingerprintUI>(web_ui);

  return {};
}

}  // namespace electron
