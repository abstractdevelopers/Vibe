import { useEffect, useState } from "react";
import { api, ApiError, setToken } from "../api";
import { ArrowLeftIcon, ShieldIcon } from "../components/Icons";

interface Props {
  onAuthenticated: () => void | Promise<void>;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"welcome" | "signup" | "login" | "forgot" | "reset">("welcome");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState("");

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

  // A reset link is /reset?token=... . The API serves index.html for that path,
  // so the token is read here rather than through a router.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    // Collapse duplicate slashes: a proxy or a base URL ending in "/" can
    // produce "//reset", which is still the reset screen.
    const path = window.location.pathname.replace(/\/+/g, "/");
    if (path === "/reset" && token) {
      setResetToken(token);
      setMode("reset");
    }
  }, []);

  async function submitReset() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/v1/auth/reset", { body: { token: resetToken, password } });
      setPassword("");
      setMode("login");
      setNotice("Your password has been changed. Log in with your new password.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function requestReset() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/v1/auth/forgot", { body: { email } });
      // Same message whether or not the address has an account, so this screen
      // cannot be used to discover who has one.
      setNotice("If that email has a Vibe account, a reset link is on its way. Check your inbox and spam.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "reset") {
    return (
      <div className="auth-form-wrap">
        <h1 className="screen-title">Choose a new password</h1>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitReset();
          }}
        >
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {error && <div className="notice danger">{error}</div>}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "One moment…" : "Set new password"}
          </button>
        </form>
      </div>
    );
  }

  if (mode === "forgot") {
    return (
      <div className="auth-form-wrap">
        <button className="btn ghost" onClick={() => setMode("login")} style={{ paddingLeft: 0 }}>
          <ArrowLeftIcon width={18} height={18} /> Back
        </button>
        <h1 className="screen-title">Reset your password</h1>
        <p className="muted">Enter your email and we will send you a link to choose a new password.</p>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void requestReset();
          }}
        >
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {notice && <div className="notice">{notice}</div>}
          {error && <div className="notice danger">{error}</div>}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "One moment…" : "Send reset link"}
          </button>
        </form>
      </div>
    );
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
          <ShieldIcon width={15} height={15} />
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

        {notice && <div className="notice">{notice}</div>}
        {!isSignup && (
          <button
            className="btn ghost"
            type="button"
            onClick={() => { setError(null); setNotice(null); setMode("forgot"); }}
            style={{ paddingLeft: 0 }}
          >
            Forgot your password?
          </button>
        )}

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
