// Lightweight telemetry utility with basic PII redaction
// Replace console sink with Sentry or any analytics provider later

export type TelemetryData = Record<string, unknown>;

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value) return value;
    // Keep first 6 chars, mask the rest
    return value.length <= 6 ? '***' : `${value.slice(0, 6)}***`;
  }
  return value;
}

function sanitize(data?: TelemetryData): TelemetryData | undefined {
  if (!data) return undefined;
  const cloned: TelemetryData = {};
  for (const [k, v] of Object.entries(data)) {
    // Redact potentially sensitive keys
    if (/vendor|invoice|ref|notes|name|bank|address/i.test(k)) {
      cloned[k] = redact(v);
    } else {
      cloned[k] = v;
    }
  }
  return cloned;
}

const consoleSink = {
  captureEvent(name: string, data?: TelemetryData) {
    // eslint-disable-next-line no-console
    console.info('[telemetry:event]', name, sanitize(data));
  },
  captureError(name: string, error: unknown, data?: TelemetryData) {
    // eslint-disable-next-line no-console
    console.error('[telemetry:error]', name, sanitize(data), normalizeError(error));
  },
};

function normalizeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: 'Unknown error' };
  }
}

export const telemetry = {
  event: (name: string, data?: TelemetryData) => consoleSink.captureEvent(name, data),
  error: (name: string, error: unknown, data?: TelemetryData) => consoleSink.captureError(name, error, data),
};
