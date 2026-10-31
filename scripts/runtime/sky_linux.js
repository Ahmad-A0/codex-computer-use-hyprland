// Replaces Sky's targets/linux/sky_linux.js in the private copies of @oai/cua
// and @oai/sky. Same export and signature: sky_linux(command, { options, input })
// sends one line-protocol request to the Linux backend and returns its output
// as a JSON string.
//
// Codex runs node_repl's trusted worker, and so this module, in the session's
// sandbox (bwrap, seccomp without AF_UNIX connect). The backend needs the
// desktop's sockets (Hyprland, D-Bus, AT-SPI), so as on macOS, where Sky
// reaches the Computer Use service over nodeRepl.nativePipe, the backend runs
// outside the sandbox: scripts/sky-broker.mjs, started by scripts/launch.mjs,
// listens on CODEX_HYPRLAND_SKY_SOCKET and runs one backend per connection;
// node_repl relays the connection. Without that variable (the overlay used
// without launch.mjs) the backend is spawned directly, as upstream does.
import { package_bin } from "../../core/package_bin.js";
import { SkyLinuxTransport } from "./sky_linux_transport.js";

const transports = new Map();

function backendArgs(options) {
  const args = [];
  if (options.mouse_size_px) args.push("--mouse-size-px", String(options.mouse_size_px));
  return args;
}

async function sky_linux(command, { options, input }) {
  const args = backendArgs(options);
  const socket = process.env.CODEX_HYPRLAND_SKY_SOCKET;
  const key = JSON.stringify(args);
  let transport = transports.get(key);
  if (transport == null) {
    transport = socket
      ? new BrokerTransport(socket, process.env.CODEX_HYPRLAND_SKY_TOKEN ?? "", args)
      : new SkyLinuxTransport(package_bin({ relative_path: ["bin", "linux", `sky_linux_${process.arch}`],
          env_var_override: "OAI_SKY_LINUX_BIN" }), [...args, "server"]);
    transports.set(key, transport);
  }
  const output = await transport.request(command, input ?? {});
  return output == null ? "" : JSON.stringify(output);
}

// The backend's line protocol over a node_repl native pipe. The first line
// introduces the client to the broker; then each request line gets a response
// line { id, ok, output | error, restart? }. When the backend exits, the broker
// sends { exit: "<status>: <stderr tail>" } and closes the connection. A closed
// connection fails its pending requests; the next request reconnects and so
// starts a new backend, as upstream respawns its child.
class BrokerTransport {
  #socket; #token; #args;
  #connecting = null; #connection = null; #pending = new Map(); #serial = 1; #buffer = ""; #decoder = null; #exit = null;

  constructor(socket, token, args) {
    this.#socket = socket;
    this.#token = token;
    this.#args = args;
  }

  async request(command, input) {
    if (this.#connecting == null) {
      const connecting = this.#connect();
      this.#connecting = connecting;
      connecting.catch(() => { if (this.#connecting === connecting) this.#connecting = null; });
    }
    const connection = await this.#connecting;
    // Closed while this request waited for it: nothing would ever answer.
    if (connection !== this.#connection) throw new Error(this.#exit ?? "the Hyprland computer-use backend closed its connection");
    const id = this.#serial++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command, resolve, reject });
      connection.write(Buffer.from(JSON.stringify({ id, command, input }) + "\n", "utf8"));
    });
  }

  async #connect() {
    const nativePipe = globalThis.nodeRepl?.nativePipe;
    if (typeof nativePipe?.createConnection !== "function") {
      throw new Error("The Hyprland computer-use backend requires nodeRepl.nativePipe, which this Codex node_repl does not provide.");
    }
    let connection;
    try {
      connection = await nativePipe.createConnection(this.#socket);
    } catch (error) {
      throw new Error(`Cannot reach the Hyprland computer-use backend at ${this.#socket}: ${error?.message ?? error}`);
    }
    this.#connection = connection;
    this.#buffer = "";
    this.#decoder = new TextDecoder();
    this.#exit = null;
    connection.on("data", (data) => this.#receive(data));
    connection.on("error", (error) => this.#closed(connection, error));
    connection.on("close", () => this.#closed(connection));
    connection.write(Buffer.from(JSON.stringify({ token: this.#token, args: this.#args, cwd: process.cwd() }) + "\n", "utf8"));
    return connection;
  }

  #receive(data) {
    this.#buffer += this.#decoder.decode(data, { stream: true });
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#message(line);
    }
  }

  #message(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.#fail(new Error(`sky_linux server emitted invalid JSON: ${line}`));
      return;
    }
    if (response != null && typeof response === "object" && typeof response.exit === "string") {
      this.#exit = response.exit;
      return;
    }
    if (response == null || typeof response !== "object" || typeof response.id !== "number") {
      this.#fail(new Error("sky_linux server response missing numeric id"));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending == null) return;
    this.#pending.delete(response.id);
    if (response.ok === true) {
      pending.resolve(response.output);
      return;
    }
    const error = new Error(typeof response.error === "string" ? response.error : `sky_linux request failed: ${pending.command}`);
    if (response.restart === true) this.#fail(error);
    pending.reject(error);
  }

  // End the backend; later requests start a new one.
  #fail(error) {
    const connection = this.#connection;
    this.#forget();
    this.#rejectAll(error);
    connection?.end();
  }

  #closed(connection, error) {
    if (connection !== this.#connection) return;
    this.#forget();
    this.#rejectAll(new Error(this.#exit ?? error?.message ?? "the Hyprland computer-use backend closed its connection"));
  }

  #forget() {
    this.#connection = null;
    this.#connecting = null;
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export { sky_linux };
