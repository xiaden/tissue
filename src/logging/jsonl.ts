// src/logging/jsonl.ts
//
// Masked structured JSONL logging (R16). Every record is a single JSON line on
// a writable stream. Secret material is masked before it can be written, so a
// payload that accidentally carries a token/credential never reaches the log
// stream. This is the ONLY logging path from src/ (no console.*).

import type { Writable } from "node:stream";

const SECRET_KEY_RE = /(secret|token|password|credential|authorization|bearer|apikey|api[-_]?key|oauth)/i;
const SECRET_VALUE_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/,
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
];

const REDACTED = "[REDACTED]";

function maskScalar(v: unknown): unknown {
  if (typeof v === "string") {
    for (const re of SECRET_VALUE_SHAPES) {
      if (re.test(v)) return REDACTED;
    }
    // A URL that embeds credentials (user:pass@) must not be logged verbatim.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(v)) return REDACTED;
  }
  return v;
}

/** Deep-copy `value`, masking secret-like keys and credential-shaped values. */
export function mask(value: unknown): unknown {
  if (value === null || typeof value !== "object") return maskScalar(value);
  if (Array.isArray(value)) return value.map((item) => mask(item));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : mask(v);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface JsonLogRecord {
  ts: string;
  lvl: LogLevel;
  op?: string;
  event: string;
  [key: string]: unknown;
}

/** Writes masked JSONL records to a stream. */
export class JsonLogger {
  readonly #stream: Writable;
  readonly #minLevel: number;
  readonly #op?: string;

  constructor(stream: Writable, minLevel: LogLevel = "info", op?: string) {
    this.#stream = stream;
    this.#minLevel = LEVEL_ORDER[minLevel];
    this.#op = op;
  }

  /** Bind an operation id (e.g. "reconcile", "enqueue") for structured routing. */
  op(operation: string): JsonLogger {
    return new JsonLogger(this.#stream, this.minLevelName(), operation);
  }

  minLevelName(): LogLevel {
    const m = (Object.keys(LEVEL_ORDER) as LogLevel[]).find(
      (k) => LEVEL_ORDER[k] === this.#minLevel,
    );
    return m ?? "info";
  }

  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.#minLevel) return;
    const record: JsonLogRecord = {
      ts: new Date().toISOString(),
      lvl: level,
      ...(this.#op ? { op: this.#op } : {}),
      event,
      ...(data ? (mask(data) as Record<string, unknown>) : {}),
    };
    this.#stream.write(JSON.stringify(record) + "\n");
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log("debug", event, data);
  }
  info(event: string, data?: Record<string, unknown>): void {
    this.log("info", event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.log("warn", event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.log("error", event, data);
  }
}

/** In-memory capture for tests/telemetry sinks. */
export class CapturingSink {
  readonly chunks: string[] = [];
  writeable(): Writable {
    const sink = this;
    return {
      write(chunk: string | Uint8Array): boolean {
        sink.chunks.push(String(chunk));
        return true;
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
      emit() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as Writable;
  }
  records(): JsonLogRecord[] {
    return this.chunks.filter(Boolean).map((c) => JSON.parse(c) as JsonLogRecord);
  }
}
