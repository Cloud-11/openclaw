/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;
const CHAT_PROGRESS_SELECTORS = {
  rail: ".chat-progress-rail",
  railList: ".chat-progress-rail__list",
  anchor: "[data-chat-progress-anchor]",
  dot: ".chat-progress-rail__dot",
  preview: ".chat-progress-rail__preview",
  previewText: ".chat-progress-rail__preview-text",
} as const;

const CHAT_PROGRESS_LAYOUT = {
  scrollOffsetPx: 18,
  previewOffsetPx: 18,
  previewEdgeMarginPx: 20,
  viewportInsetPx: 64,
  fixedRightPx: 30,
  visibleDotCount: 12,
  dotStepFallbackPx: 24,
  hoverVerticalPaddingPx: 3,
  railDeadzoneSteps: 1.6,
  railWindowViewportRatio: 0.68,
  railWindowPaddingPx: 28,
} as const;

const CHAT_PROGRESS_POINTER = {
  horizontalInsetPx: 12,
  switchHysteresisPx: 4,
} as const;

const CHAT_PROGRESS_PIN = {
  durationMs: 420,
  topTolerancePx: 40,
} as const;

const CHAT_PROGRESS_EMPHASIS = {
  distance: 7,
  active: {
    scaleMax: 1.26,
    scaleMin: 0.84,
    opacityMin: 0.62,
    power: 0.86,
  },
  hover: {
    scaleMax: 1.34,
    scaleMin: 0.88,
    opacityMin: 0.68,
    power: 0.82,
  },
} as const;

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatNewMessagesBelow: boolean;
  chatProgressActiveKey: string | null;
  chatProgressPinnedKey: string | null;
  chatProgressPinnedUntil: number | null;
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  topbarObserver: ResizeObserver | null;
};

function queryHost(host: Partial<ScrollHost>, selectors: string): Element | null {
  return typeof host.querySelector === "function" ? host.querySelector(selectors) : null;
}

function resolveChatThread(
  host: Partial<ScrollHost>,
  container?: Element | null,
): HTMLElement | null {
  if (
    container &&
    typeof (container as Element).matches === "function" &&
    (container as Element).matches(".chat-thread")
  ) {
    return container as HTMLElement;
  }
  return queryHost(host, ".chat-thread") as HTMLElement | null;
}

function getChatProgressAnchors(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(CHAT_PROGRESS_SELECTORS.anchor)).filter(
    (item) => Boolean(item.dataset.chatProgressAnchor),
  );
}

function getChatProgressRail(host: Partial<ScrollHost>): HTMLElement | null {
  return queryHost(host, CHAT_PROGRESS_SELECTORS.rail) as HTMLElement | null;
}

function getChatProgressRailList(host: Partial<ScrollHost>): HTMLElement | null {
  return queryHost(host, CHAT_PROGRESS_SELECTORS.railList) as HTMLElement | null;
}

function getChatProgressPreview(host: Partial<ScrollHost>): HTMLElement | null {
  return queryHost(host, CHAT_PROGRESS_SELECTORS.preview) as HTMLElement | null;
}

function getChatProgressPreviewText(host: Partial<ScrollHost>): HTMLElement | null {
  return queryHost(host, CHAT_PROGRESS_SELECTORS.previewText) as HTMLElement | null;
}

function hideChatProgressPreview(host: Partial<ScrollHost>) {
  const preview = getChatProgressPreview(host);
  if (!preview) {
    return;
  }
  preview.hidden = true;
  preview.dataset.visible = "false";
  delete preview.dataset.chatProgressTarget;
}

function clearChatProgressPin(host: Partial<ScrollHost>) {
  host.chatProgressPinnedKey = null;
  host.chatProgressPinnedUntil = null;
}

function hideChatProgressRail(host: Partial<ScrollHost>) {
  const rail = getChatProgressRail(host);
  if (rail) {
    rail.hidden = true;
    rail.dataset.visible = "false";
  }
  clearChatProgressPin(host);
  setChatProgressHoverState(host, null);
  hideChatProgressPreview(host);
}

