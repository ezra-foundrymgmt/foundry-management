const read = (key) => {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? undefined : value;
};

const appEnv = read("APP_ENV") ?? "development";
const mode = read("CREATOROS_INTEGRATION_MODE") ?? "mock";
const vercelEnv = read("VERCEL_ENV");
const errors = [];

if (!["development", "staging", "production"].includes(appEnv))
  errors.push("APP_ENV must be development, staging, or production.");
if (!["mock", "live"].includes(mode))
  errors.push("CREATOROS_INTEGRATION_MODE must be mock or live.");
if (vercelEnv === "preview" && appEnv === "production")
  errors.push("A Vercel preview cannot use APP_ENV=production.");
if (vercelEnv === "production" && appEnv !== "production")
  errors.push("A Vercel production deployment must use APP_ENV=production.");

// Mock mode fabricates a super_admin session and disables the auth proxy. It is
// only safe on a developer machine, never on anything with a reachable URL.
const deployed = vercelEnv !== undefined || appEnv !== "development";
if (mode === "mock" && deployed)
  errors.push(
    "CREATOROS_INTEGRATION_MODE=mock is forbidden outside local development: it serves an unauthenticated super_admin session. Set CREATOROS_INTEGRATION_MODE=live.",
  );

if (mode === "live") {
  const required = [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "INTEGRATION_ENCRYPTION_KEY",
  ];
  for (const key of required) if (!read(key)) errors.push(`${key} is required in live mode.`);
  if (!read("SUPABASE_SECRET_KEY") && !read("SUPABASE_SERVICE_ROLE_KEY"))
    errors.push("SUPABASE_SECRET_KEY or legacy SUPABASE_SERVICE_ROLE_KEY is required in live mode.");
  if ((read("NEXT_PUBLIC_APP_URL") ?? "").includes("localhost"))
    errors.push("NEXT_PUBLIC_APP_URL cannot be localhost in live mode.");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Environment contract valid (${appEnv}/${mode}).`);
