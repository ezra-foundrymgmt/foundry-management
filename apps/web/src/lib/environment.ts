import "server-only";
import { z } from "zod";

/**
 * Next's env loader assigns "" to bare `KEY=` lines, and `.optional()` only
 * admits `undefined`. Without this, copying `.env.example` to `.env.local` —
 * exactly what the README instructs — makes every parse below fail.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(blankToUndefined, z.string().url().optional());

const schema = z.object({
  APP_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "staging", "production"]).default("development"),
  ),
  CREATOROS_INTEGRATION_MODE: z.preprocess(
    blankToUndefined,
    z.enum(["mock", "live"]).default("mock"),
  ),
  NEXT_PUBLIC_APP_URL: z.preprocess(
    blankToUndefined,
    z.string().url().default("http://localhost:3000"),
  ),
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalSecret,
  SUPABASE_SECRET_KEY: optionalSecret,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  INNGEST_EVENT_KEY: optionalSecret,
  INNGEST_SIGNING_KEY: optionalSecret,
  INNGEST_SIGNING_KEY_FALLBACK: optionalSecret,
  SLACK_CLIENT_ID: optionalSecret,
  SLACK_CLIENT_SECRET: optionalSecret,
  SLACK_SIGNING_SECRET: optionalSecret,
  SLACK_REDIRECT_URI: optionalUrl,
  NOTION_CLIENT_ID: optionalSecret,
  NOTION_CLIENT_SECRET: optionalSecret,
  NOTION_REDIRECT_URI: optionalUrl,
  INTEGRATION_ENCRYPTION_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  FOUNDRY_AGENT_MODEL: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).default("claude-sonnet-5"),
  ),
  SENTRY_DSN: optionalSecret,
  VERCEL_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "preview", "production"]).optional(),
  ),
});

export type CreatorOSEnvironment = z.infer<typeof schema>;

let cached: CreatorOSEnvironment | undefined;

export function getEnvironment(): CreatorOSEnvironment {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Test-only: clears the module-level cache between environment permutations. */
export function resetEnvironmentCache(): void {
  cached = undefined;
}

/**
 * Mock mode fabricates a super_admin session and disables the auth proxy, so it
 * is only ever safe on a developer machine. Anything that looks like a deployed
 * environment must run live.
 */
export function isDeployedEnvironment(environment = getEnvironment()): boolean {
  return environment.VERCEL_ENV !== undefined || environment.APP_ENV !== "development";
}

export function validateRuntimeEnvironment(environment = getEnvironment()): string[] {
  const errors: string[] = [];
  if (environment.VERCEL_ENV === "preview" && environment.APP_ENV === "production")
    errors.push("Preview deployments cannot declare APP_ENV=production.");
  if (environment.VERCEL_ENV === "production" && environment.APP_ENV !== "production")
    errors.push("Production deployments must declare APP_ENV=production.");
  if (environment.CREATOROS_INTEGRATION_MODE === "mock" && isDeployedEnvironment(environment))
    errors.push(
      "CREATOROS_INTEGRATION_MODE=mock is forbidden outside local development: mock mode serves an unauthenticated super_admin session. Set CREATOROS_INTEGRATION_MODE=live.",
    );
  if (environment.CREATOROS_INTEGRATION_MODE === "live") {
    const required: Array<keyof CreatorOSEnvironment> = [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "INTEGRATION_ENCRYPTION_KEY",
    ];
    if (!environment.SUPABASE_SECRET_KEY && !environment.SUPABASE_SERVICE_ROLE_KEY)
      errors.push(
        "SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is required in live mode.",
      );
    for (const key of required)
      if (!environment[key]) errors.push(`${key} is required in live mode.`);
    if (environment.NEXT_PUBLIC_APP_URL.includes("localhost"))
      errors.push("NEXT_PUBLIC_APP_URL cannot be localhost in live mode.");
  }
  return errors;
}

export function assertRuntimeEnvironment(): CreatorOSEnvironment {
  const environment = getEnvironment();
  const errors = validateRuntimeEnvironment(environment);
  if (errors.length) throw new Error(`INVALID_RUNTIME_ENVIRONMENT: ${errors.join(" ")}`);
  return environment;
}

export function isMockMode() {
  const environment = getEnvironment();
  if (environment.CREATOROS_INTEGRATION_MODE !== "mock") return false;
  if (isDeployedEnvironment(environment))
    throw new Error(
      "MOCK_MODE_FORBIDDEN_IN_DEPLOYED_ENVIRONMENT: refusing to serve a fabricated super_admin session. Set CREATOROS_INTEGRATION_MODE=live.",
    );
  return true;
}
