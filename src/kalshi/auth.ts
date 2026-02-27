import crypto from "node:crypto";

export function buildKalshiSigningPayload(timestampMs: string, method: string, pathWithQuery: string): string {
  return `${timestampMs}${method.toUpperCase()}${pathWithQuery}`;
}

export function signKalshiRequest(input: {
  timestampMs: string;
  method: string;
  pathWithQuery: string;
  privateKeyPem: string;
}): string {
  const payload = buildKalshiSigningPayload(input.timestampMs, input.method, input.pathWithQuery);
  const signature = crypto.sign("sha256", Buffer.from(payload, "utf8"), {
    key: input.privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return signature.toString("base64");
}

export function validatePemLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("BEGIN") && trimmed.includes("PRIVATE KEY");
}
