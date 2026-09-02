import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  decryptSecret,
  encryptSecret,
  hashOAuthState,
} from "./integration-crypto";

describe("integration secret boundaries", () => {
  it("encrypts provider tokens with authenticated encryption", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("provider-token", key);
    expect(encrypted.ciphertext).not.toContain("provider-token");
    expect(decryptSecret(encrypted, key)).toBe("provider-token");
  });
  it("creates one-time state values that are stored only as hashes", () => {
    const state = createOAuthState();
    expect(state.value).not.toBe(state.hash);
    expect(hashOAuthState(state.value)).toBe(state.hash);
  });
});
