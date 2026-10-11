.pragma library
.import "Shared.js" as Shared

// OpenVPN, WireGuard, OpenConnect, VPNC and L2TP/IPsec profiles, via `nmcli`.
// Parsing and row-building only — the process plumbing lives in
// NetworkManagerBackend.qml.

//
// All five live here because on a desktop they are NetworkManager profiles:
// same listing call, same activation and teardown. What differs is how
// NetworkManager types them — OpenVPN, OpenConnect, VPNC and L2TP are `vpn`
// connections with a service-type plugin behind them, while WireGuard is its
// own connection type with the keys in the profile.
//
// OpenConnect differs from the other four in one way that reaches this file: it
// cannot be brought up with `connection up` alone. Its cookie/gateway/gwcert/
// resolve secrets are all flagged not-saved, so every activation needs a
// secret agent to produce them, and the answer is a helper that runs the
// openconnect auth dialog. That is why an OpenConnect target carries a whole
// command rather than nmcli arguments.

// `nmcli -t` escapes literal colons as "\:", so split on the first unescaped
// one rather than on every colon.
function splitNmcliLine(line) {
  var text = String(line || "")
  for (var i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue }
    if (text[i] === ":") return [unescapeNmcli(text.substring(0, i)), unescapeNmcli(text.substring(i + 1))]
  }
  return [unescapeNmcli(text), ""]
}

function unescapeNmcli(value) {
  return String(value || "").replace(/\\(.)/g, "$1")
}

// Generated on the fly for a device someone else brought up, rather than a
// profile on disk. Empty means the field was never asked for: nmcli refuses a
// listing that names a field it does not know, so an nmcli too old for
// FILENAME is retried without it — see NetworkManagerBackend. Such a
// connection is kept, since a stray row beats a backend that lists nothing.
function isVolatileConnection(filename) {
  return String(filename || "").indexOf("/run/") === 0
}

// `nmcli -t -f NAME,UUID,TYPE,ACTIVE,FILENAME connection show` — one connection
// per line. Two types are tunnels: `vpn` (an OpenVPN profile, or another
// plugin's, which the second pass sorts out) and `wireguard`. Ethernet, wifi,
// bridges and the rest are somebody else's business.
//
// FILENAME is what keeps other tools' tunnels out. When something brings up a
// WireGuard interface itself — Mullvad's `wg0-mullvad`, say — NetworkManager
// adopts the device and generates a volatile connection for it under
// `/run/NetworkManager/`. Listing that would put the same tunnel on two chips,
// and taking it down through nmcli would yank it out from under the tool that
// owns it. Profiles the user actually imported are stored under `/etc`.
function parseNmcliConnections(raw) {
  var connections = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue

    var fields = []
    var rest = line
    for (var f = 0; f < 4; f++) {
      var pair = splitNmcliLine(rest)
      fields.push(pair[0])
      rest = pair[1]
    }
    fields.push(unescapeNmcli(rest))

    if (fields[2] !== "vpn" && fields[2] !== "wireguard") continue
    if (isVolatileConnection(fields[4])) continue
    connections.push({
      name: fields[0],
      uuid: fields[1],
      // "vpn" here means "needs the second pass to say which plugin".
      kind: fields[2] === "wireguard" ? "wireguard" : "vpn",
      active: fields[3] === "yes"
    })
  }
  return connections
}

// `nmcli -t -f connection.uuid,vpn.service-type,vpn.data connection show <uuid>…`
// prints one blank-line-separated block per connection, each line prefixed
// with its field name. Returns
// { uuid: { serviceType, hasUsername, gateway, connectionType } }.
function parseNmcliVpnDetails(raw) {
  var details = {}
  var current = null
  var lines = String(raw || "").split("\n")

  function flush() {
    if (current && current.uuid !== "") details[current.uuid] = current
    current = null
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") {
      flush()
      continue
    }

    var pair = splitNmcliLine(line)
    if (!current) current = { uuid: "", serviceType: "", hasUsername: false, gateway: "", connectionType: "" }

    if (pair[0] === "connection.uuid") current.uuid = pair[1]
    else if (pair[0] === "vpn.service-type") current.serviceType = pair[1]
    else if (pair[0] === "vpn.data") {
      current.hasUsername = hasVpnUsername(pair[1])
      current.connectionType = vpnDataValue(pair[1], "connection-type")
      // OpenConnect calls this `gateway`; VPNC inherited the spelling used by
      // vpnc.conf. Keeping one field downstream lets the detail row stay blind
      // to the plugin that supplied it.
      current.gateway = vpnDataValue(pair[1], "gateway")
        || vpnDataValue(pair[1], "IPSec gateway")
    }
  }
  flush()

  return details
}

