import { useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { parseToMinorUnits } from "@vibe/shared";
import type { CircleSummary, Me } from "../types";

interface Props {
  me: Me;
  onClose: () => void;
  onCreated: () => void;
}

type Mode = "post" | "poll" | "plan" | "expense";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "post", label: "Post", hint: "Share something with your connections or a Circle" },
  { id: "poll", label: "Poll", hint: "Ask a question and let people vote once" },
  { id: "plan", label: "Plan", hint: "Propose an outing and collect RSVPs" },
  { id: "expense", label: "Shared expense", hint: "Split a cost — Vibe never holds the money" },
];

export function CreateSheet({ me, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>("post");
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ circles: CircleSummary[] }>("/v1/circles").then((r) => setCircles(r.circles));
  }, []);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Create">
      <div className="sheet-inner">
        <div className="row spread">
          <h2 className="screen-title" style={{ margin: 0 }}>
            Create
          </h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="pill-row" role="tablist" aria-label="What to create">
          {MODES.map((m) => (
            <button key={m.id} className="pill" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="meta">{MODES.find((m) => m.id === mode)?.hint}</p>

        {error && <div className="notice danger">{error}</div>}

        {mode === "post" && <PostForm circles={circles} onDone={onCreated} setError={setError} />}
        {mode === "poll" && (
          <PollForm circles={circles} onDone={onCreated} setError={setError} busy={busy} setBusy={setBusy} />
        )}
        {mode === "plan" && (
          <PlanForm circles={circles} onDone={onCreated} setError={setError} busy={busy} setBusy={setBusy} />
        )}
        {mode === "expense" && (
          <ExpenseForm me={me} circles={circles} onDone={onCreated} setError={setError} />
        )}
      </div>
    </div>
  );
}

function CircleSelect({
  circles,
  value,
  onChange,
  allowNone,
}: {
  circles: CircleSummary[];
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  if (circles.length === 0) {
    return <p className="meta">You need to be in a Circle for this. Create one first.</p>;
  }
  return (
    <>
      <label htmlFor="circleSelect">Circle</label>
      <select id="circleSelect" value={value} onChange={(e) => onChange(e.target.value)}>
        {allowNone && <option value="">No Circle (your connections)</option>}
        {circles.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </>
  );
}

function PostForm({
  circles,
  onDone,
  setError,
}: {
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
}) {
  const [body, setBody] = useState("");
  const [circleId, setCircleId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/posts", {
        body: {
          body,
          audience: circleId ? "circle" : "connections",
          ...(circleId ? { circleId } : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="postBody">Message</label>
      <textarea id="postBody" value={body} onChange={(e) => setBody(e.target.value)} required />
      {circles.length > 0 && (
        <CircleSelect circles={circles} value={circleId} onChange={setCircleId} allowNone />
      )}
      <button className="btn primary" type="submit" disabled={busy || !body.trim()}>
        {busy ? "Posting…" : "Publish"}
      </button>
    </form>
  );
}

function PollForm({
  circles,
  onDone,
  setError,
  busy,
  setBusy,
}: {
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [circleId, setCircleId] = useState(circles[0]?.id ?? "");

  async function submit() {
    const cleaned = options.map((o) => o.trim()).filter(Boolean);
    if (cleaned.length < 2) {
      setError("A poll needs at least two options");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/v1/activities", {
        body: { question, options: cleaned, ...(circleId ? { circleId } : {}) },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the poll");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="question">Question</label>
      <input id="question" value={question} onChange={(e) => setQuestion(e.target.value)} required />
      {options.map((option, index) => (
        <div key={index}>
          <label htmlFor={`option-${index}`}>Option {index + 1}</label>
          <input
            id={`option-${index}`}
            value={option}
            onChange={(e) => setOptions(options.map((o, i) => (i === index ? e.target.value : o)))}
          />
        </div>
      ))}
      <button
        className="btn ghost"
        type="button"
        onClick={() => setOptions([...options, ""])}
        disabled={options.length >= 10}
      >
        Add option
      </button>
      <CircleSelect circles={circles} value={circleId} onChange={setCircleId} />
      <button className="btn primary" type="submit" disabled={busy || !question.trim()}>
        {busy ? "Creating…" : "Create poll"}
      </button>
    </form>
  );
}

function PlanForm({
  circles,
  onDone,
  setError,
  busy,
  setBusy,
}: {
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [circleId, setCircleId] = useState(circles[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [place, setPlace] = useState("");

  async function submit() {
    if (!circleId) {
      setError("Plans live in a Circle");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/v1/plans", {
        body: {
          circleId,
          title,
          startsAt: new Date(startsAt).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(place ? { place } : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the plan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <CircleSelect circles={circles} value={circleId} onChange={setCircleId} />
      <label htmlFor="planTitle">Title</label>
      <input id="planTitle" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor="planWhen">When</label>
      <input
        id="planWhen"
        type="datetime-local"
        value={startsAt}
        onChange={(e) => setStartsAt(e.target.value)}
        required
      />
      <label htmlFor="planPlace">Place</label>
      <input id="planPlace" value={place} onChange={(e) => setPlace(e.target.value)} />
      <button className="btn primary" type="submit" disabled={busy || !title.trim() || !startsAt || !circleId}>
        {busy ? "Creating…" : "Propose plan"}
      </button>
    </form>
  );
}

interface Member {
  id: string;
  handle: string;
  displayName: string;
}

function ExpenseForm({
  me,
  circles,
  onDone,
  setError,
}: {
  me: Me;
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
}) {
  const [circleId, setCircleId] = useState(circles[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [splitMode, setSplitMode] = useState<"equal" | "custom">("equal");
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!circleId) {
      setMembers([]);
      return;
    }
    void api<{ members: Member[] }>(`/v1/circles/${circleId}`).then((r) => {
      setMembers(r.members);
      setSelected(r.members.map((m) => m.id));
    });
  }, [circleId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const amountMinor = parseToMinorUnits(amount, currency);
      const participants =
        splitMode === "equal"
          ? selected.map((userId) => ({ userId }))
          : selected.map((userId) => ({ userId, amountMinor: parseToMinorUnits(custom[userId] ?? "0", currency) }));

      await api("/v1/expenses", {
        idempotencyKey: idempotencyKey("expense"),
        body: {
          circleId,
          description,
          amountMinor,
          currency,
          payerId: me.id,
          splitMode,
          participants,
        },
      });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message}${err.fieldErrors ? ` (${err.fieldErrors.map((f) => f.field).join(", ")})` : ""}`
          : "Could not save the expense",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="notice">
        Track and coordinate shared expenses. Payments happen through your bank or provider — Vibe
        does not hold pooled funds.
      </div>
      <CircleSelect circles={circles} value={circleId} onChange={setCircleId} />
      <label htmlFor="expDesc">Description</label>
      <input id="expDesc" value={description} onChange={(e) => setDescription(e.target.value)} required />
      <div className="row">
        <div style={{ flex: 2 }}>
          <label htmlFor="expAmount">Amount</label>
          <input
            id="expAmount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="expCurrency">Currency</label>
          <input id="expCurrency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </div>
      </div>

      <label htmlFor="splitMode">Split</label>
      <select id="splitMode" value={splitMode} onChange={(e) => setSplitMode(e.target.value as "equal" | "custom")}>
        <option value="equal">Equal</option>
        <option value="custom">Custom amounts</option>
      </select>

      <p className="meta">Participants</p>
      {members.map((member) => (
        <div key={member.id} className="row spread" style={{ marginBottom: "var(--space-1)" }}>
          <label htmlFor={`part-${member.id}`} style={{ marginBottom: 0 }}>
            @{member.handle}
          </label>
          <div className="row">
            {splitMode === "custom" && selected.includes(member.id) && (
              <input
                aria-label={`Amount for ${member.handle}`}
                inputMode="decimal"
                style={{ width: 100, marginBottom: 0 }}
                value={custom[member.id] ?? ""}
                onChange={(e) => setCustom({ ...custom, [member.id]: e.target.value })}
              />
            )}
            <input
              id={`part-${member.id}`}
              type="checkbox"
              checked={selected.includes(member.id)}
              onChange={(e) =>
                setSelected(e.target.checked ? [...selected, member.id] : selected.filter((id) => id !== member.id))
              }
              style={{ width: 44, minHeight: 24, marginBottom: 0 }}
            />
          </div>
        </div>
      ))}

      <button
        className="btn primary"
        type="submit"
        disabled={busy || !description.trim() || !amount || selected.length === 0 || !circleId}
      >
        {busy ? "Saving…" : "Save expense"}
      </button>
    </form>
  );
}
