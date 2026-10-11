.pragma library
.import "Shared.js" as Shared

// AmneziaWG: the obfuscated WireGuard fork AmneziaVPN ships (protocol name
// "AmneziaWG", tools `awg` / `awg-quick`), driven the same way WireGuard would
// be if this widget had a plain-WireGuard backend — plain `*.conf` profiles in
// a directory, brought up and down with `awg-quick`. Parsing and row-building
// only; the process plumbing lives in AmneziaWgBackend.qml.
//
// `awg` and `awg-quick` are a drop-in CLI fork of `wg` and `wg-quick`: same
// subcommands, same `show interfaces` output, same "interface name is the
// config basename" convention. What AmneziaWG adds lives entirely inside the
// `.conf` file — `Jc`/`Jmin`/`Jmax`/`S1`/`S2`/`H1`-`H4` in `[Interface]`, which
// `awg-quick` understands and plain `wg-quick` would silently ignore (or, on
// stricter builds, reject). None of that reaches this file: from here a profile
// is a path, a hooks flag and an endpoint.

// `awg show interfaces` separates interface names with whitespace. An empty
// read, or a read that failed, means nothing is up.
function parseAwgInterfaces(raw) {
  var names = []
  var parts = String(raw || "").trim().split(/\s+/)
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim()
    if (name === "") continue
    if (names.indexOf(name) < 0) names.push(name)
  }
  return names
}

// One config line as awg-quick itself reads it. Its parser (inherited verbatim
// from wg-quick) is:
//
//     stripped="${line%%\#*}"
//     key="${stripped%%=*}"; key="${key##*([[:space:]])}"; key="${key%%*([[:space:]])}"
//
// so a `#` starts a comment anywhere in the line, not only at column 0, and the
// key is whatever is left once the text before the first `=` is trimmed. A `;`
// starts no comment at all: `;PostUp = x` is a key named ";PostUp", which
// matches no directive and is therefore inert. Matching is done under
// `shopt -s nocasematch`, so `postup =` is every bit as much a hook as
// `PostUp =`.
function confDirective(line) {
  var stripped = String(line || "").split("#")[0]
  var eq = stripped.indexOf("=")
  if (eq < 0) return null
  var key = stripped.substring(0, eq).trim()
  if (key === "") return null
  return { key: key.toLowerCase(), value: stripped.substring(eq + 1).trim() }
}

// A PreUp/PostUp/PreDown/PostDown line runs as root the moment awg-quick brings
// the interface up or down — the same hazard a plain WireGuard profile carries,
// and one a dropped-in `.conf` file is exactly the way to hide. Profiles
// carrying one are listed but refused at connect time rather than silently
// stripped, so the user sees why rather than wondering why nothing happened.
//
// awg-quick only honours these inside `[Interface]`; this ignores sections and
// blocks the profile wherever the line appears, erring towards refusing one the
// tool would have ignored rather than running one it would have executed.
function hasDangerousHooks(confText) {
  var lines = String(confText || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var directive = confDirective(lines[i])
    if (!directive) continue
    if (directive.key === "preup" || directive.key === "postup"
        || directive.key === "predown" || directive.key === "postdown") return true
  }
  return false
}

// Everything the panel needs to know about one profile, read from the config
// itself: whether connecting to it would run root hooks, where it goes, and
// whether it carries the default route. A config can hold several `[Peer]`
// blocks, so endpoints is a list.
function parseConf(confText) {
  var lines = String(confText || "").split("\n")
  var endpoints = []
  var defaultRoute = false
  for (var i = 0; i < lines.length; i++) {
    var directive = confDirective(lines[i])
    if (!directive) continue
    if (directive.key === "endpoint") {
      if (directive.value !== "" && endpoints.indexOf(directive.value) < 0) endpoints.push(directive.value)
    } else if (directive.key === "allowedips") {
      var cidrs = directive.value.split(",")
      for (var j = 0; j < cidrs.length; j++) {
        var cidr = cidrs[j].trim()
        if (cidr === "0.0.0.0/0" || cidr === "::/0") defaultRoute = true
      }
    }
  }
  return { hasHooks: hasDangerousHooks(confText), endpoints: endpoints, defaultRoute: defaultRoute }
}

