import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, MapPinIcon, MoneyIcon, StoreIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";

interface Place {
  id: string;
  name: string;
  kind: string;
  category: string;
  city: string;
  area: string | null;
  description: string | null;
  addressHint: string | null;
  priceBand: number | null;
  imageUrl: string | null;
  isVerified: boolean;
  isSample: boolean;
}

export function PlaceDetailScreen({ placeId, onBack }: { placeId: string; onBack: () => void }) {
  const [place, setPlace] = useState<Place | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ place: Place }>(`/v1/places/${placeId}`);
      setPlace(result.place);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this place");
    }
  }, [placeId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && (
        <EmptyState
          icon={<StoreIcon />}
          title="We couldn't open this place"
          text={error}
          action={
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          }
        />
      )}

      {!error && place === null && <div className="skeleton" aria-busy="true" />}

      {place && (
        <>
          <h1 className="screen-title">{place.name}</h1>
          <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
            <span className="audience-tag">{place.category}</span>
            {place.isVerified && <span className="audience-tag">Verified</span>}
            {place.isSample && <span className="audience-tag">Sample listing</span>}
          </div>

          <div className="card">
            {place.description && <p style={{ marginTop: 0 }}>{place.description}</p>}
            <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
              <MapPinIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
              <span>
                {[place.area, place.city].filter(Boolean).join(", ")}
                {place.addressHint ? ` · ${place.addressHint}` : ""}
              </span>
            </div>
            {place.priceBand != null && (
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <MoneyIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
                <span>{"₦".repeat(place.priceBand)} price band</span>
              </div>
            )}
          </div>

          <p className="meta" style={{ marginTop: "var(--space-4)" }}>
            Vibe shows places by city and area only. There is no checkout here — purchases happen at
            a verified shop's storefront, where the payment provider collects the money.
          </p>
        </>
      )}
    </div>
  );
}
