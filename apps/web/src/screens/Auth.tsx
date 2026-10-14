import { useState } from "react";
import { api, ApiError, setToken } from "../api";

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
        mode === "signup" ? { email, handle, displayName: displayName || handle, password } : { email, password };
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
      <div className="app-shell">
        <h1 className="screen-title">Make plans. Do things together.</h1>
        <p className="muted">
          Vibe turns conversations into plans, activities and shared experiences with your people.
        </p>
        <div className="stack" style={{ marginTop: "var(--space-6)" }}>
          <button className="btn primary" onClick={() => setMode("signup")}>
            Create an account
          </button>
          <button className="btn" onClick={() => setMode("login")}>
            Log in
          </button>
        </div>
        <p className="meta" style={{ marginTop: "var(--space-6)" }}>
          We never ask for your contacts or location during sign-up.
        </p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <h1 className="screen-title">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
      {error && <div className="notice danger">{error}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {mode === "signup" && (
          <>
            <label htmlFor="handle">Handle</label>
            <input
              id="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              pattern="[a-zA-Z0-9_]+"
              minLength={3}
              required
            />
            <label htmlFor="displayName">Display name</label>
            <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </>
        )}
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <div className="stack" style={{ marginTop: "var(--space-4)" }}>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>
          <button className="btn ghost" type="button" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
            {mode === "signup" ? "I already have an account" : "Create an account instead"}
          </button>
        </div>
      </form>
    </div>
  );
}
