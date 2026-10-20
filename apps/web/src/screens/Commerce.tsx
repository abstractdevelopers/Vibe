import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useNav } from "../nav";
import { ArrowLeftIcon, CheckIcon, MoneyIcon, ReceiptIcon, StoreIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { ScreenHeader } from "../components/ScreenHeader";
import { formatMoney } from "../money";

interface Product {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  availability: string;
  status: string;
}

interface Merchant {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  verificationStatus: string;
  policies: string | null;
  isOwner: boolean;
}

const ORDER_STATES = [
  "created", "awaiting_payment", "payment_processing", "paid", "seller_confirmed",
  "fulfilling", "completed", "cancelled", "failed", "refund_pending", "refunded", "disputed",
];


export function StorefrontScreen({ merchantId, onBack }: { merchantId: string; onBack: () => void }) {
  const nav = useNav();
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, p] = await Promise.all([
        api<Merchant>(`/v1/merchants/${merchantId}`),
        api<{ products: Product[] }>(`/v1/merchants/${merchantId}/products`),
      ]);
      setMerchant(m);
      setProducts(p.products);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this store");
    }
  }, [merchantId]);

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
          title="We couldn't open this store"
          text={error}
          action={<button className="btn" onClick={() => void load()}>Try again</button>}
        />
      )}
      {!error && merchant === null && <div className="skeleton" aria-busy="true" />}

      {merchant && (
        <>
          <h1 className="screen-title">{merchant.name}</h1>
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            {merchant.category && <span className="audience-tag">{merchant.category}</span>}
            <span className="audience-tag">
              {merchant.verificationStatus === "verified" ? "Verified business" : "Not yet verified"}
            </span>
          </div>
          {merchant.description && <p>{merchant.description}</p>}

          <h2 className="section-title">Products</h2>
          {products.length === 0 && <p className="meta">This store has no products yet.</p>}
          <div className="stack">
            {products.map((p) => (
              <button key={p.id} className="card row spread" onClick={() => nav.push({ name: "product", productId: p.id })}>
                <span>
                  <strong>{p.name}</strong>
                  <div className="meta">{p.availability.replace(/_/g, " ")}</div>
                </span>
                <span className="price">{formatMoney(p.priceMinor, p.currency)}</span>
              </button>
            ))}
          </div>

          {merchant.policies && (
            <>
              <h2 className="section-title">Policies</h2>
              <p className="meta">{merchant.policies}</p>
            </>
          )}

          <p className="meta" style={{ marginTop: "var(--space-4)" }}>
            Payments are collected by the payment provider. Vibe does not hold your money, and an
            order is only marked paid once the provider confirms it.
          </p>
        </>
      )}
    </div>
  );
}

