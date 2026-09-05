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
  /**
   * Shared with the Apps Script bound to the creator intake Google Form. It
   * authenticates the TRANSPORT only — that a POST came from something holding
   * the secret. It says nothing about who filled the form in, because a Google
   * Form prefill is a visible, editable field and can never authenticate a
   * person. Absent means the intake endpoint refuses every request rather than
   * accepting unsigned ones.
   */
  CREATOR_INTAKE_SIGNING_SECRET: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  FOUNDRY_AGENT_MODEL: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).default("claude-opus-5"),
  ),
  SENTRY_DSN: optionalSecret,
  /**
   * The Supabase project ref that holds real Foundry data. When set, a preview
   * deployment pointed at that project refuses to start rather than letting a
   * branch build mutate production records.
   */
  PRODUCTION_SUPABASE_PROJECT_REF: optionalSecret,
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

/**
 * True when a non-production deployment is configured against the Supabase
 * project that holds real Foundry data. Branch previews are the realistic way
 * production records get mutated by accident, and a preview URL is reachable by
 * anyone with the link.
 */
export function targetsProductionDatabaseFromPreview(environment = getEnvironment()): boolean {
  const productionRef = environment.PRODUCTION_SUPABASE_PROJECT_REF;
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (!productionRef || !url) return false;
  if (environment.VERCEL_ENV === "production" && environment.APP_ENV === "production") return false;
  return url.includes(productionRef);
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
  if (targetsProductionDatabaseFromPreview(environment))
    errors.push(
      "A preview deployment is pointed at the production Supabase project. Point previews at a staging project, or clear PRODUCTION_SUPABASE_PROJECT_REF if this is intentional.",
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
