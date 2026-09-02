const appEnv = process.env.APP_ENV ?? "development";
const mode = process.env.CREATOROS_INTEGRATION_MODE ?? "mock";
const vercelEnv = process.env.VERCEL_ENV;
const errors = [];

if (!["development", "staging", "production"].includes(appEnv))
  errors.push("APP_ENV must be development, staging, or production.");
if (!["mock", "live"].includes(mode))
  errors.push("CREATOROS_INTEGRATION_MODE must be mock or live.");
if (vercelEnv === "preview" && appEnv === "production")
  errors.push("A Vercel preview cannot use APP_ENV=production.");
if (vercelEnv === "production" && appEnv !== "production")
  errors.push("A Vercel production deployment must use APP_ENV=production.");

if (mode === "live") {
  const required = [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "INTEGRATION_ENCRYPTION_KEY",
  ];
  for (const key of required)
    if (!process.env[key]) errors.push(`${key} is required in live mode.`);
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)
    errors.push(
      "SUPABASE_SECRET_KEY or legacy SUPABASE_SERVICE_ROLE_KEY is required in live mode.",
    );
  if ((process.env.NEXT_PUBLIC_APP_URL ?? "").includes("localhost"))
    errors.push("NEXT_PUBLIC_APP_URL cannot be localhost in live mode.");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Environment contract valid (${appEnv}/${mode}).`);
