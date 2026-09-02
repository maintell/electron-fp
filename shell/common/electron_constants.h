// Copyright (c) 2015 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_COMMON_ELECTRON_CONSTANTS_H_
#define ELECTRON_SHELL_COMMON_ELECTRON_CONSTANTS_H_

#include <string_view>

#include "base/strings/cstring_view.h"
#include "electron/buildflags/buildflags.h"

namespace electron {

// The app-command in NativeWindow.
inline constexpr std::string_view kBrowserForward = "browser-forward";
inline constexpr std::string_view kBrowserBackward = "browser-backward";

// Scheme for Electron's own privileged WebUIs (electron://fingerprint/).
//
// Registered as a WebUI scheme via
// ElectronBrowserClient::GetAdditionalWebUISchemes(), which is what makes
// content route it to ElectronWebUIControllerFactory and serve it from the
// browser process. Adding it to that list is the whole registration - but note
// that this scheme is NOT a standard/secure scheme for web content, so pages
// cannot be loaded from it by ordinary navigation.
inline constexpr char kElectronUIScheme[] = "electron";

// Keys for Device APIs
inline constexpr std::string_view kDeviceVendorIdKey = "vendorId";
inline constexpr std::string_view kDeviceProductIdKey = "productId";
inline constexpr std::string_view kDeviceSerialNumberKey = "serialNumber";

// Window state preference keys
inline constexpr std::string_view kLeft = "left";
inline constexpr std::string_view kTop = "top";
inline constexpr std::string_view kRight = "right";
inline constexpr std::string_view kBottom = "bottom";

inline constexpr std::string_view kMaximized = "maximized";
inline constexpr std::string_view kFullscreen = "fullscreen";
inline constexpr std::string_view kKiosk = "kiosk";

inline constexpr std::string_view kWorkAreaLeft = "workAreaLeft";
inline constexpr std::string_view kWorkAreaTop = "workAreaTop";
inline constexpr std::string_view kWorkAreaRight = "workAreaRight";
inline constexpr std::string_view kWorkAreaBottom = "workAreaBottom";

inline constexpr std::string_view kWindowStates = "windowStates";

inline constexpr base::cstring_view kRunAsNode = "ELECTRON_RUN_AS_NODE";

// Per-profile UUID to distinguish global shortcut sessions for
// org.freedesktop.portal.GlobalShortcuts. This is a counterpart to
// extensions::pref_names::kGlobalShortcutsUuid, which may be not defined
// if extensions are disabled.
inline constexpr char kElectronGlobalShortcutsUuid[] =
    "electron.global_shortcuts.uuid";

// Per-profile secret used to encrypt Touch ID WebAuthn credential metadata
// stored in the macOS keychain.
inline constexpr char kWebAuthnTouchIdMetadataSecretPrefName[] =
    "electron.webauthn.touchid.metadata_secret";

#if BUILDFLAG(ENABLE_PDF_VIEWER)
inline constexpr std::string_view kPDFExtensionPluginName =
    "Chromium PDF Viewer";
#endif  // BUILDFLAG(ENABLE_PDF_VIEWER)

}  // namespace electron

#endif  // ELECTRON_SHELL_COMMON_ELECTRON_CONSTANTS_H_