function showChatProgressPreview(host: Partial<ScrollHost>, button: HTMLButtonElement) {
  const preview = getChatProgressPreview(host);
  const previewText = getChatProgressPreviewText(host);
  if (!preview || !previewText) {
    return;
  }

  const targetKey = button.dataset.chatProgressSelect?.trim() ?? "";
  if (
    !preview.hidden &&
    preview.dataset.visible === "true" &&
    preview.dataset.chatProgressTarget === targetKey
  ) {
    return;
  }

  const summary = button.dataset.chatProgressPreview?.trim();
  previewText.textContent = summary || "Message preview unavailable";
  preview.hidden = false;
  preview.dataset.visible = "true";
  preview.dataset.chatProgressTarget = targetKey;

  const buttonRect = button.getBoundingClientRect();
  const previewWidth = Math.min(320, Math.max(220, window.innerWidth - 88));
  const left = Math.max(16, buttonRect.left - previewWidth - CHAT_PROGRESS_LAYOUT.previewOffsetPx);
  const centerY = buttonRect.top + buttonRect.height / 2;
  const clampedTop = Math.max(
    CHAT_PROGRESS_LAYOUT.previewEdgeMarginPx,
    Math.min(window.innerHeight - CHAT_PROGRESS_LAYOUT.previewEdgeMarginPx, centerY),
  );
  preview.style.left = `${left}px`;
  preview.style.top = `${clampedTop}px`;
}

function getChatProgressDots(host: Partial<ScrollHost>): HTMLButtonElement[] {
  const list = getChatProgressRailList(host);
  if (!list) {
    return [];
  }
  return Array.from(list.querySelectorAll<HTMLButtonElement>(CHAT_PROGRESS_SELECTORS.dot));
}

function getChatProgressVisibleCount(list: HTMLElement | null): number {
  const value = Number(list?.dataset.chatProgressVisibleCount ?? "");
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : CHAT_PROGRESS_LAYOUT.visibleDotCount;
}

function estimateChatProgressDotStep(dots: HTMLElement[]): number {
  if (dots.length >= 2) {
    const firstTop = dots[0].getBoundingClientRect().top;
    const secondTop = dots[1].getBoundingClientRect().top;
    const distance = Math.abs(secondTop - firstTop);
    if (Number.isFinite(distance) && distance > 1) {
      return distance;
    }
  }
  return CHAT_PROGRESS_LAYOUT.dotStepFallbackPx;
}

function getChatProgressDotMetrics(
  list: HTMLElement,
  dot: HTMLElement,
): { top: number; center: number; height: number } {
  const listRect = list.getBoundingClientRect();
  const dotRect = dot.getBoundingClientRect();
  const height = dotRect.height || dot.offsetHeight || 14;
  const fallbackTop = list.scrollTop + (dotRect.top - listRect.top);
  const offsetTop = typeof dot.offsetTop === "number" && dot.offsetTop > 0 ? dot.offsetTop : fallbackTop;
  return {
    top: offsetTop,
    center: offsetTop + height / 2,
    height,
  };
}

function isChatProgressDotActive(dot: HTMLButtonElement, activeKey: string | null): boolean {
  return (
    dot.dataset.chatProgressSelect === activeKey ||
    dot.classList.contains("is-active") ||
    dot.getAttribute("aria-current") === "step"
  );
}

function parseChatProgressDotIndex(
  dot: HTMLButtonElement,
  fallbackIndex: number | null = null,
): number | null {
  const rawValue = dot.dataset.chatProgressIndex?.trim();
  if (!rawValue) {
    return fallbackIndex;
  }
  const value = Number(rawValue);
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallbackIndex;
}

