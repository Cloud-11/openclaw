/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleChatScroll,
  resetChatScroll,
  scheduleChatScroll,
  scrollChatProgressAnchor,
  syncChatProgressActive,
} from "./app-scroll.ts";

type AnchorSpec = {
  key: string;
  offset: number;
  height?: number;
};

type ScrollHostOptions = {
  anchors?: AnchorSpec[];
  scrollHeight?: number;
  scrollTop?: number;
  clientHeight?: number;
  overflowY?: string;
  threadTop?: number;
  listTop?: number;
  listHeight?: number;
  dotStep?: number;
  dotHeight?: number;
  initialListScrollTop?: number;
  visibleDotCount?: number;
};

type MutableNumber = {
  get: () => number;
  set: (next: number) => void;
};

function createMutableNumber(initial: number): MutableNumber {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

function createRect(top: number, height: number, width = 320, left = 0): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function bindScrollState(
  element: HTMLElement,
  scrollTopState: MutableNumber,
  scrollHeight: number,
  clientHeight: number,
) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTopState.get(),
    set: (value: number) => scrollTopState.set(Number(value)),
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: vi.fn((arg0?: ScrollToOptions | number, arg1?: number) => {
      const top =
        typeof arg0 === "number" ? arg1 ?? 0 : (arg0?.top ?? scrollTopState.get());
      scrollTopState.set(Number(top));
    }),
  });
}

function createScrollHost(overrides: ScrollHostOptions = {}) {
  const {
    anchors = [],
    scrollHeight = 2_000,
    scrollTop = 1_500,
    clientHeight = 500,
    overflowY = "auto",
    threadTop = 100,
    listTop = 180,
    listHeight = 240,
    dotStep = 24,
    dotHeight = 14,
    initialListScrollTop = 0,
    visibleDotCount = 12,
  } = overrides;

  const root = document.createElement("div");
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  thread.style.overflowY = overflowY;

  const rail = document.createElement("div");
  rail.className = "chat-progress-rail";
  rail.hidden = true;
  rail.dataset.visible = "false";

  const railWindow = document.createElement("div");
  railWindow.className = "chat-progress-rail__window";
  const list = document.createElement("div");
  list.className = "chat-progress-rail__list";
  list.dataset.chatProgressVisibleCount = String(visibleDotCount);

  const preview = document.createElement("div");
  preview.className = "chat-progress-rail__preview";
  preview.hidden = true;
  preview.dataset.visible = "false";
  const previewText = document.createElement("div");
  previewText.className = "chat-progress-rail__preview-text";
  preview.append(previewText);

  railWindow.append(list);
  rail.append(railWindow);
  root.append(thread, rail, preview);
  document.body.append(root);

  const threadScrollTop = createMutableNumber(scrollTop);
  const listScrollTop = createMutableNumber(initialListScrollTop);

  bindScrollState(thread, threadScrollTop, scrollHeight, clientHeight);
  Object.defineProperty(thread, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => createRect(threadTop, clientHeight, 720)),
  });

  const listPadding = 14;
  const listScrollHeight =
    anchors.length === 0
      ? listHeight
      : listPadding * 2 + dotHeight + dotStep * Math.max(0, anchors.length - 1);
  bindScrollState(list, listScrollTop, listScrollHeight, listHeight);
  Object.defineProperty(list, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => createRect(listTop, listHeight, 32)),
  });

  const anchorElements = anchors.map((anchor) => {
    const element = document.createElement("div");
    element.className = "chat-group user";
    element.dataset.chatProgressAnchor = anchor.key;
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() =>
        createRect(
          threadTop + anchor.offset - threadScrollTop.get(),
          anchor.height ?? 32,
          640,
        ),
      ),
    });
    thread.append(element);
    return element;
  });

  const dotElements = anchors.map((anchor, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "chat-progress-rail__dot";
    dot.dataset.chatProgressSelect = anchor.key;
    dot.dataset.chatProgressIndex = String(index);
    list.append(dot);

    const offsetTop = listPadding + index * dotStep;
    Object.defineProperty(dot, "offsetTop", {
      configurable: true,
      get: () => offsetTop,
    });
    Object.defineProperty(dot, "offsetHeight", {
      configurable: true,
      get: () => dotHeight,
    });
    Object.defineProperty(dot, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() =>
        createRect(listTop + offsetTop - listScrollTop.get(), dotHeight, dotHeight, 9),
      ),
    });
    return dot;
  });

  const host = {
    updateComplete: Promise.resolve(),
    querySelector: root.querySelector.bind(root),
    style: root.style,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    chatProgressActiveKey: null as string | null,
    chatProgressPinnedKey: null as string | null,
    chatProgressPinnedUntil: null as number | null,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null as ResizeObserver | null,
  };

  return {
    host,
    thread,
    rail,
    list,
    preview,
    previewText,
    anchorElements,
    dotElements,
    threadScrollTop,
    listScrollTop,
  };
}