// One "key = value" out of vpn.data, matched on the whole key so that
// `gateway-flags` is not mistaken for `gateway` — OpenConnect profiles carry
// both, and the flags entry sorts first.
function vpnDataValue(data, wanted) {
  var entries = String(data || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var eq = entry.indexOf("=")
    if (eq === -1) continue
    if (entry.substring(0, eq).trim() !== wanted) continue
    return entry.substring(eq + 1).trim()
  }
  return ""
}

// vpn.data is a comma-separated "key = value" list. OpenVPN calls the identity
// `username`; VPNC calls it `Xauth username`; L2TP calls it `user`. All three
// live outside vpn.secrets, so `nmcli --ask` never prompts for any of them — a
// profile missing one authenticates as the empty user and is rejected.
function hasVpnUsername(data) {
  var entries = String(data || "").split(",")
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].trim()
    var eq = entry.indexOf("=")
    if (eq === -1) continue
    var key = entry.substring(0, eq).trim().toLowerCase()
    if (key !== "username" && key !== "xauth username" && key !== "user") continue

    var value = entry.substring(eq + 1).trim()
    if (value !== "") return true
  }
  return false
}

function isOpenVpnService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("openvpn") !== -1
}

// "openconnect" does not contain "openvpn", so the two checks cannot both
// claim the same profile.
function isOpenConnectService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("openconnect") !== -1
}

function isVpncService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("networkmanager.vpnc") !== -1
}

function isL2tpService(serviceType) {
  return String(serviceType || "").toLowerCase().indexOf("networkmanager.l2tp") !== -1
}

function isWireGuard(profile) {
  return profile && profile.kind === "wireguard"
}

function isOpenConnect(profile) {
  return profile && profile.kind === "openconnect"
}

function isVpnc(profile) {
  return profile && profile.kind === "vpnc"
}

function isL2tp(profile) {
  return profile && profile.kind === "l2tp"
}

// NetworkManager's OpenVPN plugin records the auth mode in `connection-type`:
// `tls` authenticates with a certificate and key alone, and `static-key` with a
// pre-shared key, so neither reads a username — only `password` and
// `password-tls` do. An Azure point-to-site certificate profile imports as
// `tls`, and calling that one "no username set" blocks a connection that would
// have worked.
function isCertificateOnlyOpenVpn(profile) {
  var type = String((profile && profile.connectionType) || "").toLowerCase()
  return type === "tls" || type === "static-key"
}

// A username is an OpenVPN, VPNC and L2TP concern. WireGuard keeps its keys in
// the profile, and OpenConnect asks the gateway who you are as part of its own
// authentication, so neither can be missing one.
function needsUsername(profile) {
  return !isWireGuard(profile) && !isOpenConnect(profile)
    && !isCertificateOnlyOpenVpn(profile)
}

function usernameSetting(profile) {
  if (isVpnc(profile)) return "Xauth username"
  if (isL2tp(profile)) return "user"
  return "username"
}

// Which chip a profile is listed on. NetworkManager is one tool, so by default
// one chip carries every kind. With `openvpnChip` on, OpenVPN profiles move to
// a chip of their own — a second instance of the same backend — so a list of
// OpenVPN servers is not interleaved with WireGuard tunnels that do something
// else entirely. Each profile lands on exactly one chip either way: listing a
// tunnel twice would let the two instances fight over it.
// The chip is named after what it holds when that is one kind: a chip of
// WireGuard tunnels reads "WireGuard", not the name of the daemon behind it.
// Mixed kinds, or none, keep the manager's name, which is the only honest
// umbrella for them.
function nmChipLabel(profiles, fallback) {
  var kind = ""
  for (var i = 0; i < (profiles || []).length; i++) {
    var next = nmKindLabel(profiles[i])
    if (kind !== "" && next !== kind) return fallback
    kind = next
  }
  return kind !== "" ? kind : fallback
}

function nmOnChip(profile, chipId, openvpnChip) {
  var openvpn = nmKindLabel(profile) === "OpenVPN"
  if (chipId === "openvpn") return openvpnChip === true && openvpn
  return !(openvpnChip === true && openvpn)
}

