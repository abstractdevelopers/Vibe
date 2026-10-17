import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { uploadImageFile } from "../media";
import { ImageIcon, MegaphoneIcon, RadioIcon, StoreIcon, TicketIcon } from "../components/Icons";

/**
 * "Start something" hub.
 *
 * These five surfaces all had working API endpoints but no way in from the UI:
 * a business, a room, an event, a campaign and a product could only be created
 * with curl. This is the single place that exposes them.
 */

interface Circle { id: string; name: string }
interface Merchant { id: string; name: string; verificationStatus: string }

type Panel = "menu" | "room" | "merchant" | "event" | "product" | "campaign";

export function CreateSomethingSheet({ onClose, onCreated, initialPanel = "menu" }: { onClose: () => void; onCreated: () => void; initialPanel?: Panel }) {
  const [panel, setPanel] = useState<Panel>(initialPanel);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Start something" onClick={onClose}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div>
            <p className="meta">Start something</p>
            <h2>{panel === "menu" ? "What are you starting?" : TITLES[panel]}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <p className="error" role="alert">{error}</p>}

        {panel === "menu" && (
          <div className="stack">
            <MenuRow Icon={RadioIcon} title="Live room" hint="Sports, movie or music room with a schedule." onClick={() => setPanel("room")} />
            <MenuRow Icon={TicketIcon} title="Event" hint="A ticketed or free event people can attend." onClick={() => setPanel("event")} />
            <MenuRow Icon={StoreIcon} title="Business" hint="Open a store. An operator verifies it before products go live." onClick={() => setPanel("merchant")} />
            <MenuRow Icon={ImageIcon} title="Product" hint="List something for sale in one of your businesses." onClick={() => setPanel("product")} />
            <MenuRow Icon={MegaphoneIcon} title="Ad campaign" hint="Promote something. An operator reviews it before it runs." onClick={() => setPanel("campaign")} />
          </div>
        )}

        {panel === "room" && <RoomForm setError={setError} onDone={onCreated} onBack={() => setPanel("menu")} />}
        {panel === "merchant" && <MerchantForm setError={setError} onDone={onCreated} onBack={() => setPanel("menu")} />}
        {panel === "event" && <EventForm setError={setError} onDone={onCreated} onBack={() => setPanel("menu")} />}
        {panel === "product" && <ProductForm setError={setError} onDone={onCreated} onBack={() => setPanel("menu")} />}
        {panel === "campaign" && <CampaignForm setError={setError} onDone={onCreated} onBack={() => setPanel("menu")} />}
      </div>
    </div>
  );
}

const TITLES: Record<Exclude<Panel, "menu">, string> = {
  room: "Create a live room",
  merchant: "Open a business",
  event: "Create an event",
  product: "Add a product",
  campaign: "Create an ad campaign",
};

function MenuRow({ Icon, title, hint, onClick }: { Icon: (p: { width?: number; height?: number }) => JSX.Element; title: string; hint: string; onClick: () => void }) {
  return (
    <button className="card row spread menu-row" onClick={onClick} style={{ textAlign: "left" }}>
      <span className="row" style={{ gap: "var(--space-3)", alignItems: "center" }}>
        <Icon width={20} height={20} />
        <span>
          <strong style={{ display: "block" }}>{title}</strong>
          <span className="meta">{hint}</span>
        </span>
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0 }}>← Back</button>
  );
}

function useCircles(): Circle[] {
  const [circles, setCircles] = useState<Circle[]>([]);
  useEffect(() => {
    void api<{ circles: Circle[] }>("/v1/circles")
      .then((r) => setCircles(r.circles))
      .catch(() => setCircles([]));
  }, []);
  return circles;
}

function useMyMerchants(): Merchant[] {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  useEffect(() => {
    void api<{ merchants: Merchant[] }>("/v1/merchants/mine")
      .then((r) => setMerchants(r.merchants))
      .catch(() => setMerchants([]));
  }, []);
  return merchants;
}