function createScrollEvent(container: HTMLElement) {
  return {
    currentTarget: container,
  } as unknown as Event;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function readStyleNumber(element: HTMLElement, propertyName: string): number {
  return Number.parseFloat(element.style.getPropertyValue(propertyName) || "0");
}

describe("app-scroll", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 1_000,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1_600,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("handleChatScroll", () => {
    it("sets chatUserNearBottom=true when within the 450px threshold", () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 1_600,
        clientHeight: 400,
      });

      handleChatScroll(host, createScrollEvent(thread));

      expect(host.chatUserNearBottom).toBe(true);
    });

    it("sets chatUserNearBottom=true when distance is just under threshold", () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 1_151,
        clientHeight: 400,
      });

      handleChatScroll(host, createScrollEvent(thread));

      expect(host.chatUserNearBottom).toBe(true);
    });

    it("sets chatUserNearBottom=false when distance is exactly at threshold", () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 1_150,
        clientHeight: 400,
      });

      handleChatScroll(host, createScrollEvent(thread));

      expect(host.chatUserNearBottom).toBe(false);
    });

    it("updates the active chat progress anchor while scrolling", () => {
      const { host, thread } = createScrollHost({
        anchors: [
          { key: "group:user:msg:0", offset: 720 },
          { key: "group:user:msg:2", offset: 980 },
          { key: "group:user:msg:4", offset: 1_480 },
        ],
        scrollHeight: 2_200,
        scrollTop: 900,
        clientHeight: 400,
      });

      handleChatScroll(host, createScrollEvent(thread));

      expect(host.chatProgressActiveKey).toBe("group:user:msg:2");
    });
  });

  describe("syncChatProgressActive", () => {
    it("selects the first user anchor when the thread starts near the top", () => {
      const { host } = createScrollHost({
        anchors: [
          { key: "group:user:msg:0", offset: 24 },
          { key: "group:user:msg:2", offset: 520 },
        ],
        scrollTop: 0,
        clientHeight: 400,
      });

      syncChatProgressActive(host);

      expect(host.chatProgressActiveKey).toBe("group:user:msg:0");
    });

    it("selects the last fully passed anchor near the viewport pivot", () => {
      const { host } = createScrollHost({
        anchors: [
          { key: "group:user:msg:0", offset: 120 },
          { key: "group:user:msg:2", offset: 460 },
          { key: "group:user:msg:4", offset: 900 },
        ],
        scrollTop: 350,
        clientHeight: 400,
      });

      syncChatProgressActive(host);

      expect(host.chatProgressActiveKey).toBe("group:user:msg:2");
    });

    it("keeps the active anchor inside the visible chat thread when the thread is short", () => {
      const { host } = createScrollHost({
        anchors: [
          { key: "group:user:msg:0", offset: 120 },
          { key: "group:user:msg:2", offset: 320 },
        ],
        scrollTop: 0,
        clientHeight: 240,
      });

      syncChatProgressActive(host);

      expect(host.chatProgressActiveKey).toBe("group:user:msg:0");
    });

    it("limits the rail to the centered 12-dot window and updates dot emphasis", () => {
      const anchors = Array.from({ length: 18 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 100 + index * 220,
      }));
      const { host, rail, list, dotElements } = createScrollHost({
        anchors,
        scrollHeight: 5_000,
        scrollTop: 1_750,
        clientHeight: 500,
        listHeight: 240,
      });

      const activeKey = syncChatProgressActive(host);

      expect(activeKey).toBe("group:user:msg:8");
      expect(rail.hidden).toBe(false);
      expect(rail.dataset.visible).toBe("true");
      expect(rail.style.right).toBe("30px");
      expect(rail.style.getPropertyValue("--chat-progress-window-height")).toBe("316px");
      expect(list.scrollTop).toBeGreaterThan(50);
      expect(list.scrollTop).toBeLessThan(60);

      const activeScale = Number.parseFloat(
        dotElements[8]?.style.getPropertyValue("--chat-progress-scale") ?? "0",
      );
      const nearbyScale = Number.parseFloat(
        dotElements[9]?.style.getPropertyValue("--chat-progress-scale") ?? "0",
      );
      const distantScale = Number.parseFloat(
        dotElements[0]?.style.getPropertyValue("--chat-progress-scale") ?? "0",
      );
      const activeOpacity = Number.parseFloat(
        dotElements[8]?.style.getPropertyValue("--chat-progress-opacity") ?? "0",
      );
      const distantOpacity = Number.parseFloat(
        dotElements[0]?.style.getPropertyValue("--chat-progress-opacity") ?? "0",
      );

      expect(activeScale).toBeGreaterThan(nearbyScale);
      expect(nearbyScale).toBeGreaterThan(distantScale);
      expect(activeOpacity).toBeGreaterThan(distantOpacity);
    });

    it("uses the hovered dot as the temporary emphasis source and restores active emphasis after leave", () => {
      const anchors = Array.from({ length: 15 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 100 + index * 220,
      }));
      const { host, rail, dotElements } = createScrollHost({
        anchors,
        scrollHeight: 4_200,
        scrollTop: 1_500,
        clientHeight: 500,
        listHeight: 240,
      });

      const activeKey = syncChatProgressActive(host);
      expect(activeKey).toBe("group:user:msg:7");

      const activeScaleBeforeHover = readStyleNumber(
        dotElements[8] as HTMLElement,
        "--chat-progress-scale",
      );

      dotElements[12]?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

      const hoveredScale = readStyleNumber(
        dotElements[12] as HTMLElement,
        "--chat-progress-scale",
      );
      const hoveredNeighborScale = readStyleNumber(
        dotElements[11] as HTMLElement,
        "--chat-progress-scale",
      );
      const hoveredSecondNeighborScale = readStyleNumber(
        dotElements[10] as HTMLElement,
        "--chat-progress-scale",
      );
      const hoveredFarScale = readStyleNumber(
        dotElements[8] as HTMLElement,
        "--chat-progress-scale",
      );

      expect(dotElements[12]?.dataset.chatProgressHovered).toBe("true");
      expect(hoveredScale).toBeGreaterThan(activeScaleBeforeHover);
      expect(hoveredScale).toBeGreaterThan(hoveredNeighborScale);
      expect(hoveredNeighborScale).toBeGreaterThan(hoveredSecondNeighborScale);
      expect(hoveredSecondNeighborScale).toBeGreaterThan(hoveredFarScale);

      rail.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));

      const restoredActiveScale = readStyleNumber(
        dotElements[8] as HTMLElement,
        "--chat-progress-scale",
      );
      const restoredHoveredScale = readStyleNumber(
        dotElements[12] as HTMLElement,
        "--chat-progress-scale",
      );

      expect(dotElements[12]?.dataset.chatProgressHovered).toBeUndefined();
      expect(restoredActiveScale).toBeGreaterThan(restoredHoveredScale);
      expect(restoredActiveScale).toBeCloseTo(activeScaleBeforeHover, 3);
    });

    it("does not auto-scroll the rail list back to the active dot while a hover dot is locked", () => {
      const anchors = Array.from({ length: 15 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 100 + index * 220,
      }));
      const { host, rail, list, dotElements, listScrollTop } = createScrollHost({
        anchors,
        scrollHeight: 4_200,
        scrollTop: 1_500,
        clientHeight: 500,
        listHeight: 240,
      });

      const activeKey = syncChatProgressActive(host);
      expect(activeKey).toBe("group:user:msg:7");

      dotElements[12]?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      listScrollTop.set(220);

      syncChatProgressActive(host);

      expect(list.scrollTop).toBe(220);
      expect(dotElements[12]?.dataset.chatProgressHovered).toBe("true");

      rail.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));

      expect(list.scrollTop).toBeLessThan(220);
      expect(dotElements[12]?.dataset.chatProgressHovered).toBeUndefined();
    });

    it("snaps hover to the nearest dot even when the pointer is near the dot edge", () => {
      const anchors = Array.from({ length: 15 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 100 + index * 220,
      }));
      const { host, list, dotElements } = createScrollHost({
        anchors,
        scrollHeight: 4_200,
        scrollTop: 1_500,
        clientHeight: 500,
        listHeight: 240,
      });

      syncChatProgressActive(host);

      const activeIndex = dotElements.findIndex(
        (dot) => dot.dataset.chatProgressSelect === host.chatProgressActiveKey,
      );
      const hoverIndex = Math.min(dotElements.length - 1, Math.max(0, activeIndex + 1));
      const dotRect = dotElements[hoverIndex]?.getBoundingClientRect();
      expect(dotRect).toBeDefined();
      list.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: (dotRect?.left ?? 0) - 6,
          clientY: (dotRect?.top ?? 0) + (dotRect?.height ?? 0) / 2,
        }),
      );

      expect(dotElements[hoverIndex]?.dataset.chatProgressHovered).toBe("true");
    });

    it("keeps hover continuity while moving between adjacent dots", () => {
      const anchors = Array.from({ length: 15 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 100 + index * 220,
      }));
      const { host, list, dotElements } = createScrollHost({
        anchors,
        scrollHeight: 4_200,
        scrollTop: 1_500,
        clientHeight: 500,
        listHeight: 240,
      });

      syncChatProgressActive(host);
      const activeIndex = dotElements.findIndex(
        (dot) => dot.dataset.chatProgressSelect === host.chatProgressActiveKey,
      );
      const hoverIndex = Math.min(dotElements.length - 2, Math.max(0, activeIndex + 1));
      const nextIndex = hoverIndex + 1;

      dotElements[hoverIndex]?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      expect(dotElements[hoverIndex]?.dataset.chatProgressHovered).toBe("true");

      const currentRect = dotElements[hoverIndex]?.getBoundingClientRect();
      const nextRect = dotElements[nextIndex]?.getBoundingClientRect();
      expect(currentRect).toBeDefined();
      expect(nextRect).toBeDefined();

      list.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: ((currentRect?.left ?? 0) + 1),
          clientY: (((currentRect?.top ?? 0) + (currentRect?.height ?? 0) / 2) +
            ((nextRect?.top ?? 0) + (nextRect?.height ?? 0) / 2)) / 2,
        }),
      );

      expect(dotElements[hoverIndex]?.dataset.chatProgressHovered).toBe("true");
      expect(dotElements[nextIndex]?.dataset.chatProgressHovered).toBeUndefined();

      list.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: ((nextRect?.left ?? 0) + 1),
          clientY: (nextRect?.top ?? 0) + (nextRect?.height ?? 0) / 2,
        }),
      );

      expect(dotElements[hoverIndex]?.dataset.chatProgressHovered).toBeUndefined();
      expect(dotElements[nextIndex]?.dataset.chatProgressHovered).toBe("true");
    });
  });

  describe("scheduleChatScroll", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb(0);
        return 1;
      });
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("scrolls to bottom when user is near bottom", async () => {
      const { host, thread } = createScrollHost({
        anchors: [
          { key: "group:user:msg:0", offset: 120 },
          { key: "group:user:msg:2", offset: 1_820 },
        ],
        scrollHeight: 2_000,
        scrollTop: 1_600,
        clientHeight: 400,
      });
      host.chatUserNearBottom = true;

      scheduleChatScroll(host);
      await flushMicrotasks();

      expect(thread.scrollTop).toBe(thread.scrollHeight);
      expect(host.chatProgressActiveKey).toBe("group:user:msg:2");
    });

    it("does not scroll when user is scrolled up and no force is requested", async () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 500,
        clientHeight: 400,
      });
      host.chatUserNearBottom = false;
      const originalScrollTop = thread.scrollTop;

      scheduleChatScroll(host);
      await flushMicrotasks();

      expect(thread.scrollTop).toBe(originalScrollTop);
    });

    it("does not force-scroll after the user has already taken control", async () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 500,
        clientHeight: 400,
      });
      host.chatUserNearBottom = false;
      host.chatHasAutoScrolled = true;

      scheduleChatScroll(host, true);
      await flushMicrotasks();

      expect(thread.scrollTop).toBe(500);
    });

    it("force-scrolls on initial load before auto-follow is established", async () => {
      const { host, thread } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 500,
        clientHeight: 400,
      });
      host.chatUserNearBottom = false;
      host.chatHasAutoScrolled = false;

      scheduleChatScroll(host, true);
      await flushMicrotasks();

      expect(thread.scrollTop).toBe(thread.scrollHeight);
    });

    it("marks that newer messages are below when auto-follow is paused", async () => {
      const { host } = createScrollHost({
        scrollHeight: 2_000,
        scrollTop: 500,
        clientHeight: 400,
      });
      host.chatUserNearBottom = false;
      host.chatHasAutoScrolled = true;

      scheduleChatScroll(host);
      await flushMicrotasks();

      expect(host.chatNewMessagesBelow).toBe(true);
    });
  });

  describe("scrollChatProgressAnchor", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("scrolls to the matching anchor and keeps the rail list aligned", () => {
      const anchors = Array.from({ length: 14 }, (_, index) => ({
        key: `group:user:msg:${index}`,
        offset: 240 + index * 240,
      }));
      const { host, thread, list } = createScrollHost({
        anchors,
        scrollHeight: 3_500,
        scrollTop: 100,
        clientHeight: 500,
        listHeight: 240,
      });

      const didScroll = scrollChatProgressAnchor(host, "group:user:msg:10", false);

      expect(didScroll).toBe(true);
      expect(thread.scrollTop).toBe(2_622);
      expect(host.chatProgressActiveKey).toBe("group:user:msg:10");
      expect(host.chatUserNearBottom).toBe(true);
      expect(host.chatNewMessagesBelow).toBe(false);
      expect(list.scrollTop).toBeGreaterThan(95);
      expect(list.scrollTop).toBeLessThan(120);

      vi.advanceTimersByTime(220);
      expect(host.chatProgressActiveKey).toBe("group:user:msg:10");

      vi.advanceTimersByTime(250);
      thread.scrollTop = 2_682;
      syncChatProgressActive(host, thread);
      expect(host.chatProgressActiveKey).toBe("group:user:msg:11");
    });
  });

  describe("resetChatScroll", () => {
    it("resets state for a new chat session", () => {
      const { host } = createScrollHost();
      host.chatHasAutoScrolled = true;
      host.chatUserNearBottom = false;
      host.chatProgressActiveKey = "group:user:msg:2";
      host.chatProgressPinnedKey = "group:user:msg:2";
      host.chatProgressPinnedUntil = Date.now() + 400;

      resetChatScroll(host);

      expect(host.chatHasAutoScrolled).toBe(false);
      expect(host.chatUserNearBottom).toBe(true);
      expect(host.chatProgressActiveKey).toBeNull();
      expect(host.chatProgressPinnedKey).toBeNull();
      expect(host.chatProgressPinnedUntil).toBeNull();
    });
  });
});
