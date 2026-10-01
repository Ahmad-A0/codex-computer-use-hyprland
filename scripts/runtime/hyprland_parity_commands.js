// Copied next to the generated create_client.js in the private copies of Sky's
// Linux target. Sky commands that upstream's Linux client lacks but our backend
// (bin/sky-hyprland) serves. Like upstream commands, each waits for the action
// settler, resolves element IDs to native IDs, and defers the next observation.
// transport is Sky's sky_linux(command, { options, input }) request function.
function parity(transport, options, command) {
  return async function (input) {
    await options.action_settler.wait();
    const result = await transport(command, { options, input: options.element_ids.resolve(input) });
    options.action_settler.defer();
    if (command === "resolve_app") return JSON.parse(result);
  };
}

export function parityCommands(options, transport) {
  return {
    resolve_app: parity(transport, options, "resolve_app"),
    select_text: parity(transport, options, "select_text"),
    set_value: parity(transport, options, "set_value"),
    paste: parity(transport, options, "paste"),
  };
}