function getChatProgressHoverIndex(list: HTMLElement | null): number | null {
  if (!list) {
    return null;
  }
  const rawValue = list.dataset.chatProgressHoverIndex?.trim();
  if (!rawValue) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function getChatProgressEmphasisCurve(distance: number, power: number): number {
  const clampedDistance = Math.max(0, Math.min(CHAT_PROGRESS_EMPHASIS.distance, distance));
  if (clampedDistance === 0) {
    return 0;
  }
  return Math.pow(clampedDistance / CHAT_PROGRESS_EMPHASIS.distance, power);
}

function getChatProgressDotEmphasis(
  distance: number,
  mode: "active" | "hover",
): { scale: number; opacity: number } {
  const profile = CHAT_PROGRESS_EMPHASIS[mode];
  const curve = getChatProgressEmphasisCurve(distance, profile.power);
  return {
    scale: profile.scaleMax - (profile.scaleMax - profile.scaleMin) * curve,
    opacity: 1 - (1 - profile.opacityMin) * curve,
  };
}

function getChatProgressDotPointerDistance(dot: HTMLButtonElement, clientY: number): number {
  const rect = dot.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  return Math.abs(clientY - centerY);
}

function resolveChatProgressPointerButton(
  host: Partial<ScrollHost>,
  event: Event,
): HTMLButtonElement | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }

  const directButton = target.closest(CHAT_PROGRESS_SELECTORS.dot);
  if (directButton instanceof HTMLButtonElement) {
    return directButton;
  }

  const list = getChatProgressRailList(host);
  if (!list || target !== list && !list.contains(target)) {
    return null;
  }

  if (!(event instanceof MouseEvent)) {
    return null;
  }

  const dots = getChatProgressDots(host);
  if (dots.length === 0) {
    return null;
  }

  const listRect = list.getBoundingClientRect();
  const horizontalInset = Math.max(
    CHAT_PROGRESS_POINTER.horizontalInsetPx,
    Math.round(listRect.width * 0.5),
  );
  const step = estimateChatProgressDotStep(dots);
  const dotHeight = dots[0]?.getBoundingClientRect().height ?? 14;
  const verticalInset = Math.max(
    step / 2,
    dotHeight / 2 + CHAT_PROGRESS_LAYOUT.hoverVerticalPaddingPx,
  );
  if (
    event.clientX < listRect.left - horizontalInset ||
    event.clientX > listRect.right + horizontalInset ||
    event.clientY < listRect.top - verticalInset ||
    event.clientY > listRect.bottom + verticalInset
  ) {
    return null;
  }

  let nearest: HTMLButtonElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const dot of dots) {
    const distance = getChatProgressDotPointerDistance(dot, event.clientY);
    if (distance < nearestDistance) {
      nearest = dot;
      nearestDistance = distance;
    }
  }

  const currentHoverIndex = getChatProgressHoverIndex(list);
  const currentHoverButton =
    currentHoverIndex === null
      ? null
      : dots.find(
          (dot, fallbackIndex) => parseChatProgressDotIndex(dot, fallbackIndex) === currentHoverIndex,
        ) ?? null;
  if (currentHoverButton && nearest && currentHoverButton !== nearest) {
    const currentDistance = getChatProgressDotPointerDistance(currentHoverButton, event.clientY);
    if (currentDistance <= nearestDistance + CHAT_PROGRESS_POINTER.switchHysteresisPx) {
      return currentHoverButton;
    }
  }

  return nearest;
}

function setChatProgressHoverState(host: Partial<ScrollHost>, hoverIndex: number | null): boolean {
  const list = getChatProgressRailList(host);
  if (!list) {
    return false;
  }
  const currentHoverIndex = getChatProgressHoverIndex(list);
  if (currentHoverIndex === hoverIndex) {
    return false;
  }
  if (hoverIndex === null) {
    delete list.dataset.chatProgressHoverIndex;
  } else {
    list.dataset.chatProgressHoverIndex = String(hoverIndex);
  }
  setChatProgressDotEmphasis(host, host.chatProgressActiveKey);
  return true;
}

function isChatProgressHoverLocked(host: Partial<ScrollHost>): boolean {
  return getChatProgressHoverIndex(getChatProgressRailList(host)) !== null;
}