function RoomForm({ setError, onDone, onBack }: FormProps) {
  const circles = useCircles();
  const [kind, setKind] = useState<"sports" | "movie" | "music" | "other">("sports");
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [durationMinutes, setDuration] = useState(120);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [circleId, setCircleId] = useState("");
  const [playbackMode, setPlaybackMode] = useState<"coordinated" | "synchronized">("coordinated");
  const [externalUrl, setExternalUrl] = useState("");
  const [spoilerPolicy, setSpoilerPolicy] = useState<"open" | "spoiler_safe">("open");
  const [dataSource, setDataSource] = useState("");
  const [dataSourceUrl, setDataSourceUrl] = useState("");
  const [rules, setRules] = useState("");
  const [recurrence, setRecurrence] = useState("");
  const [busy, setBusy] = useState(false);

  // The API refuses a synchronized room without a licensed-service link, and a
  // cited score without a named source. Surface that here rather than as a 400.
  const needsLink = playbackMode === "synchronized" && !externalUrl.trim();
  const needsSource = kind === "sports" && dataSourceUrl.trim() !== "" && !dataSource.trim();

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("/v1/activities/rooms", {
        body: {
          kind, title, topic: topic || undefined,
          startsAt: new Date(startsAt).toISOString(),
          durationMinutes, visibility,
          circleId: circleId || undefined,
          playbackMode,
          externalUrl: externalUrl || undefined,
          spoilerPolicy,
          dataSource: dataSource || undefined,
          dataSourceUrl: dataSourceUrl || undefined,
          rules: rules || undefined,
          recurrence: recurrence || undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the room");
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <BackRow onBack={onBack} />
      <label htmlFor="r-kind">Kind</label>
      <select id="r-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="sports">Sports — match room</option>
        <option value="movie">Movie — film club or watch party</option>
        <option value="music">Music — listening party</option>
        <option value="other">Other</option>
      </select>

      <label htmlFor="r-title">Title</label>
      <input id="r-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Arsenal vs Chelsea — match room" />

      <label htmlFor="r-topic">Topic (optional)</label>
      <input id="r-topic" className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is this room about?" />

      <label htmlFor="r-start">Starts at</label>
      <input id="r-start" className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />

      <label htmlFor="r-duration">Duration (minutes)</label>
      <input id="r-duration" className="input" type="number" min={5} max={1440} value={durationMinutes} onChange={(e) => setDuration(Number(e.target.value))} />

      <label htmlFor="r-vis">Who can see it</label>
      <select id="r-vis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
        <option value="public">Public</option>
        <option value="private">Private — invite only, revocable links</option>
      </select>

      <label htmlFor="r-circle">Circle (optional)</label>
      <select id="r-circle" className="input" value={circleId} onChange={(e) => setCircleId(e.target.value)}>
        <option value="">No Circle</option>
        {circles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <label htmlFor="r-repeat">Repeats (optional)</label>
      <select id="r-repeat" className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
        <option value="">Does not repeat</option>
        <option value="weekly">Weekly</option>
        <option value="fortnightly">Fortnightly</option>
        <option value="monthly">Monthly</option>
      </select>

      {(kind === "movie" || kind === "music") && (
        <>
          <label htmlFor="r-playback">Playback</label>
          <select id="r-playback" className="input" value={playbackMode} onChange={(e) => setPlaybackMode(e.target.value as typeof playbackMode)}>
            <option value="coordinated">Coordinated — everyone plays it on their own service</option>
            <option value="synchronized">Synchronized — needs a licensed service link</option>
          </select>
          <label htmlFor="r-ext">Licensed service link{playbackMode === "synchronized" ? "" : " (optional)"}</label>
          <input id="r-ext" className="input" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://open.spotify.com/…" />
          {needsLink && <p className="meta">A synchronized room must link the licensed service. Vibe does not retransmit media.</p>}
        </>
      )}

      {kind === "movie" && (
        <>
          <label htmlFor="r-spoiler">Spoilers</label>
          <select id="r-spoiler" className="input" value={spoilerPolicy} onChange={(e) => setSpoilerPolicy(e.target.value as typeof spoilerPolicy)}>
            <option value="open">Open discussion</option>
            <option value="spoiler_safe">Spoiler-safe</option>
          </select>
        </>
      )}

      {kind === "sports" && (
        <>
          <label htmlFor="r-source">Score source name (optional)</label>
          <input id="r-source" className="input" value={dataSource} onChange={(e) => setDataSource(e.target.value)} placeholder="Which licensed provider are scores from?" />
          <label htmlFor="r-source-url">Score source link (optional)</label>
          <input id="r-source-url" className="input" value={dataSourceUrl} onChange={(e) => setDataSourceUrl(e.target.value)} placeholder="https://…" />
          {needsSource && <p className="meta">Citing a data source requires naming it. Vibe does not fabricate live scores.</p>}
        </>
      )}

      <label htmlFor="r-rules">Room rules (optional)</label>
      <textarea id="r-rules" className="input" rows={3} value={rules} onChange={(e) => setRules(e.target.value)} />

      <button className="btn primary" disabled={busy || !title.trim() || !startsAt || needsLink || needsSource} onClick={() => void submit()}>
        {busy ? "Creating…" : "Create room"}
      </button>
    </div>
  );
}

function MerchantForm({ setError, onDone, onBack }: FormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [policies, setPolicies] = useState("");
  const [contactRoute, setContactRoute] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("/v1/merchants", {
        body: { name, description: description || undefined, category: category || undefined, policies: policies || undefined, contactRoute: contactRoute || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the business");
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <BackRow onBack={onBack} />
      <p className="meta">A new business starts unverified. An operator verifies it before its products appear in discovery.</p>
      <label htmlFor="m-name">Business name</label>
      <input id="m-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="m-desc">What do you sell?</label>
      <textarea id="m-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label htmlFor="m-cat">Category</label>
      <input id="m-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Food, fashion, electronics…" />
      <label htmlFor="m-policies">Returns and policies</label>
      <textarea id="m-policies" className="input" rows={3} value={policies} onChange={(e) => setPolicies(e.target.value)} />
      <label htmlFor="m-contact">How customers reach you</label>
      <input id="m-contact" className="input" value={contactRoute} onChange={(e) => setContactRoute(e.target.value)} />
      <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
        {busy ? "Opening…" : "Open business"}
      </button>
    </div>
  );
}

function EventForm({ setError, onDone, onBack }: FormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [city, setCity] = useState("");
  const [place, setPlace] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function pickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      setImageUrl(await uploadImageFile(file, 1280));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload that image");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api("/v1/events", {
        body: {
          title, description: description || undefined,
          startsAt: new Date(startsAt).toISOString(),
          city: city || undefined, place: place || undefined,
          imageUrl: imageUrl || undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the event");
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <BackRow onBack={onBack} />
      <label htmlFor="e-title">Event name</label>
      <input id="e-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="e-desc">Description</label>
      <textarea id="e-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label htmlFor="e-start">Starts at</label>
      <input id="e-start" className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
      <label htmlFor="e-city">City</label>
      <input id="e-city" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
      <label htmlFor="e-place">Venue</label>
      <input id="e-place" className="input" value={place} onChange={(e) => setPlace(e.target.value)} />
      <label htmlFor="e-image">Banner image (optional)</label>
      {imageUrl && <img className="event-banner" src={imageUrl} alt="" />}
      <label className="dropzone">
        <input
          id="e-image"
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => void pickImage(e.target.files?.[0])}
        />
        <ImageIcon width={18} height={18} />
        <span className="meta">{uploading ? "Uploading…" : imageUrl ? "Replace banner" : "Add a banner image"}</span>
      </label>
      <button className="btn primary" disabled={busy || uploading || !title.trim() || !startsAt} onClick={() => void submit()}>
        {busy ? "Creating…" : "Create event"}
      </button>
    </div>
  );
}

function ProductForm({ setError, onDone, onBack }: FormProps) {
  const merchants = useMyMerchants();
  const [merchantId, setMerchantId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [availability, setAvailability] = useState("in_stock");
  const [mediaUrl, setMediaUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!merchantId && merchants[0]) setMerchantId(merchants[0].id);
  }, [merchants, merchantId]);

  if (merchants.length === 0) {
    return (
      <div className="stack">
        <BackRow onBack={onBack} />
        <p className="meta">You need a business before you can list a product.</p>
      </div>
    );
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api(`/v1/merchants/${merchantId}/products`, {
        body: {
          name, description: description || undefined,
          priceMinor: Math.round(Number(price) * 100),
          currency,
          availability,
          status: "active",
          mediaUrl: mediaUrl.trim() ? mediaUrl.trim() : undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the product");
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <BackRow onBack={onBack} />
      <label htmlFor="p-merchant">Business</label>
      <select id="p-merchant" className="input" value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
        {merchants.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.verificationStatus})</option>)}
      </select>
      <label htmlFor="p-name">Product name</label>
      <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="p-desc">Description</label>
      <textarea id="p-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label htmlFor="p-price">Price</label>
      <input id="p-price" className="input" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
      <label htmlFor="p-cur">Currency</label>
      <input id="p-cur" className="input" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
      <label htmlFor="p-avail">Availability</label>
      <select id="p-avail" className="input" value={availability} onChange={(e) => setAvailability(e.target.value)}>
        <option value="in_stock">In stock</option>
        <option value="out_of_stock">Out of stock</option>
        <option value="preorder">Pre-order</option>
        <option value="discontinued">Discontinued</option>
      </select>
      <label htmlFor="p-media">Image link (optional)</label>
      <input id="p-media" className="input" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" />
      <button className="btn primary" disabled={busy || !name.trim() || !price} onClick={() => void submit()}>
        {busy ? "Adding…" : "Add product"}
      </button>
    </div>
  );
}

function CampaignForm({ setError, onDone, onBack }: FormProps) {
  const merchants = useMyMerchants();
  const [merchantId, setMerchantId] = useState("");
  const [name, setName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [objective, setObjective] = useState("awareness");
  const [creative, setCreative] = useState("");
  const [creativeTitle, setCreativeTitle] = useState("");
  const [creativeBody, setCreativeBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!merchantId && merchants[0]) setMerchantId(merchants[0].id);
  }, [merchants, merchantId]);

  if (merchants.length === 0) {
    return (
      <div className="stack">
        <BackRow onBack={onBack} />
        <p className="meta">You need a business before you can run a campaign.</p>
      </div>
    );
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      const created = await api<{ id: string }>("/v1/campaigns", {
        body: {
          merchantId, name, destinationUrl,
          budgetMinor: Math.round(Number(budget) * 100),
          currency,
          objective,
          creative,
          creativeTitle: creativeTitle || undefined,
          creativeBody: creativeBody || undefined,
        },
      });
      // Submit for review, which is what puts it in the operator queue.
      await api(`/v1/campaigns/${created.id}/submit`, { method: "POST" });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the campaign");
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <BackRow onBack={onBack} />
      <p className="meta">A campaign goes to an operator for review before it runs. Sponsored content is labelled.</p>
      <label htmlFor="c-merchant">Business</label>
      <select id="c-merchant" className="input" value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
        {merchants.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.verificationStatus})</option>)}
      </select>
      <label htmlFor="c-name">Campaign name</label>
      <input id="c-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="c-dest">Destination link</label>
      <input id="c-dest" className="input" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://…" />
      <label htmlFor="c-budget">Budget</label>
      <input id="c-budget" className="input" type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
      <label htmlFor="c-cur">Currency</label>
      <input id="c-cur" className="input" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
      <label htmlFor="c-objective">Objective</label>
      <select id="c-objective" className="input" value={objective} onChange={(e) => setObjective(e.target.value)}>
        <option value="awareness">Awareness</option>
        <option value="traffic">Traffic</option>
        <option value="engagement">Engagement</option>
        <option value="conversions">Conversions</option>
      </select>
      <label htmlFor="c-creative">Creative</label>
      <textarea id="c-creative" className="input" rows={3} required value={creative} onChange={(e) => setCreative(e.target.value)} placeholder="The full creative shown to people." />
      <label htmlFor="c-headline">Headline (optional)</label>
      <input id="c-headline" className="input" value={creativeTitle} onChange={(e) => setCreativeTitle(e.target.value)} />
      <label htmlFor="c-body">Body (optional)</label>
      <textarea id="c-body" className="input" rows={3} value={creativeBody} onChange={(e) => setCreativeBody(e.target.value)} />
      <button className="btn primary" disabled={busy || !name.trim() || !destinationUrl.trim() || !budget || !creative.trim()} onClick={() => void submit()}>
        {busy ? "Submitting…" : "Create and submit for review"}
      </button>
    </div>
  );
}

interface FormProps {
  setError: (v: string | null) => void;
  onDone: () => void;
  onBack: () => void;
}
