#!/usr/bin/env node
/**
 * BrowserProfile - a named, cross-layer fingerprint profile plus a consistency
 * self-check.
 *
 * WHY THIS EXISTS
 *   Everything before this dealt with single surfaces: set a UA, set a platform,
 *   set a cipher list. But a fingerprint is judged as a WHOLE. A profile that
 *   says "Windows Chrome" in its UA while reporting a Mac platform, or that
 *   claims iPhone hardware with a desktop screen, is not merely imperfect - it
 *   is MORE detectable than not spoofing at all, because inconsistency is
 *   itself a signal (constraint C17).
 *
 *   Nothing in this codebase previously ENFORCED that. There were UA-derived
 *   helpers (fpPlatformForUserAgent etc.) and a lot of comments explaining why
 *   each contradiction was bad, but no single place that takes a profile and
 *   answers "does this hang together?". This is that place.
 *
 * DESIGN
 *   - Pure data + pure functions. No Electron import, so it runs in the
 *     renderer, the main process, and plain `node` for tests.
 *   - The UA is the ANCHOR. It is the most-observed surface and the one every
 *     other surface is checked against, because we already have helpers that
 *     derive platform / vendor / brands / mobile from it.
 *   - Rules declare a severity. "error" means actively detectable and should
 *     block; "warn" means suspicious and worth surfacing.
 *   - A rule that cannot evaluate (missing inputs) is reported as such rather
 *     than silently passing. Silence is how the gin-whitelist bug survived.
 */

'use strict';

const S = require('./fp-schema.js');

const SCHEMA_VERSION = 1;

/** Severities, ordered so callers can gate on the worst finding. */
const SEVERITY = { error: 'error', warn: 'warn' };

// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BrowserProfile
 * @property {string} id         Stable identifier.
 * @property {string} name       Human label.
 * @property {string} userAgent  The UA - NOT part of the fingerprint key space.
 * @property {object} config     Flat fp_* key -> value map.
 * @property {string} [createdAt]
 *
 * The UA is deliberately a separate field rather than a key in `config`.
 * `user_agent` is not one of the 63 fp_* keys: fpNormalizeConfig drops it into
 * its `unknown` list, and main.js carries it as `tab.userAgent` / a separate
 * `applyTabUserAgent()` call. Modelling it as a config key would make a profile
 * silently lose its UA on normalization - and the UA is the anchor every
 * consistency rule is checked against, so losing it would disable the entire
 * self-check while reporting success.
 */

/**
 * Create a profile from a partial spec.
 *
 * Normalizes through fpNormalizeConfig so unknown keys are dropped and values
 * are coerced - the same path the UI uses, so a profile built here and a
 * profile built by the panel cannot disagree.
 *
 * @param {object} spec { id, name, userAgent, config, createdAt }
 * @returns {BrowserProfile}
 */
function createProfile(spec) {
  const s = spec || {};
  const id = String(s.id || s.name || 'profile').trim();
  // fpNormalizeConfig returns { config, unknown } - not a bare map.
  const normalized = S.fpNormalizeConfig(s.config || {});
  return {
    id,
    name: String(s.name || id).trim(),
    userAgent: S.fpNormalizeUserAgent(s.userAgent || ''),
    config: normalized.config,
    unknownKeys: normalized.unknown || [],
    createdAt: s.createdAt || new Date().toISOString(),
    __schema: SCHEMA_VERSION,
  };
}

/**
 * Merge a partial config into a profile, returning a NEW profile.
 * (Immutable: the Inspector diffs profiles and must never see one mutate
 * underneath it.)
 *
 * @param {object} [patch]      fp_* key -> value
 * @param {string} [userAgent]  new UA; omitted means "leave unchanged"
 */
function withConfig(profile, patch, userAgent) {
  const normalized = S.fpNormalizeConfig(
    Object.assign({}, profile.config, patch || {}));
  return Object.assign({}, profile, {
    config: normalized.config,
    unknownKeys: normalized.unknown || [],
    userAgent: userAgent === undefined
      ? profile.userAgent
      : S.fpNormalizeUserAgent(userAgent),
  });
}

/** Per-group coverage, reusing the schema's own notion of "active". */
function coverage(profile) {
  return S.fpCoverage(profile ? profile.config : {});
}

/** Active key count / total, and which groups are untouched. */
function summary(profile) {
  const cov = coverage(profile);
  const active = cov.reduce((n, g) => n + g.active, 0);
  const total = cov.reduce((n, g) => n + g.total, 0);
  return {
    active,
    total,
    groups: cov.length,
    emptyGroups: cov.filter((g) => g.active === 0).map((g) => g.id),
  };
}

// ---------------------------------------------------------------------------
// Consistency rules
// ---------------------------------------------------------------------------

/**
 * Each rule: { id, severity, groups, describe, check(cfg, ctx) }
 *   check returns null (pass), a string (failed, with reason), or
 *   { skip: 'reason' } when it cannot evaluate.
 *
 * Returning an explicit skip matters: a rule that silently passes when its
 * inputs are absent would let a broken profile claim to be clean.
 */

