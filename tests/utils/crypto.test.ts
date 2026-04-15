import { describe, it, expect } from "vitest";
import { verifySlackSignature } from "../../src/common/utils/crypto.ts";
import { generateSlackSignature } from "../setup.ts";

const SIGNING_SECRET = "test-signing-secret";

describe("verifySlackSignature", () => {
  it("returns true for a valid signature", async () => {
    const body = "payload=test-body";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSlackSignature(SIGNING_SECRET, timestamp, body);

    const result = await verifySlackSignature(SIGNING_SECRET, signature, timestamp, body);
    expect(result).toBe(true);
  });

  it("returns false for an invalid signature", async () => {
    const body = "payload=test-body";
    const timestamp = String(Math.floor(Date.now() / 1000));

    const result = await verifySlackSignature(
      SIGNING_SECRET,
      "v0=invalidsignature",
      timestamp,
      body,
    );
    expect(result).toBe(false);
  });

  it("returns false for a tampered body", async () => {
    const body = "payload=test-body";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSlackSignature(SIGNING_SECRET, timestamp, body);

    const result = await verifySlackSignature(
      SIGNING_SECRET,
      signature,
      timestamp,
      "payload=tampered-body",
    );
    expect(result).toBe(false);
  });

  it("returns false for an expired timestamp (>5 minutes old)", async () => {
    const body = "payload=test-body";
    const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = await generateSlackSignature(SIGNING_SECRET, expiredTimestamp, body);

    const result = await verifySlackSignature(SIGNING_SECRET, signature, expiredTimestamp, body);
    expect(result).toBe(false);
  });

  it("returns false for a non-numeric timestamp", async () => {
    const body = "payload=test-body";
    const result = await verifySlackSignature(SIGNING_SECRET, "v0=abc", "not-a-number", body);
    expect(result).toBe(false);
  });

  it("returns false for a wrong signing secret", async () => {
    const body = "payload=test-body";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSlackSignature("different-secret", timestamp, body);

    const result = await verifySlackSignature(SIGNING_SECRET, signature, timestamp, body);
    expect(result).toBe(false);
  });
});
