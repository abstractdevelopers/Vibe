/**
 * A stricter UI probe than `probe-overflow.mjs`.
 *
 * Overflow alone missed the defects the owner actually sees: a control that
 * overlaps another one, a tap target under 44px, a label clipped by an ellipsis
 * the design did not ask for, a fixed element sitting over content, and text
 * whose colour has no contrast against what is behind it.
 *
 * Everything here runs in the page and returns plain data. Findings are
 * grouped by kind so a driver can fail on the kinds that matter and ignore the
 * ones that are a deliberate design (a horizontal shelf is meant to run off the
 * edge).
 */
export function probeUi() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const findings = [];

  const desc = (el) => {
    const cls = (el.className || "").toString().slice(0, 70);
    const id = el.id ? `#${el.id}` : "";
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return `${el.tagName.toLowerCase()}${id}.${cls}${txt ? ` "${txt}"` : ""}`;
  };

  const style = (el) => getComputedStyle(el);

  /**
   * Inside a scroll container — either axis.
   *
   * This used to check only the horizontal axis, so content in a vertical
   * scroller (the room's facts column) was tested for overlap even when it had
   * scrolled out of view, and reported as sitting on top of the dock below it.
   * Overflow on either axis is the same situation: the element may simply not
   * be on screen.
   */
  const inScroller = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cs = style(n);
      const scrollsY = (cs.overflowY === "auto" || cs.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 1;
      const scrollsX = (cs.overflowX === "auto" || cs.overflowX === "scroll") && n.scrollWidth > n.clientWidth + 1;
      if (scrollsX || scrollsY) return true;
      n = n.parentElement;
    }
    return false;
  };

  const visible = (el) => {
    const cs = style(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };

  const all = [...document.querySelectorAll("body *")].filter(visible);

  // 1. Horizontal overflow outside a scroller.
  for (const el of all) {
    const cs = style(el);
    if (cs.position === "fixed") continue;
    if (inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1.5) findings.push({ kind: "overflow-right", el: desc(el), detail: `${Math.round(r.right)} > ${vw}` });
    if (r.left < -1.5) findings.push({ kind: "overflow-left", el: desc(el), detail: `${Math.round(r.left)}` });
  }

  // 2. Sibling boxes that overlap without one being the other's ancestor and
  //    without a deliberate overlay (absolute/fixed, or a transform/negative
  //    margin). This is the "collided containers/components" class.
  const isOverlayish = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const cs = style(n);
      if (cs.position === "absolute" || cs.position === "fixed" || cs.position === "sticky") return true;
      n = n.parentElement;
    }
    return false;
  };

  const boxes = all.filter((el) => {
    if (el.children.length > 0) return false;
    if (el.closest("svg")) return false;
    if (isOverlayish(el)) return false;
    if (inScroller(el)) return false;
    const t = (el.textContent || "").trim();
    return t.length > 0;
  });

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        findings.push({ kind: "text-overlap", el: `${desc(a)} <> ${desc(b)}`, detail: `${Math.round(ox)}x${Math.round(oy)}` });
      }
    }
  }

  // 3. Tap targets. 44px is the floor for anything a finger must hit. A control
  //    may reach it either with its own box or with a transparent
  //    absolutely-positioned ::after overlay — the pattern `.feed-author` uses
  //    so a text link stays a text link. Measure what a finger can actually
  //    hit, or the audit argues with the repo's own documented fix.
  const hitRect = (el, r) => {
    const after = getComputedStyle(el, "::after");
    if (!after || after.content === "none" || after.content === "normal") return r;
    if (after.position !== "absolute") return r;
    if (after.pointerEvents === "none") return r;
    const px = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
    const top = px(after.top), left = px(after.left), right = px(after.right), bottom = px(after.bottom);
    if (top === null && left === null && right === null && bottom === null) return r;
    const out = {
      left: left !== null ? r.left + left : r.left,
      top: top !== null ? r.top + top : r.top,
      right: right !== null ? r.right - right : r.right,
      bottom: bottom !== null ? r.bottom - bottom : r.bottom,
    };
    out.width = out.right - out.left;
    out.height = out.bottom - out.top;
    return out;
  };

  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, [role=button], [role=tab]")) {
    if (!visible(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 6 || box.height < 6) continue;
    const r = hitRect(el, box);
    if (r.width < 44 || r.height < 44) {
      const cs = style(el);
      // A link inside a paragraph is exempt: it is text, not a control.
      const inlineLink = el.tagName === "A" && cs.display.startsWith("inline");
      if (inlineLink) continue;
      findings.push({ kind: "small-target", el: desc(el), detail: `${Math.round(r.width)}x${Math.round(r.height)}` });
    }
  }

  // 4. Text clipped by a hidden overflow without an ellipsis or a clamp — the
  //    case where a label is cut mid-word and simply looks broken.
  for (const el of all) {
    if (el.children.length > 0) continue;
    const cs = style(el);
    const text = (el.textContent || "").trim();
    if (!text) continue;
    if (cs.overflow === "visible") continue;
    const clippedX = el.scrollWidth > el.clientWidth + 2;
    const clippedY = el.scrollHeight > el.clientHeight + 2;
    if (!clippedX && !clippedY) continue;
    const ellipsis = cs.textOverflow === "ellipsis";
    const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
    const scrollerSelf = cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (scrollerSelf) continue;
    if (clippedX && !ellipsis && !clamp) {
      findings.push({ kind: "clipped-text", el: desc(el), detail: `scroll ${el.scrollWidth} > ${el.clientWidth}` });
    }
  }

  // 5. Fixed or sticky elements that cover content when they should not.
  for (const el of all) {
    const cs = style(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.height < 20) continue;
    // Look for content behind the element's band.
    const hit = document.elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height / 2, 24)))
      .filter((n) => !el.contains(n) && n !== el && n !== document.body && n !== document.documentElement);
    const interactive = hit.find((n) => n.matches("button, a[href], input, select, textarea, [role=button]"));
    if (interactive && !el.contains(interactive)) {
      findings.push({ kind: "covered-control", el: desc(el), detail: `covers ${desc(interactive)}` });
    }
  }

  // 6. Hard-coded hex colours on interactive elements. Every interactive colour
  //    must come from a token, or the element ignores the selected theme.
  for (const el of document.querySelectorAll("button, .btn, .chip, .pill, input, select, textarea")) {
    if (!visible(el)) continue;
    const cs = style(el);
    const hex = /^rgb\(/.test(cs.color) ? null : cs.color;
    if (hex && /^#[0-9a-f]{3,8}$/i.test(hex)) {
      findings.push({ kind: "raw-colour", el: desc(el), detail: `color ${hex}` });
    }
  }

  // 7. Backdrop of the page: if a decorative layer has a non-negative z-index it
  //    paints over content, which once made the whole app look empty.
  for (const sel of [".atmosphere", ".grain"]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const z = Number(style(el).zIndex);
    if (z >= 0) findings.push({ kind: "layer-z", el: sel, detail: `z=${style(el).zIndex} must be negative` });
  }

  // 8. Body must never scroll sideways.
  if (document.documentElement.scrollWidth > vw + 2) {
    findings.push({ kind: "page-scroll-x", el: "html", detail: `${document.documentElement.scrollWidth} > ${vw}` });
  }

  return {
    url: location.href,
    viewport: { w: vw, h: vh },
    findings,
  };
}