function nmKindLabel(profile) {
  if (isWireGuard(profile)) return "WireGuard"
  if (isOpenConnect(profile)) return "OpenConnect"
  if (isVpnc(profile)) return "VPNC"
  if (isL2tp(profile)) return "L2TP"
  return "OpenVPN"
}

// The glyph carries the kind, since the rows otherwise look identical and the
// three behave differently the moment credentials come up.
//
// `authScript` is the openconnect helper's absolute path, which only the
// backend knows. An OpenConnect target gets a `command` — a whole argv — where
// the others get `args` to hand to nmcli, because its activation is not an
// nmcli call. Without the helper an OpenConnect row is still listed and still
// says what it is, but has nothing to run.
function nmTargets(profiles, authScript) {
  var targets = []
  for (var i = 0; i < profiles.length; i++) {
    var profile = profiles[i]
    var wireguard = isWireGuard(profile)
    var openconnect = isOpenConnect(profile)
    var vpnc = isVpnc(profile)
    var l2tp = isL2tp(profile)

    var glyph = Shared.GLYPH_LOCK
    if (wireguard) glyph = Shared.GLYPH_SHIELD
    else if (openconnect || vpnc || l2tp) glyph = Shared.GLYPH_SHIELD_LOCK

    var target = {
      key: "profile:" + profile.uuid,
      label: profile.name,
      detail: profile.active
        ? "Connected"
        // OpenVPN, VPNC and L2TP keep identity outside their secrets. WireGuard
        // keeps its keys in the profile, and OpenConnect settles identity with
        // the gateway, so neither has anything for the user to have left out.
        : (!needsUsername(profile) || profile.hasUsername
            ? nmKindLabel(profile) + " profile"
            : "No username set"),
      glyph: glyph,
      args: ["connection", "up", "uuid", profile.uuid],
      uuid: profile.uuid,
      kind: profile.kind,
      hasUsername: profile.hasUsername,
      connectionType: profile.connectionType || "",
      gateway: profile.gateway || "",
      // Part of the target contract: the panel offers an edit action on rows
      // that carry it, and hands them to the backend's editTarget().
      editable: profile.uuid !== ""
    }

    if (openconnect && String(authScript || "") !== "") {
      target.command = [String(authScript), profile.uuid]
    }

    targets.push(target)
  }
  return targets
}

// Each plugin has its own way in, and naming one that is not installed sends
// people after a package they do not need — the line named OpenVPN and
// WireGuard whatever was actually installed. OpenVPN and WireGuard import the
// file someone is handed; an IPsec gateway arrives as a set of values in an
// email rather than a file, so those profiles are built field by field. The
// key names are the ones NetworkManager itself stores, which is why they are
// spelled inconsistently.
function nmEmptyText(tools) {
  var available = tools || {}
  var ways = []

  if (available.openvpn) {
    ways.push("nmcli connection import type openvpn file <config.ovpn>")
  }
  if (available.wireguard) {
    ways.push("nmcli connection import type wireguard file <config.conf>")
  }
  if (available.openconnect) {
    ways.push("nmcli connection add type vpn vpn-type openconnect con-name <name>"
      + " -- vpn.data \"gateway = <host>\"")
  }
  if (available.vpnc) {
    ways.push("nmcli connection add type vpn vpn-type vpnc con-name <name>"
      + " -- vpn.data \"IPSec gateway = <host>, IPSec ID = <group>, Xauth username = <you>\"")
  }
  if (available.l2tp) {
    ways.push("nmcli connection add type vpn vpn-type l2tp con-name <name>"
      + " -- vpn.data \"gateway = <host>, user = <you>, ipsec-enabled = yes\"")
  }

  if (ways.length === 0) return "No profiles yet."
  return "No profiles yet. Create one with: " + ways.join(" — or: ")
}

function nmSummary(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i].name
  }
  return profiles.length === 0 ? "No profiles" : "Not connected"
}

function nmDetails(profiles) {
  var rows = []
  for (var i = 0; i < profiles.length; i++) {
    if (!profiles[i].active) continue
    rows.push(Shared.detail("Profile", profiles[i].name))
    rows.push(Shared.detail("Type", nmKindLabel(profiles[i])))
    // Which gateway an interactive or concentrator-backed profile reached,
    // since an organisation commonly has several and the profile name rarely
    // says which one.
    if ((isOpenConnect(profiles[i]) || isVpnc(profiles[i]) || isL2tp(profiles[i]))
        && profiles[i].gateway) {
      rows.push(Shared.detail("Gateway", profiles[i].gateway))
    }
  }
  if (rows.length > 0) rows.push(Shared.detail("Managed by", "NetworkManager"))
  return rows
}

