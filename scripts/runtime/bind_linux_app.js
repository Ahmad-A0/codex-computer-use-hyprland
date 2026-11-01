// Replaces @oai/cua's tinysky_alt/bind_linux_app.js in the private runtime copy.
// Same export and signature as upstream (see bind_linux_app.d.ts):
//   bind_linux_app(computer: LinuxComputer, window: WindowInfo): App
// Upstream's Linux binding rejects page scrolling, selectText, setValue and rich
// paste, and returns full accessibility trees. This binding gives the macOS
// behaviour of the same public methods: macOS-format accessibility diffs, page
// or pixel scrolling, and selectText/setValue/paste through the Hyprland Sky
// backend. Helpers are imported from upstream by module path and export name;
// scripts/prepare-runtime.mjs verifies those exports before copying this file.
import { image, text } from "../core/display.js";
import { positive_pixels } from "../core/positive_pixels.js";
import { one_screenshot } from "./one_screenshot.js";
import { axState } from "./hyprland_ax_diff.js";

// Errors meaning the bound window itself is gone (closed, or its ID reused).
const GONE = /Window \d+ is unavailable|Window ID was reused|Target is not mapped/;

export function bind_linux_app(computer, bound) {
  // macOS binds the whole app: when a dialog it was driving closes, the next
  // call sees the app's remaining window. Here a binding starts on one window,
  // so when that window is gone it follows its app: an open modal dialog
  // first (the window macOS would report as key), then the focused window,
  // then any other window of the same process.
  async function follow(error) {
    if (!GONE.test(String(error?.message ?? error))) return null;
    const windows = await computer.list_windows();
    if (windows.some((w) => w.id === bound.id && w.pid === bound.pid
      && (bound.stable_id === undefined || w.stable_id === bound.stable_id))) return null;
    const own = windows.filter((w) => w.pid === bound.pid);
    const next = own.find((w) => w.modal) ?? own.find((w) => w.focused) ?? own[0];
    if (next === undefined) return null;
    const closed = bound.title;
    bound = next;
    return `Window "${closed}" closed; this app binding now follows its window "${next.title}" (windowId ${next.id}).`;
  }
  // Every observation refreshes the bound window (title, geometry, ...).
  async function observe(include_screenshot, options) {
    let state;
    try {
      state = await computer.get_window_state({ window: bound, include_screenshot });
    } catch (error) {
      const notice = await follow(error);
      if (notice === null) throw error;
      await text(notice, options);
      state = await computer.get_window_state({ window: bound, include_screenshot });
    }
    bound = state.window;
    // macOS shows an app's open dialog to its binding; name the app's modal
    // windows here so the agent can bind the one waiting for it.
    const dialogs = (await computer.list_windows()).filter((w) => w.pid === bound.pid && w.id !== bound.id && w.modal);
    if (dialogs.length) {
      await text(`This app also has a dialog open: ${dialogs.map((w) => `"${w.title}" (windowId ${w.id})`).join(", ")}.`
        + " Bind it with cua.getApp({ windowId }) to use it.", options);
    }
    return state;
  }
  // An action whose window closed as it took effect (Return or a click on a
  // dialog's button) succeeded, as on macOS. An action on a window that had
  // already gone sends nothing: its element indices and coordinates belonged
  // to that window. Either way the binding moves to the app's remaining window.
  async function act(run) {
    try {
      return await run();
    } catch (error) {
      const notice = await follow(error);
      if (notice === null) throw error;
      if (/Target is not mapped/.test(String(error?.message ?? error))) {
        await text(notice);
        return undefined;
      }
      throw new Error(`${notice} Nothing was sent; observe it before acting.`);
    }
  }
  function screenshotOf(state) {
    return one_screenshot(state.screenshots, bound.id);
  }
  return {
    async getAXState(options) {
      const state = await observe(false, options);
      const value = axState(state, options);
      await text(value, options);
      return value;
    },
    async getScreenshot(options) {
      const state = await observe(true, options);
      const screenshot = screenshotOf(state);
      if (screenshot === undefined) throw new Error(`Screenshot unavailable for window ${bound.id}.`);
      const bytes = screenshot.bytes;
      await image({ bytes, mime_type: "image/jpeg", options });
      return bytes;
    },
    async getAXStateAndScreenshot(options) {
      const state = await observe(true, options);
      const value = axState(state, options);
      await text(value, options);
      const screenshot = screenshotOf(state);
      if (screenshot === undefined) return { state: value };
      const bytes = screenshot.bytes;
      await image({ bytes, mime_type: "image/jpeg", options });
      return { state: value, screenshot: bytes };
    },
    click(target, options) {
      const input = { window: bound };
      if (Array.isArray(target)) {
        input.x = target[0];
        input.y = target[1];
      } else {
        input.element_id = String(target);
      }
      if (options?.mouseButton !== undefined) input.mouse_button = options.mouseButton;
      if (options?.clickCount !== undefined) input.click_count = options.clickCount;
      return act(() => computer.click(input));
    },
    drag: (from, to) => act(() => computer.drag({ window: bound, path: [{ x: from[0], y: from[1] }, { x: to[0], y: to[1] }] })),
    // As on macOS, distance is a page count (default one page); { pixels } is
    // also accepted.
    scroll(target, direction, distance) {
      const input = { window: bound, direction };
      if (Array.isArray(target)) {
        input.x = target[0];
        input.y = target[1];
      } else {
        input.element_id = String(target);
      }
      if (typeof distance === "number") input.pages = positive_pixels(distance);
      else if (distance !== undefined) input.pixels = positive_pixels(distance.pixels);
      else input.pages = 1;
      return act(() => computer.scroll(input));
    },
    selectText: (elementIndex, value, options) => act(() => computer.select_text({
      window: bound,
      element_id: String(elementIndex),
      text: value,
      prefix: options?.prefix,
      suffix: options?.suffix,
      selection_type: options?.selectionType ?? "text",
    })),
    setValue: (elementIndex, value) => act(() => computer.set_value({ window: bound, element_id: String(elementIndex), value })),
    paste: (value, options) => act(() => computer.paste({ window: bound, text: value, format: options?.format ?? "text" })),
    pressKey: (key) => act(() => computer.press_key({ window: bound, key })),
    // As upstream: an element index focuses that field first.
    typeText: (value, elementIndex) => act(() => computer.type_text(elementIndex === undefined
      ? { window: bound, text: value }
      : { window: bound, text: value, element_id: String(elementIndex) })),
    async typeCharacters(value) {
      return { charactersSent: await act(() => computer.type_characters({ window: bound, text: value })) };
    },
    performSecondaryAction(elementIndex, action) {
      const element_id = String(elementIndex);
      return act(() => computer.perform_secondary_action({ window: bound, element_id, action }));
    },
  };
}
