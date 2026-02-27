import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildKalshiSigningPayload, signKalshiRequest } from "../src/kalshi/auth";

describe("kalshi signing", () => {
  it("creates a base64 signature that verifies", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const timestamp = "1700000000000";
    const method = "GET";
    const path = "/trade-api/v2/portfolio/balance";
    const sig = signKalshiRequest({ timestampMs: timestamp, method, pathWithQuery: path, privateKeyPem: privatePem });

    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(32);

    const payload = buildKalshiSigningPayload(timestamp, method, path);
    const ok = crypto.verify(
      "sha256",
      Buffer.from(payload, "utf8"),
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sig, "base64")
    );
    expect(ok).toBe(true);
  });
});
