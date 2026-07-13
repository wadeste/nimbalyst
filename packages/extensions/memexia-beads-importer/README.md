# Memexia Beads Importer Extension

Import [memexia beads](https://github.com/wadeste/memexia-beads) (`bb`) issues into the Nimbalyst tracker as **native tracker items** that link back to their source. Imported items behave like any other tracker item — they sync across your team, can be re-typed, commented on, and linked to sessions — while remembering the bead they came from so you can re-snapshot them when the upstream issue changes.

Workspace access and Dolt authentication go entirely through your installed `bb` CLI. No Dolt password is ever read, logged, or persisted by the extension, and it is never passed on the command line.

> **Scope (v1): one-way pull.** This importer *reads* beads into Nimbalyst. Editing an imported item in Nimbalyst does **not** write back to `bb`. Use the host's **re-snapshot (⟳)** to pull upstream changes. Two-way sync would require the importer contract's optional write methods, which are not implemented here.

## How It Works

1. Have the [`bb` CLI](https://github.com/wadeste/memexia-beads) installed and your `bb` workspaces on disk (e.g. `~/mx/mx_brain`, `~/mx/mx_research_ai`).
2. From the tracker toolbar's **Import** menu, choose **Import from Memexia Beads** (or use the `tracker_import` AI tool).
3. On first use, Nimbalyst prompts you to enable the importer's backend module (it runs native code via `bb`). Approve it for the workspace.
4. The importer lists your `bb` workspaces as bindings; pick one, then pick which beads to import.
5. Each imported bead becomes a native tracker item with its body (description + design + acceptance + notes), labels, status, priority, assignee, and a source reference back to the bead.

## Bindings — which beads workspaces show up

A **binding** is one `bb` workspace directory. They are resolved in this precedence order:

1. **`NIMBALYST_BB_WORKSPACES`** — an explicit `:`- or `,`-separated list of workspace dirs.
2. **`MX_BEADS_PROJECT_DIR`** — a single explicit workspace dir.
3. **Scan `NIMBALYST_MX_BEADS_ROOT`** (default `~/mx`) for immediate subdirectories that contain a `.beads/` directory.

Only directories that actually contain a `.beads/` folder are offered. Each binding's label is the directory basename (`mx_brain`, `mx_research_ai`, …).

## Authentication & Access Model

- **No tokens stored.** The backend shells out to `bb`, which resolves the Dolt server from each workspace's `.beads/` metadata and reads the password from `BEADS_DOLT_PASSWORD` in the environment. The extension never reads or persists that value.
- **GUI-launch credentials.** Apps started from Finder/Dock don't inherit a shell environment, so `BEADS_DOLT_PASSWORD` / `DOLT_*` may be unset. Point the importer at a credentials file to supply them (see below). Values from the file are merged **under** the real environment, so an explicitly-set variable always wins.
- **Backend runs sandboxed.** The privileged work (spawning `bb`) happens in an Electron utility-process backend module, isolated from both the main process and the renderer, behind a first-use consent gate (see `enablement` in `manifest.json`).

## What Gets Imported

Each bead maps to a tracker snapshot:

| Tracker field | Beads source |
|---------------|--------------|
| `title` | bead `title` |
| `body` | `description` + `## Design` + `## Acceptance` + `## Notes` + a provenance footer |
| `status` | `open`→`to-do`, `in_progress`→`in-progress`, `blocked`→`blocked`, `deferred`→`to-do`, `closed`→`done` |
| `priority` | bb `0`→`critical`, `1`→`high`, `2`→`medium`, `3`/`4`→`low` (accepts `P0`..`P4` too) |
| `labels` | bead labels (e.g. `agent:work`) |
| `primaryType` | `bug`→bug, `feature`→feature, `epic`/`goal`→plan, everything else→task |
| author identity | bead `assignee` |
| `urn` | `beads://<workspace>/<id>` (e.g. `beads://mx_brain/mx-123`) |
| source URL | bead `source_url` if present, else the URN |
| upstream timestamps | `created_at` / `updated_at` |

`importsAs` in the manifest allows importing as `task`, `plan`, `bug`, or `feature`; the mapping above is the default, and you can re-type an item after import.

## Configuration

| Variable | Default | Effect |
|----------|---------|--------|
| `NIMBALYST_BB_PATH` | `bb` | Path to the `bb` binary |
| `NIMBALYST_BB_WORKSPACES` | — | Explicit `:`/`,`-separated list of workspace dirs (overrides discovery) |
| `MX_BEADS_PROJECT_DIR` | — | A single explicit workspace dir |
| `NIMBALYST_MX_BEADS_ROOT` | `~/mx` | Root scanned for `.beads/` workspaces |
| `NIMBALYST_BEADS_ENV_FILE` | `~/.config/nimbalyst-beads.env` | Optional `KEY=VALUE` file supplying `BEADS_DOLT_PASSWORD` / `DOLT_*` for GUI launches |

The backend augments `PATH` with common install locations (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, and Windows equivalents) because Electron's GUI-launch `PATH` often omits them.

### Example credentials file

```
# ~/.config/nimbalyst-beads.env
BEADS_DOLT_PASSWORD=…
DOLT_BEADS_HOST=100.93.163.114
DOLT_BEADS_PORT=3658
DOLT_BEADS_USER=beads
```

## Requirements

- The `bb` CLI (memexia beads) installed and on your `PATH` (or set `NIMBALYST_BB_PATH`).
- Network reachability to your Dolt server (e.g. over Tailscale) and valid `BEADS_DOLT_PASSWORD`.
- At least one `bb` workspace on disk (a directory containing `.beads/`).

## RPC Methods

The backend module exposes the importer contract the host's `TrackerImporterRegistry` calls. Method keys match `TRACKER_IMPORTER_RPC_METHODS` in the extension SDK:

| Method | Purpose |
|--------|---------|
| `importer.isAuthenticated` | Probe the first workspace with `bb list --limit 1 --json` — reachable + authed? |
| `importer.listBindings` | Resolve `bb` workspace dirs (see Bindings) |
| `importer.list` | `bb -C <ws> list --json --sort updated` with state/label filters and client-side search |
| `importer.fetch` | `bb -C <ws> show <id> --json` → a `TrackerSnapshot` for import |

Because `fetch` receives only an `externalId` (no binding), the externalId encodes both the workspace dir and the bead id as `<workspaceDir>::<id>`.

## Building

This package is a monorepo citizen: it imports `@nimbalyst/extension-sdk`
(a workspace package whose types resolve from its built `dist/`) and its tests
import `vitest` (a root-level devDep). So `typecheck`/`test` only work once the
**monorepo is installed and the SDK is built** — running `npm install` inside
this subdirectory alone leaves the workspace unlinked and `tsc`/`vitest` unresolved
(the sibling `github-issues-importer` has the same requirement).

From the repo root:

```bash
# 1. Install the whole monorepo (links workspaces, hoists vitest/typescript).
#    ELECTRON_SKIP_BINARY_DOWNLOAD + --ignore-scripts skips the Electron binary
#    and native builds, which aren't needed just to build an extension.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts

# 2. Build the extension SDK so its dist/*.d.ts exists (this package resolves
#    @nimbalyst/extension-sdk via its package.json `types: dist/index.d.ts`).
npm run build --workspace @nimbalyst/extension-sdk

# 3. Typecheck, test, and build this extension.
cd packages/extensions/memexia-beads-importer
npm run typecheck
npx vitest run          # 20 tests over the pure mapping/parsing helpers
npm run build           # builds both the inert renderer entry and the backend module
```

`npm run build` runs two Vite passes:

- `vite build` — `src/index.ts` → `dist/index.js` (inert renderer `main`; the manifest requires one)
- `vite build --config vite.backend.config.ts` — `src/backend.ts` → `dist/backend.js` (the utility-process backend)

> Note: `vite build` alone tends to succeed even standalone (it externalises
> `@nimbalyst/*` and erases `import type`), but `npm run typecheck` and the tests
> need steps 1–2 above. Other scripts: `npm run dev` (watch build).

## Architecture

```
src/
  index.ts           # Inert renderer entry (no UI surface in v1; manifest requires a main)
  backend.ts         # Utility-process backend: bb spawning + importer.* RPC methods
  __tests__/
    backend.test.ts  # externalId/URN round-trips, status/priority/type mapping, snapshot shaping
manifest.json        # trackerImporters + backendModules contributions
vite.config.ts             # renderer entry build
vite.backend.config.ts     # backend module build
```

### Execution Flow

1. The host discovers the importer from the manifest and registers it (no backend started yet).
2. On first import, the host prompts for backend consent; once granted it persists for the workspace.
3. The host calls `importer.listBindings` → `bb` workspace dirs.
4. `importer.list` runs `bb -C <ws> list --json` for the chosen workspace (state filter, recently-updated sort).
5. The user selects beads; `importer.fetch` returns a `TrackerSnapshot` per bead via `bb show`.
6. The **host** turns each snapshot into a native tracker item (provenance in `data.origin.external`) and seeds the collaborative body Y.Doc.

## License

Part of Nimbalyst. Authored by Nimbalyst.