function setChatProgressDotEmphasis(host: Partial<ScrollHost>, activeKey?: string | null) {
  const list = getChatProgressRailList(host);
  if (!list) {
    return;
  }
  const dots = getChatProgressDots(host);
  if (dots.length === 0) {
    return;
  }

  const resolvedActiveKey = activeKey ?? host.chatProgressActiveKey ?? null;
  const hoverIndex = getChatProgressHoverIndex(list);
  const activeIndex = dots.findIndex((dot) => isChatProgressDotActive(dot, resolvedActiveKey));
  const sourceIndex = hoverIndex ?? activeIndex;
  const mode = hoverIndex === null ? "active" : "hover";

  for (const [fallbackIndex, dot] of dots.entries()) {
    const dotIndex = parseChatProgressDotIndex(dot, fallbackIndex) ?? fallbackIndex;
    const distance =
      sourceIndex >= 0 ? Math.abs(dotIndex - sourceIndex) : CHAT_PROGRESS_EMPHASIS.distance;
    const isHovered = hoverIndex !== null && dotIndex === hoverIndex;
    const emphasis = getChatProgressDotEmphasis(distance, mode);
    const opacity = isHovered ? 1 : emphasis.opacity;

    if (isHovered) {
      dot.dataset.chatProgressHovered = "true";
    } else {
      delete dot.dataset.chatProgressHovered;
    }
    dot.style.setProperty("--chat-progress-scale", emphasis.scale.toFixed(3));
    dot.style.setProperty("--chat-progress-opacity", opacity.toFixed(3));
  }
}

function resolveChatProgressPinnedKey(
  host: Partial<ScrollHost>,
  thread: HTMLElement,
  anchors: HTMLElement[],
): string | null {
  const pinnedKey = host.chatProgressPinnedKey?.trim();
  if (!pinnedKey) {
    return null;
  }

  const pinnedAnchor = anchors.find((anchor) => anchor.dataset.chatProgressAnchor === pinnedKey);
  if (!pinnedAnchor) {
    clearChatProgressPin(host);
    return null;
  }

  if (Date.now() < (host.chatProgressPinnedUntil ?? 0)) {
    return pinnedKey;
  }

  const threadRect = thread.getBoundingClientRect();
  const pinnedRect = pinnedAnchor.getBoundingClientRect();
  const pinnedBandTop = threadRect.top + CHAT_PROGRESS_LAYOUT.scrollOffsetPx;
  const pinnedBandBottom = pinnedBandTop + CHAT_PROGRESS_PIN.topTolerancePx;
  const staysPinned = pinnedRect.top <= pinnedBandBottom && pinnedRect.bottom >= pinnedBandTop;
  if (staysPinned) {
    return pinnedKey;
  }

  clearChatProgressPin(host);
  return null;
}

function syncChatProgressRailList(
  host: Partial<ScrollHost>,
  activeKey: string | null,
  smooth = true,
) {
  const list = getChatProgressRailList(host);
  if (!list) {
    return;
  }
  if (getChatProgressHoverIndex(list) !== null) {
    setChatProgressDotEmphasis(host, activeKey);
    return;
  }
  const dots = getChatProgressDots(host);
  if (dots.length === 0) {
    return;
  }

  const activeDot = activeKey
    ? dots.find((dot) => dot.dataset.chatProgressSelect === activeKey) ?? null
    : dots.find((dot) => dot.classList.contains("is-active")) ?? null;
  if (!activeDot) {
    setChatProgressDotEmphasis(host, activeKey);
    return;
  }

  const listRect = list.getBoundingClientRect();
  const listHeight = list.clientHeight || listRect.height;
  if (!Number.isFinite(listHeight) || listHeight <= 0) {
    setChatProgressDotEmphasis(host, activeKey);
    return;
  }

  const step = estimateChatProgressDotStep(dots);
  const deadzone = Math.max(step * CHAT_PROGRESS_LAYOUT.railDeadzoneSteps, 18);
  const currentScrollTop = list.scrollTop;
  const visibleCenter = currentScrollTop + listHeight / 2;
  const { top, center, height } = getChatProgressDotMetrics(list, activeDot);
  const visibleTop = currentScrollTop;
  const visibleBottom = currentScrollTop + listHeight;
  const activeBottom = top + height;
  let nextScrollTop = currentScrollTop;

  if (activeBottom < visibleTop || top > visibleBottom) {
    nextScrollTop = center - listHeight / 2;
  } else if (center < visibleCenter - deadzone) {
    nextScrollTop = currentScrollTop + (center - (visibleCenter - deadzone));
  } else if (center > visibleCenter + deadzone) {
    nextScrollTop = currentScrollTop + (center - (visibleCenter + deadzone));
  }

  const maxScrollTop = Math.max(0, list.scrollHeight - listHeight);
  nextScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  const smoothEnabled = isSmoothScrollEnabled(smooth);

  if (Math.abs(nextScrollTop - currentScrollTop) > 1) {
    if (typeof list.scrollTo === "function") {
      list.scrollTo({
        top: nextScrollTop,
        behavior: smoothEnabled ? "smooth" : "auto",
      });
    } else {
      list.scrollTop = nextScrollTop;
    }
    if (!smoothEnabled) {
      list.scrollTop = nextScrollTop;
    }
  }

  setChatProgressDotEmphasis(host, activeKey);
}

