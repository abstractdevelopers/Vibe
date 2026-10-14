import { useState } from "react";
import { api, ApiError, setToken } from "../api";
import { ArrowLeftIcon, SparkIcon } from "../components/Icons";

interface Props {
  onAuthenticated: () => void | Promise<void>;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"welcome" | "signup" | "login">("welcome");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const path = mode === "signup" ? "/v1/auth/register" : "/v1/auth/login";
      const payload =
        mode === "signup"
          ? { email, handle, displayName: displayName || handle, password }
          : { email, password };
      const result = await api<{ token: string }>(path, { body: payload });
      setToken(result.token);
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "welcome") {
    return (
      <div className="auth-hero">
        <div className="brand-mark">
          <span className="brand-orb" aria-hidden="true" />
          <span className="brand-name gradient-text">Vibe</span>
        </div>

        <p className="eyebrow reveal" style={{ marginBottom: "var(--space-3)" }}>
          Plans · People · Places
        </p>
        <h1 className="display reveal">
          Make plans.
          <br />
          Do things <span className="gradient-text">together.</span>
        </h1>
        <p className="muted reveal" style={{ fontSize: 16, maxWidth: "38ch" }}>
          Vibe turns conversations into plans, activities and real-world
          experiences with your people.
        </p>

        <div className="stack reveal" style={{ marginTop: "var(--space-8)" }}>
          <button className="btn primary block" onClick={() => setMode("signup")}>
            Create an account
          </button>
          <button className="btn block" onClick={() => setMode("login")}>
            Log in
          </button>
        </div>

        <p className="meta reveal" style={{ marginTop: "var(--space-6)", display: "flex", gap: 8, alignItems: "center" }}>
          <SparkIcon width={15} height={15} />
          No contacts. No location. Just you, at sign-up.
        </p>
      </div>
    );
  }

  const isSignup = mode === "signup";
  return (
    <div className="auth-hero">
      <button
        className="btn ghost"
        style={{ alignSelf: "flex-start", marginBottom: "var(--space-5)", paddingLeft: 0 }}
        onClick={() => setMode("welcome")}
      >
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      <h1 className="display auth-form" style={{ fontSize: "var(--text-title)" }}>
        {isSignup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="muted auth-form" style={{ marginBottom: "var(--space-5)" }}>
        {isSignup ? "It takes less than a minute." : "Pick up where you left off."}
      </p>

      {error && <div className="notice danger auth-form">{error}</div>}

      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        {isSignup && (
          <>
            <label htmlFor="handle">Handle</label>
            <input
              id="handle"
              autoComplete="username"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              pattern="[a-zA-Z0-9_]+"
              minLength={3}
              placeholder="yourname"
              required
            />
            <label htmlFor="displayName">Display name</label>
            <input
              id="displayName"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How people see you"
            />
          </>
        )}

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />

        <div className="stack" style={{ marginTop: "var(--space-5)" }}>
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "One moment…" : isSignup ? "Create account" : "Log in"}
          </button>
          <button
            className="btn ghost block"
            type="button"
            onClick={() => setMode(isSignup ? "login" : "signup")}
          >
            {isSignup ? "I already have an account" : "Create an account instead"}
          </button>
        </div>
      </form>
    </div>
  );
}