export function ProductScreen({ productId, onBack }: { productId: string; onBack: () => void }) {
  const nav = useNav();
  const [product, setProduct] = useState<Product & { merchantId: string; merchantName: string; merchantVerification: string; fulfillment: string | null; refundPolicy: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProduct(await api(`/v1/products/${productId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this product");
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function buy() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api<{ id: string }>("/v1/orders", {
        method: "POST",
        idempotencyKey: `order-${productId}-${Date.now()}`,
        body: { merchantId: product.merchantId, items: [{ productId, quantity: qty }] },
      });
      nav.push({ name: "order", orderId: order.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && <div className="notice danger">{error}</div>}
      {!product && !error && <div className="skeleton" aria-busy="true" />}

      {product && (
        <>
          <h1 className="screen-title">{product.name}</h1>
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            <button className="audience-tag" onClick={() => nav.push({ name: "store", merchantId: product.merchantId })}>
              {product.merchantName}
            </button>
            <span className="audience-tag">{product.availability.replace(/_/g, " ")}</span>
            {product.merchantVerification === "verified" && (
              <span className="audience-tag"><CheckIcon width={12} height={12} /> Verified</span>
            )}
          </div>

          {product.description && <p>{product.description}</p>}
          <div className="card">
            <div className="row spread">
              <span className="row" style={{ gap: "var(--space-2)" }}>
                <MoneyIcon width={16} height={16} /> Price
              </span>
              <strong className="price">{formatMoney(product.priceMinor, product.currency)}</strong>
            </div>
            {product.fulfillment && <p className="meta">Fulfilment: {product.fulfillment}</p>}
            {product.refundPolicy && <p className="meta">Refunds: {product.refundPolicy}</p>}
          </div>

          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            <label className="meta" htmlFor="qty">Quantity</label>
            <input
              id="qty"
              className="input"
              type="number"
              min={1}
              max={100}
              value={qty}
              style={{ width: 80 }}
              onChange={(e) => setQty(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
            <button className="btn primary" disabled={busy} onClick={() => void buy()}>
              {busy ? "Starting…" : "Continue to payment"}
            </button>
          </div>
          <p className="meta" style={{ marginTop: "var(--space-3)" }}>
            You'll confirm the full amount with the payment provider. The order stays unpaid until
            the provider tells us the payment succeeded.
          </p>
        </>
      )}
    </div>
  );
}

interface Order {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  reference: string;
  provider: string | null;
  merchantId: string;
  merchantName: string | null;
  isSeller: boolean;
  isBuyer: boolean;
  items: Array<{ id: string; name: string; unitAmountMinor: number; quantity: number; currency: string }>;
  history: Array<{ fromStatus: string | null; toStatus: string; reason: string | null; createdAt: string }>;
}

/**
 * What each side may do from the current state. The API is the real guard; this
 * only decides which buttons to draw. `refunded` never appears: money returns
 * only when the provider confirms it, so the most we offer is a refund request.
 */
function orderActions(order: Order): Array<{ to: string; label: string }> {
  const actions: Array<{ to: string; label: string }> = [];
  const seller = order.isSeller;
  const buyer = order.isBuyer;
  switch (order.status) {
    case "paid":
      if (seller) actions.push({ to: "seller_confirmed", label: "Confirm order" }, { to: "fulfilling", label: "Start fulfilling" });
      break;
    case "seller_confirmed":
      if (seller) actions.push({ to: "fulfilling", label: "Start fulfilling" });
      break;
    case "fulfilling":
      if (seller) actions.push({ to: "completed", label: "Mark completed" });
      break;
    case "disputed":
      if (seller) actions.push({ to: "completed", label: "Resolve and complete" });
      break;
  }
  if (seller && ["paid", "seller_confirmed", "fulfilling"].includes(order.status)) {
    actions.push({ to: "refund_pending", label: "Request refund" });
  }
  if (buyer && ["created", "awaiting_payment", "payment_processing"].includes(order.status)) {
    actions.push({ to: "cancelled", label: "Cancel order" });
  }
  if (buyer && ["paid", "seller_confirmed", "fulfilling", "completed"].includes(order.status)) {
    actions.push({ to: "disputed", label: "Raise a dispute" });
  }
  if (buyer && order.status === "fulfilling") actions.push({ to: "completed", label: "Confirm received" });
  return actions;
}

export function OrderScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redirect, setRedirect] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrder(await api<Order>(`/v1/orders/${orderId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this order");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirectUrl: string | null; status: string }>(`/v1/orders/${orderId}/checkout`, {
        method: "POST",
        idempotencyKey: `checkout-${orderId}-${Date.now()}`,
      });
      setRedirect(res.redirectUrl);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start payment");
    } finally {
      setBusy(false);
    }
  }

  async function transition(to: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${orderId}/transition`, { method: "POST", body: { to } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && <div className="notice danger">{error}</div>}
      {!order && !error && <div className="skeleton" aria-busy="true" />}

      {order && (
        <>
          <h1 className="screen-title">Order</h1>
          <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <span className="audience-tag">{order.status.replace(/_/g, " ")}</span>
            <span className="meta">#{order.reference}</span>
          </div>

          <div className="card">
            {order.items.map((it) => (
              <div className="row spread" key={it.id}>
                <span>{it.name} × {it.quantity}</span>
                <span>{formatMoney(it.unitAmountMinor * it.quantity, it.currency)}</span>
              </div>
            ))}
            <div className="row spread" style={{ marginTop: "var(--space-2)", fontWeight: 600 }}>
              <span>Total</span>
              <span className="price">{formatMoney(order.amountMinor, order.currency)}</span>
            </div>
          </div>

          {["created", "awaiting_payment"].includes(order.status) && (
            <button className="btn primary" style={{ marginTop: "var(--space-3)" }} disabled={busy} onClick={() => void pay()}>
              {busy ? "Opening payment…" : "Pay with the payment provider"}
            </button>
          )}

          {order.merchantName && (
            <p className="meta" style={{ marginTop: "var(--space-3)" }}>
              {order.isSeller ? "Selling at" : "Bought from"} {order.merchantName}
            </p>
          )}

          {orderActions(order).length > 0 && (
            <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
              {orderActions(order).map((action) => (
                <button
                  key={action.to}
                  className={`btn small ${action.to === "cancelled" || action.to === "disputed" ? "ghost" : "primary"}`}
                  disabled={busy}
                  onClick={() => void transition(action.to)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {order.status === "refund_pending" && (
            <p className="meta" style={{ marginTop: "var(--space-2)" }}>
              A refund is requested. The order is only marked refunded once the payment provider confirms it.
            </p>
          )}

          {redirect && (
            <div className="notice" style={{ marginTop: "var(--space-3)" }}>
              <p style={{ marginTop: 0 }}>
                Payment is awaiting confirmation. Complete it in the provider window, then come back —
                this order updates only when the provider confirms the payment.
              </p>
              <a className="btn" href={redirect} target="_blank" rel="noreferrer">Open provider checkout</a>
            </div>
          )}

          <h2 className="section-title">History</h2>
          <ul className="plain-list">
            {order.history.map((e, i) => (
              <li key={i} className="meta">
                {e.toStatus.replace(/_/g, " ")} — {new Date(e.createdAt).toLocaleString()}
                {e.reason ? ` (${e.reason})` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function OrdersScreen({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const [orders, setOrders] = useState<Array<{ id: string; status: string; amountMinor: number; currency: string; createdAt: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ orders: typeof orders }>("/v1/orders");
        setOrders(res.orders ?? []);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load your orders");
      }
    })();
  }, []);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Orders</h1>

      {error && <div className="notice danger">{error}</div>}
      {orders === null && !error && <div className="skeleton" aria-busy="true" />}
      {orders?.length === 0 && (
        <EmptyState icon={<ReceiptIcon />} title="No orders yet" text="Orders you place will appear here." />
      )}
      <div className="stack">
        {orders?.map((o) => (
          <button key={o.id} className="card row spread" onClick={() => nav.push({ name: "order", orderId: o.id })}>
            <span>
              <strong>{o.status.replace(/_/g, " ")}</strong>
              <div className="meta">{new Date(o.createdAt).toLocaleDateString()}</div>
            </span>
            <span className="price">{formatMoney(o.amountMinor, o.currency)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export { ORDER_STATES };

/**
 * The seller's side of commerce: orders placed against a store the caller owns.
 * This is where fulfilment happens — confirm, fulfil, complete, or request a
 * refund. A buyer never sees this list; the API scopes it to the store owner.
 */
export function SellerOrdersScreen({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const [orders, setOrders] = useState<
    Array<{ id: string; status: string; amountMinor: number; currency: string; createdAt: string; merchantName: string; buyerHandle: string }> | null
  >(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ orders: typeof orders }>(`/v1/seller/orders${onlyOpen ? "?open=true" : ""}`);
      setOrders(res.orders ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your sales");
    }
  }, [onlyOpen]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <ScreenHeader
        eyebrow="Your store"
        title="Sales"
        subtitle="Orders placed at your store. Fulfil them here; money is collected by the payment provider."
      />

      <div className="pill-row" role="tablist" aria-label="Filter">
        <button className="pill" role="tab" aria-pressed={!onlyOpen} onClick={() => setOnlyOpen(false)}>
          All
        </button>
        <button className="pill" role="tab" aria-pressed={onlyOpen} onClick={() => setOnlyOpen(true)}>
          Needs action
        </button>
      </div>

      {error && <div className="notice danger">{error}</div>}
      {orders === null && !error && <div className="skeleton" aria-busy="true" />}
      {orders?.length === 0 && (
        <EmptyState
          icon={<StoreIcon />}
          title={onlyOpen ? "Nothing needs you right now" : "No sales yet"}
          text="When someone buys from your store, the order shows up here."
        />
      )}
      <div className="stack">
        {orders?.map((o) => (
          <button key={o.id} className="card row spread" onClick={() => nav.push({ name: "order", orderId: o.id })}>
            <span>
              <strong>{o.status.replace(/_/g, " ")}</strong>
              <div className="meta">
                {o.merchantName} · @{o.buyerHandle} · {new Date(o.createdAt).toLocaleDateString()}
              </div>
            </span>
            <span className="price">{formatMoney(o.amountMinor, o.currency)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
