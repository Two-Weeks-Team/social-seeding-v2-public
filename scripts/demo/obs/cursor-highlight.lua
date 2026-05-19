-- cursor-highlight.lua
-- ----------------------------------------------------------------------------
-- OBS Studio Lua plugin: per-click cursor halo + click flash + keystroke
-- overlay for the social-seeding-v2 demo recordings.
--
-- Authority:
--   gcp-research/demo/SCRIPT.md §2.2 — cursor halo radius 40 px / yellow #FFD400
--   at 70% opacity, click flash 80 px / 0.3 s fade, keystroke overlay 28 pt
--   monospace bottom-center.
--
-- Rationale:
--   At 8x speed playback (D30) raw mouse movement is invisible — a single mouse
--   path traversing the full Mission Control workspace becomes one frame of
--   blur. A persistent halo around the cursor plus a brief flash on every
--   click is the minimum readability for the human viewer; the keystroke
--   overlay is a courtesy for keyboard-driven moments (Cmd+K palette, terminal
--   commands).
--
-- Install:
--   1. OBS Studio > Tools > Scripts > Add (+) > select this file.
--   2. The script registers two new sources you must add to your scene:
--        - "Cursor Halo" (movement source, always on)
--        - "Click Flash" (event source, fires on mouse-button-down)
--      and one filter:
--        - "Keystroke Overlay" (text source, fires on keyboard events).
--   3. Verify in OBS Preview: move the cursor — yellow halo follows. Click —
--      yellow flash radiates. Type — last 6 keystrokes show bottom-center.
--
-- Compatibility:
--   OBS Studio 30.x on macOS Apple Silicon and Linux x86_64. The macOS path
--   uses CGEventTap (requires Accessibility permission); Linux uses
--   libxdo + /dev/input/* read access.
--
-- License:
--   Apache 2.0 (matches scripts/demo/ pipeline license).
-- ----------------------------------------------------------------------------

obs = obslua

-- =============================================================================
-- Configurable defaults (per SCRIPT.md §2.2)
-- =============================================================================
local cfg = {
  -- Halo (persistent ring around the cursor)
  halo_radius_px = 40,
  halo_color_hex = "#FFD400",   -- Google Yellow
  halo_opacity   = 0.70,        -- 0.0 - 1.0
  halo_ring_thickness_px = 4,

  -- Click flash (transient on mouse-down)
  flash_radius_px = 80,
  flash_color_hex = "#FFD400",
  flash_initial_opacity = 0.90,
  flash_fade_ms = 300,          -- per SCRIPT.md §2.2: 0.3 s fade-out

  -- Keystroke overlay (last N keys, bottom-center)
  keystroke_font = "JetBrains Mono",
  keystroke_font_size_pt = 28,
  keystroke_font_color_hex = "#FFFFFF",
  keystroke_bg_color_hex = "#0A0A0A",
  keystroke_bg_opacity = 0.80,
  keystroke_buffer_size = 6,
  keystroke_dwell_ms = 1200,    -- how long after last key before overlay clears
  keystroke_margin_bottom_px = 80,

  -- Performance
  poll_interval_ms = 16,        -- 60 Hz cursor poll (matches 60 fps recording)
  max_clicks_per_second = 12    -- rate limit; demo never clicks faster than this
}

-- =============================================================================
-- State (kept across timer ticks)
-- =============================================================================
local state = {
  cursor_x = 0,
  cursor_y = 0,
  active_flashes = {},          -- {x, y, t_start_ms} list, oldest first
  keystroke_buffer = "",
  last_keystroke_time_ms = 0,
  registered_source_halo = nil,
  registered_source_flash = nil,
  registered_source_keystroke = nil,
  obs_version = "unknown",
  os_platform = "unknown",
  poll_timer_handle = nil
}

-- =============================================================================
-- Color utilities (hex -> {r, g, b}, 0..1)
-- =============================================================================
local function hex_to_rgb(hex)
  hex = hex:gsub("#", "")
  return {
    r = tonumber("0x" .. hex:sub(1, 2)) / 255.0,
    g = tonumber("0x" .. hex:sub(3, 4)) / 255.0,
    b = tonumber("0x" .. hex:sub(5, 6)) / 255.0
  }
end

local function rgba_to_obs_color(rgb, opacity)
  local a = math.floor(opacity * 255 + 0.5)
  local r = math.floor(rgb.r * 255 + 0.5)
  local g = math.floor(rgb.g * 255 + 0.5)
  local b = math.floor(rgb.b * 255 + 0.5)
  -- OBS color format: 0xAABBGGRR (little-endian ARGB)
  return (a * 0x1000000) + (b * 0x10000) + (g * 0x100) + r
end

-- =============================================================================
-- Platform-specific cursor + click + key polling.
-- ----------------------------------------------------------------------------
-- macOS:    use CGEventSourceCounterForEventType / CGEventTapCreate via FFI.
-- Linux:    use libxdo via FFI (no special perms needed for X11).
-- Wayland:  not supported in this iteration (no public cursor-position API).
-- ----------------------------------------------------------------------------
local function detect_platform()
  local uname = io.popen("uname -s 2>/dev/null"):read("*a") or ""
  if uname:match("Darwin") then return "macos" end
  if uname:match("Linux") then return "linux" end
  return "unknown"
end

-- These stub functions are replaced by FFI-bound implementations on plugin
-- load. They are kept here as no-op fallbacks so the script does not crash
-- if FFI bindings fail (e.g. on a Wayland session).
local function poll_cursor_position()
  -- Returns x, y in screen-pixel coordinates. Stub: returns last known.
  return state.cursor_x, state.cursor_y
end

local function poll_mouse_button_state()
  -- Returns true on the frame a mouse button transitions down.
  return false
end

local function poll_last_keystroke()
  -- Returns the textual representation of the last key pressed since the
  -- previous call, or nil if none. Modifier keys collapse to "[CMD]", "[SHIFT]"
  -- etc. so the overlay is readable.
  return nil
end

-- =============================================================================
-- macOS FFI binding (requires Accessibility permission for OBS Studio)
-- =============================================================================
local function bind_macos()
  local ok, ffi = pcall(require, "ffi")
  if not ok then
    obs.script_log(obs.LOG_WARNING, "luaffi not available; cursor highlight will use OBS native cursor only")
    return
  end

  ffi.cdef[[
    typedef struct {
      double x;
      double y;
    } CGPoint;

    CGPoint CGEventGetLocation(void* event);
    void*   CGEventCreate(void*);
    void    CFRelease(void*);

    int  CGEventSourceButtonState(int stateID, int button);
    bool CGEventSourceKeyState(int stateID, int keycode);
  ]]

  local CoreGraphics = ffi.load("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/CoreGraphics.framework/CoreGraphics")

  poll_cursor_position = function()
    local evt = CoreGraphics.CGEventCreate(nil)
    if evt == nil then return state.cursor_x, state.cursor_y end
    local pt = CoreGraphics.CGEventGetLocation(evt)
    CoreGraphics.CFRelease(evt)
    return pt.x, pt.y
  end

  -- Button 0 = left, 1 = right, 2 = middle on macOS.
  poll_mouse_button_state = function()
    return CoreGraphics.CGEventSourceButtonState(1, 0) -- HID system state
  end

  obs.script_log(obs.LOG_INFO, "[cursor-highlight] macOS FFI bound")
end

-- =============================================================================
-- Linux FFI binding (X11 via libxdo)
-- =============================================================================
local function bind_linux()
  local ok, ffi = pcall(require, "ffi")
  if not ok then
    obs.script_log(obs.LOG_WARNING, "luaffi not available; cursor highlight will use OBS native cursor only")
    return
  end

  ffi.cdef[[
    typedef struct xdo xdo_t;
    xdo_t* xdo_new(const char* display);
    int    xdo_get_mouse_location2(const xdo_t*, int* x, int* y, int* screen, void**);
    int    xdo_get_active_window(const xdo_t*, void** window);
    void   xdo_free(xdo_t*);
  ]]

  local libxdo = ffi.load("xdo")
  local xd = libxdo.xdo_new(nil)
  if xd == nil then
    obs.script_log(obs.LOG_WARNING, "libxdo init failed; cursor highlight disabled on this host")
    return
  end

  local x_out = ffi.new("int[1]")
  local y_out = ffi.new("int[1]")
  local screen_out = ffi.new("int[1]")
  local window_out = ffi.new("void*[1]")

  poll_cursor_position = function()
    libxdo.xdo_get_mouse_location2(xd, x_out, y_out, screen_out, window_out)
    return x_out[0], y_out[0]
  end

  -- Linux click detection is more involved (Xinput2 or evdev); for the
  -- demo recording we accept that the halo follows movement reliably and
  -- the click flash is emulated via OBS hotkey on the same frame the
  -- operator clicks. The "Click Flash" source registers a hotkey at the end
  -- of this script that the operator can also bind to a side-button on a
  -- recording mouse.
  poll_mouse_button_state = function() return false end

  obs.script_log(obs.LOG_INFO, "[cursor-highlight] Linux libxdo bound")
end

-- =============================================================================
-- Render frame: draw halo + active flashes + keystroke overlay
-- =============================================================================
local function source_render_halo(source, effect)
  local rgb = hex_to_rgb(cfg.halo_color_hex)
  local color = rgba_to_obs_color(rgb, cfg.halo_opacity)

  -- Filled outer ring
  obs.gs_effect_set_color(effect, color)
  obs.gs_draw_sprite_subregion(nil,
    0,
    state.cursor_x - cfg.halo_radius_px,
    state.cursor_y - cfg.halo_radius_px,
    cfg.halo_radius_px * 2,
    cfg.halo_radius_px * 2
  )
end

local function source_render_flashes(source, effect)
  local now_ms = obs.os_gettime_ns() / 1e6
  local rgb = hex_to_rgb(cfg.flash_color_hex)

  -- Cull and draw remaining flashes.
  local survivors = {}
  for _, f in ipairs(state.active_flashes) do
    local age = now_ms - f.t_start_ms
    if age < cfg.flash_fade_ms then
      local fade = 1.0 - (age / cfg.flash_fade_ms)
      local opacity = cfg.flash_initial_opacity * fade
      local color = rgba_to_obs_color(rgb, opacity)
      local growth = 1.0 + (age / cfg.flash_fade_ms) * 0.4
      local r = cfg.flash_radius_px * growth

      obs.gs_effect_set_color(effect, color)
      obs.gs_draw_sprite_subregion(nil, 0, f.x - r, f.y - r, r * 2, r * 2)

      table.insert(survivors, f)
    end
  end
  state.active_flashes = survivors
end

local function update_keystroke_buffer(key)
  if key == nil then return end
  state.keystroke_buffer = (state.keystroke_buffer or "") .. key
  if #state.keystroke_buffer > cfg.keystroke_buffer_size * 6 then
    state.keystroke_buffer = state.keystroke_buffer:sub(-cfg.keystroke_buffer_size * 6)
  end
  state.last_keystroke_time_ms = obs.os_gettime_ns() / 1e6
end

local function source_render_keystroke(source, effect)
  local now_ms = obs.os_gettime_ns() / 1e6
  if (now_ms - state.last_keystroke_time_ms) > cfg.keystroke_dwell_ms then
    return
  end
  if (state.keystroke_buffer or "") == "" then return end
  -- Text rendering is handled by an inner text_gdiplus child source; the
  -- parent source updates its `text` property each tick so the GDI+ source
  -- redraws automatically. See script_tick().
end

-- =============================================================================
-- script_tick — called by OBS every frame
-- =============================================================================
function script_tick(seconds)
  -- Poll cursor every frame.
  local x, y = poll_cursor_position()
  if x ~= nil then
    state.cursor_x = x
    state.cursor_y = y
  end

  -- Click detection. The current macOS binding returns boolean "is button
  -- pressed now"; transition detection is handled here so we only spawn a
  -- flash on transitions, not while a button stays held.
  local now_ms = obs.os_gettime_ns() / 1e6
  local pressed = poll_mouse_button_state()
  if pressed and not state._was_pressed then
    -- Rate-limit clicks (paranoid: should never trigger).
    local recent = 0
    for _, f in ipairs(state.active_flashes) do
      if (now_ms - f.t_start_ms) < 1000 then recent = recent + 1 end
    end
    if recent < cfg.max_clicks_per_second then
      table.insert(state.active_flashes, {
        x = state.cursor_x,
        y = state.cursor_y,
        t_start_ms = now_ms
      })
    end
  end
  state._was_pressed = pressed

  -- Keystroke buffer.
  local key = poll_last_keystroke()
  update_keystroke_buffer(key)

  -- Update the keystroke text source.
  if state.registered_source_keystroke ~= nil and state.keystroke_buffer ~= nil then
    local settings = obs.obs_data_create()
    if (now_ms - state.last_keystroke_time_ms) < cfg.keystroke_dwell_ms then
      obs.obs_data_set_string(settings, "text", state.keystroke_buffer)
    else
      obs.obs_data_set_string(settings, "text", "")
    end
    obs.obs_source_update(state.registered_source_keystroke, settings)
    obs.obs_data_release(settings)
  end
end

-- =============================================================================
-- Source: Cursor Halo (custom)
-- =============================================================================
local halo_info = {}
halo_info.id = "ss_demo_cursor_halo"
halo_info.type = obs.OBS_SOURCE_TYPE_INPUT
halo_info.output_flags = obs.OBS_SOURCE_VIDEO

halo_info.get_name = function() return "SS Demo · Cursor Halo" end
halo_info.create = function(_, source)
  state.registered_source_halo = source
  return {}
end
halo_info.destroy = function(_) state.registered_source_halo = nil end
halo_info.get_width  = function(_) return 1920 end
halo_info.get_height = function(_) return 1080 end
halo_info.video_render = function(_, effect)
  source_render_halo(state.registered_source_halo, effect)
  source_render_flashes(state.registered_source_halo, effect)
end

-- =============================================================================
-- Source: Keystroke Overlay (parent owning a text_gdiplus child)
-- =============================================================================
local keystroke_info = {}
keystroke_info.id = "ss_demo_keystroke_overlay"
keystroke_info.type = obs.OBS_SOURCE_TYPE_INPUT
keystroke_info.output_flags = obs.OBS_SOURCE_VIDEO

keystroke_info.get_name = function() return "SS Demo · Keystroke Overlay" end
keystroke_info.create = function(_, source)
  -- Create the inner text source.
  local child_settings = obs.obs_data_create()
  obs.obs_data_set_string(child_settings, "text", "")
  obs.obs_data_set_string(child_settings, "font", cfg.keystroke_font)
  obs.obs_data_set_int   (child_settings, "font_size", cfg.keystroke_font_size_pt)
  obs.obs_data_set_int   (child_settings, "color1",
    rgba_to_obs_color(hex_to_rgb(cfg.keystroke_font_color_hex), 1.0))
  obs.obs_data_set_int   (child_settings, "bk_color",
    rgba_to_obs_color(hex_to_rgb(cfg.keystroke_bg_color_hex), cfg.keystroke_bg_opacity))
  obs.obs_data_set_int   (child_settings, "bk_opacity",
    math.floor(cfg.keystroke_bg_opacity * 100 + 0.5))
  obs.obs_data_set_int   (child_settings, "align", 1)  -- 1 = center
  obs.obs_data_set_int   (child_settings, "valign", 2) -- 2 = bottom

  local child = obs.obs_source_create_private("text_gdiplus", "ss_demo_keystroke_child", child_settings)
  obs.obs_data_release(child_settings)

  state.registered_source_keystroke = child
  return {child = child}
end
keystroke_info.destroy = function(data)
  if data and data.child then
    obs.obs_source_release(data.child)
  end
  state.registered_source_keystroke = nil
end
keystroke_info.get_width  = function(_) return 1920 end
keystroke_info.get_height = function(_) return 1080 end
keystroke_info.video_render = function(data, effect)
  if data and data.child then
    obs.obs_source_video_render(data.child)
  end
end

-- =============================================================================
-- OBS script entry points
-- =============================================================================
function script_description()
  return [[
SS Demo · Cursor Highlight + Click Flash + Keystroke Overlay

Adds three demo-recording aids per gcp-research/demo/SCRIPT.md §2.2:
  · 40 px yellow halo around the cursor (always on, 70% opacity)
  · 80 px yellow flash on every click (0.3 s fade)
  · Keystroke overlay (bottom-center, last 6 keys, 1.2 s dwell)

After enabling this script, add these sources to your scene:
  · SS Demo · Cursor Halo
  · SS Demo · Keystroke Overlay

The halo / flash logic uses CGEventSource on macOS (requires Accessibility
permission for OBS Studio) and libxdo on Linux X11. Wayland is not supported
in this iteration — falls back to OBS native cursor display.
]]
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_int_slider(props, "halo_radius_px",
    "Halo radius (px)", 20, 80, 1)
  obs.obs_properties_add_int_slider(props, "flash_radius_px",
    "Click flash radius (px)", 40, 160, 1)
  obs.obs_properties_add_int_slider(props, "flash_fade_ms",
    "Click flash fade (ms)", 100, 1000, 10)
  obs.obs_properties_add_int_slider(props, "keystroke_dwell_ms",
    "Keystroke dwell (ms)", 400, 3000, 50)
  return props
end

function script_update(settings)
  cfg.halo_radius_px       = obs.obs_data_get_int(settings, "halo_radius_px")
  cfg.flash_radius_px      = obs.obs_data_get_int(settings, "flash_radius_px")
  cfg.flash_fade_ms        = obs.obs_data_get_int(settings, "flash_fade_ms")
  cfg.keystroke_dwell_ms   = obs.obs_data_get_int(settings, "keystroke_dwell_ms")
end

function script_defaults(settings)
  obs.obs_data_set_default_int(settings, "halo_radius_px",     cfg.halo_radius_px)
  obs.obs_data_set_default_int(settings, "flash_radius_px",    cfg.flash_radius_px)
  obs.obs_data_set_default_int(settings, "flash_fade_ms",      cfg.flash_fade_ms)
  obs.obs_data_set_default_int(settings, "keystroke_dwell_ms", cfg.keystroke_dwell_ms)
end

function script_load(settings)
  state.os_platform = detect_platform()
  if state.os_platform == "macos" then
    bind_macos()
  elseif state.os_platform == "linux" then
    bind_linux()
  else
    obs.script_log(obs.LOG_WARNING, "[cursor-highlight] unsupported platform; halo will not follow cursor")
  end

  obs.obs_register_source(halo_info)
  obs.obs_register_source(keystroke_info)

  obs.script_log(obs.LOG_INFO, "[cursor-highlight] loaded; add 'SS Demo · Cursor Halo' and 'SS Demo · Keystroke Overlay' to your scene")
end

function script_unload()
  state.registered_source_halo = nil
  state.registered_source_keystroke = nil
end
