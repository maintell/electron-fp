import io, difflib
from pathlib import Path

# ponytail: pathlib for cross-platform (Win+Linux), no hardcoded \ separators
base = Path(__file__).resolve().parent.parent / "build" / "src"
files = {
    'network.cc': str(base / "third_party" / "webrtc" / "rtc_base" / "network.cc"),
    'network.h': str(base / "third_party" / "webrtc" / "rtc_base" / "network.h"),
    'ipc_network_manager.cc': str(base / "third_party" / "blink" / "renderer" / "platform" / "p2p" / "ipc_network_manager.cc"),
    'port.cc': str(base / "third_party" / "webrtc" / "p2p" / "base" / "port.cc"),
    'stun_port.cc': str(base / "third_party" / "webrtc" / "p2p" / "base" / "stun_port.cc"),
    'fp_config_helpers.h': str(base / "third_party" / "blink" / "renderer" / "core" / "frame" / "fp_config_helpers.h"),
    'screen.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "frame" / "screen.cc"),
    'navigator_events.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "events" / "navigator_events.cc"),
    'base_audio_context.h': str(base / "third_party" / "blink" / "renderer" / "modules" / "webaudio" / "base_audio_context.h"),
    'webgl_rendering_context_base.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webgl" / "webgl_rendering_context_base.cc"),
    'navigator_concurrent_hardware.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "frame" / "navigator_concurrent_hardware.cc"),
    'navigator_device_memory.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "frame" / "navigator_device_memory.cc"),
    'audio_destination_node.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webaudio" / "audio_destination_node.cc"),
    'audio_context.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webaudio" / "audio_context.cc"),
    'navigator_do_not_track.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "donottrack" / "navigator_do_not_track.cc"),
    'geolocation.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "geolocation" / "geolocation.cc"),
    'speech_synthesis.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "speech" / "speech_synthesis.cc"),
    'media_devices.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "mediastream" / "media_devices.cc"),
    'html_canvas_element.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "html" / "canvas" / "html_canvas_element.cc"),
    'core_initializer.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "core_initializer.cc"),
    'font_face_set.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "css" / "font_face_set.cc"),
    'network_information.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "netinfo" / "network_information.cc"),
    'permissions.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "permissions" / "permissions.cc"),
    'storage_manager.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "quota" / "storage_manager.cc"),
    'permission_status.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "permissions" / "permission_status.cc"),
    'performance.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "timing" / "performance.cc"),
    'media_capabilities.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "media_capabilities" / "media_capabilities.cc"),
    'media_values.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "css" / "media_values.cc"),
    'offline_audio_context.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webaudio" / "offline_audio_context.cc"),
    'analyser_node.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webaudio" / "analyser_node.cc"),
    'base_rendering_context_2d.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "canvas" / "canvas2d" / "base_rendering_context_2d.cc"),
    'font_cache.cc': str(base / "third_party" / "blink" / "renderer" / "platform" / "fonts" / "font_cache.cc"),
    'battery_manager.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "battery" / "battery_manager.cc"),
    'gpu_adapter.cc': str(base / "third_party" / "blink" / "renderer" / "modules" / "webgpu" / "gpu_adapter.cc"),
    'element.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "dom" / "element.cc"),
    'offscreen_canvas.cc': str(base / "third_party" / "blink" / "renderer" / "core" / "offscreencanvas" / "offscreen_canvas.cc"),
}

CC_MARK = '// ---- fp: custom WebRTC IP ----'


def revert_network_cc(new):
    t = new
    t = t.replace('#include <cstring>\n#include <cstdio>\n#include <cstdlib>\n#include <map>',
                  '#include <cstring>\n#include <map>')
    start = t.find(CC_MARK)
    assert start >= 0, 'cc marker'
    s = t.rfind('\n', 0, start)
    e = t.find('#if defined(WEBRTC_POSIX)', start)
    assert e >= 0, 'cc end'
    t = t[:s] + t[e:]
    t = t.replace('\n    // fp: override host IPs before merging.\n    ApplyCustomWebRtcIp(list);\n    bool changed;',
                  '\n    bool changed;')
    return t


def revert_network_h(new):
    return new.replace(
        '// fp: override host candidate IPs (config/env driven).\nIPAddress GetCustomWebRtcIp();\nvoid ApplyCustomWebRtcIp(std::vector<std::unique_ptr<Network>>& list);\n',
        '')


def revert_ipc(new):
    t = new.replace('#include "third_party/webrtc/rtc_base/network.h"\n', '')
    t = t.replace('  // fp: override host IPs before merging.\n  webrtc::ApplyCustomWebRtcIp(networks);\n',
                  '')
    return t


def revert_port(new):
    t = new.replace('#include "p2p/base/port.h"\n#include "rtc_base/network.h"',
                    '#include "p2p/base/port.h"')
    old = '''  // fp: spoof host candidate address.
  {
    IPAddress custom_ip = GetCustomWebRtcIp();
    if (!custom_ip.IsNil() && c.is_local()) {
      c.set_address(SocketAddress(custom_ip, address.port()));
    }
  }
  // Set the relay protocol before computing the foundation field.'''
    repl = '  // Set the relay protocol before computing the foundation field.'
    t = t.replace(old, repl)
    old2 = '''bool Port::MaybeObfuscateAddress(const Candidate& c, bool is_final) {
  // fp: never obfuscate when a custom IP is active.
  if (!GetCustomWebRtcIp().IsNil()) {
    return false;
  }
  // TODO(bugs.webrtc.org/9723): Use a config to control the feature of IP
  // handling with mDNS.
  if (network_->GetMdnsResponder() == nullptr) {'''
    repl2 = '''bool Port::MaybeObfuscateAddress(const Candidate& c, bool is_final) {
  // TODO(bugs.webrtc.org/9723): Use a config to control the feature of IP
  // handling with mDNS.
  if (network_->GetMdnsResponder() == nullptr) {'''
    t = t.replace(old2, repl2)
    return t


def revert_stun(new):
    t = new.replace('#include "p2p/base/stun_port.h"\n#include "rtc_base/network.h"',
                    '#include "p2p/base/stun_port.h"')
    old = '''    SocketAddress related_address = socket_->GetLocalAddress();
    // fp: spoof srflx related address (leaks the real local IP).
    {
      IPAddress fp_ip = GetCustomWebRtcIp();
      if (!fp_ip.IsNil()) {
        related_address = SocketAddress(fp_ip, related_address.port());
      }
    }
    // If we can't stamp the related address correctly, empty it to avoid leak.'''
    repl = '''    SocketAddress related_address = socket_->GetLocalAddress();
    // If we can't stamp the related address correctly, empty it to avoid leak.'''
    t = t.replace(old, repl)
    return t