// The backend's listProcess concatenates every readable profile into one
// stream: a `#awg-profile <path>` header at column 0, then that file's lines
// each indented by one tab. The indent is what keeps a config that happens to
// contain a line looking like a header from opening a record of its own.
function parseProfileBundle(raw) {
  var entries = []
  var current = null
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("#awg-profile ") === 0) {
      var path = line.substring("#awg-profile ".length).trim()
      if (path === "") { current = null; continue }
      current = { path: path, text: [] }
      entries.push(current)
      continue
    }
    if (current && line.indexOf("\t") === 0) current.text.push(line.substring(1))
  }

  var profiles = []
  for (var k = 0; k < entries.length; k++) {
    var conf = parseConf(entries[k].text.join("\n"))
    profiles.push({
      path: entries[k].path,
      hasHooks: conf.hasHooks,
      endpoints: conf.endpoints,
      defaultRoute: conf.defaultRoute
    })
  }
  return profiles
}

// The config basename is the interface name awg-quick would bring up — same
// rule wg-quick uses, since awg-quick is a fork of it.
function interfaceFor(confFile) {
  var base = String(confFile || "").replace(/\\/g, "/").split("/").pop()
  return base.replace(/\.conf$/i, "")
}

// The `systemdProfiles` setting: interface names whose tunnel is owned by
// amneziawg-tools' `awg-quick@<name>.service` rather than by a bare awg-quick.
// The setting is the only way to learn them. Their configs live in
// /etc/amnezia/amneziawg, which is not even listable by the user the shell runs
// as, and `systemctl list-units` forgets an instance soon after it stops, so
// neither can say which tunnels exist while they are down.
//
// Every name ends up inside a unit name passed to systemctl, so anything that
// is not a valid awg-quick interface name is dropped here rather than escaped.
// The pattern and the 15-character limit are awg-quick's own (inherited from
// wg-quick), so nothing it would accept is lost.
function parseAwgUnitProfiles(raw) {
  var names = []
  var parts = String(raw || "").split(/[\s,]+/)
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim()
    if (!/^[a-zA-Z0-9_=+.-]{1,15}$/.test(name)) continue
    if (names.indexOf(name) < 0) names.push(name)
  }
  return names
}

function awgUnitFor(name) {
  return "awg-quick@" + name + ".service"
}

// The `profileNames` setting: "pc-david=VPS Hong Kong, work=Office". A profile
// is named after its config file because awg-quick derives the interface from
// it, and an interface name allows no spaces and 15 characters at most — so a
// readable name has to live beside the file rather than in it. Renaming the
// file would also rename the interface, its systemd unit and anything (a
// polkit rule) keyed to either. Entries without an "=" or with an empty side
// are dropped; the first entry for an interface wins.
function parseAwgProfileNames(raw) {
  var names = {}
  var parts = String(raw || "").split(",")
  for (var i = 0; i < parts.length; i++) {
    var at = parts[i].indexOf("=")
    if (at < 0) continue
    var iface = parts[i].substring(0, at).trim()
    var shown = parts[i].substring(at + 1).trim()
    if (iface === "" || shown === "" || names[iface] !== undefined) continue
    names[iface] = shown
  }
  return names
}

// Copies, so a profile list the backend already published is never changed
// under a binding that read it.
function awgApplyNames(profiles, names) {
  var named = []
  for (var i = 0; i < profiles.length; i++) {
    var copy = {}
    for (var key in profiles[i]) copy[key] = profiles[i][key]
    if (names && names[copy.name] !== undefined) copy.label = names[copy.name]
    named.push(copy)
  }
  return named
}

function awgLabel(profile) {
  return profile.label ? profile.label : profile.name
}