const RULES = [
  {
    id: 'platform-matches-ua',
    severity: SEVERITY.error,
    groups: ['navigator'],
    describe: 'navigator.platform agrees with the platform implied by the UA',
    check(cfg, ctx) {
      const ua = ctx.userAgent;
      const platform = cfg.navigator_platform;
      if (!ua || !platform) return { skip: 'needs both user_agent and navigator_platform' };
      const want = S.fpPlatformForUserAgent(ua);
      if (!want) return { skip: 'could not derive a platform from this UA' };
      // Normalize: values differ in case/whitespace across sources, and
      // comparing raw strings would flag cosmetic differences as contradictions.
      const norm = (v) => String(v).trim().toLowerCase();
      if (norm(want) === norm(platform)) return null;
      return 'UA implies platform "' + want + '" but navigator_platform is "' + platform + '"';
    },
  },
  {
    id: 'vendor-matches-ua',
    severity: SEVERITY.error,
    groups: ['navigator'],
    describe: 'navigator.vendor agrees with the vendor implied by the UA',
    check(cfg, ctx) {
      const ua = ctx.userAgent;
      const vendor = cfg.navigator_vendor;
      if (!ua || !vendor) return { skip: 'needs both user_agent and navigator_vendor' };
      const want = S.fpVendorForUserAgent(ua);
      if (!want) return { skip: 'could not derive a vendor from this UA' };
      const norm = (v) => String(v).trim().toLowerCase();
      if (norm(want) === norm(vendor)) return null;
      return 'UA implies vendor "' + want + '" but navigator_vendor is "' + vendor + '"';
    },
  },
  {
    id: 'ua-mobile-matches-ua',
    severity: SEVERITY.error,
    groups: ['navigator'],
    describe: 'ua_mobile (Client Hint) agrees with the UA being a mobile device',
    check(cfg, ctx) {
      const ua = ctx.userAgent;
      const mobile = cfg.ua_mobile;
      if (!ua || mobile === undefined || mobile === null || mobile === '') {
        return { skip: 'needs both user_agent and ua_mobile' };
      }
      const meta = S.fpUaMetadataForUserAgent(ua);
      if (!meta || typeof meta.mobile !== 'boolean') {
        return { skip: 'could not derive mobility from this UA' };
      }
      // The schema stores ua_mobile as a STRING ("true"/"false"), and the panel
      // may hand us a boolean or 0/1, so accept all of them. Treating the
      // string "false" as truthy would make every desktop profile look mobile.
      const got = mobile === true || mobile === 'true' || mobile === 1 || mobile === '1';
      if (got === meta.mobile) return null;
      return 'UA implies mobile=' + meta.mobile + ' but ua_mobile=' + mobile;
    },
  },
  {
    id: 'ua-platform-ch-matches-ua',
    severity: SEVERITY.error,
    groups: ['navigator'],
    describe: 'ua_platform (Client Hint) agrees with the OS implied by the UA',
    check(cfg, ctx) {
      const ua = ctx.userAgent;
      const chPlatform = cfg.ua_platform;
      if (!ua || !chPlatform) return { skip: 'needs both user_agent and ua_platform' };
      const meta = S.fpUaMetadataForUserAgent(ua);
      if (!meta || !meta.platform) return { skip: 'could not derive a platform from this UA' };
      const norm = (v) => String(v).trim().toLowerCase();
      if (norm(meta.platform) === norm(chPlatform)) return null;
      return 'UA implies Client-Hint platform "' + meta.platform +
        '" but ua_platform is "' + chPlatform + '"';
    },
  },
  {
    id: 'mobile-hardware-consistent',
    severity: SEVERITY.warn,
    groups: ['navigator', 'hardware', 'screen'],
    describe: 'touch points are set for a mobile UA, and absent for a desktop one',
    check(cfg, ctx) {
      const ua = ctx.userAgent;
      if (!ua) return { skip: 'needs a user_agent' };
      const meta = S.fpUaMetadataForUserAgent(ua);
      if (!meta || typeof meta.mobile !== 'boolean') {
        return { skip: 'could not derive mobility from this UA' };
      }
      const touch = cfg.max_touch_points;
      const hasTouch = !(touch === undefined || touch === null || touch === '' || Number(touch) === 0);
      // A desktop UA advertising touch is a strong mobile-emulation tell; the
      // reverse (mobile UA with no touch) is what a real phone never does.
      if (meta.mobile && !hasTouch) {
        return 'mobile UA but max_touch_points is not set (real phones report touch)';
      }
      if (!meta.mobile && hasTouch) {
        return 'desktop UA but max_touch_points is set - a mobile-emulation tell';
      }
      return null;
    },
  },
  {
    id: 'device-memory-plausible',
    severity: SEVERITY.warn,
    groups: ['hardware'],
    describe: 'device_memory is a plausible value',
    check(cfg) {
      const dm = cfg.device_memory;
      // 0 is the schema's DISABLED sentinel, not a real value - the defaults are
      // deliberately 0/"" so an untouched key means "do not spoof". Warning on it
      // would flag every empty profile. Use the schema's own fpIsActive.
      if (!S.fpIsActive('device_memory', dm)) return { skip: 'device_memory not set' };
      const n = Number(dm);
      if (!isFinite(n) || n <= 0) return 'device_memory must be positive, got ' + dm;
      // Real devices expose powers of two (rounded down), so 3 or 7 is a tell.
      if (n > 0 && (n & (n - 1)) !== 0) {
        return 'device_memory ' + n + ' is not a power of two (real devices report 1/2/4/8)';
      }
      return null;
    },
  },
  {
    id: 'screen-dimensions-plausible',
    severity: SEVERITY.warn,
    groups: ['screen'],
    describe: 'screen dimensions are internally consistent',
    check(cfg) {
      const w = Number(cfg.screen_width);
      const h = Number(cfg.screen_height);
      const aw = Number(cfg.screen_avail_width);
      const ah = Number(cfg.screen_avail_height);
      // Same sentinel reasoning as device_memory: only evaluate when actually set.
      const setW = S.fpIsActive('screen_width', cfg.screen_width);
      const setH = S.fpIsActive('screen_height', cfg.screen_height);
      if (!setW || !setH) return { skip: 'needs screen_width and screen_height' };
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
        return 'screen dimensions must be positive, got ' + w + 'x' + h;
      }
      // avail is the viewport minus OS chrome, so it can never exceed the screen.
      if (cfg.screen_avail_width !== undefined && cfg.screen_avail_width !== '' && aw > w) {
        return 'screen_avail_width (' + aw + ') exceeds screen_width (' + w + ')';
      }
      if (cfg.screen_avail_height !== undefined && cfg.screen_avail_height !== '' && ah > h) {
        return 'screen_avail_height (' + ah + ') exceeds screen_height (' + h + ')';
      }
      return null;
    },
  },
  {
    id: 'webrtc-ip-requires-network-group',
    severity: SEVERITY.warn,
    groups: ['network'],
    describe: 'webrtc_ip is set only alongside other network keys (not in isolation)',
    check(cfg) {
      const ip = cfg.webrtc_ip;
      if (!ip) return { skip: 'webrtc_ip not set' };
      const others = Object.keys(S.FP_KEYS)
        .filter((k) => S.FP_KEYS[k].group === 'network' && k !== 'webrtc_ip')
        .filter((k) => S.fpIsActive(k, cfg[k]));
      if (others.length === 0) {
        return 'webrtc_ip set alone; real clients vary more than one network surface';
      }
      return null;
    },
  },
];