function ensureChatProgressRailBindings(host: Partial<ScrollHost>) {
  const rail = getChatProgressRail(host);
  if (!rail) {
    return;
  }

  if (rail.dataset.chatProgressBound !== "true") {
    rail.dataset.chatProgressBound = "true";

    const syncPointerHover = (event: Event) => {
      const button = resolveChatProgressPointerButton(host, event);
      if (!(button instanceof HTMLButtonElement)) {
        setChatProgressHoverState(host, null);
        hideChatProgressPreview(host);
        return;
      }
      const dots = getChatProgressDots(host);
      const hoverIndex = parseChatProgressDotIndex(button, dots.indexOf(button));
      setChatProgressHoverState(host, hoverIndex);
      showChatProgressPreview(host, button);
    };

    const showFocusedPreview = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest(CHAT_PROGRESS_SELECTORS.dot);
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      const dots = getChatProgressDots(host);
      const hoverIndex = parseChatProgressDotIndex(button, dots.indexOf(button));
      setChatProgressHoverState(host, hoverIndex);
      showChatProgressPreview(host, button);
    };

    rail.addEventListener("pointerover", syncPointerHover);
    rail.addEventListener("pointermove", syncPointerHover);
    rail.addEventListener("focusin", showFocusedPreview);
    rail.addEventListener("pointerleave", () => {
      setChatProgressHoverState(host, null);
      hideChatProgressPreview(host);
      syncChatProgressRailList(host, host.chatProgressActiveKey);
    });
    rail.addEventListener("focusout", (event) => {
      const relatedTarget = event.relatedTarget;
      if (!(relatedTarget instanceof Node) || !rail.contains(relatedTarget)) {
        setChatProgressHoverState(host, null);
        hideChatProgressPreview(host);
        syncChatProgressRailList(host, host.chatProgressActiveKey);
      }
    });
  }

  const list = getChatProgressRailList(host);
  if (!list || list.dataset.chatProgressScrollBound === "true") {
    return;
  }
  list.dataset.chatProgressScrollBound = "true";
  list.addEventListener(
    "scroll",
    () => {
      setChatProgressHoverState(host, null);
      hideChatProgressPreview(host);
    },
    { passive: true },
  );
}

function syncChatProgressRailPosition(
  host: Partial<ScrollHost>,
  thread: HTMLElement | null,
  anchorCount: number,
) {
  const rail = getChatProgressRail(host);
  if (!rail || !thread) {
    hideChatProgressRail(host);
    return;
  }

  const rect = thread.getBoundingClientRect();
  const isVisible =
    anchorCount > 1 &&
    rect.bottom > CHAT_PROGRESS_LAYOUT.viewportInsetPx &&
    rect.top < window.innerHeight - CHAT_PROGRESS_LAYOUT.viewportInsetPx;

  rail.hidden = !isVisible;
  rail.dataset.visible = isVisible ? "true" : "false";

  if (!isVisible) {
    hideChatProgressPreview(host);
    return;
  }

  const list = getChatProgressRailList(host);
  const dots = getChatProgressDots(host);
  const step = estimateChatProgressDotStep(dots);
  const visibleCount = Math.min(anchorCount, getChatProgressVisibleCount(list));
  const visibleHeight = Math.round(
    Math.min(
      window.innerHeight * CHAT_PROGRESS_LAYOUT.railWindowViewportRatio,
      visibleCount * step + CHAT_PROGRESS_LAYOUT.railWindowPaddingPx,
    ),
  );

  rail.style.top = `${Math.round(window.innerHeight / 2)}px`;
  rail.style.right = `${CHAT_PROGRESS_LAYOUT.fixedRightPx}px`;
  rail.style.removeProperty("max-height");
  rail.style.setProperty("--chat-progress-window-height", `${visibleHeight}px`);
}