// The profile list the panel renders: every config found, one row per
// systemd-managed profile the listing could not read, and one synthesized row
// per interface that is up and has no config behind it.
//
// That second half matters more than it looks. awg-quick's own profile
// directory is /etc/amnezia/amneziawg, root-owned and unreadable to the user
// the shell runs as, so a tunnel started with `sudo awg-quick up work` is up
// with nothing in the listing to match it. Without a row for it the backend is
// undetected, the chip is gone, and the tunnel that is carrying the user's
// traffic cannot be brought down from the panel. The same hole opens when a
// config is deleted or renamed while its tunnel is up — a listing that cannot
// see a profile is stale, not proof the tunnel ended. awg-quick resolves a bare
// interface name against its own directory, so `awg-quick down work` takes it
// down without the widget ever having read the file.
//
// A profile named in `units` carries `unit`, which switches its connect and
// disconnect over to systemctl (see awgControlCommand). A unit profile is never
// `external`: the user named it, so it is a profile they expect to start from
// here, up or down. Its config is usually unreadable, which `configRead`
// records so the detail rows leave out what only the config could say.
function buildProfiles(entries, upInterfaces, units) {
  var up = upInterfaces || []
  var managed = units || []
  var profiles = []
  var seen = {}
  for (var i = 0; i < entries.length; i++) {
    var name = interfaceFor(entries[i].path)
    if (name === "" || seen[name]) continue
    seen[name] = true
    profiles.push({
      name: name,
      confFile: entries[i].path,
      unit: managed.indexOf(name) !== -1 ? awgUnitFor(name) : "",
      hasHooks: entries[i].hasHooks === true,
      endpoints: entries[i].endpoints || [],
      defaultRoute: entries[i].defaultRoute === true,
      configRead: true,
      external: false,
      active: up.indexOf(name) !== -1
    })
  }
  for (var k = 0; k < managed.length; k++) {
    if (seen[managed[k]]) continue
    seen[managed[k]] = true
    profiles.push({
      name: managed[k],
      confFile: managed[k],
      unit: awgUnitFor(managed[k]),
      hasHooks: false,
      endpoints: [],
      defaultRoute: false,
      configRead: false,
      external: false,
      active: up.indexOf(managed[k]) !== -1
    })
  }
  for (var j = 0; j < up.length; j++) {
    if (seen[up[j]]) continue
    seen[up[j]] = true
    profiles.push({
      name: up[j],
      confFile: up[j],
      unit: "",
      hasHooks: false,
      endpoints: [],
      defaultRoute: false,
      configRead: false,
      external: true,
      active: true
    })
  }
  return profiles
}

// The command that brings a profile up ("up") or down ("down"), and whether the
// backend has to elevate it.
//
// A systemd-managed tunnel has to be driven through its unit. Taking it down
// with a bare `awg-quick down` leaves `awg-quick@<name>.service` — a oneshot
// with RemainAfterExit — reporting active with no interface behind it, and a
// later `systemctl start` is then a silent no-op: the unit believes it is
// already running. systemctl also needs no elevation of its own; polkit
// decides, which lets a rule scoped to these units connect without a prompt,
// and falls back to the session's polkit agent where there is none.
//
// "up" restarts rather than starts for that same reason: a tunnel taken down
// behind the unit's back can only be brought back by stopping the unit first,
// and on a unit that is really inactive a restart is just a start.
function awgControlCommand(profile, verb) {
  if (profile && profile.unit) {
    return { argv: ["systemctl", verb === "up" ? "restart" : "stop", profile.unit], elevate: false }
  }
  return { argv: [verb === "up" ? "up" : "down", profile ? profile.confFile : ""], elevate: true }
}

// One line per up interface, "<iface>\t<rxBytes>\t<txBytes>", built by the
// backend from /sys/class/net counters (see AmneziaWgBackend.qml's
// healthProcess). `wg`/`awg` keep per-peer stats behind root, so the sysfs
// counters are what a normal user can read without elevating just to watch
// throughput.
function parseSysfsStats(raw) {
  var health = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    var fields = line.split("\t")
    var iface = String(fields[0] || "").trim()
    if (iface === "") continue
    health[iface] = {
      rxBytes: parseInt(fields[1], 10) || 0,
      txBytes: parseInt(fields[2], 10) || 0
    }
  }
  return health
}