function activeNmProfile(profiles) {
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i]
  }
  return null
}

// How to edit a profile in place: the command, and whether it needs a
// terminal. nm-connection-editor is NetworkManager's own editor and the only
// one that covers every kind this backend lists — WireGuard peers, OpenVPN
// certificates, the IPsec kinds' secrets — so it is used whenever it is
// installed (it ships with network-manager-applet, which many desktops pull in
// without running the applet). nmtui is part of NetworkManager itself, so it is
// always there as the fallback, in a terminal because it is a TUI. Both edit
// the stored profile, which takes effect the next time it connects.
function nmEditCommand(target, connectionEditorPresent) {
  var uuid = target ? String(target.uuid || "") : ""
  if (uuid === "") return null
  if (connectionEditorPresent) return { argv: ["nm-connection-editor", "--edit=" + uuid], terminal: false }
  return { argv: ["nmtui", "edit", uuid], terminal: true }
}

// --- Importing a profile from a file -------------------------------------
//
// The panel's "+" hands the backend a path the user picked. OpenVPN files go
// to `nmcli connection import`, which only stores them. WireGuard files must
// not: `nmcli connection import type wireguard` activates the tunnel the
// moment it is stored (NetworkManager defaults autoconnect to yes, and a new
// WireGuard profile has nothing to wait for), and a full tunnel coming up
// unasked cuts whatever the machine was doing. So a WireGuard file is parsed
// here and created with `nmcli connection add … connection.autoconnect no`.

// Which file types the picker offers. The OpenVPN chip only takes .ovpn, and a
// NetworkManager chip that has handed OpenVPN to that chip only takes .conf.
function nmImportFilter(backendId, openvpnChip) {
  if (backendId === "openvpn") return "OpenVPN profile (*.ovpn) | *.ovpn"
  if (openvpnChip === true) return "WireGuard config (*.conf) | *.conf"
  return "OpenVPN or WireGuard profile | *.ovpn *.conf"
}

function nmImportKind(path, backendId, openvpnChip) {
  var lower = String(path || "").toLowerCase()
  if (/\.ovpn$/.test(lower)) return backendId === "openvpn" || openvpnChip !== true ? "openvpn" : ""
  if (/\.conf$/.test(lower)) return backendId === "openvpn" ? "" : "wireguard"
  return ""
}

// The profile is named after the file, as `nmcli connection import` does.
function nmImportName(path) {
  var base = String(path || "").split("/").pop()
  return base.replace(/\.(ovpn|conf)$/i, "").trim()
}

