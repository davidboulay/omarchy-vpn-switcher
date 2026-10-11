An Omarchy bar widget (Quickshell/QML plugin) that switches between installed
VPN tools from one bar icon.

## Read before editing

- **Backend `.qml`, `VpnController.qml`, `Panel.qml`, or `model/`**: read
  [The backend contract](ARCHITECTURE.md#the-backend-contract) and the
  [Design notes](ARCHITECTURE.md#design-notes) for the tool you touch. Several
  contract rules exist because a bug shipped once.
- **Adding a VPN tool**: [Adding a backend](ARCHITECTURE.md#adding-a-backend).
  If it needs edits to `Panel.qml` or `model/Shared.js`, change the contract
  instead.
- **Seeing QML errors at runtime**: [Working on it](ARCHITECTURE.md#working-on-it).
- **Commits, branches, pull requests**: [CONTRIBUTING.md](CONTRIBUTING.md#commits).

## Commands

```bash
node tests/run.js                    # the whole suite; CI runs exactly this
omarchy plugin validate .            # after touching manifest.json
omarchy restart shell                # after touching model/ — .pragma library scripts stay cached; QML hot-reloads
```

One test file (a bare `node tests/model/x.test.js` prints nothing; `report()`
fires only from `run.js`):

```bash
node -e 'const h=require("./tests/harness.js"); require("./tests/model/mullvad.test.js"); process.exit(h.report())'
```

Lint one QML file per invocation, from the parent directory (run inside the
plugin directory, `Panel.qml` resolves to itself and exits 255 silently):

```bash
cd .. && qmllint -I /usr/share/omarchy/shell davidboulay.vpn-switcher/MullvadBackend.qml
```

## Rules

- **Decisions live in `model/`**, the only tested half; `.qml` files hold
  `Process` plumbing and bindings.
- **`model/*.js` are QML `.pragma library` scripts**: `var` and `function`
  declarations, pure functions of their arguments, one import
  (`.import "Shared.js" as Shared`), each tool's model self-contained. Test files
  are plain node with modern syntax.
- **Nerd Font glyphs use `String.fromCodePoint`**; editing tools mangle pasted
  multi-byte literals.
- **Comments record why**, at length where the code can't recover it; a
  workaround writes down what the CLI actually does.
- **A fixed parser gets the case that broke it**, real CLI output pasted
  verbatim.
- **Pull requests target `main`.** A release bumps the `manifest.json` version
  and adds its `CHANGELOG.md` section in the same commit.

## Agent skills

- **Issue tracker**: GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.
- **Triage labels**: the five defaults. See `docs/agents/triage-labels.md`.
- **Domain docs**: single-context. See `docs/agents/domain.md`.