// Turn two byte counters into the rates the detail rows show, and decide what
// to keep when a sample comes back empty.
//
// The inner `awg show interfaces` in healthProcess exits 0 whether it found
// interfaces or failed to, so an empty read is indistinguishable from "nothing
// is up" at the shell. Taking it at face value blanks the throughput rows of a
// connection the rest of the panel still reports as up. An empty sample is
// therefore treated the way a failed status read is: stale, not empty. It is
// also reported as unsampled, so the caller leaves its sample clock alone and
// the next real reading divides its byte delta by the whole elapsed interval
// rather than by the gap since a sample that never happened.
function mergeHealth(previous, next, elapsedSeconds) {
  var prior = previous || {}
  var empty = true
  for (var key in next) { empty = false; break }
  if (empty) return { health: prior, sampled: false }

  var elapsed = Number(elapsedSeconds) || 0
  for (var iface in next) {
    var before = prior[iface]
    if (!before || elapsed <= 0) continue
    next[iface].rxRate = Math.max(0, next[iface].rxBytes - before.rxBytes) / elapsed
    next[iface].txRate = Math.max(0, next[iface].txBytes - before.txBytes) / elapsed
  }
  return { health: next, sampled: true }
}

function formatBytes(bytes) {
  var value = Math.max(0, Number(bytes) || 0)
  var units = ["B", "KiB", "MiB", "GiB", "TiB"]
  var index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return (index === 0 ? String(Math.floor(value)) : value.toFixed(value >= 10 ? 0 : 1)) + " " + units[index]
}

function formatRate(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + "/s"
}

function awgTargets(profiles) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var detailText = "AmneziaWG profile"
    if (profile.hasHooks) detailText = "Blocked: contains root hooks"
    else if (profile.external) detailText = profile.active ? "Connected · started outside the widget" : "Started outside the widget"
    else if (profile.active) detailText = profile.unit ? "Connected · systemd unit" : "Connected"
    else if (profile.unit) detailText = "AmneziaWG profile · systemd unit"
    targets.push({
      key: "profile:" + profile.name,
      label: awgLabel(profile),
      // The interface name, which the label no longer is once profileNames
      // renames it: anything that needs a file or unit reads this.
      name: profile.name,
      detail: detailText,
      glyph: profile.hasHooks ? Shared.GLYPH_SHIELD_LOCK : Shared.GLYPH_SHIELD,
      confFile: profile.confFile,
      unit: profile.unit || "",
      active: profile.active === true,
      external: profile.external === true,
      hasHooks: profile.hasHooks === true,
      configRead: profile.configRead !== false && profile.external !== true,
      // Hooks included: editing a blocked profile is how its hooks come out.
      editable: true,
      // Part of the target contract: the panel draws a blocked row dimmed, so a
      // profile that cannot be connected does not look like one that can.
      blocked: profile.hasHooks === true
    })
  }
  return targets
}

function awgSummary(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return awgLabel(profiles[i])
  }
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function awgDetails(profiles, healthByInterface) {
  var rows = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    if (!profile.active) continue
    var iface = interfaceFor(profile.confFile)
    var health = healthByInterface ? healthByInterface[iface] : null
    rows.push(Shared.detail("Profile", awgLabel(profile)))
    rows.push(Shared.detail("Interface", iface))
    // An externally started tunnel, like most systemd-managed ones, has a config
    // this widget never read, so the rows that come from one are left out
    // rather than guessed at.
    if (!profile.external && profile.configRead !== false) {
      if (profile.endpoints && profile.endpoints.length > 0) {
        rows.push(Shared.detail("Endpoint", profile.endpoints.join(", ")))
      }
      rows.push(Shared.detail("Default route", profile.defaultRoute ? "Yes" : "No — traffic may bypass the VPN"))
    }
    if (health) {
      rows.push(Shared.detail("Receiving", formatRate(health.rxRate || 0)))
      rows.push(Shared.detail("Sending", formatRate(health.txRate || 0)))
      rows.push(Shared.detail("Downloaded", formatBytes(health.rxBytes)))
      rows.push(Shared.detail("Uploaded", formatBytes(health.txBytes)))
    }
  }
  var active = activeAwgProfile(profiles)
  if (rows.length > 0) rows.push(Shared.detail("Managed by", active && active.unit ? active.unit : "awg-quick"))
  return rows
}

function activeAwgProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}