function isSmoothScrollEnabled(smooth: boolean): boolean {
  return (
    smooth &&
    (typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

function pickChatScrollTarget(host: ScrollHost): HTMLElement | null {
  const container = queryHost(host, ".chat-thread") as HTMLElement | null;
  if (container) {
    const overflowY = getComputedStyle(container).overflowY;
    const canScroll =
      overflowY === "auto" ||
      overflowY === "scroll" ||
      container.scrollHeight - container.clientHeight > 1;
    if (canScroll) {
      return container;
    }
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
}

function resolveChatProgressPivot(thread: HTMLElement): number {
  const threadRect = thread.getBoundingClientRect();
  const visibleTop = Math.max(threadRect.top, 0);
  const visibleBottom = Math.min(threadRect.bottom, window.innerHeight);
  const visibleHeight = visibleBottom - visibleTop;

  if (!Number.isFinite(visibleHeight) || visibleHeight <= 0) {
    return Math.min(window.innerHeight - 96, Math.max(96, window.innerHeight * 0.5));
  }

  return visibleTop + visibleHeight / 2;
}

export function syncChatProgressActive(
  host: ScrollHost,
  container?: Element | null,
): string | null {
  ensureChatProgressRailBindings(host);

  const thread = resolveChatThread(host, container);
  if (!thread) {
    host.chatProgressActiveKey = null;
    hideChatProgressRail(host);
    return null;
  }

  const anchors = getChatProgressAnchors(thread);
  syncChatProgressRailPosition(host, thread, anchors.length);
  if (anchors.length === 0) {
    host.chatProgressActiveKey = null;
    hideChatProgressRail(host);
    return null;
  }

  if (!isChatProgressHoverLocked(host)) {
    hideChatProgressPreview(host);
  }

  const pinnedKey = resolveChatProgressPinnedKey(host, thread, anchors);
  if (pinnedKey) {
    host.chatProgressActiveKey = pinnedKey;
    syncChatProgressRailList(host, host.chatProgressActiveKey);
    return host.chatProgressActiveKey;
  }

  const pivot = resolveChatProgressPivot(thread);
  let active = anchors[0];

  for (const anchor of anchors) {
    if (anchor.getBoundingClientRect().top <= pivot) {
      active = anchor;
      continue;
    }
    break;
  }

  const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  if (distanceFromBottom <= 4) {
    active = anchors[anchors.length - 1] ?? active;
  }

  host.chatProgressActiveKey = active.dataset.chatProgressAnchor ?? null;
  syncChatProgressRailList(host, host.chatProgressActiveKey);
  return host.chatProgressActiveKey;
}

export function scrollChatProgressAnchor(host: ScrollHost, key: string, smooth = true): boolean {
  const thread = resolveChatThread(host);
  if (!thread) {
    return false;
  }

  const anchor = getChatProgressAnchors(thread).find(
    (item) => item.dataset.chatProgressAnchor === key,
  );
  if (!anchor) {
    return false;
  }

  const threadRect = thread.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const targetTop = Math.max(
    0,
    thread.scrollTop + anchorRect.top - threadRect.top - CHAT_PROGRESS_LAYOUT.scrollOffsetPx,
  );
  const smoothEnabled = isSmoothScrollEnabled(smooth);

  hideChatProgressPreview(host);

  if (typeof thread.scrollTo === "function") {
    thread.scrollTo({
      top: targetTop,
      behavior: smoothEnabled ? "smooth" : "auto",
    });
  } else {
    thread.scrollTop = targetTop;
  }
  if (!smoothEnabled) {
    thread.scrollTop = targetTop;
  }

  const distanceFromBottom = thread.scrollHeight - targetTop - thread.clientHeight;
  host.chatUserNearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
  host.chatProgressPinnedKey = key;
  host.chatProgressPinnedUntil = Date.now() + CHAT_PROGRESS_PIN.durationMs;
  host.chatProgressActiveKey = key;
  syncChatProgressRailList(host, key);
  window.setTimeout(() => {
    syncChatProgressActive(host, thread);
  }, 220);
  return true;
}

export function scheduleChatScroll(host: ScrollHost, force = false, smooth = false) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }

  // Wait for Lit render to complete, then scroll.
  void host.updateComplete.then(() => {
    host.chatScrollFrame = requestAnimationFrame(() => {
      host.chatScrollFrame = null;
      const target = pickChatScrollTarget(host);
      if (!target) {
        host.chatProgressActiveKey = null;
        return;
      }

      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const shouldStick =
        effectiveForce || host.chatUserNearBottom || distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

      if (!shouldStick) {
        // User is scrolled up, flag that new content arrived below.
        host.chatNewMessagesBelow = true;
        syncChatProgressActive(host, target);
        return;
      }

      if (effectiveForce) {
        host.chatHasAutoScrolled = true;
      }

      const scrollTop = target.scrollHeight;
      const smoothEnabled = isSmoothScrollEnabled(smooth);
      if (typeof target.scrollTo === "function") {
        target.scrollTo({
          top: scrollTop,
          behavior: smoothEnabled ? "smooth" : "auto",
        });
      } else {
        target.scrollTop = scrollTop;
      }
      if (!smoothEnabled) {
        target.scrollTop = scrollTop;
      }
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;
      syncChatProgressActive(host, target);

      const retryDelay = effectiveForce ? 150 : 120;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        const latest = pickChatScrollTarget(host);
        if (!latest) {
          host.chatProgressActiveKey = null;
          return;
        }

        const latestDistanceFromBottom =
          latest.scrollHeight - latest.scrollTop - latest.clientHeight;
        const shouldStickRetry =
          effectiveForce ||
          host.chatUserNearBottom ||
          latestDistanceFromBottom < NEAR_BOTTOM_THRESHOLD;
        if (!shouldStickRetry) {
          syncChatProgressActive(host, latest);
          return;
        }

        latest.scrollTop = latest.scrollHeight;
        host.chatUserNearBottom = true;
        syncChatProgressActive(host, latest);
      }, retryDelay);
    });
  });
}

