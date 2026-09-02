"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.assign("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed");
      setBusy(false);
    }
  }

  async function magicLink() {
    setBusy(true);
    setMessage("");
    try {
      const client = createSupabaseBrowserClient();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setMessage("Check your email for the secure sign-in link.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Magic link failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void signIn(event)}>
      <label>
        Email
        <input
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <button
        className="button"
        type="button"
        onClick={() => void magicLink()}
        disabled={busy || !email}
      >
        Email a magic link
      </button>
      {message ? (
        <p role="status" className="subtitle">
          {message}
        </p>
      ) : null}
    </form>
  );
}
