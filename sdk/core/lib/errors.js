'use strict';
// SDK error taxonomy — mirrors the runtime's script-runner 9 error classes +
// CancelledError, and maps the runtime's HTTP/WS error codes onto SDK classes.
// The declaration surface IS the permission surface (automation.d.ts), so the
// error surface must be just as explicit.

// Server envelope error codes -> SDK class.
const CODE_MAP = {
  VALIDATION: 'ValidationError',
  NOT_FOUND: 'NotFoundError',
  LIMIT: 'LimitError',
  FORBIDDEN: 'PermissionError',
  NOT_IMPLEMENTED: 'NotImplementedError',
  INTERNAL: 'InternalError',
};

// The runtime's script-runner taxonomy (returned as execution.error.name).
const TAXONOMY = [
  'ScriptError',
  'TimeoutError',
  'SelectorError',
  'BrowserError',
  'NetworkError',
  'PermissionError',
  'ProfileError',
  'DownloadError',
  'UploadError',
  'CancelledError',
];

class SdkError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'SdkError';
    this.code = code || null;
    this.status = status == null ? null : status;
  }
}
class ConfigError extends SdkError {
  constructor(message) {
    super(message, 'CONFIG');
    this.name = 'ConfigError';
  }
}
class HttpError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'HttpError';
  }
}
class WsError extends SdkError {
  constructor(message, code) {
    super(message, code || 'WS');
    this.name = 'WsError';
  }
}
class CapabilityError extends SdkError {
  constructor(message) {
    super(message, 'CAPABILITY');
    this.name = 'CapabilityError';
  }
}
class ValidationError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'ValidationError';
  }
}
class NotFoundError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'NotFoundError';
  }
}
class LimitError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'LimitError';
  }
}
class PermissionError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'PermissionError';
  }
}
class NotImplementedError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'NotImplementedError';
  }
}
class InternalError extends SdkError {
  constructor(message, code, status) {
    super(message, code, status);
    this.name = 'InternalError';
  }
}

const CLASSES = {
  ValidationError,
  NotFoundError,
  LimitError,
  PermissionError,
  NotImplementedError,
  InternalError,
};

// Map a server error {code,message} (or a taxonomy name) to an SDK Error.
function mapError(code, message, status) {
  const msg = message == null ? String(code) : String(message);
  if (TAXONOMY.indexOf(code) !== -1) {
    const e = new Error(msg);
    e.name = code;
    e.code = code;
    e.status = status == null ? null : status;
    return e;
  }
  const name = CODE_MAP[code];
  const Ctor = name ? CLASSES[name] : HttpError;
  return new Ctor(msg, code, status);
}

module.exports = {
  SdkError,
  ConfigError,
  HttpError,
  WsError,
  CapabilityError,
  ValidationError,
  NotFoundError,
  LimitError,
  PermissionError,
  NotImplementedError,
  InternalError,
  CODE_MAP,
  TAXONOMY,
  mapError,
};