// An interface name is at most 15 characters with no space, "/" or ":".
// "wg0 (5)" becomes "wg0-5"; a name with nothing usable falls back.
function nmInterfaceName(name) {
  var clean = String(name || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  clean = clean.substring(0, 15).replace(/-+$/, "")
  return clean !== "" ? clean : "wg-import"
}

// Keys AmneziaWG adds to the WireGuard format. A file carrying them only
// works under awg-quick: plain WireGuard would connect to nothing.
var NM_AWG_ONLY_KEYS = ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5"]
var NM_WG_HOOK_KEYS = ["preup", "postup", "predown", "postdown"]

function nmParseWireGuardConfig(text) {
  var config = { iface: {}, peers: [], amnezia: false, hooks: false }
  var section = null
  var lines = String(text || "").split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/[#;].*$/, "").trim()
    if (line === "") continue
    var header = /^\[(\w+)\]$/.exec(line)
    if (header) {
      var kind = header[1].toLowerCase()
      if (kind === "peer") { section = {}; config.peers.push(section) }
      else section = kind === "interface" ? config.iface : null
      continue
    }
    var at = line.indexOf("=")
    if (at < 0 || section === null) continue
    var key = line.substring(0, at).trim().toLowerCase()
    var value = line.substring(at + 1).trim()
    if (NM_AWG_ONLY_KEYS.indexOf(key) !== -1) config.amnezia = true
    if (NM_WG_HOOK_KEYS.indexOf(key) !== -1) config.hooks = true
    section[key] = value
  }
  return config
}

function nmSplitList(value) {
  var items = []
  var parts = String(value || "").split(",")
  for (var i = 0; i < parts.length; i++) {
    var item = parts[i].trim()
    if (item !== "") items.push(item)
  }
  return items
}

function nmIsWireGuardKey(value) {
  return /^[A-Za-z0-9+/]{43}=$/.test(String(value || ""))
}

// { argv } to run, or { error } to show. The private key ends up in argv —
// nmcli takes no other non-interactive route for it — so it is visible in the
// process list for the moment nmcli runs, to this user and root.
function nmWireGuardAddCommand(text, name) {
  var config = nmParseWireGuardConfig(text)
  if (config.amnezia) return { error: "This is an AmneziaWG config. Import it from the AmneziaWG chip." }
  if (config.hooks) return { error: "This config has PostUp/PreDown hooks, which NetworkManager would silently skip." }
  if (!nmIsWireGuardKey(config.iface.privatekey)) return { error: "No valid PrivateKey in [Interface]." }
  if (config.peers.length === 0) return { error: "No [Peer] section." }

  var profileName = String(name || "").trim() || "WireGuard"
  var argv = ["nmcli", "connection", "add", "type", "wireguard",
    "con-name", profileName, "ifname", nmInterfaceName(profileName),
    "connection.autoconnect", "no", "wireguard.private-key", config.iface.privatekey]

  var v4 = [], v6 = []
  var addresses = nmSplitList(config.iface.address)
  for (var i = 0; i < addresses.length; i++) (addresses[i].indexOf(":") !== -1 ? v6 : v4).push(addresses[i])
  if (v4.length === 0 && v6.length === 0) return { error: "No Address in [Interface]." }
  argv.push("ipv4.method", v4.length > 0 ? "manual" : "disabled")
  if (v4.length > 0) argv.push("ipv4.addresses", v4.join(","))
  argv.push("ipv6.method", v6.length > 0 ? "manual" : "disabled")
  if (v6.length > 0) argv.push("ipv6.addresses", v6.join(","))

  var dns4 = [], dns6 = [], search = []
  var dns = nmSplitList(config.iface.dns)
  for (var d = 0; d < dns.length; d++) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(dns[d])) dns4.push(dns[d])
    else if (dns[d].indexOf(":") !== -1) dns6.push(dns[d])
    else search.push(dns[d])
  }
  if (dns4.length > 0) argv.push("ipv4.dns", dns4.join(","))
  if (dns6.length > 0 && v6.length > 0) argv.push("ipv6.dns", dns6.join(","))
  if (search.length > 0) argv.push("ipv4.dns-search", search.join(","))

  if (/^\d+$/.test(config.iface.mtu || "")) argv.push("wireguard.mtu", config.iface.mtu)
  if (/^\d+$/.test(config.iface.listenport || "")) argv.push("wireguard.listen-port", config.iface.listenport)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(config.iface.fwmark || "")) argv.push("wireguard.fwmark", config.iface.fwmark)

  var peers = []
  for (var p = 0; p < config.peers.length; p++) {
    var peer = config.peers[p]
    if (!nmIsWireGuardKey(peer.publickey)) return { error: "A [Peer] has no valid PublicKey." }
    var spec = peer.publickey + " allowed-ips=" + nmSplitList(peer.allowedips).join(";")
    if (peer.endpoint) spec += " endpoint=" + peer.endpoint
    if (nmIsWireGuardKey(peer.presharedkey)) spec += " preshared-key=" + peer.presharedkey + " preshared-key-flags=0"
    if (/^\d+$/.test(peer.persistentkeepalive || "")) spec += " persistent-keepalive=" + peer.persistentkeepalive
    peers.push(spec)
  }
  argv.push("wireguard.peers", peers.join(","))
  return { argv: argv, name: profileName }
}

// "Connection 'Singapore' (27d00f73-…) successfully added."
function nmImportedUuid(output) {
  var match = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/.exec(String(output || ""))
  return match ? match[1] : ""
}

// After an OpenVPN import: autoconnect off (the importer turns it on), and the
// `ns-cert-type` provider files still carry swapped for `remote-cert-tls`,
// its replacement in current OpenVPN. `vpnData` is `nmcli -g vpn.data` output.
function nmOpenVpnFixupCommand(uuid, vpnData) {
  var argv = ["nmcli", "connection", "modify", "uuid", uuid, "connection.autoconnect", "no"]
  var match = /(?:^|,)\s*ns-cert-type\s*=\s*(\w+)/.exec(String(vpnData || ""))
  if (match && !/(?:^|,)\s*remote-cert-tls\s*=/.test(String(vpnData || ""))) {
    argv.push("-vpn.data", "ns-cert-type", "+vpn.data", "remote-cert-tls=" + match[1])
  }
  return argv
}