/**
 * Run every rule against a profile.
 *
 * @returns {{
 *   ok: boolean, errorCount: number, warnCount: number, skipCount: number,
 *   findings: Array<{id, severity, message, describe}>,
 *   skipped: Array<{id, reason}>,
 *   worst: string|null
 * }}
 */
function checkConsistency(profile) {
  const cfg = (profile && profile.config) || {};
  const findings = [];
  const skipped = [];

  // Rules receive the UA from the profile, not from the config: it is a
  // separate field (see the BrowserProfile typedef).
  const ctx = {
    schema: S,
    profile,
    userAgent: (profile && profile.userAgent) || '',
  };

  for (const rule of RULES) {
    let out;
    try {
      out = rule.check(cfg, ctx);
    } catch (e) {
      // A rule that throws must not be mistaken for a rule that passed.
      findings.push({
        id: rule.id,
        severity: SEVERITY.error,
        message: 'rule threw: ' + (e && e.message),
        describe: rule.describe,
      });
      continue;
    }
    if (out && typeof out === 'object' && out.skip) {
      skipped.push({ id: rule.id, reason: out.skip });
      continue;
    }
    if (typeof out === 'string' && out) {
      findings.push({
        id: rule.id,
        severity: rule.severity,
        message: out,
        describe: rule.describe,
      });
    }
  }

  const errorCount = findings.filter((f) => f.severity === SEVERITY.error).length;
  const warnCount = findings.filter((f) => f.severity === SEVERITY.warn).length;
  return {
    ok: errorCount === 0,
    errorCount,
    warnCount,
    skipCount: skipped.length,
    findings,
    skipped,
    worst: errorCount ? SEVERITY.error : (warnCount ? SEVERITY.warn : null),
  };
}

/** The rule catalogue, for the Inspector to render. */
function rules() {
  return RULES.map((r) => ({
    id: r.id, severity: r.severity, groups: r.groups, describe: r.describe,
  }));
}

module.exports = {
  SCHEMA_VERSION,
  SEVERITY,
  createProfile,
  withConfig,
  coverage,
  summary,
  checkConsistency,
  rules,
  // Re-exported so consumers need only this module.
  fpKeys: S.FP_KEYS,
  fpGroups: S.FP_GROUPS,
};
