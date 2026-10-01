-- Minimal session for the end-to-end VM: no animations, no wallpaper, and focus
-- that never follows the pointer, so the suite sees a static desktop.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "1" })
hl.config({
    animations = { enabled = false },
    input = { follow_mouse = 0 },
    misc = { disable_hyprland_logo = true, disable_splash_rendering = true },
    ecosystem = { no_update_news = true, no_donation_nag = true },
    debug = { disable_logs = false },
})
-- Publish the environment apps inherit (DISPLAY, WAYLAND_DISPLAY, ...) so the
-- host can run commands as if from a terminal in this session.
hl.on("hyprland.start", function()
    hl.exec_cmd("export -p > ~/.session-env.new && mv ~/.session-env.new ~/.session-env")
end)