var AWG_SYSTEM_PROFILE_DIR = "/etc/amnezia/amneziawg"

// How to edit a profile's config: the command, and whether it needs a
// terminal. A config the listing read from the user's own directory opens in
// the user's editor (omarchy-launch-editor picks it, and puts a TUI editor in a
// terminal itself). Everything else — a systemd profile, a tunnel started
// outside the widget, anything under awg-quick's own directory — lives in a
// root-owned file, which goes through bin/omarchy-vpn-root-edit so the editor
// never runs as root. A tunnel that is up
// keeps its old settings until it reconnects, as with awg-quick itself.
// An editor that blocks until the file is closed, from Omarchy's default
// editor setting, and whether it needs a terminal. A root-owned profile is
// edited as a copy that is written back only once the editor exits, and
// Omarchy launches GUI editors detached (omarchy-launch-editor runs them under
// setsid), which return at once: the copy would be judged unchanged before the
// window had drawn. So the GUI editors that can be told to wait are told to,
// a terminal editor blocks by nature but needs a terminal, and anything else
// gets nvim, Omarchy's own fallback.
function awgBlockingEditor(defaultEditor) {
  var name = String(defaultEditor || "").trim().split("/").pop()
  if (["nvim", "vim", "nano", "micro", "hx", "helix"].indexOf(name) !== -1) return { argv: [name], terminal: true }
  if (name === "sublime_text" || name === "subl") return { argv: ["subl", "--wait"], terminal: false }
  if (name === "code") return { argv: ["code", "--wait"], terminal: false }
  if (name === "zeditor" || name === "zed") return { argv: ["zeditor", "--wait"], terminal: false }
  return { argv: ["nvim"], terminal: true }
}

function awgEditCommand(target, defaultEditor, rootEditHelper) {
  if (!target) return null
  var path = String(target.confFile || "")
  var userFile = target.configRead === true && path.indexOf("/") === 0
    && path.indexOf(AWG_SYSTEM_PROFILE_DIR + "/") !== 0
  if (userFile) return { argv: ["omarchy-launch-editor", path], terminal: false }
  if (path.indexOf("/") !== 0) {
    // `name` when the target carries one: a display name (profileNames) is
    // not an interface name.
    var name = String(target.name || target.label || path)
    if (!/^[a-zA-Z0-9_=+.-]{1,15}$/.test(name)) return null
    path = AWG_SYSTEM_PROFILE_DIR + "/" + name + ".conf"
  }
  // Root's file: bin/omarchy-vpn-root-edit reads and writes it through polkit
  // and edits a private copy, so a GUI editor needs no terminal at all.
  var editor = awgBlockingEditor(defaultEditor)
  return { argv: [String(rootEditHelper || "omarchy-vpn-root-edit"), path].concat(editor.argv), terminal: editor.terminal }
}

// The panel's "+": copy the picked file into the profile directory, where the
// listing finds it on the next poll. Its basename becomes the interface name,
// so it has to be one: 15 characters of [A-Za-z0-9_=+.-]. The copy is
// owner-only (it holds a private key), and never replaces a profile that
// already has the name. Hooks are not checked here: the listing already shows
// a hooked profile as blocked, which is also how its hooks get edited out.
function awgImportCommand(path, profilesDir) {
  var base = String(path || "").split("/").pop()
  if (!/\.conf$/i.test(base)) return { error: "Pick an AmneziaWG .conf file." }
  var name = base.replace(/\.conf$/i, "")
  if (!/^[a-zA-Z0-9_=+.-]{1,15}$/.test(name)) {
    return { error: "\"" + name + "\" is not a usable interface name (15 characters, no spaces). Rename the file first." }
  }
  var dir = String(profilesDir || "")
  if (dir === "") return { error: "No profile directory set." }
  var dest = dir + "/" + name + ".conf"
  return {
    name: name,
    argv: ["sh", "-c",
      "test -e \"$2\" && { echo \"A profile named $3 already exists\" >&2; exit 17; }; " +
      "mkdir -m 0700 -p \"$(dirname \"$2\")\" && install -m 0600 \"$1\" \"$2\"",
      "sh", String(path), dest, name]
  }
}
