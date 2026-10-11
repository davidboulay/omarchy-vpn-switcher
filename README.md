# VPN Switcher

One bar icon for every VPN on an Omarchy machine. It shows whether you are
behind a tunnel, and one panel connects, disconnects, stacks and switches
between the VPN tools you actually have installed.

Based on [jkoestinger/omarchy-vpn](https://github.com/jkoestinger/omarchy-vpn)
(MIT), extended with tunnel stacking, profile import, exit location, a separate
OpenVPN chip, AmneziaWG systemd profiles and display names, and profile editing.

It supports **Proton VPN**, **Mullvad**, **Windscribe**, **Cloudflare WARP**,
**AmneziaWG**, and the **OpenVPN**, **WireGuard**, **OpenConnect**, **VPNC** and
**L2TP/IPsec** profiles NetworkManager holds. Only the tools that have something
to offer appear — install none and the widget tells you so; have several and a
chip row lets you switch between them.

<img src="preview.png" alt="The VPN panel open in the Omarchy bar, showing a Proton VPN connection to Zurich and a country list" width="365">

Each installed tool gets its own chip and its own view — Proton VPN above,
[Mullvad](#mullvad), [Windscribe](#windscribe), [AmneziaWG](#amneziawg) and
[NetworkManager](#networkmanager-profiles) below.

## Install

```bash
omarchy plugin add https://github.com/davidboulay/omarchy-vpn-switcher.git
omarchy plugin enable davidboulay.vpn-switcher
```

Plugins land disabled so you can read the code before it runs — it runs
unsandboxed inside `omarchy-shell`, like every Omarchy plugin. **Setup ›
Plugins** does the same thing from the menu.

The icon appears at the right end of the bar. Move it with
`omarchy bar move davidboulay.vpn-switcher --before omarchy.clock`, or any other
placement.

To update later: `omarchy plugin update`. To remove:
`omarchy plugin remove davidboulay.vpn-switcher`.

## What VPN Switcher adds

| Feature | How |
|---|---|
| **Stack connections** | Off: connecting one VPN disconnects the others. On: tunnels from different tools stay up together, e.g. an office network next to a full tunnel. The line under the header shows "Stacking off", "Stacking on" or "Stacked · A + B" (it scrolls when long); click it to flip |
| **Import a profile** | The **+** on a tool's name row (or `a`) opens a file picker. OpenVPN `.ovpn` goes through `nmcli connection import` (autoconnect off, `ns-cert-type` modernised); WireGuard `.conf` is created with `nmcli connection add … autoconnect no`, because a plain import brings the tunnel up at once; AmneziaWG `.conf` is copied, owner-only, into `profilesDir`. A notification reports the result; nothing is connected |
| **Exit location** | The public IP's city and country on a second line (ipinfo.io, asked once per new address, through the tunnel), and in the bar tooltip |
| **Empty chips** | A chip appears once its tool is installed, so the first profile can be imported into it |
| **AmneziaWG install** | When `amneziawg-tools` or an engine (`amneziawg-go` / kernel module) is missing, the gear offers **Install AmneziaWG**, which runs `omarchy-pkg-aur-add` in a terminal |
| **AmneziaWG under systemd** | `systemdProfiles` lists root-owned tunnels while down and connects them through `awg-quick@<name>.service`, so a polkit rule can allow it without a prompt |
| **Edit a profile** | Pencil or `e`: NetworkManager profiles open in `nm-connection-editor`; root-owned AmneziaWG files go through a polkit helper that edits a private copy |
| **OpenVPN chip, chip names** | `openvpnChip` splits OpenVPN off; a NetworkManager chip with one kind of tunnel is named after it ("WireGuard") |

## Using it

The bar icon is dim when nothing is connected and bright when a tunnel is up.
Hover it to see which one.

| Action | Result |
|--------|--------|
| Left click | Open the panel |
| Right click | Connect using the tool's own default, or disconnect |
| Middle click | Refresh status and public IP |

Inside the panel:

- **Public IP** sits top-left. Click it to copy it.
- **The switch** top-right connects or disconnects. Turning one VPN on shuts
  every other one off first — you never end up with two tunnels fighting over
  your routes.
- **The gear** to its left opens the widget's own settings, which for now is one
  switch per tool found on this machine. Turn one off and the widget forgets it
  entirely: no chip, no polling, and it stops counting toward the bar icon. Turn
  it back on from the same place. The choice is written to
  `~/.config/omarchy/shell.json` and survives a restart.
- **The chips** below choose which tool you are looking at. They only appear
  when you have more than one installed.
- **The name row** is also a drawer. Tools with settings of their own get a
  chevron; click the row to fold them out, click it again to put them away. It
  starts closed and stays however you left it until the shell restarts.
- **The settings** inside are Mullvad's connect-on-startup, lockdown mode, and
  local network sharing, Proton VPN's kill switch, NetShield, and port
  forwarding, and Windscribe's firewall. They show what the tool itself reports,
  so changing one from its CLI shows up here on the next poll — the widget keeps
  no copy and never puts one back for you.
- **The list** is what you can connect to: for Proton VPN, fastest / P2P /
  random / Secure Core followed by every country; for Mullvad, any location
  followed by every country it has relays in; for Windscribe, best location
  followed by every region it serves; for AmneziaWG, each local profile; for
  NetworkManager, your OpenVPN and WireGuard profiles, told apart by their icon.
  A check mark marks where you are connected.

Keyboard, once the panel is open: `j`/`k` or arrows move — through the header,
the chips, the name row, the settings switches if they are open, then the list —
`Enter` connects, flips a switch, or opens and closes the settings drawer,
depending on what the cursor is on. `h`/`l` move along the chip row and between
the gear and the master switch in the header, `s` cycles tools, `/` searches
countries, `e` edits the profile under the cursor, `d` disconnects, `r`
refreshes, `Esc` closes.

**Editing a profile.** NetworkManager and AmneziaWG rows carry a pencil. A
NetworkManager profile opens in `nm-connection-editor` (from
`network-manager-applet`), or `nmtui` in a terminal without it. An AmneziaWG
profile in your own directory opens in your editor. One under
`/etc/amnezia/amneziawg/` is root's, so it is read through a polkit prompt,
edited as a private copy in `$XDG_RUNTIME_DIR` (RAM, never `/var/tmp`) in your
default editor — Sublime Text, VS Code and Zed are opened with `--wait`, a
terminal editor in a terminal — and written back with a second prompt, only if
you changed it. A tunnel that is up keeps its old settings until it reconnects.
`nm-connection-editor` tiles unless told otherwise; in
`~/.config/hypr/hyprland.lua`:

```lua
o.window("^(nm-connection-editor)$", { float = true, center = true })
```

The public IP is fetched from `https://checkip.amazonaws.com` — never on a timer, only
when the connection changes, when the panel first opens, or when you ask.

## Requirements

Omarchy with its Quickshell desktop, plus at least one of:

- **Proton VPN** — the `protonvpn` CLI, signed in (`protonvpn signin`).
- **Mullvad** — the `mullvad` CLI with `mullvad-daemon` running, logged in
  (`mullvad account login <number>`).
- **Windscribe** — `windscribe-cli` with the Windscribe app running, logged in
  (`windscribe-cli login`).
- **Cloudflare WARP** — `warp-cli` with `warp-svc` running, the device
  registered (`warp-cli registration new`), and WARP's terms accepted once in a
  terminal.
- **AmneziaWG** — `awg` and `awg-quick` from `amneziawg-tools`, **plus an
  engine to carry the traffic**: `amneziawg-go` (userspace) or the kernel module
  (`amneziawg-dkms`). NetworkManager cannot run AmneziaWG. The widget checks for
  both, and offers an install button under the gear when something is missing.
- **OpenVPN, WireGuard, OpenConnect, VPNC or L2TP/IPsec** — `nmcli`, plus
  `openvpn`, `wg` (wireguard-tools), `networkmanager-openconnect`,
  `networkmanager-vpnc`, or `networkmanager-l2tp`. A chip appears as soon as
  the tool is installed; its + imports the first profile.

## Settings

Configure these in **Setup › Plugins**, or in the widget's entry in
`~/.config/omarchy/shell.json`.

| Setting | Default | What it does |
|---------|---------|--------------|
| `refreshIntervalSec` | `15` | How often the connection status is polled |
| `preferredBackend` | `Auto` | Which tool the panel opens on. `Auto` picks whichever is connected |
| `favoriteCountries` | `CH,NL,US` | Country codes pinned to the top of the Proton VPN and Mullvad lists. Windscribe has no codes, so it matches names instead — see below |
| `hiddenBackends` | *(empty)* | Tools the widget ignores entirely: `proton`, `mullvad`, `windscribe`, `warp`, `networkmanager`, `openvpn`, `amneziawg`. The gear inside the panel writes this |
| `stackConnections` | `false` | Tunnels from different tools stay up together instead of replacing each other. Also the line under the panel header |
| `openvpnChip` | `false` | NetworkManager's OpenVPN profiles get their own **OpenVPN** chip |
| `barIcon` | `VPN` | `VPN`, `Shield`, or `WireGuard` (the WireGuard mark) |
| `profilesDir` | `~/.config/omarchy/vpn/awg-profiles` | Where AmneziaWG profiles are listed from, and imported to |
| `systemdProfiles` | *(empty)* | AmneziaWG interfaces run as `awg-quick@<name>.service` (configs in `/etc/amnezia/amneziawg`), comma separated |
| `profileNames` | *(empty)* | Display names for AmneziaWG interfaces: `pc-david=VPS Hong Kong` |

## Mullvad

<img src="preview-mullvad.png" alt="The VPN panel on the Mullvad chip, showing Any location followed by a country list" width="365">

Mullvad separates picking a relay from connecting: `mullvad relay set location`
records a constraint, `mullvad connect` brings the tunnel up against it. The
widget does both for you, so clicking a country connects to it and the choice
sticks — the switch and `quickconnect` reconnect to whatever you picked last
rather than to a "fastest server" the CLI has no notion of. **Any location**
hands the choice back to Mullvad.

Cities are searchable even though only countries are listed: typing `zurich`
finds Switzerland.

**Lockdown mode** blocks all traffic whenever Mullvad is disconnected —
including the traffic another VPN needs to connect. The widget says so before it
shuts Mullvad down for a different tool, but it will not turn lockdown off on its
own. That switch is in the panel, or:

```bash
mullvad lockdown-mode set off
```

## Windscribe

`windscribe-cli` is a client for the Windscribe desktop app, so the chip appears
only once that app is running and logged in. Until then the panel says which of
the two is missing instead of listing an empty chip.

The list is Windscribe's own regions — a country most of the time, a slice of one
where a country has too many (`US East`, `US West`). Clicking one connects to a
datacenter inside it. **Best location** hands the choice back to Windscribe, and
names the server it currently resolves to. Cities and Windscribe's server
nicknames are searchable even though only regions are listed, so both `zurich`
and `alphorn` find Switzerland.

Rows marked **Pro only** hold nothing a free account can reach. Connecting to one
fails with `Location does not exist or is disabled`, which does not say which of
the two it meant — hence the marker.

Because Windscribe names its regions and never prints a country code,
`favoriteCountries` matches them by name (`Switzerland`) and by leading word
(`US` pins US East, US Central and US West). The default `CH,NL,US` therefore
pins only the US rows on this chip.

**The firewall** is Windscribe's kill switch, and with the app's firewall mode set
to `Auto` it turns itself on before a connect and off after a disconnect. While it
is on and the tunnel is down, nothing leaves the machine — including the traffic
another VPN needs to connect. The widget says so before it shuts Windscribe down
for a different tool, but it will not turn the firewall off on its own. That
switch is in the panel, or:

```bash
windscribe-cli firewall off
```

One caveat that is Windscribe's and not the widget's: `windscribe-cli` refuses to
run while another copy of itself is running, exiting with `Windscribe CLI is
already running` rather than waiting its turn. The widget serialises its own calls
and retries the ones that lose the race, so a command you run yourself at a
terminal costs the panel a moment and nothing more.

## Cloudflare WARP

WARP is not a pick-a-country VPN. Cloudflare routes through the data centre
nearest you and keeps your own country as the exit location, so the list offers
WARP's tunnel modes instead of places: **WARP** (all traffic through Cloudflare)
and **WARP with DNS over HTTPS**. Picking one sets `warp-cli mode` if it differs,
then connects. While connected the panel shows the data centre, mode, protocol,
latency and account type, plus a Network line when WARP reports the
network as anything but healthy.

DNS-only (`doh`, `dot`) and proxy modes are left out: they carry none of the
machine's other traffic, so the switch would show a tunnel that protects nothing.
Set them with `warp-cli mode` if you want them.

The widget never passes `--accept-tos`. Without a terminal, `warp-cli` refuses
every command until WARP's terms were accepted once, and agreeing to them is for
you to do. Until then the panel says so instead of listing WARP; click that line
and it opens a terminal running `warp-cli registration show`, where you answer
the prompt yourself, then reopen the panel.

Switching to another tool runs `warp-cli disconnect`, which also turns off
WARP's own Always On, so it stays off until you connect it again.

## AmneziaWG

AmneziaWG profiles are regular `awg-quick` configuration files. Put exported
`.conf` files in `~/.config/omarchy/vpn/awg-profiles/`; the directory is created
automatically when the widget first checks for profiles, and the
**AmneziaWG profile directory** setting points it somewhere else. Each file
becomes a row on the AmneziaWG chip, named after its filename — for example,
`home.conf` appears as **home**.

`awg-quick`'s own directory, `/etc/amnezia/amneziawg/`, is read too where its
files are readable to you; they are normally root-only, so a tunnel started with
`sudo awg-quick up work` instead shows up as a row while it is running, marked
as started outside the widget. Its rows exist so you can take it down from the
panel — there is nothing to reconnect to once it is off.

Profiles normally contain a private key. The widget creates the directory with
owner-only access (`0700`), but does not change an existing profile's mode; keep
each `.conf` readable only by your user, for example with `chmod 600 *.conf`.

The chip appears only when `awg` and `awg-quick` are both installed and there is
at least one profile to show. Selecting a profile brings it up with `awg-quick`;
selecting another takes the first one down before bringing the new one up, so
the widget does not leave two AmneziaWG tunnels running.

### Profiles run by systemd

If a tunnel lives in `/etc/amnezia/amneziawg/` and you run it as
`awg-quick@<name>.service`, name it in the **AmneziaWG systemd profiles**
setting (`systemdProfiles`, comma separated, e.g. `"work, home"`). Those rows
show while the tunnel is down, even though the config there is unreadable to
you, and the widget drives them with `systemctl restart` / `systemctl stop`
instead of `awg-quick`, so the unit never reports a tunnel it no longer has.
systemctl asks polkit, which lets a rule scoped to the units connect without a
prompt:

```js
// /etc/polkit-1/rules.d/50-amneziawg-units.rules
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      /^awg-quick@[a-zA-Z0-9_=+.-]+\.service$/.test(action.lookup("unit")) &&
      ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0 &&
      subject.local && subject.active && subject.isInGroup("wheel")) {
    return polkit.Result.YES;
  }
});
```

Without a rule, the session's polkit agent asks for your password instead.

Bringing a profile up or down needs root privileges. The widget normally opens
a Polkit prompt through `pkexec`; with a `NOPASSWD` sudo rule for `awg-quick`,
it uses `sudo -n` instead and does not prompt.

For safety, profiles containing `PreUp`, `PostUp`, `PreDown`, or `PostDown`
hooks are shown as blocked and cannot be connected from the widget. Those
directives execute arbitrary commands as root through `awg-quick`; remove the
hooks or run a profile you trust directly from a terminal instead.

## NetworkManager profiles

<img src="preview-networkmanager.png" alt="The VPN panel on the NetworkManager chip, listing two OpenVPN profiles and one WireGuard profile" width="365">

OpenVPN, WireGuard, OpenConnect, VPNC and L2TP/IPsec profiles all come from
NetworkManager — the thing that imports and stores tunnel configs on a desktop.
They share one chip, and the row icon says which is which. Import one with:

```bash
nmcli connection import type openvpn file ~/Downloads/office.ovpn
nmcli connection import type wireguard file ~/Downloads/home.conf
```

NetworkManager runs on every desktop, so the chip appears only once you have a
profile it can actually carry — an OpenVPN one with `openvpn` installed, a
WireGuard one with `wireguard-tools`, an OpenConnect one with
`networkmanager-openconnect`, a VPNC one with `networkmanager-vpnc`, or an
L2TP/IPsec one with `networkmanager-l2tp`. Until then the panel names the tools
you do have and how to create a profile for them, rather than showing a chip
that leads to an empty list.

A tunnel you started some other way is not listed: a bare `openvpn` process,
`openvpn-client@.service`, or a `wg-quick@` unit. Neither is a tunnel another
tool on this list owns — Mullvad brings up its own WireGuard interface, and
NetworkManager adopts it, but that belongs on the Mullvad chip and appears only
there.

Picking a profile takes down whichever one is already up. NetworkManager is
happy to run two tunnels at once; that is never what clicking a second profile
means.

A freshly imported OpenVPN profile usually has no credentials saved, and there is no
password prompt running inside the Omarchy shell. To make a profile connect in
one click:

```bash
nmcli connection modify <name> +vpn.data username=<user>
nmcli connection modify <name> +vpn.data password-flags=0
nmcli connection modify <name> vpn.secrets 'password=<password>'
```

`password-flags=0` tells NetworkManager to own the password; imported profiles
usually arrive as `2` ("always ask"), which makes it ignore anything you saved.
The password then lives in `/etc/NetworkManager/system-connections/`, readable
by root only.

Without those, clicking a profile opens a terminal running
`nmcli --ask connection up …` so you can type the password there.

WireGuard needs none of this: its keys live in the profile. The one exception is
a profile whose `wireguard.private-key-flags` were set to ask an agent, which
lands in the same terminal.

VPNC profiles follow the OpenVPN credential path, but call their identity
`Xauth username` and carry both a user password and an IPSec group secret. Save
both secrets in the NetworkManager profile for a one-click connection; if the
user password is not saved, the panel opens `nmcli --ask` in a terminal.

L2TP/IPsec profiles work the same way, calling their identity `user` and
carrying a user password alongside the IPsec pre-shared key. An L2TP gateway is
usually handed out as a server, a username and a PSK rather than as a file, so
the profile is built field by field instead of imported:

```bash
nmcli connection add type vpn vpn-type l2tp con-name office \
  -- vpn.data "gateway = vpn.example.com, user = you, ipsec-enabled = yes"
```

If you are importing a Proton `.ovpn`: the username and password are the
**OpenVPN/IKEv2** credentials from your Proton dashboard, not your Proton
account login.

### OpenConnect

OpenConnect profiles need none of the above, and cannot use it: their
`cookie`, `gateway`, `gwcert` and `resolve` secrets are all flagged not-saved,
so there is nothing to pre-save and `nmcli --ask` cannot help — it would prompt
for a session cookie by name. Instead, picking the profile raises the auth
dialog that `networkmanager-openconnect` ships, which is the same window
nm-applet would have raised. Enter your password there, complete whatever second
factor the gateway asks for, and the tunnel comes up. Install
`networkmanager-openconnect` and the profile appears; nm-applet is not needed.

**Give the dialog a floating rule.** It is a small GTK window, and tiled it
lands as a ~240×270 tile among whatever else is on the workspace — which reads
as the widget having done nothing, while the panel sits on "Authenticating…"
and further clicks are ignored until that attempt finishes. In
`~/.config/hypr/hyprland.lua`:

```lua
o.window("^(nm-openconnect-auth-dialog)$", { float = true, center = true })
```

**Let the dialog remember your password.** Tick "Save passwords" in it. That
one setting does more than it looks like: `networkmanager-openconnect` also
gates keyring storage and form auto-submission on it, so with it off every page
of the form has to be clicked through by hand each time.

## Troubleshooting

**"No username set" on a profile.** NetworkManager keeps the OpenVPN username
outside the secrets store, so no password prompt can supply it. Set it with the
`nmcli connection modify … +vpn.data username=<user>` line above.

**The server rejects credentials that look right.** Check them against the
tool's own CLI first — for Proton, the OpenVPN credentials are not the account
password. `journalctl -u NetworkManager -f` shows `AUTH_FAILED` when the server
is the one saying no.

**Mullvad says the daemon is not responding.** The CLI is only a client. Start
the daemon with `sudo systemctl start mullvad-daemon` (and `enable` it to have it
come back after a reboot).

**Windscribe is installed but has no chip.** `windscribe-cli` is a client too.
The panel says which half is missing — start the Windscribe app, or
`windscribe-cli login` — and picks the chip up on the next refresh.

**Nothing appears in the bar.** Confirm the plugin is enabled with
`omarchy plugin list`, then `omarchy restart shell`.

**Proton and NetworkManager fight each other.** Proton's daemon tears down foreign
tunnels when it connects. The widget already shuts other tools down before
connecting, so use the widget rather than mixing it with the Proton app.

## Scripting

The widget answers on the shell's IPC bus, so keybindings and scripts can drive
it:

```bash
omarchy-shell davidboulay.vpn-switcher status       # "Proton VPN · CH#1129 · Zurich, Switzerland"
omarchy-shell davidboulay.vpn-switcher ip           # current public address
omarchy-shell davidboulay.vpn-switcher backends     # "proton mullvad windscribe warp networkmanager amneziawg"
omarchy-shell davidboulay.vpn-switcher use mullvad  # switch the panel's active tool
omarchy-shell davidboulay.vpn-switcher connect CH   # country code, region or profile name, or row key
omarchy-shell davidboulay.vpn-switcher quickconnect # each tool's default connection
omarchy-shell davidboulay.vpn-switcher disconnect
omarchy-shell davidboulay.vpn-switcher setup        # run the setup hint's command in a terminal
omarchy-shell davidboulay.vpn-switcher toggle       # open or close the panel
```

## Contributing

Adding support for another VPN tool means two files of its own and two lines in
the controller. [CONTRIBUTING.md](CONTRIBUTING.md) covers how to run, test and
debug the widget; [ARCHITECTURE.md](ARCHITECTURE.md) covers how it is put
together and why.

## License

MIT. See [LICENSE](LICENSE). Original work © Justin Köstinger
([omarchy-vpn](https://github.com/jkoestinger/omarchy-vpn)); extensions ©
David Boulay.
