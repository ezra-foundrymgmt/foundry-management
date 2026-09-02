import "server-only";
import { z } from "zod";

const optionalSecret = z.string().trim().min(1).optional();
const schema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  CREATOROS_INTEGRATION_MODE: z.enum(["mock", "live"]).default("mock"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalSecret,
  SUPABASE_SECRET_KEY: optionalSecret,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  INNGEST_EVENT_KEY: optionalSecret,
  INNGEST_SIGNING_KEY: optionalSecret,
  INNGEST_SIGNING_KEY_FALLBACK: optionalSecret,
  SLACK_CLIENT_ID: optionalSecret,
  SLACK_CLIENT_SECRET: optionalSecret,
  SLACK_SIGNING_SECRET: optionalSecret,
  SLACK_REDIRECT_URI: z.string().url().optional(),
  NOTION_CLIENT_ID: optionalSecret,
  NOTION_CLIENT_SECRET: optionalSecret,
  NOTION_REDIRECT_URI: z.string().url().optional(),
  INTEGRATION_ENCRYPTION_KEY: optionalSecret,
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
});

export type CreatorOSEnvironment = z.infer<typeof schema>;

let cached: CreatorOSEnvironment | undefined;

export function getEnvironment(): CreatorOSEnvironment {
  cached ??= schema.parse(process.env);
  return cached;
}

export function validateRuntimeEnvironment(environment = getEnvironment()): string[] {
  const errors: string[] = [];
  if (environment.VERCEL_ENV === "preview" && environment.APP_ENV === "production")
    errors.push("Preview deployments cannot declare APP_ENV=production.");
  if (environment.VERCEL_ENV === "production" && environment.APP_ENV !== "production")
    errors.push("Production deployments must declare APP_ENV=production.");
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
  return getEnvironment().CREATOROS_INTEGRATION_MODE === "mock";
}
