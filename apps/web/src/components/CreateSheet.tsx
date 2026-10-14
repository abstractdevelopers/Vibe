import { useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { parseToMinorUnits } from "@vibe/shared";
import type { CircleSummary, Me } from "../types";
import {
  CalendarIcon,
  CheckIcon,
  CloseIcon,
  SparkIcon,
  WalletIcon,
  ChatIcon,
  UsersIcon,
} from "../components/Icons";

interface Props {
  me: Me;
  onClose: () => void;
  onCreated: () => void;
}

type Mode = "post" | "poll" | "plan" | "expense";

const MODES: Array<{ id: Mode; label: string; hint: string; Icon: typeof ChatIcon }> = [
  { id: "post", label: "Post", hint: "Share something with your connections or a Circle.", Icon: ChatIcon },
  { id: "poll", label: "Poll", hint: "Ask a question. Everyone gets one vote.", Icon: SparkIcon },
  { id: "plan", label: "Plan", hint: "Propose an outing and collect RSVPs.", Icon: CalendarIcon },
  { id: "expense", label: "Split", hint: "Track a shared cost — Vibe never holds the money.", Icon: WalletIcon },
];

export function CreateSheet({ me, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>("post");
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const active = MODES.find((m) => m.id === mode)!;

  useEffect(() => {
    void api<{ circles: CircleSummary[] }>("/v1/circles").then((r) => setCircles(r.circles));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Create" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />

        <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            <p className="eyebrow">Create</p>
            <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-display)" }}>
              {active.label}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        <div className="pill-row" role="tablist" aria-label="What to create">
          {MODES.map((m) => (
            <button
              key={m.id}
              className="pill"
              role="tab"
              aria-pressed={mode === m.id}
              onClick={() => {
                setMode(m.id);
                setError(null);
              }}
            >
              <m.Icon width={15} height={15} style={{ marginRight: 6 }} />
              {m.label}
            </button>
          ))}
        </div>
        <p className="meta" style={{ marginBottom: "var(--space-4)" }}>
          {active.hint}
        </p>

        {error && <div className="notice danger">{error}</div>}

        {mode === "post" && <PostForm circles={circles} onDone={onCreated} setError={setError} />}
        {mode === "poll" && <PollForm circles={circles} onDone={onCreated} setError={setError} />}
        {mode === "plan" && <PlanForm circles={circles} onDone={onCreated} setError={setError} />}
        {mode === "expense" && <ExpenseForm me={me} circles={circles} onDone={onCreated} setError={setError} />}
      </div>
    </div>
  );
}

function CircleSelect({
  circles,
  value,
  onChange,
  allowNone,
  id,
}: {
  circles: CircleSummary[];
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
  id: string;
}) {
  if (circles.length === 0) {
    return (
      <div className="notice">
        <UsersIcon width={16} height={16} /> You need to be in a Circle for this. Create one first.
      </div>
    );
  }
  return (
    <>
      <label htmlFor={id}>Circle</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowNone && <option value="">No Circle — my connections</option>}
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
        body: { body, audience: circleId ? "circle" : "connections", ...(circleId ? { circleId } : {}) },
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
      <textarea id="postBody" value={body} onChange={(e) => setBody(e.target.value)} autoFocus required />
      {circles.length > 0 && (
        <CircleSelect id="postCircle" circles={circles} value={circleId} onChange={setCircleId} allowNone />
      )}
      <button className="btn primary block" type="submit" disabled={busy || !body.trim()}>
        {busy ? "Posting…" : "Publish"}
      </button>
    </form>
  );
}

function PollForm({
  circles,
  onDone,
  setError,
}: {
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [circleId, setCircleId] = useState(circles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const cleaned = options.map((o) => o.trim()).filter(Boolean);
    if (cleaned.length < 2) {
      setError("A poll needs at least two options");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/v1/activities", { body: { question, options: cleaned, ...(circleId ? { circleId } : {}) } });
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
      <input id="question" value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus required />
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
      <button className="btn ghost" type="button" onClick={() => setOptions([...options, ""])} disabled={options.length >= 10}>
        + Add option
      </button>
      <CircleSelect id="pollCircle" circles={circles} value={circleId} onChange={setCircleId} />
      <button className="btn primary block" type="submit" disabled={busy || !question.trim()}>
        {busy ? "Creating…" : "Create poll"}
      </button>
    </form>
  );
}

function PlanForm({
  circles,
  onDone,
  setError,
}: {
  circles: CircleSummary[];
  onDone: () => void;
  setError: (v: string | null) => void;
}) {
  const [circleId, setCircleId] = useState(circles[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);

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
      <CircleSelect id="planCircle" circles={circles} value={circleId} onChange={setCircleId} />
      <label htmlFor="planTitle">Title</label>
      <input id="planTitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Friday dinner" required />
      <label htmlFor="planWhen">When</label>
      <input id="planWhen" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
      <label htmlFor="planPlace">Place</label>
      <input id="planPlace" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Where?" />
      <button className="btn primary block" type="submit" disabled={busy || !title.trim() || !startsAt || !circleId}>
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
        body: { circleId, description, amountMinor, currency, payerId: me.id, splitMode, participants },
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
        <WalletIcon width={16} height={16} /> Payments happen through your bank or provider. Vibe does not hold pooled funds.
      </div>
      <CircleSelect id="expCircle" circles={circles} value={circleId} onChange={setCircleId} />
      <label htmlFor="expDesc">Description</label>
      <input id="expDesc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Dinner" required />

      <div className="row" style={{ gap: "var(--space-3)" }}>
        <div className="grow">
          <label htmlFor="expAmount">Amount</label>
          <input id="expAmount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
        </div>
        <div style={{ width: 100 }}>
          <label htmlFor="expCurrency">Currency</label>
          <input id="expCurrency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </div>
      </div>

      <label htmlFor="splitMode">Split</label>
      <select id="splitMode" value={splitMode} onChange={(e) => setSplitMode(e.target.value as "equal" | "custom")}>
        <option value="equal">Equal</option>
        <option value="custom">Custom amounts</option>
      </select>

      <p className="eyebrow" style={{ marginTop: "var(--space-3)" }}>
        Participants
      </p>
      {members.map((member) => (
        <div key={member.id} className="row spread" style={{ padding: "var(--space-2) 0" }}>
          <label htmlFor={`part-${member.id}`} style={{ marginBottom: 0, color: "var(--text)" }}>
            @{member.handle}
          </label>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            {splitMode === "custom" && selected.includes(member.id) && (
              <input
                aria-label={`Amount for ${member.handle}`}
                inputMode="decimal"
                style={{ width: 96, marginBottom: 0 }}
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
              style={{ width: 26, minHeight: 26, height: 26, marginBottom: 0, accentColor: "var(--coral)", cursor: "pointer" }}
            />
          </div>
        </div>
      ))}

      <button
        className="btn primary block"
        type="submit"
        style={{ marginTop: "var(--space-4)" }}
        disabled={busy || !description.trim() || !amount || selected.length === 0 || !circleId}
      >
        <CheckIcon width={18} height={18} />
        {busy ? "Saving…" : "Save expense"}
      </button>
    </form>
  );
}
