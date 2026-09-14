export type VirtualScreenReaderCommand =
  | "start"
  | "next-item"
  | "previous-item"
  | "next-heading"
  | "previous-heading"
  | "next-landmark"
  | "next-control"
  | "read-current";

export interface VirtualScreenReaderItem {
  key: string;
  nodePath: string;
  tagName: string;
  role: string;
  name?: string;
  level?: number;
  states: string[];
}

export interface VirtualScreenReaderEntry {
  sequence: number;
  timestamp: string;
  command: VirtualScreenReaderCommand;
  announcement: string;
  item?: VirtualScreenReaderItem;
  domFocusBefore?: string;
  domFocusAfter?: string;
  focusMoved: boolean;
}

export interface VirtualScreenReaderTranscript {
  schemaVersion: "0.1.0";
  engine: "aee-portable-virtual-screen-reader";
  engineVersion: "0.1.0";
  mode: "guide";
  fidelity: "semantic-simulation";
  physicalAssistiveTechnology: false;
  pageUrl: string;
  generatedAt: string;
  currentItem?: VirtualScreenReaderItem;
  entries: VirtualScreenReaderEntry[];
}

export function renderPortableVirtualScreenReaderTranscript(
  transcript: VirtualScreenReaderTranscript
): string {
  const lines = [
    "AEE portable virtual screen-reader transcript",
    "Fidelity: semantic simulation; not VoiceOver, NVDA, or another physical assistive technology.",
    `Page: ${transcript.pageUrl}`,
    `Mode: ${transcript.mode}`,
    ""
  ];

  if (transcript.entries.length === 0) {
    lines.push("No commands recorded.");
  } else {
    for (const entry of transcript.entries) {
      lines.push(`${entry.sequence}. ${entry.command}: ${entry.announcement}`);
      lines.push(
        `   DOM focus: ${entry.domFocusBefore ?? "none"} -> ${entry.domFocusAfter ?? "none"}; moved: ${entry.focusMoved ? "yes" : "no"}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface PortableVirtualScreenReader {
  command(command: VirtualScreenReaderCommand): Promise<VirtualScreenReaderEntry>;
  snapshot(): Promise<VirtualScreenReaderTranscript>;
}

export interface VirtualScreenReaderPage {
  url(): string;
  evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
}

interface PageSemanticState {
  items: VirtualScreenReaderItem[];
  focusKey?: string;
}

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search"
]);

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);

/**
 * Creates a deterministic semantic navigator. It reads the page but never focuses, clicks, types,
 * or dispatches events. It is useful portable evidence, not a substitute for VoiceOver or NVDA.
 */
export function createPortableVirtualScreenReader(
  page: VirtualScreenReaderPage
): PortableVirtualScreenReader {
  const entries: VirtualScreenReaderEntry[] = [];
  let currentKey: string | undefined;
  let currentItem: VirtualScreenReaderItem | undefined;

  return {
    async command(command) {
      const before = await captureSemanticState(page);
      const item = selectItem(command, before.items, currentKey);
      const announcement = item
        ? describeItem(item)
        : describeBoundary(command, currentKey === undefined);

      if (item) {
        currentKey = item.key;
        currentItem = item;
      }

      const after = await captureSemanticState(page);
      const entry: VirtualScreenReaderEntry = {
        sequence: entries.length + 1,
        timestamp: new Date().toISOString(),
        command,
        announcement,
        ...(item ? { item } : {}),
        ...(before.focusKey ? { domFocusBefore: before.focusKey } : {}),
        ...(after.focusKey ? { domFocusAfter: after.focusKey } : {}),
        focusMoved: before.focusKey !== after.focusKey
      };

      entries.push(entry);
      return cloneEntry(entry);
    },
    async snapshot() {
      return {
        schemaVersion: "0.1.0",
        engine: "aee-portable-virtual-screen-reader",
        engineVersion: "0.1.0",
        mode: "guide",
        fidelity: "semantic-simulation",
        physicalAssistiveTechnology: false,
        pageUrl: page.url(),
        generatedAt: new Date().toISOString(),
        ...(currentItem ? { currentItem: cloneItem(currentItem) } : {}),
        entries: entries.map(cloneEntry)
      };
    }
  };
}

function selectItem(
  command: VirtualScreenReaderCommand,
  items: VirtualScreenReaderItem[],
  currentKey: string | undefined
): VirtualScreenReaderItem | undefined {
  const currentIndex = currentKey ? items.findIndex(({ key }) => key === currentKey) : -1;

  if (command === "read-current") {
    return currentIndex >= 0 ? items[currentIndex] : items[0];
  }

  if (command === "start") {
    return items[0];
  }

  const backwards = command === "previous-item" || command === "previous-heading";
  const predicate = getCommandPredicate(command);

  if (backwards) {
    for (let index = currentIndex < 0 ? items.length - 1 : currentIndex - 1; index >= 0; index--) {
      if (predicate(items[index]!)) {
        return items[index];
      }
    }

    return undefined;
  }

  for (let index = currentIndex + 1; index < items.length; index++) {
    if (predicate(items[index]!)) {
      return items[index];
    }
  }

  return undefined;
}

function getCommandPredicate(
  command: VirtualScreenReaderCommand
): (item: VirtualScreenReaderItem) => boolean {
  if (command === "next-heading" || command === "previous-heading") {
    return ({ role }) => role === "heading";
  }

  if (command === "next-landmark") {
    return ({ role }) => LANDMARK_ROLES.has(role);
  }

  if (command === "next-control") {
    return ({ role }) => CONTROL_ROLES.has(role);
  }

  return () => true;
}

function describeBoundary(command: VirtualScreenReaderCommand, hasNoCursor: boolean): string {
  if (hasNoCursor) {
    return "No readable item.";
  }

  return command.startsWith("previous") ? "Start of document." : "End of document.";
}

function describeItem(item: VirtualScreenReaderItem): string {
  const name = item.name?.trim();
  const parts = [name, item.role];

  if (item.role === "heading" && item.level) {
    parts.push(`level ${item.level}`);
  }

  parts.push(...item.states);
  return parts.filter((part): part is string => Boolean(part)).join(", ");
}

function cloneItem(item: VirtualScreenReaderItem): VirtualScreenReaderItem {
  return { ...item, states: [...item.states] };
}

function cloneEntry(entry: VirtualScreenReaderEntry): VirtualScreenReaderEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    command: entry.command,
    announcement: entry.announcement,
    ...(entry.item ? { item: cloneItem(entry.item) } : {}),
    ...(entry.domFocusBefore ? { domFocusBefore: entry.domFocusBefore } : {}),
    ...(entry.domFocusAfter ? { domFocusAfter: entry.domFocusAfter } : {}),
    focusMoved: entry.focusMoved
  };
}

async function captureSemanticState(page: VirtualScreenReaderPage): Promise<PageSemanticState> {
  return page.evaluate(() => {
    type ElementLike = {
      tagName?: unknown;
      id?: unknown;
      textContent?: unknown;
      parentElement?: ElementLike | null;
      children?: Iterable<unknown>;
      labels?: Iterable<unknown>;
      getAttribute?: (name: string) => string | null;
      getClientRects?: () => { length?: number };
    };
    type DocumentLike = {
      title?: unknown;
      body?: ElementLike;
      activeElement?: unknown;
      getElementById?: (id: string) => unknown;
      querySelectorAll?: (selector: string) => Iterable<unknown>;
    };
    const globalRef = globalThis as unknown as {
      document?: DocumentLike;
      getComputedStyle?: (element: ElementLike) => {
        display?: string;
        visibility?: string;
      };
    };
    const documentRef = globalRef.document;
    const isElement = (value: unknown): value is ElementLike =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as ElementLike).tagName === "string";
    const getAttribute = (element: ElementLike, name: string) =>
      element.getAttribute?.(name) ?? undefined;
    const getTagName = (element: ElementLike) =>
      typeof element.tagName === "string" ? element.tagName.toLowerCase() : "unknown";
    const getNodePath = (element: ElementLike) => {
      if (typeof element.id === "string" && element.id.length > 0) {
        return `#${element.id}`;
      }

      const segments: string[] = [];
      let current: ElementLike | null | undefined = element;

      while (current && segments.length < 8) {
        const tagName = getTagName(current);
        const parent: ElementLike | null | undefined = current.parentElement;
        const siblings = parent
          ? Array.from(parent.children ?? []).filter(
              (candidate): candidate is ElementLike =>
                isElement(candidate) && getTagName(candidate) === tagName
            )
          : [];
        const index = siblings.indexOf(current);
        segments.unshift(`${tagName}${siblings.length > 1 ? `:nth-of-type(${index + 1})` : ""}`);
        current = parent;
      }

      return segments.join(" > ");
    };
    const isVisible = (element: ElementLike) => {
      let current: ElementLike | null | undefined = element;

      while (current) {
        if (
          getAttribute(current, "aria-hidden") === "true" ||
          getAttribute(current, "hidden") !== undefined
        ) {
          return false;
        }

        current = current.parentElement;
      }

      const style = globalRef.getComputedStyle?.(element);
      if (style?.display === "none" || style?.visibility === "hidden") {
        return false;
      }

      const rects = element.getClientRects?.();
      return typeof rects?.length === "number" ? rects.length > 0 : true;
    };
    const inferRole = (element: ElementLike) => {
      const explicitRole = getAttribute(element, "role")?.split(/\s+/)[0];
      if (explicitRole) {
        return explicitRole;
      }

      const tagName = getTagName(element);
      const inputType = getAttribute(element, "type")?.toLowerCase() ?? "text";
      const roles: Record<string, string> = {
        a: "link",
        button: "button",
        nav: "navigation",
        main: "main",
        header: "banner",
        footer: "contentinfo",
        aside: "complementary",
        form: "form",
        img: "img",
        p: "paragraph",
        ul: "list",
        ol: "list",
        li: "listitem",
        table: "table",
        summary: "button",
        select: "combobox",
        textarea: "textbox"
      };

      if (/^h[1-6]$/.test(tagName)) {
        return "heading";
      }

      if (tagName === "input") {
        if (["button", "submit", "reset"].includes(inputType)) return "button";
        if (inputType === "checkbox") return "checkbox";
        if (inputType === "radio") return "radio";
        if (inputType === "range") return "slider";
        if (inputType === "number") return "spinbutton";
        if (inputType === "search") return "searchbox";
        return "textbox";
      }

      return roles[tagName] ?? "group";
    };
    const getName = (element: ElementLike, role: string) => {
      const labelledBy = getAttribute(element, "aria-labelledby");
      const labelledByText = labelledBy
        ?.split(/\s+/)
        .flatMap((id) => {
          const candidate = documentRef?.getElementById?.(id);
          return isElement(candidate) && typeof candidate.textContent === "string"
            ? [candidate.textContent.trim()]
            : [];
        })
        .filter(Boolean)
        .join(" ");
      const text = typeof element.textContent === "string" ? element.textContent.trim() : "";
      const nativeLabelText = Array.from(element.labels ?? [])
        .filter(isElement)
        .flatMap((label) =>
          typeof label.textContent === "string" ? [label.textContent.trim()] : []
        )
        .filter(Boolean)
        .join(" ");
      const permitsNameFromContent = new Set([
        "button",
        "heading",
        "link",
        "listitem",
        "menuitem",
        "option",
        "paragraph",
        "tab"
      ]).has(role);
      const tagName = getTagName(element);
      const inputType = getAttribute(element, "type")?.toLowerCase();
      const valueNamesInput =
        tagName === "input" && ["button", "submit", "reset"].includes(inputType ?? "");
      const candidates = [
        labelledByText,
        getAttribute(element, "aria-label"),
        nativeLabelText,
        getAttribute(element, "alt"),
        valueNamesInput ? getAttribute(element, "value") : undefined,
        permitsNameFromContent ? text.slice(0, 240) : undefined,
        getAttribute(element, "title"),
        getAttribute(element, "placeholder")
      ];

      return candidates.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0
      );
    };
    const getStates = (element: ElementLike) => {
      const states: string[] = [];
      const addBooleanState = (attribute: string, label: string) => {
        const value = getAttribute(element, attribute);
        if (value === "true") states.push(label);
        if (value === "false" && attribute === "aria-expanded") states.push("collapsed");
      };
      addBooleanState("aria-expanded", "expanded");
      addBooleanState("aria-checked", "checked");
      addBooleanState("aria-selected", "selected");
      addBooleanState("aria-pressed", "pressed");
      addBooleanState("aria-disabled", "disabled");
      if (getAttribute(element, "disabled") !== undefined) states.push("disabled");
      if (
        getAttribute(element, "required") !== undefined ||
        getAttribute(element, "aria-required") === "true"
      ) {
        states.push("required");
      }
      const current = getAttribute(element, "aria-current");
      if (current && current !== "false")
        states.push(current === "true" ? "current" : `current ${current}`);
      return states;
    };
    const selector = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "nav",
      "main",
      "aside",
      "footer",
      "form",
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "summary",
      "p",
      "ul",
      "ol",
      "li",
      "img",
      "table",
      "[role]"
    ].join(",");
    const candidates = Array.from(documentRef?.querySelectorAll?.(selector) ?? []).filter(
      isElement
    );
    const items = candidates.filter(isVisible).map((element) => {
      const tagName = getTagName(element);
      let role = inferRole(element);
      const explicitLevel = Number(getAttribute(element, "aria-level"));
      const nativeLevel = /^h[1-6]$/.test(tagName) ? Number(tagName.slice(1)) : undefined;
      const level =
        role === "heading"
          ? Number.isFinite(explicitLevel) && explicitLevel > 0
            ? explicitLevel
            : nativeLevel
          : undefined;
      const nodePath = getNodePath(element);
      const name = getName(element, role);

      if (tagName === "form" && role === "form" && !name) {
        role = "group";
      }

      return {
        key: nodePath,
        nodePath,
        tagName,
        role,
        name,
        level,
        states: getStates(element)
      };
    });
    const activeElement = isElement(documentRef?.activeElement)
      ? documentRef?.activeElement
      : undefined;

    return {
      items,
      focusKey: activeElement ? getNodePath(activeElement) : undefined
    };
  });
}
