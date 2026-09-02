import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  initializationVector: string;
  authTag: string;
}

function parseKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes encoded as base64.");
  return key;
}

export function encryptSecret(plaintext: string, keyValue: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    initializationVector: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret, keyValue: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseKey(keyValue),
    Buffer.from(secret.initializationVector, "base64"),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function createOAuthState() {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: hashOAuthState(value) };
}

export function hashOAuthState(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
