// Copied next to the generated create_client.js in the private copies of Sky's
// Linux target. Mirrors @oai/sky's macOS computer-use-policy.js: each app
// action asks "Allow Computer Use to use X?" through nodeRepl.createElicitation,
// and node_repl's computer-use interceptor auto-answers session/always grants.
// Usage telemetry from the macOS module is deliberately not reproduced.
const approvalGated = ["get_window_state", "get_screenshot", "click", "drag", "drag_handle", "move",
  "move_relative", "scroll", "press_key", "key_down", "key_up", "type_text", "type_characters", "perform_secondary_action",
  "activate_window", "select_text", "set_value", "paste", "resolve_app", "launch_app",
  "clipboard_read", "clipboard_write"];
// Approval prompts use the macOS tool name where Linux names differ.
const approvalToolNames = { get_window_state: "get_app_state" };

function approvalGlobal(name) {
  const value = globalThis.nodeRepl?.[name];
  if (typeof value !== "function") throw new Error(`Computer Use requires nodeRepl.${name}`);
  return value;
}

function approvalResponseMeta(appId) {
  globalThis.nodeRepl?.setResponseMeta?.({
    "codex/toolSurface": { app: appId == null ? null : { appId, kind: "appId" }, kind: "computerUse" },
  });
}

function approvalCallId() {
  let meta = globalThis.nodeRepl?.requestMeta?.["x-codex-turn-metadata"];
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { return undefined; }
  }
  if (meta == null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  for (const key of ["call_id", "item_id"]) {
    if (typeof meta[key] === "string" && meta[key].trim() !== "") return meta[key].trim();
  }
  return undefined;
}

async function approveApp(transport, options, tool, input) {
  approvalResponseMeta(null);
  const query = input?.window != null ? { window: input.window }
    : typeof input?.app === "string" ? { app: input.app } : {};
  const policy = JSON.parse(await transport("app_policy", { options, input: query }));
  const { target } = policy;
  approvalResponseMeta(target.bundleIdentifier);
  if (policy.decision === "denied") {
    throw new Error(`Computer Use is blocked from using the app '${target.bundleIdentifier}' by your organization's policy.`);
  }
  if (policy.decision === "forbidden") {
    throw new Error(`Computer Use is not allowed to use the app '${target.bundleIdentifier}' for safety reasons.`);
  }
  const callId = approvalCallId();
  const answer = await approvalGlobal("createElicitation")({
    message: `Allow Computer Use to use "${target.displayName}"?`,
    meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "computer-use",
      connector_name: "Computer Use",
      persist: policy.allowPersistentApproval ? ["session", "always"] : ["session"],
      riskLevel: target.risk,
      ...(target.warningSubtitle == null ? {} : { subtitle: target.warningSubtitle }),
      ...(callId == null ? {} : { tool_call_id: callId }),
      tool_name: approvalToolNames[tool] ?? tool,
      tool_params: { app: target.bundleIdentifier },
      tool_params_display: [{ name: "app", display_name: "App", value: target.displayName }],
    },
  });
  if (answer?.action !== "accept") throw new Error(`Computer Use was not approved to use ${target.displayName}`);
}

// transport is Sky's sky_linux(command, { options, input }) request function.
export function gateApps(options, client, transport) {
  // Unattended runs (e.g. disposable-app validation) may opt out explicitly.
  if (/^(0|false|no|off)$/i.test(process.env.CODEX_HYPRLAND_APP_APPROVAL ?? "")) return client;
  for (const name of approvalGated) {
    const run = client[name];
    if (typeof run !== "function") continue;
    if (name === "drag_handle") {
      // drag_handle() synchronously returns a handle; approve when it starts.
      client[name] = function () {
        const handle = run();
        return Object.assign({}, handle, {
          async start(point) {
            await approveApp(transport, options, name, point);
            const suspend = globalThis.nodeRepl?.withSuspendedTimeout;
            return typeof suspend === "function" ? suspend(() => handle.start(point)) : handle.start(point);
          },
        });
      };
      continue;
    }
    client[name] = async function (input) {
      await approveApp(transport, options, name, input);
      const suspend = globalThis.nodeRepl?.withSuspendedTimeout;
      return typeof suspend === "function" ? suspend(() => run(input)) : run(input);
    };
  }
  return client;
}