export function scheduleLogsScroll(host: ScrollHost, force = false) {
  if (host.logsScrollFrame) {
    cancelAnimationFrame(host.logsScrollFrame);
  }
  void host.updateComplete.then(() => {
    host.logsScrollFrame = requestAnimationFrame(() => {
      host.logsScrollFrame = null;
      const container = queryHost(host, ".log-stream") as HTMLElement | null;
      if (!container) {
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick = force || distanceFromBottom < 80;
      if (!shouldStick) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
  });
}

export function handleChatScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.chatUserNearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
  syncChatProgressActive(host, container);
}

export function handleLogsScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.logsAtBottom = distanceFromBottom < 80;
}

export function resetChatScroll(host: ScrollHost) {
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatNewMessagesBelow = false;
  host.chatProgressActiveKey = null;
  clearChatProgressPin(host);
}

export function exportLogs(lines: string[], label: string) {
  if (lines.length === 0) {
    return;
  }
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  anchor.href = url;
  anchor.download = `openclaw-logs-${label}-${stamp}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function observeTopbar(host: ScrollHost) {
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const topbar = queryHost(host, ".topbar");
  if (!topbar) {
    return;
  }
  const update = () => {
    const { height } = topbar.getBoundingClientRect();
    host.style.setProperty("--topbar-height", `${height}px`);
  };
  update();
  host.topbarObserver = new ResizeObserver(() => update());
  host.topbarObserver.observe(topbar);
}
