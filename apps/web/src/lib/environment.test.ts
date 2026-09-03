import { afterEach, describe, expect, it } from "vitest";
import {
  getEnvironment,
  isDeployedEnvironment,
  isMockMode,
  resetEnvironmentCache,
  validateRuntimeEnvironment,
} from "./environment";

const TOUCHED = [
  "APP_ENV",
  "CREATOROS_INTEGRATION_MODE",
  "VERCEL_ENV",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "INTEGRATION_ENCRYPTION_KEY",
] as const;

function applyEnvironment(values: Record<string, string | undefined>) {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) process.env[key] = value;
  resetEnvironmentCache();
}

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
  resetEnvironmentCache();
});

const LIVE_CREDENTIALS = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SECRET_KEY: "secret-key",
  INNGEST_EVENT_KEY: "event-key",
  INNGEST_SIGNING_KEY: "signing-key",
  INTEGRATION_ENCRYPTION_KEY: "encryption-key",
  NEXT_PUBLIC_APP_URL: "https://creatoros.example.com",
};

describe("environment contract: blank values", () => {
  it("treats a bare KEY= line as unset rather than failing to parse", () => {
    // `copy .env.example .env.local` (the documented setup) assigns "" to every
    // secret. Those must read as absent, not crash the whole application.
    applyEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "   ",
      NEXT_PUBLIC_APP_URL: "",
    });
    const environment = getEnvironment();
    expect(environment.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(environment.SUPABASE_SECRET_KEY).toBeUndefined();
    expect(environment.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });
});

describe("environment contract: mock mode may never be deployed", () => {
  it("allows mock mode on a developer machine", () => {
    applyEnvironment({ APP_ENV: "development", CREATOROS_INTEGRATION_MODE: "mock" });
    expect(isDeployedEnvironment()).toBe(false);
    expect(isMockMode()).toBe(true);
    expect(validateRuntimeEnvironment()).toEqual([]);
  });

  for (const deployment of [
    { label: "a Vercel production deployment", env: { VERCEL_ENV: "production", APP_ENV: "production" } },
    { label: "a Vercel preview deployment", env: { VERCEL_ENV: "preview", APP_ENV: "staging" } },
    { label: "a staging APP_ENV with no Vercel marker", env: { APP_ENV: "staging" } },
    { label: "a production APP_ENV with no Vercel marker", env: { APP_ENV: "production" } },
  ]) {
    it(`refuses mock mode on ${deployment.label}`, () => {
      applyEnvironment({ ...deployment.env, CREATOROS_INTEGRATION_MODE: "mock" });
      expect(isDeployedEnvironment()).toBe(true);
      expect(validateRuntimeEnvironment().join(" ")).toContain(
        "CREATOROS_INTEGRATION_MODE=mock is forbidden",
      );
      // Fail closed at runtime, not only at build time: a fabricated
      // super_admin session must never be served from a reachable URL.
      expect(() => isMockMode()).toThrow("MOCK_MODE_FORBIDDEN_IN_DEPLOYED_ENVIRONMENT");
    });
  }

  it("accepts a fully configured live production deployment", () => {
    applyEnvironment({
      APP_ENV: "production",
      VERCEL_ENV: "production",
      CREATOROS_INTEGRATION_MODE: "live",
      ...LIVE_CREDENTIALS,
    });
    expect(validateRuntimeEnvironment()).toEqual([]);
    expect(isMockMode()).toBe(false);
  });
});

describe("environment contract: live mode requires real credentials", () => {
  it("lists every missing live-mode requirement", () => {
    applyEnvironment({ APP_ENV: "production", CREATOROS_INTEGRATION_MODE: "live" });
    const errors = validateRuntimeEnvironment().join(" ");
    expect(errors).toContain("SUPABASE_SECRET_KEY");
    expect(errors).toContain("NEXT_PUBLIC_SUPABASE_URL is required");
    expect(errors).toContain("INNGEST_SIGNING_KEY is required");
    expect(errors).toContain("INTEGRATION_ENCRYPTION_KEY is required");
    expect(errors).toContain("NEXT_PUBLIC_APP_URL cannot be localhost");
  });

  it("accepts the legacy service-role key in place of the modern secret key", () => {
    applyEnvironment({
      APP_ENV: "production",
      CREATOROS_INTEGRATION_MODE: "live",
      ...LIVE_CREDENTIALS,
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
    });
    expect(validateRuntimeEnvironment()).toEqual([]);
  });

  it("rejects a preview deployment claiming APP_ENV=production", () => {
    applyEnvironment({
      APP_ENV: "production",
      VERCEL_ENV: "preview",
      CREATOROS_INTEGRATION_MODE: "live",
      ...LIVE_CREDENTIALS,
    });
    expect(validateRuntimeEnvironment().join(" ")).toContain(
      "Preview deployments cannot declare APP_ENV=production",
    );
  });
});
