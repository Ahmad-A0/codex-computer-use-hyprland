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

export function bind_linux_app(computer, bound) {
  // Every observation refreshes the bound window (title, geometry, ...).
  async function observe(include_screenshot) {
    const state = await computer.get_window_state({ window: bound, include_screenshot });
    bound = state.window;
    return state;
  }
  function screenshotOf(state) {
    return one_screenshot(state.screenshots, bound.id);
  }
  return {
    async getAXState(options) {
      const state = await observe(false);
      const value = axState(state, options);
      await text(value, options);
      return value;
    },
    async getScreenshot(options) {
      const state = await observe(true);
      const screenshot = screenshotOf(state);
      if (screenshot === undefined) throw new Error(`Screenshot unavailable for window ${bound.id}.`);
      const bytes = screenshot.bytes;
      await image({ bytes, mime_type: "image/jpeg", options });
      return bytes;
    },
    async getAXStateAndScreenshot(options) {
      const state = await observe(true);
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
      return computer.click(input);
    },
    drag: (from, to) => computer.drag({ window: bound, path: [{ x: from[0], y: from[1] }, { x: to[0], y: to[1] }] }),
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
      return computer.scroll(input);
    },
    selectText: (elementIndex, value, options) => computer.select_text({
      window: bound,
      element_id: String(elementIndex),
      text: value,
      prefix: options?.prefix,
      suffix: options?.suffix,
      selection_type: options?.selectionType ?? "text",
    }),
    setValue: (elementIndex, value) => computer.set_value({ window: bound, element_id: String(elementIndex), value }),
    paste: (value, options) => computer.paste({ window: bound, text: value, format: options?.format ?? "text" }),
    pressKey: (key) => computer.press_key({ window: bound, key }),
    // As upstream: an element index focuses that field first.
    typeText: (value, elementIndex) => computer.type_text(elementIndex === undefined
      ? { window: bound, text: value }
      : { window: bound, text: value, element_id: String(elementIndex) }),
    async typeCharacters(value) {
      return { charactersSent: await computer.type_characters({ window: bound, text: value }) };
    },
    performSecondaryAction(elementIndex, action) {
      const element_id = String(elementIndex);
      return computer.perform_secondary_action({ window: bound, element_id, action });
    },
  };
}
