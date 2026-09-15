// tests/unit/logging.test.ts
//
// P1-S3 spec-first tests for masked structured JSONL: secret-like keys and
// credential-shaped values never reach the log stream; level filtering and
// operation binding behave correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mask, JsonLogger, CapturingSink } from "../../src/logging/jsonl.ts";
import type { JsonLogRecord } from "../../src/logging/jsonl.ts";

test("mask() redacts secret-like keys by name", () => {
  const out = mask({
    repo: "acme/widgets",
    token: "abc",
    nested: { password: "hunter2", n: 1 },
    list: ["ok", "x"],
  }) as Record<string, unknown>;
  assert.equal(out.repo, "acme/widgets");
  assert.equal(out.token, "[REDACTED]");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.password, "[REDACTED]");
  assert.equal(nested.n, 1);
});

test("mask() redacts credential-shaped values even under safe keys", () => {
  const token = "ghp_" + "x".repeat(30);
  const out = mask({ remote: token, note: "fine" }) as Record<string, unknown>;
  assert.equal(out.remote, "[REDACTED]");
  assert.equal(out.note, "fine");
});

test("logger writes masked JSONL and never leaks secret material", () => {
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "info");
  const token = "gho_" + "y".repeat(30);
  logger.info("event", { repo: "acme/widgets", authorization: "Bearer secret", token });
  const chunks = sink.chunks.join("");
  assert.ok(!chunks.includes(token), "token value must not appear in log output");
  assert.ok(!chunks.includes("Bearer secret"), "authorization value must not appear");
  const records: JsonLogRecord[] = sink.records();
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.repo, "acme/widgets");
  assert.equal(r.authorization, "[REDACTED]");
  assert.equal(r.token, "[REDACTED]");
  assert.equal(r.lvl, "info");
});

test("op() binds an operation id onto records", () => {
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "info").op("reconcile");
  logger.warn("pass_started", {});
  const r = sink.records()[0]!;
  assert.equal(r.op, "reconcile");
  assert.equal(r.lvl, "warn");
});

test("level filtering drops records below the configured minimum", () => {
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "warn");
  logger.info("should_drop", {});
  logger.error("kept", {});
  const records = sink.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.event, "kept");
});
