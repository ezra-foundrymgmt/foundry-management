import { LoginForm } from "@/components/login-form";
export default function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-card card">
        <div className="brand-mark" style={{ background: "var(--graphite)", marginBottom: 18 }}>
          F
        </div>
        <div className="eyebrow">FOUNDRY MANAGEMENT</div>
        <h1>Sign in to CreatorOS</h1>
        <p className="subtitle">
          Protected internal operating infrastructure for authorized Foundry staff.
        </p>
        <LoginForm />
        <p className="login-note">
          Creator platform ownership, recovery, and payout control always remain with the creator.
        </p>
      </section>
    </main>
  );
}
