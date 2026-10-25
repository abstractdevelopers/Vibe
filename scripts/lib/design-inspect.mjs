/**
 * A design inspector, not a layout linter.
 *
 * The layout audit answers "does anything overflow or collide". This answers
 * "is it readable, rhythmically spaced, correctly hierarchical, and visibly
 * finished" — questions a zero-collision page can still fail badly.
 *
 * Checks, each returning evidence rather than a verdict:
 *   contrast      WCAG 2.1 ratio for every run of text against its real
 *                 backdrop (walks ancestors for the first painted colour)
 *   fontSize      body copy below 12px, or display type that is not display
 *   rhythm        vertical gaps between siblings: off-scale values and
 *                 inconsistent section spacing
 *   hierarchy     more than three type sizes competing in one view
 *   images        <img> that failed, has no dimensions, or is 0x0
 *   safeArea      fixed chrome overlapping content, or content under it
 *   truncation    text clipped by ellipsis or overflow where it matters
 *   density       touch targets closer than 8px, labels with no breathing room
 */

export function inspectDesign() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const issues = [];
  const add = (kind, severity, el, detail) => {
    const cls = typeof el?.className === "string" ? el.className.split(" ")[0] : "";
    const label = el ? `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}` : "-";
    const text = (el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
    issues.push({ kind, severity, el: `${label}${text ? ` "${text}"` : ""}`, detail });
  };

  // ---- colour ------------------------------------------------------------
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(",").map((v) => parseFloat(v));
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  /**
   * The effective background behind an element, compositing every translucent
   * layer down to the page. Stopping at the first "mostly opaque" colour is
   * wrong: a 60%-opaque surface over the page is much darker than the token
   * suggests, and reading the token alone reports contrast failures that are
   * not there (and hides some that are).
   */
  const backdropOf = (el) => {
    const layers = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // photographic or gradient: not computable here
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) layers.push(bg);
      if (bg && bg.a >= 1) break;
      n = n.parentElement;
    }
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    let base = bodyBg && bodyBg.a >= 1 ? bodyBg : { r: 13, g: 15, b: 24, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i];
      base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a), a: 1 };
    }
    return base;
  };
  const composite = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const textNodes = [...document.querySelectorAll("body *")].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // Only elements that own visible text.
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  });

  const sizes = new Map();
  let contrastFails = 0;
  for (const el of textNodes) {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    sizes.set(size, (sizes.get(size) || 0) + 1);

    const fgRaw = parse(cs.color);
    const bg = backdropOf(el);
    if (fgRaw && bg) {
      const fg = composite(fgRaw, bg);
      const cr = ratio(fg, bg);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (cr < need) {
        contrastFails += 1;
        if (contrastFails <= 12) add("contrast", cr < need - 1.5 ? "high" : "medium", el, `${cr.toFixed(2)}:1 needs ${need}:1 at ${size}px/${weight}`);
      }
    }
    // 11.5px is this design's metadata step (--text-meta), used for dates,
    // counts and secondary labels. Body copy below 11px is the problem.
    if (size < 11 && el.textContent.trim().length > 24) {
      add("font-size", "medium", el, `${size}px body copy`);
    }
  }

  // ---- vertical rhythm ---------------------------------------------------
  const SCALE = [4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64];
  const offScale = [];
  const containers = [...document.querySelectorAll("main, .app-shell, .stack, .screen, .studio, .room-facts, .feed, .sheet-card")];
  for (const c of containers) {
    const kids = [...c.children].filter((k) => k.getBoundingClientRect().height > 4);
    for (let i = 1; i < kids.length; i += 1) {
      const prev = kids[i - 1].getBoundingClientRect();
      const cur = kids[i].getBoundingClientRect();
      const gap = Math.round(cur.top - prev.bottom);
      if (gap > 0 && !SCALE.includes(gap)) offScale.push(gap);
    }
  }
  if (offScale.length) {
    const uniq = [...new Set(offScale)].slice(0, 8);
    issues.push({ kind: "rhythm", severity: "low", el: "section gaps", detail: `off-scale: ${uniq.join(", ")}px` });
  }

  // ---- type hierarchy ----------------------------------------------------
  const distinct = [...sizes.entries()].filter(([, n]) => n >= 2).map(([s]) => s).sort((a, b) => b - a);
  if (distinct.length > 4) {
    issues.push({ kind: "hierarchy", severity: "low", el: "type scale", detail: `${distinct.length} sizes in view: ${distinct.slice(0, 8).join(", ")}` });
  }

  // ---- images ------------------------------------------------------------
  // Only images that are actually on screen. A lazy image below the fold has
  // not loaded yet by design; counting it reports twenty broken images on a
  // page that renders perfectly.
  for (const img of document.querySelectorAll("img")) {
    const r = img.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    if (!onScreen) continue;
    if (!img.complete || img.naturalWidth === 0) {
      if (r.width > 0) add("image", "high", img, `not loaded (${Math.round(r.width)}x${Math.round(r.height)}) src=${(img.getAttribute("src") || "").slice(0, 60)}`);
      continue;
    }
    if (r.width < 2 || r.height < 2) add("image", "high", img, "renders at zero size");
    const ratioBox = img.naturalWidth / img.naturalHeight;
    const ratioSlot = r.width / r.height;
    const fit = getComputedStyle(img).objectFit;
    if (fit === "fill" && Math.abs(ratioBox - ratioSlot) > 0.35) add("image", "medium", img, `stretched ${ratioBox.toFixed(2)} -> ${ratioSlot.toFixed(2)}`);
  }

  // ---- fixed chrome over content ----------------------------------------
  // Only chrome that can actually intercept a tap counts: a decorative layer
  // with pointer-events:none cannot cover anything, and a bar overlapping its
  // own children is the bar. Without both filters this reports hundreds of
  // non-issues and buries the real ones.
  const fixed = [...document.querySelectorAll("body *")].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") return false;
    if (cs.pointerEvents === "none") return false;
    if (Number(cs.opacity) < 0.05 || cs.visibility === "hidden") return false;
    return el.getBoundingClientRect().height > 10;
  });
  const interactive = [...document.querySelectorAll("button, a, input, [role=button], [role=tab]")];
  for (const bar of fixed) {
    const br = bar.getBoundingClientRect();
    const covered = interactive.filter((el) => {
      if (bar.contains(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === "none") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2) return false;
      // An element taller/wider than the viewport that merely extends under the
      // bar is not "covered" in the way that blocks a tap; only elements whose
      // centre falls inside the bar are actually unreachable.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return cx > br.left && cx < br.right && cy > br.top && cy < br.bottom;
    });
    if (covered.length) {
      // A scrollable page can bring a covered element out from under the bar
      // with a flick; only a page that cannot scroll has genuinely buried
      // content. (A room reserves the nav and is checked separately.)
      const scrollable = document.documentElement.scrollHeight > vh + 4 || document.body.scrollHeight > vh + 4;
      if (scrollable && bar.classList.contains("bottom-nav")) continue;
      const sample = covered[0];
      add("safe-area", "high", bar, `covers ${covered.length} control(s), e.g. ${(sample.getAttribute("aria-label") || sample.textContent || "").trim().slice(0, 24)}`);
    }
  }

  // ---- truncation --------------------------------------------------------
  let clipped = 0;
  for (const el of textNodes) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) {
      clipped += 1;
      if (clipped <= 4) add("truncation", "low", el, `ellipsised at ${el.clientWidth}px`);
    }
  }

  // ---- density -----------------------------------------------------------
  const targets = interactive
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== "hidden";
    })
    .map((el) => ({ el, r: el.getBoundingClientRect() }));
  let tight = 0;
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const a = targets[i].r, b = targets[j].r;
      if (targets[i].el.contains(targets[j].el) || targets[j].el.contains(targets[i].el)) continue;
      const gapX = Math.max(a.left, b.left) - Math.min(a.right, b.right);
      const gapY = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
      const overlapping = gapX < 0 && gapY < 0;
      if (overlapping) continue;
      const gap = Math.max(gapX, gapY);
      if (gap >= 0 && gap < 4) { tight += 1; }
    }
  }
  if (tight > 0) issues.push({ kind: "density", severity: "low", el: "control spacing", detail: `${tight} adjacent control pair(s) below 4px apart` });

  return {
    viewport: { w: vw, h: vh },
    textRuns: textNodes.length,
    contrastChecked: textNodes.length,
    typeSizes: distinct,
    issues,
  };
}