def revert_screen(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''int Screen::height() const {
  if (!DomWindow())
    return 0;
  int h = GetRect(/*available=*/false).height();
  int fp = FpConfigInt("screen_height", 0);
  return fp > 0 ? fp : h;
}

int Screen::width() const {
  if (!DomWindow())
    return 0;
  int w = GetRect(/*available=*/false).width();
  int fp = FpConfigInt("screen_width", 0);
  return fp > 0 ? fp : w;
}'''
    repl = '''int Screen::height() const {
  if (!DomWindow())
    return 0;
  return GetRect(/*available=*/false).height();
}

int Screen::width() const {
  if (!DomWindow())
    return 0;
  return GetRect(/*available=*/false).width();
}'''
    t = t.replace(old, repl)
    # colorDepth
    old = '''unsigned Screen::colorDepth() const {
  int fp = FpConfigInt("screen_color_depth", 0);
  if (fp > 0) {
    return static_cast<unsigned>(fp);
  }'''
    repl = 'unsigned Screen::colorDepth() const {'
    t = t.replace(old, repl)
    # availHeight
    old = '''  int h = GetRect(/*available=*/true).height();
  int fp = FpConfigInt("screen_avail_height", 0);
  return fp > 0 ? fp : h;'''
    repl = '''  return GetRect(/*available=*/true).height();'''
    t = t.replace(old, repl)
    # availWidth
    old = '''  int w = GetRect(/*available=*/true).width();
  int fp = FpConfigInt("screen_avail_width", 0);
  return fp > 0 ? fp : w;'''
    repl = '''  return GetRect(/*available=*/true).width();'''
    t = t.replace(old, repl)
    return t


def revert_nav_events(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''int32_t NavigatorEvents::maxTouchPoints(Navigator& navigator) {
  LocalDOMWindow* window = navigator.DomWindow();
  int real = window ? window->GetFrame()->GetSettings()->GetMaxTouchPoints() : 0;
  int fp = FpConfigInt("max_touch_points", 0);
  return fp > 0 ? fp : real;
}'''
    repl = '''int32_t NavigatorEvents::maxTouchPoints(Navigator& navigator) {
  LocalDOMWindow* window = navigator.DomWindow();
  return window ? window->GetFrame()->GetSettings()->GetMaxTouchPoints() : 0;
}'''
    t = t.replace(old, repl)
    return t


def revert_audio_h(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''  float sampleRate() const {
    int fp = blink::FpConfigInt("audio_sample_rate", 0);
    return fp > 0 ? static_cast<float>(fp) : destination_handler_->SampleRate();
  }'''
    repl = '  float sampleRate() const { return destination_handler_->SampleRate(); }'
    t = t.replace(old, repl)
    return t


def revert_webgl(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''  // fp: spoof common WebGL parameters.
  {
    int v = 0;
    switch (pname) {
      case GL_MAX_TEXTURE_SIZE:
        v = FpConfigInt("webgl_max_texture_size", 0);
        break;
      case GL_MAX_RENDERBUFFER_SIZE:
        v = FpConfigInt("webgl_max_renderbuffer_size", 0);
        break;
      case GL_MAX_VIEWPORT_DIMS: {
        int w = FpConfigInt("webgl_max_viewport_width", 0);
        int h = FpConfigInt("webgl_max_viewport_height", 0);
        if (w > 0 && h > 0)
          return WebGLAny(script_state, gfx::Size(w, h));
        break;
      }
      default:
        break;
    }
    if (v > 0)
      return WebGLAny(script_state, v);
  }
  const int kIntZero = 0;'''
    repl = '  const int kIntZero = 0;'
    t = t.replace(old, repl)
    return t


def revert_geo(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '    // fp: spoof coordinates from config.\n'
    old += '    device::mojom::blink::GeopositionPtr fp_pos =\n'
    old += '        result->get_position().Clone();\n'
    old += '    {\n'
    old += '      std::string fp_lat = FpConfigString("geo_latitude");\n'
    old += '      std::string fp_lng = FpConfigString("geo_longitude");\n'
    old += '      if (!fp_lat.empty() && !fp_lng.empty()) {\n'
    old += '        fp_pos->latitude = atof(fp_lat.c_str());\n'
    old += '        fp_pos->longitude = atof(fp_lng.c_str());\n'
    old += '      }\n'
    old += '      std::string fp_acc = FpConfigString("geo_accuracy");\n'
    old += '      if (!fp_acc.empty()) {\n'
    old += '        fp_pos->accuracy = atof(fp_acc.c_str());\n'
    old += '      }\n'
    old += '    }\n'
    old += '    last_position_ = CreateGeoposition(*fp_pos);\n'
    old += '    PositionChanged();'
    repl = '    last_position_ = CreateGeoposition(*result->get_position());\n'
    repl += '    PositionChanged();'
    t = t.replace(old, repl)
    return t

def revert_speech(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include "base/containers/span.h"\n', '')
    old = '  // fp: limit voice count and override language.\n'
    old += '  {\n'
    old += '    int fp_count = FpConfigInt("speech_voices_count", 0);\n'
    old += '    std::string fp_lang = FpConfigString("speech_voices_lang");\n'
    old += '    if (fp_count > 0 &&\n'
    old += '        fp_count < static_cast<int>(mojom_voices.size())) {\n'
    old += '      mojom_voices.resize(static_cast<wtf_size_t>(fp_count));\n'
    old += '    }\n'
    old += '    if (!fp_lang.empty()) {\n'
    old += '      for (auto& voice : mojom_voices) {\n'
    old += '        voice->lang = String::FromUtf8(base::as_byte_span(fp_lang));\n'
    old += '      }\n'
    old += '    }\n'
    old += '  }\n'
    t = t.replace(old, '')
    return t

def revert_media_devices(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    start = t.find('  // fp: limit device enumeration counts')
    if start != -1:
        end = t.find('  if (!video_input_capabilities.empty()) {', start)
        if end != -1:
            t = t[:start] + t[end:]
    # restore result loop references (fp_enumeration -> enumeration)
    t = t.replace('for (wtf_size_t j = 0; j < fp_enumeration[i].size(); ++j) {',
                  'for (wtf_size_t j = 0; j < enumeration[i].size(); ++j) {')
    t = t.replace('WebMediaDeviceInfo device_info = fp_enumeration[i][j];',
                  'WebMediaDeviceInfo device_info = enumeration[i][j];')
    return t

def revert_html_canvas_element(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '  scoped_refptr<StaticBitmapImage> image_bitmap = Snapshot(source_buffer);\n'
    old += '  FpApplyCanvasExportNoise(image_bitmap);\n'
    t = t.replace(old, '  scoped_refptr<StaticBitmapImage> image_bitmap = Snapshot(source_buffer);\n')
    old = '  scoped_refptr<StaticBitmapImage> image_bitmap = Snapshot(kBackBuffer);\n'
    old += '  FpApplyCanvasExportNoise(image_bitmap);\n'
    t = t.replace(old, '  scoped_refptr<StaticBitmapImage> image_bitmap = Snapshot(kBackBuffer);\n')
    return t

def revert_core_initializer(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include "base/containers/span.h"\n', '')
    start = t.find('  // fp: override default timezone from FP_CONFIG "tz_id"')
    if start != -1:
        end = t.find('  FontGlobalContext::Init();', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_font_face_set(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''    for (const FontFamily* f = &font->GetFontDescription().Family(); f;\n'''
    old += '''         f = f->Next()) {\n'''
    old += '''      // fp: blocklisted families report as missing to document.fonts.check.\n'''
    old += '''      if (FpFontFamilyBlocked(f->FamilyName().Utf8())) {\n'''
    old += '''        return false;\n'''
    old += '''      }\n'''
    t = t.replace(old, '')
    return t

def revert_webgl_m8(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include "third_party/blink/renderer/core/typed_arrays/dom_typed_array.h"\n', '')
    t = t.replace('#include <memory>\n#include <cstdlib>', '#include <memory>')
    # remove the whole fp spoof block (from the fp comment to kIntZero)
    start = t.find('  // fp: spoof common WebGL parameters.')
    if start != -1:
        end = t.find('  const int kIntZero = 0;', start)
        if end != -1:
            t = t[:start] + t[end:]
    # dom_typed_array.h include may have been added right after the webgl base header
    t = t.replace('#include "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.h"\n#include "third_party/blink/renderer/core/typed_arrays/dom_typed_array.h"',
                  '#include "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.h"')
    # getSupportedExtensions append block
    start = t.find('  // fp: append configured extra extensions.')
    if start != -1:
        end = t.find('  return result;', start)
        if end != -1:
            t = t[:start] + t[end:]
    # shader precision override
    start = t.find('  // fp: override highp precision values')
    if start != -1:
        end = t.find('  return MakeGarbageCollected<WebGLShaderPrecisionFormat>(range[0], range[1],', start)
        if end != -1:
            t = t[:start] + t[end:]
    t = t.replace('#include <cstdlib>\n#include <cstdio>', '#include <cstdlib>')
    return t

def revert_network_information(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    # type block
    start = t.find('  // fp: override from FP_CONFIG \"net_type\"')
    if start != -1:
        end = t.find('  if (RuntimeEnabledFeatures::NetInfoConstantTypeEnabled()) {', start)
        if end != -1:
            t = t[:start] + t[end:]
    # downlinkMax block
    start = t.find('  // fp: override from FP_CONFIG \"net_downlink_max_mbps\"')
    if start != -1:
        end = t.find('  if (RuntimeEnabledFeatures::NetInfoConstantTypeEnabled()) {', start)
        if end != -1:
            t = t[:start] + t[end:]
    # effectiveType block
    start = t.find('  // fp: override from FP_CONFIG \"net_effective_type\"')
    if start != -1:
        end = t.find('  MaybeShowWebHoldbackConsoleMsg();', start)
        if end != -1:
            t = t[:start] + t[end:]
    # rtt block
    start = t.find('  // fp: override from FP_CONFIG \"net_rtt_ms\"')
    if start != -1:
        end = t.find('  MaybeShowWebHoldbackConsoleMsg();', start)
        if end != -1:
            t = t[:start] + t[end:]
    # downlink block
    start = t.find('  // fp: override from FP_CONFIG \"net_downlink_mbps\"')
    if start != -1:
        end = t.find('  MaybeShowWebHoldbackConsoleMsg();', start)
        if end != -1:
            t = t[:start] + t[end:]
    # saveData block
    start = t.find('  // fp: override from FP_CONFIG \"net_save_data\"')
    if start != -1:
        end = t.find('  bool save_data =', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_permissions(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    return t

def revert_storage_manager(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    start = t.find('  // fp: override usage/quota from FP_CONFIG')
    if start != -1:
        end = t.find('  estimate->setUsage(usage_in_bytes);', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_permission_status(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''V8PermissionState PermissionStatus::state() const {\n'''
    old += '''  // fp: override from FP_CONFIG \"permissions_status\" (granted/prompt/denied)\n'''
    old += '''  // for all queried permissions. Intercepts the final read path.\n'''
    old += '''  {\n'''
    old += '''    std::string fp_ps = FpConfigString(\"permissions_status\");\n'''
    old += '''    if (!fp_ps.empty()) {\n'''
    old += '''      if (fp_ps == \"granted\") {\n'''
    old += '''        return V8PermissionState(V8PermissionState::Enum::kGranted);\n'''
    old += '''      }\n'''
    old += '''      if (fp_ps == \"denied\") {\n'''
    old += '''        return V8PermissionState(V8PermissionState::Enum::kDenied);\n'''
    old += '''      }\n'''
    old += '''      return V8PermissionState(V8PermissionState::Enum::kPrompt);\n'''
    old += '''    }\n'''
    old += '''  }\n'''
    t = t.replace(old, '')
    return t

def revert_performance(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include <limits>\n#include <cmath>', '#include <limits>')
    old = '''DOMHighResTimeStamp Performance::now() const {\n'''
    old += '''  DOMHighResTimeStamp fp_now =\n'''
    old += '''      MonotonicTimeToDOMHighResTimeStamp(base::TimeTicks::Now());\n'''
    old += '''  // fp: reduce timestamp precision from FP_CONFIG \"perf_now_precision_ms\"\n'''
    old += '''  // (quantize to fixed absolute grid; monotonicity is preserved).\n'''
    old += '''  int fp_prec = FpConfigInt(\"perf_now_precision_ms\", 0);\n'''
    old += '''  if (fp_prec > 1) {\n'''
    old += '''    fp_now = std::round(fp_now / fp_prec) * fp_prec;\n'''
    old += '''  }\n'''
    old += '''  return fp_now;\n'''
    old += '''}\n'''
    repl = '''DOMHighResTimeStamp Performance::now() const {\n'''
    repl += '''  return MonotonicTimeToDOMHighResTimeStamp(base::TimeTicks::Now());\n'''
    repl += '''}\n'''
    t = t.replace(old, repl)
    return t

def revert_media_capabilities(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    start = t.find('  // fp: force unsupported for codecs listed in FP_CONFIG')
    if start != -1:
        end = t.find('  if (is_webrtc) {', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_media_values(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''mojom::blink::PreferredColorScheme MediaValues::CalculatePreferredColorScheme(\n'''
    old += '''    LocalFrame* frame) {\n'''
    old += '''  // fp: override from FP_CONFIG \"prefers_color_scheme\" (light/dark).\n'''
    old += '''  {\n'''
    old += '''    std::string fp_pcs = FpConfigString(\"prefers_color_scheme\");\n'''
    old += '''    if (fp_pcs == \"dark\") {\n'''
    old += '''      return mojom::blink::PreferredColorScheme::kDark;\n'''
    old += '''    }\n'''
    old += '''    if (fp_pcs == \"light\") {\n'''
    old += '''      return mojom::blink::PreferredColorScheme::kLight;\n'''
    old += '''    }\n'''
    old += '''  }\n'''
    t = t.replace(old, '')
    return t

def revert_offline_audio_context(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    start = t.find('    // fp: deterministic noise on offline render output')
    if start != -1:
        end = t.find('    DispatchEvent(*OfflineAudioCompletionEvent::Create(rendered_buffer));', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_analyser_node(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    noise = '''\n  // fp: deterministic noise on analyser float output (audio fingerprint).\n'''
    noise += '''  FpApplyAudioDataNoise(array->Data(), array->length());\n'''
    t = t.replace(noise, '')
    return t

def revert_base_rendering_context_2d(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    start = t.find('  // fp: deterministic per-font-family metric perturbation')
    if start != -1:
        end = t.find('  // Scale text metrics if enabled', start)
        if end != -1:
            t = t[:start] + t[end:]
    # getImageData noise
    start = t.find('    // fp: deterministic noise on getImageData readback')
    if start != -1:
        end = t.find('    if (read_pixels_successful && RuntimeEnabledFeatures::FingerprintingCanvasImageDataNoiseEnabled()) {', start)
        # restore to the original block start (find backwards from the fp comment)
        end2 = t.find('    }\n', start)
        if end2 != -1:
            t = t[:start] + t[end2 + len('    }\n'):]
    return t

def revert_font_cache(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''const SimpleFontData* FontCache::GetFontData(\n'''
    old += '''    const FontDescription& font_description,\n'''
    old += '''    const AtomicString& family,\n'''
    old += '''    AlternateFontName altername_font_name) {\n'''
    old += '''  // fp: hide configured fonts at the font-matching source. Returning\n'''
    old += '''  // nullptr triggers the normal fallback chain, so check() AND metric\n'''
    old += '''  // probing (span/measureText width) both see the font as absent, and\n'''
    old += '''  // layout stays self-consistent (no JS-level hooks).\n'''
    old += '''  if (FpFontFamilyHidden(family.Utf8())) {\n'''
    old += '''    return nullptr;\n'''
    old += '''  }\n'''
    t = t.replace(old, '')
    return t

def revert_battery_manager(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include <utility>\n#include <cstdlib>', '#include <utility>')
    start = t.find('  // fp: override from FP_CONFIG \"battery_charging\"')
    if start != -1:
        end = t.find('  return battery_status_.Charging();', start)
        if end != -1:
            t = t[:start] + t[end:]
    start = t.find('  // fp: override from FP_CONFIG \"battery_level\"')
    if start != -1:
        end = t.find('  return battery_status_.Level();', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_gpu_adapter(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    t = t.replace('#include "base/containers/span.h"\n', '')
    start = t.find('  // fp: override WebGPU adapter metadata.')
    if start != -1:
        end = t.find('  if (supportsPropertiesD3D) {', start)
        if end != -1:
            t = t[:start] + t[end:]
    return t

def revert_element(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''    gfx::RectF fp_rect = quad.BoundingBox();\n'''
    old += '''    // fp: deterministic subpixel perturbation (rasterizer fingerprint).\n'''
    old += '''    FpPerturbRectF(fp_rect);\n'''
    old += '''    result.emplace_back(fp_rect);'''
    t = t.replace(old, '    result.emplace_back(quad.BoundingBox());')
    idx = t.find('  // fp: deterministic subpixel perturbation (rasterizer fingerprint).\n')
    if idx != -1:
        t = t[:idx] + t[idx + len('  // fp: deterministic subpixel perturbation (rasterizer fingerprint).\n  FpPerturbRectF(result);\n'):]
    return t

def revert_offscreen_canvas(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''  // fp: deterministic export noise on OffscreenCanvas path (Worker/\n'''
    old += '''  // OffscreenCanvas fingerprint surface; same seed/strength semantics as\n'''
    old += '''  // HTMLCanvasElement toDataURL/toBlob).\n'''
    old += '''  FpApplyCanvasExportNoise(image_bitmap);\n'''
    t = t.replace(old, '')
    return t

def revert_b1_hw(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  int fp = FpConfigInt("hardware_concurrency", 0);
  if (fp > 0) {
    return static_cast<unsigned>(fp);
  }
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());
}'''
    repl = '''unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());
}'''
    return t.replace(old, repl)


def revert_b1_dm(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''float NavigatorDeviceMemory::deviceMemory() const {
  int fp = FpConfigInt("device_memory", 0);
  if (fp > 0) {
    return static_cast<float>(fp);
  }
  return ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
}'''
    repl = '''float NavigatorDeviceMemory::deviceMemory() const {
  return ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
}'''
    return t.replace(old, repl)


def revert_b1_screen(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''  int h = GetRect(/*available=*/true).height();
  int fp = FpConfigInt("screen_avail_height", 0);
  return fp > 0 ? fp : h;'''
    repl = '''  return GetRect(/*available=*/true).height();'''
    t = t.replace(old, repl)
    old2 = '''  int w = GetRect(/*available=*/true).width();
  int fp = FpConfigInt("screen_avail_width", 0);
  return fp > 0 ? fp : w;'''
    repl2 = '''  return GetRect(/*available=*/true).width();'''
    t = t.replace(old2, repl2)
    old3 = '''unsigned Screen::colorDepth() const {
  int fp = FpConfigInt("screen_color_depth", 0);
  if (fp > 0) {
    return static_cast<unsigned>(fp);
  }'''
    repl3 = 'unsigned Screen::colorDepth() const {'
    t = t.replace(old3, repl3)
    return t


def revert_b1_audio(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''uint32_t AudioDestinationNode::maxChannelCount() const {
  int fp = FpConfigInt("audio_max_channels", 0);
  if (fp > 0) {
    return static_cast<uint32_t>(fp);
  }
  return GetAudioDestinationHandler().MaxChannelCount();
}'''
    repl = '''uint32_t AudioDestinationNode::maxChannelCount() const {
  return GetAudioDestinationHandler().MaxChannelCount();
}'''
    t = t.replace(old, repl)
    old2 = '''  int fp_lat = FpConfigInt("audio_output_latency_ms", 0);
  if (fp_lat > 0) {
    return static_cast<double>(fp_lat) / 1000.0;
  }
  double factor = GetOutputLatencyQuantizingFactor();'''
    repl2 = '''  double factor = GetOutputLatencyQuantizingFactor();'''
    t = t.replace(old2, repl2)
    return t


def revert_b1_dnt(new):
    t = new.replace('#include "third_party/blink/renderer/core/frame/fp_config_helpers.h"\n', '')
    old = '''String doNotTrack(Navigator& navigator) {
  std::string fp = FpConfigString("do_not_track");
  if (!fp.empty()) {
    return String::FromUTF8(fp);
  }
  LocalDOMWindow* window = navigator.DomWindow();
  return window ? window->GetFrame()->Client()->DoNotTrackValue() : String();
}'''
    repl = '''String doNotTrack(Navigator& navigator) {
  LocalDOMWindow* window = navigator.DomWindow();
  return window ? window->GetFrame()->Client()->DoNotTrackValue() : String();
}'''
    return t.replace(old, repl)


reverts = {
    'network.cc': revert_network_cc,
    'network.h': revert_network_h,
    'ipc_network_manager.cc': revert_ipc,
    'port.cc': revert_port,
    'stun_port.cc': revert_stun,
    'screen.cc': revert_screen,
    'navigator_events.cc': revert_nav_events,
    'base_audio_context.h': revert_audio_h,
    'navigator_concurrent_hardware.cc': revert_b1_hw,
    'navigator_device_memory.cc': revert_b1_dm,
    'audio_destination_node.cc': revert_b1_audio,
    'audio_context.cc': revert_b1_audio,
    'navigator_do_not_track.cc': revert_b1_dnt,
    'geolocation.cc': revert_geo,
    'speech_synthesis.cc': revert_speech,
    'media_devices.cc': revert_media_devices,
    'html_canvas_element.cc': revert_html_canvas_element,
    'webgl_rendering_context_base.cc': revert_webgl_m8,
    'core_initializer.cc': revert_core_initializer,
    'font_face_set.cc': revert_font_face_set,
    'network_information.cc': revert_network_information,
    'permissions.cc': revert_permissions,
    'storage_manager.cc': revert_storage_manager,
    'permission_status.cc': revert_permission_status,
    'performance.cc': revert_performance,
    'media_capabilities.cc': revert_media_capabilities,
    'media_values.cc': revert_media_values,
    'offline_audio_context.cc': revert_offline_audio_context,
    'analyser_node.cc': revert_analyser_node,
    'base_rendering_context_2d.cc': revert_base_rendering_context_2d,
    'font_cache.cc': revert_font_cache,
    'battery_manager.cc': revert_battery_manager,
    'gpu_adapter.cc': revert_gpu_adapter,
    'element.cc': revert_element,
    'offscreen_canvas.cc': revert_offscreen_canvas,
}

header = ('''# ============================================================================\n'''
          '# fp-fingerprint.patch - fingerprint browser patches\n'
          '#\n'
          '# PURPOSE: controllable fingerprint spoofing for a multi-language\n'
          '# automation browser. Every behavior is driven by FP_CONFIG (JSON via\n'
          '# FP_CONFIG_DATA env or FP_CONFIG file, plus FP_<KEY> env fallbacks),\n'
          '# see fp_config_helpers.h (OWN FILE - never conflicts on upgrade).\n'
          '# With no config, the browser behaves 100% stock (zero intervention).\n'
          '#\n'
          '# MERGE/UPGRADE GUIDE (new Chromium versions):\n'
          '#   - Applied with patch.exe (patches/series). Any hunk mismatch aborts\n'
          '#     loudly - nothing is silently skipped.\n'
          '#   - After adapting hunks, regenerate with gen_patch6.py: it rewrites\n'
          '#     this documentation + per-file docs from the source of truth and\n'
          '#     runs a completeness check (all 59 known config keys must be\n'
          '#     present in the patch) - missing keys abort generation.\n'
          '#   - Risk legend per file below: LOW = stable getter anchors; MEDIUM =\n'
          '#     occasionally refactored modules; HIGH = frequently changing\n'
          '#     internals (WebGL/Canvas/WebRTC) - expect manual hunk adaptation.\n'
          '#   - After merging, run the CDP smoke/regression suite (verifies\n'
          '#     behavior, not just compilation).\n'
          '# ============================================================================#\n\n')

PATCH_DOCS = {
    'offscreen_canvas.cc': (
        '# --- third_party/blink/renderer/core/offscreencanvas/offscreen_canvas.cc ---\n'
        '# RANGE: OffscreenCanvas::convertToBlob (post GetImage).\n'
        '# PURPOSE: deterministic export noise on the Worker/OffscreenCanvas\n'
        '# fingerprint path - same FpApplyCanvasExportNoise semantics as\n'
        '# HTMLCanvasElement (canvas_noise_seed/strength). getImageData and\n'
        '# measureText already covered via shared BaseRenderingContext2D.\n'
        '# MERGE: MEDIUM - offscreen canvas refactors; anchor on convertToBlob.\n'),

    'battery_manager.cc': (
        '# --- third_party/blink/renderer/modules/battery/battery_manager.cc ---\n'
        '# RANGE: BatteryManager::charging() / level().\n'
        '# PURPOSE: spoof Battery API (battery_charging true/false,\n'
        '# battery_level 0.0-1.0).\n'
        '# MERGE: MEDIUM - battery module churn; anchor on the two getters.\n'),

    'element.cc': (
        '# --- third_party/blink/renderer/core/dom/element.cc ---\n'
        '# RANGE: GetClientRectsNoAdjustment + GetBoundingClientRectNoLifecycle\n'
        '# UpdateNoAdjustment.\n'
        '# PURPOSE: deterministic subpixel perturbation on rect API output\n'
        '# (client_rects_seed) - rasterizer fingerprint defense; layout\n'
        '# itself untouched (API-layer only), <0.2px.\n'
        '# MERGE: MEDIUM - DOM refactors; anchor on the two rect methods.\n'),

    'gpu_adapter.cc': (
        '# --- third_party/blink/renderer/modules/webgpu/gpu_adapter.cc ---\n'
        '# RANGE: adapter info population (vendor/architecture/device/description)\n'
        '# + features/limits population in the GPUAdapter ctor.\n'
        '# PURPOSE: spoof WebGPU adapter metadata (webgpu_vendor/architecture/\n'
        '# device/description). Keep webgpu_vendor consistent with webgl_vendor\n'
        '# (cross-API consistency - mismatch is itself a detection signal).\n'
        '# Also override the exposed feature set (webgpu_features, REPLACE) and\n'
        '# adapter limits (webgpu_limits, MERGE) so the declared GPU model is\n'
        '# self-consistent (constraint C17).\n'
        '# MERGE: MEDIUM - WebGPU module churn; anchor on GPUAdapter ctor info\n'
        '# population.\n'),

    'font_cache.cc': (
        '# --- third_party/blink/renderer/platform/fonts/font_cache.cc ---\n'
        '# RANGE: FontCache::GetFontData entry.\n'
        '# PURPOSE: hide configured fonts at the font-matching source -\n'
        '# nullptr triggers the normal fallback chain so check() AND metric\n'
        '# probing (span/measureText) both see the font as absent; layout\n'
        '# stays self-consistent (no JS hooks). Generic families always\n'
        '# exempt; web fonts bypass FontCache.\n'
        '# CONFIG: fonts_whitelist (whitelist wins), fonts_blocklist.\n'
        '# MERGE: HIGH risk - font matching internals refactor often;\n'
        '# anchor on FontCache::GetFontData signature.\n'),

    'base_rendering_context_2d.cc': (
        '# --- third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc ---\n'
        '# RANGE: measureText (post TextMetrics construction).\n'
        '# PURPOSE: deterministic per-font-family metric perturbation\n'
        '# (measure_text_seed); factor from (seed, family) so relative widths\n'
        '# across families drift - metric-based fingerprinting unstable vs\n'
        '# real browser, deterministic across sessions.\n'
        '# CONFIG: measure_text_seed (int64).\n'
        '# MERGE: HIGH risk - canvas module refactors frequent; anchor on\n'
        '# BaseRenderingContext2D::measureText.\n'),

    'offline_audio_context.cc': (
        '# --- third_party/blink/renderer/modules/webaudio/offline_audio_context.cc ---\n'
        '# RANGE: offline render completion (before event dispatch/resolve).\n'
        '# PURPOSE: deterministic noise on rendered buffer (audio fingerprint,\n'
        '# fingerprintjs-style OfflineAudioContext path).\n'
        '# CONFIG: audio_data_seed (int64), audio_data_strength (float, default\n'
        '# 0.0005).\n'
        '# MERGE: MEDIUM - anchor on the completion callback block; only touches\n'
        '# offline render output, never playback buffers.\n'),
    'analyser_node.cc': (
        '# --- third_party/blink/renderer/modules/webaudio/analyser_node.cc ---\n'
        '# RANGE: getFloatFrequencyData / getFloatTimeDomainData.\n'
        '# PURPOSE: deterministic noise on analyser float reads (real-time audio\n'
        '# fingerprint path; playback unaffected - analyser is read-only).\n'
        '# CONFIG: audio_data_seed / audio_data_strength.\n'
        '# MERGE: MEDIUM - anchor on the two float getter methods.\n'),
'network.cc': '# --- third_party/webrtc/rtc_base/network.cc ---\n# RANGE: NetworkManager::GetCustomWebRtcIp() + helpers (config read).\n# PURPOSE: custom WebRTC IP override source (webrtc_ip).\n# CONFIG: webrtc_ip (JSON or FP_WEBRTC_IP env).\n# MERGE: HIGH risk - WebRTC is a separate repo; network.cc refactors\n# frequently. Re-anchor on NetworkManager class methods.\n', 'network.h': '# --- third_party/webrtc/rtc_base/network.h ---\n# RANGE: NetworkManager interface (GetCustomWebRtcIp exposure).\n# PURPOSE: declare custom IP hook used by network.cc.\n# MERGE: HIGH risk (WebRTC), keep in sync with network.cc changes.\n', 'ipc_network_manager.cc': '# --- third_party/blink/renderer/platform/p2p/ipc_network_manager.cc ---\n# RANGE: network IP list rewrite (IpcNetworkManager).\n# PURPOSE: replace host network IPs with configured webrtc_ip so\n# local-IP leakage via ICE/network enumeration is closed.\n# CONFIG: webrtc_ip.\n# MERGE: MEDIUM - anchor on IpcNetworkManager::GetNetworks.\n', 'port.cc': '# --- third_party/webrtc/p2p/base/port.cc ---\n# RANGE: candidate local address override (Port::GetLocalAddress).\n# PURPOSE: host candidate IP spoofing (webrtc_ip).\n# MERGE: HIGH risk (WebRTC); anchor on Port class address getters.\n', 'stun_port.cc': '# --- third_party/webrtc/p2p/base/stun_port.cc ---\n# RANGE: srflx candidate IP override (StunPort).\n# PURPOSE: server-reflexive candidate IP spoofing (webrtc_ip).\n# MERGE: HIGH risk (WebRTC); anchor on StunPort::PrepareAddress.\n', 'fp_config_helpers.h': '# --- third_party/blink/renderer/core/frame/fp_config_helpers.h (OWN FILE) ---\n# RANGE: whole file - config reading infrastructure + shared helpers\n# (FpConfigInt/String/Int64, FpFontFamilyBlocked, canvas noise fn).\n# PURPOSE: single source of truth for FP_CONFIG; never conflicts on\n# upstream upgrade (new file). Keep all new helpers here.\n', 'screen.cc': '# --- third_party/blink/renderer/core/frame/screen.cc ---\n# RANGE: Screen::width/height/availWidth/availHeight/colorDepth.\n# PURPOSE: spoof screen metrics (screen_width/height/avail_*/color_depth).\n# CONFIG: screen_width, screen_height, screen_avail_width,\n# screen_avail_height, screen_color_depth.\n# MERGE: LOW - stable getter functions.\n', 'navigator_events.cc': '# --- third_party/blink/renderer/core/events/navigator_events.cc ---\n# RANGE: NavigatorEvents::maxTouchPoints.\n# PURPOSE: spoof touch support (max_touch_points).\n# MERGE: LOW.\n', 'base_audio_context.h': '# --- third_party/blink/renderer/modules/webaudio/base_audio_context.h ---\n# RANGE: sample rate plumbing for fp override.\n# PURPOSE: allow audio_sample_rate spoofing.\n# MERGE: MEDIUM - audio module refactors; keep header/impl in sync.\n', 'audio_context.cc': '# --- third_party/blink/renderer/modules/webaudio/audio_context.cc ---\n# RANGE: AudioContext::sampleRate.\n# PURPOSE: spoof audio sample rate (audio_sample_rate).\n# MERGE: MEDIUM.\n', 'audio_destination_node.cc': '# --- third_party/blink/renderer/modules/webaudio/audio_destination_node.cc ---\n# RANGE: destination maxChannelCount/outputLatency.\n# PURPOSE: spoof audio channels and latency (audio_max_channels,\n# audio_output_latency_ms).\n# MERGE: MEDIUM.\n', 'webgl_rendering_context_base.cc': '# --- third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc ---\n# RANGE: getParameter (MAX_TEXTURE/RENDERBUFFER/VIEWPORT_DIMS,\n# ALIASED_POINT/LINE_WIDTH_RANGE, UNMASKED_VENDOR/RENDERER) +\n# getSupportedExtensions append.\n# PURPOSE: spoof GPU fingerprint surface.\n# CONFIG: webgl_max_texture_size, webgl_max_renderbuffer_size,\n# webgl_max_viewport_dims, webgl_aliased_point_size_range,\n# webgl_aliased_line_width_range, webgl_vendor, webgl_renderer,\n# webgl_extensions.\n# MERGE: HIGH risk - WebGL module refactors often; anchor on\n# WebGLRenderingContextBase::getParameter/getSupportedExtensions.\n# NOTE: 151 uses DOMTypedArray (dom_typed_array.h), older versions\n# used per-type headers - adjust includes on merge.\n', 'navigator_concurrent_hardware.cc': '# --- third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc ---\n# RANGE: NavigatorConcurrentHardware::hardwareConcurrency.\n# PURPOSE: spoof CPU core count (hardware_concurrency).\n# MERGE: LOW.\n', 'navigator_device_memory.cc': '# --- third_party/blink/renderer/core/frame/navigator_device_memory.cc ---\n# RANGE: NavigatorDeviceMemory::deviceMemory.\n# PURPOSE: spoof device memory (device_memory).\n# MERGE: LOW.\n', 'navigator_do_not_track.cc': '# --- third_party/blink/renderer/modules/donottrack/navigator_do_not_track.cc ---\n# RANGE: NavigatorDoNotTrack::doNotTrack.\n# PURPOSE: spoof DNT header value (do_not_track).\n# MERGE: LOW.\n', 'geolocation.cc': '# --- third_party/blink/renderer/core/geolocation/geolocation.cc ---\n# RANGE: position reporting (GeoPosition).\n# PURPOSE: spoof geolocation (geo_latitude/longitude/accuracy).\n# MERGE: MEDIUM - geolocation permissions refactors.\n', 'speech_synthesis.cc': '# --- third_party/blink/renderer/modules/speech/speech_synthesis.cc ---\n# RANGE: GetVoices result (mojom_voices).\n# PURPOSE: limit voice count + override language\n# (speech_voices_count / speech_voices_lang).\n# MERGE: MEDIUM - speech module churn; anchor on\n# SpeechSynthesis::GetVoices.\n', 'media_devices.cc': '# --- third_party/blink/renderer/modules/mediastream/media_devices.cc ---\n# RANGE: DevicesEnumerated - truncate per-type device lists.\n# PURPOSE: cap enumerated audio/video devices\n# (media_devices_audio_input/video_input/audio_output).\n# MERGE: MEDIUM - enumeration param is const; work on a copy\n# (fp_enumeration) and switch the result loop to it.\n', 'html_canvas_element.cc': '# --- third_party/blink/renderer/core/html/canvas/html_canvas_element.cc ---\n# RANGE: ToDataURLInternal + toBlob (post-Snapshot).\n# PURPOSE: deterministic canvas export noise via\n# FpApplyCanvasExportNoise (canvas_noise_seed/strength).\n# MERGE: HIGH risk - canvas refactors frequent; anchor on\n# HTMLCanvasElement::Snapshot call sites.\n', 'core_initializer.cc': '# --- third_party/blink/renderer/core/core_initializer.cc ---\n# RANGE: Initialize() after TimeZoneController::Init().\n# PURPOSE: timezone override (tz_id) via\n# TimeZoneController::SetTimeZoneOverride (RAII handle kept static).\n# MERGE: MEDIUM - init call list changes; re-anchor after\n# TimeZoneController::Init() and before any JS runs.\n', 'font_face_set.cc': '# --- third_party/blink/renderer/core/css/font_face_set.cc ---\n# RANGE: FontFaceSet::check() family loop.\n# PURPOSE: hidden fonts (blocklist or whitelist complement) report as\n# missing via unified FpFontFamilyHidden (matches FontCache gate).\n# CONFIG: fonts_blocklist, fonts_whitelist.\n# MERGE: MEDIUM - font API refactors; anchor on check() loop.\n', 'network_information.cc': '# --- third_party/blink/renderer/modules/netinfo/network_information.cc ---\n# RANGE: effectiveType/rtt/downlink.\n# PURPOSE: spoof Network Information API\n# (net_effective_type/net_rtt_ms/net_downlink_mbps).\n# MERGE: MEDIUM - netinfo module churn.\n', 'permissions.cc': '# --- third_party/blink/renderer/modules/permissions/permissions.cc ---\n# RANGE: none (include only) - kept for future use.\n# PURPOSE: include fp_config_helpers (permission override lives in\n# permission_status.cc at the final read path).\n# MERGE: LOW.\n', 'storage_manager.cc': '# --- third_party/blink/renderer/modules/quota/storage_manager.cc ---\n# RANGE: QueryStorageUsageAndQuotaCallback.\n# PURPOSE: spoof storage estimate (storage_usage_bytes/\n# storage_quota_bytes, int64).\n# MERGE: MEDIUM.\n', 'permission_status.cc': '# --- third_party/blink/renderer/modules/permissions/permission_status.cc ---\n# RANGE: PermissionStatus::state().\n# PURPOSE: override permission query results (permissions_status:\n# granted/prompt/denied) at the final read path (browser status\n# change events would overwrite earlier injection points).\n# MERGE: MEDIUM.\n', 'performance.cc': '# --- third_party/blink/renderer/core/timing/performance.cc ---\n# RANGE: Performance::now().\n# PURPOSE: quantize timestamps (perf_now_precision_ms) on a fixed\n# absolute grid (monotonicity preserved).\n# MERGE: MEDIUM.\n', 'media_capabilities.cc': '# --- third_party/blink/renderer/modules/media_capabilities/media_capabilities.cc ---\n# RANGE: decodingInfo entry (after validation).\n# PURPOSE: force unsupported for denylisted codecs\n# (media_codecs_denylist, contentType substring match).\n# MERGE: MEDIUM.\n', 'media_values.cc': '# --- third_party/blink/renderer/core/css/media_values.cc ---\n# RANGE: MediaValues::CalculatePreferredColorScheme.\n# PURPOSE: override prefers-color-scheme (prefers_color_scheme\n# light/dark), highest priority.\n# MERGE: MEDIUM.\n'}

out = [header]
for name, path in files.items():
    new = open(path, encoding='utf-8').read()
    if name == 'fp_config_helpers.h':
        orig = ''
    else:
        orig = reverts[name](new)
        assert orig != new, f'revert failed for {name}'
    if name in ('network.cc', 'network.h'):
        sub = 'third_party/webrtc/rtc_base/'
    elif name in ('port.cc', 'stun_port.cc'):
        sub = 'third_party/webrtc/p2p/base/'
    elif name == 'ipc_network_manager.cc':
        sub = 'third_party/blink/renderer/platform/p2p/'
    elif name == 'fp_config_helpers.h':
        sub = 'third_party/blink/renderer/core/frame/'
    elif name == 'screen.cc':
        sub = 'third_party/blink/renderer/core/frame/'
    elif name == 'navigator_events.cc':
        sub = 'third_party/blink/renderer/core/events/'
    elif name == 'webgl_rendering_context_base.cc':
        sub = 'third_party/blink/renderer/modules/webgl/'
    elif name in ('audio_destination_node.cc', 'audio_context.cc'):
        sub = 'third_party/blink/renderer/modules/webaudio/'
    elif name == 'network_information.cc':
        sub = 'third_party/blink/renderer/modules/netinfo/'
    elif name == 'permissions.cc':
        sub = 'third_party/blink/renderer/modules/permissions/'
    elif name == 'media_capabilities.cc':
        sub = 'third_party/blink/renderer/modules/media_capabilities/'
    elif name == 'offscreen_canvas.cc':
        sub = 'third_party/blink/renderer/core/offscreencanvas/'
    elif name == 'element.cc':
        sub = 'third_party/blink/renderer/core/dom/'
    elif name == 'gpu_adapter.cc':
        sub = 'third_party/blink/renderer/modules/webgpu/'
    elif name == 'battery_manager.cc':
        sub = 'third_party/blink/renderer/modules/battery/'
    elif name == 'font_cache.cc':
        sub = 'third_party/blink/renderer/platform/fonts/'
    elif name == 'base_rendering_context_2d.cc':
        sub = 'third_party/blink/renderer/modules/canvas/canvas2d/'
    elif name in ('offline_audio_context.cc', 'analyser_node.cc'):
        sub = 'third_party/blink/renderer/modules/webaudio/'
    elif name == 'media_values.cc':
        sub = 'third_party/blink/renderer/core/css/'
    elif name == 'performance.cc':
        sub = 'third_party/blink/renderer/core/timing/'
    elif name == 'permission_status.cc':
        sub = 'third_party/blink/renderer/modules/permissions/'
    elif name == 'storage_manager.cc':
        sub = 'third_party/blink/renderer/modules/quota/'
    elif name == 'font_face_set.cc':
        sub = 'third_party/blink/renderer/core/css/'
    elif name == 'core_initializer.cc':
        sub = 'third_party/blink/renderer/core/'
    elif name == 'html_canvas_element.cc':
        sub = 'third_party/blink/renderer/core/html/canvas/'
    elif name == 'speech_synthesis.cc':
        sub = 'third_party/blink/renderer/modules/speech/'
    elif name == 'media_devices.cc':
        sub = 'third_party/blink/renderer/modules/mediastream/'
    elif name == 'geolocation.cc':
        sub = 'third_party/blink/renderer/core/geolocation/'
    elif name == 'navigator_do_not_track.cc':
        sub = 'third_party/blink/renderer/modules/donottrack/'
    elif name in ('navigator_concurrent_hardware.cc', 'navigator_device_memory.cc', 'screen.cc'):
        sub = 'third_party/blink/renderer/core/frame/'
    else:
        sub = 'third_party/blink/renderer/modules/webaudio/'
    diff = difflib.unified_diff(io.StringIO(orig).readlines(), io.StringIO(new).readlines(),
                                fromfile=f'a/{sub}{name}', tofile=f'b/{sub}{name}', lineterm='\n')
    if name in PATCH_DOCS:
        out.append(PATCH_DOCS[name])
    out.append(''.join(diff))

# ---- completeness check: every known FP config key must be in the patch ----
EXPECTED_KEYS = [
    "hardware_concurrency", "device_memory", "max_touch_points",
    "screen_width", "screen_height", "screen_avail_width", "screen_avail_height",
    "screen_color_depth", "audio_sample_rate", "audio_max_channels",
    "audio_output_latency_ms", "webgl_max_texture_size",
    "webgl_max_renderbuffer_size", "webgl_max_viewport_dims",
    "webgl_aliased_point_size_range", "webgl_aliased_line_width_range",
    "webgl_vendor", "webgl_renderer", "webgl_extensions",
    "geo_latitude", "geo_longitude", "geo_accuracy",
    "speech_voices_count", "speech_voices_lang",
    "media_devices_audio_input", "media_devices_video_input", "media_devices_audio_output",
    "canvas_noise_seed", "canvas_noise_strength", "tz_id", "fonts_blocklist",
    "net_type", "net_effective_type", "net_rtt_ms", "net_downlink_mbps",
    "net_downlink_max_mbps", "net_save_data",
    "permissions_status", "storage_usage_bytes", "storage_quota_bytes",
    "perf_now_precision_ms", "media_codecs_denylist", "prefers_color_scheme",
    "do_not_track", "webrtc_ip",
    "audio_data_seed", "audio_data_strength", "measure_text_seed",
    "fonts_whitelist", "webgl_shader_precision_highp",
    "battery_charging", "battery_level",
    "webgpu_vendor", "webgpu_architecture", "webgpu_device", "webgpu_description",
    "webgpu_features", "webgpu_limits",
    "client_rects_seed",
]
joined_out = ''.join(out)
missing = [k for k in EXPECTED_KEYS if k not in joined_out]
if missing:
    print('COMPLETENESS FAIL - missing keys:', missing)
    raise SystemExit(1)
print('completeness OK:', len(EXPECTED_KEYS), 'keys')

open(Path(__file__).resolve().parent.parent / "patches" / "ungoogled-chromium" / "windows" / "fp-fingerprint.patch",
     'w', encoding='utf-8', newline='\n').write(''.join(out))
print('patch written, hunks:', ''.join(out).count('\n@@ -'))

