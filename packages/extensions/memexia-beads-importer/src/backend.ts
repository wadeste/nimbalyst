/**
 * Memexia Beads importer — backend module.
 *
 * Runs in an Electron utility-process (outside main and the renderer). It does
 * the privileged work — spawning the user's `bb` CLI — and exposes the
 * `importer.*` RPC methods the host's TrackerImporterRegistry calls. The host
 * owns turning the returned snapshot into a tracker item.
 *
 * Workspace access and Dolt authentication are delegated entirely to `bb`
 * (which resolves the Dolt server from each workspace's `.beads/` metadata and
 * reads the password from `BEADS_DOLT_PASSWORD` in the environment). No
 * password is ever read, logged, or passed on argv here.
 *
 * A "binding" is one `bb` workspace directory (e.g. `~/mx/mx_brain`). Because
 * the importer contract's `fetch` receives only an `externalId` (no binding),
 * the externalId encodes both the workspace dir and the issue id.
 *
 * Method keys below MUST match TRACKER_IMPORTER_RPC_METHODS in the extension
 * SDK (`importer.isAuthenticated`, `importer.listBindings`, `importer.list`,
 * `importer.fetch`).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ImporterBinding,
  ImporterListEntry,
  ImporterListFilter,
  ImporterListPage,
  TrackerSnapshot,
} from '@nimbalyst/extension-sdk';

const PROVIDER_ID = 'memexia-beads';
const URN_SCHEME = 'beads';
const SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
/** Separator in externalId between workspace dir and issue id. `::` never
 *  appears in a bb id or an absolute path segment, so parsing is unambiguous. */
const EXTERNAL_ID_SEP = '::';

/** Minimal shape of the activate context the host bootstrap passes. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One row as emitted by `bb list --json` / one object from `bb show --json`. */
interface BeadRow {
  id?: string;
  issue_type?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number | string | null;
  assignee?: string | null;
  labels?: Array<string | { name?: string; label?: string }> | null;
  notes?: string | null;
  design?: string | null;
  acceptance?: string | null;
  acceptance_criteria?: string | null;
  source_url?: string | null;
  external_ref?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Common-install-location PATH for spawning CLIs. Electron's child-process PATH
 * on macOS/Linux GUI launches frequently omits ~/.local/bin (where `bb`
 * installs), /usr/local/bin, and /opt/homebrew/bin. Mirrors the github
 * importer's enhancedPath.
 */
function enhancedPath(): string {
  const current = process.env.PATH || '';
  const extra: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    extra.push(path.join(appData, 'npm'));
    extra.push(path.join(os.homedir(), '.local', 'bin'));
  } else {
    extra.push(path.join(os.homedir(), '.local', 'bin'));
    extra.push('/usr/local/bin');
    extra.push('/opt/homebrew/bin');
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  return [...extra, current].join(sep);
}

function bbCommand(): string {
  return process.env.NIMBALYST_BB_PATH || 'bb';
}

/**
 * Parse simple KEY=VALUE lines from an optional dotenv file into a map.
 *
 * GUI launches (Finder/Dock) don't inherit a shell environment, so a
 * Nimbalyst.app started that way won't have `BEADS_DOLT_PASSWORD` /
 * `DOLT_*` set — and `bb` would fail auth. This lets the user point the
 * importer at a credentials file (default `~/.config/nimbalyst-beads.env`)
 * without ever surfacing the secret to the renderer or the host. Values are
 * merged UNDER the real process env, so a genuinely-set env var always wins.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** The env `bb` runs with: process env + enhanced PATH + optional creds file. */
function bbEnv(): NodeJS.ProcessEnv {
  const fileEnv: Record<string, string> = {};
  const credsPath =
    process.env.NIMBALYST_BEADS_ENV_FILE ||
    path.join(os.homedir(), '.config', 'nimbalyst-beads.env');
  try {
    const text = fs.readFileSync(credsPath, 'utf-8');
    Object.assign(fileEnv, parseDotenv(text));
  } catch {
    // No creds file — fine when the env already carries BEADS_DOLT_PASSWORD.
  }
  // process.env wins over the file so an explicitly-set var is never shadowed.
  return { ...fileEnv, ...process.env, PATH: enhancedPath(), NO_COLOR: '1' };
}

function runProcess(cmd: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      timeout: SPAWN_TIMEOUT_MS,
      shell: false,
      cwd,
      env: bbEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: err.message }));
  });
}

/** Run `bb -C <workspaceDir> <args...>`. Workspace select mirrors `git -C`. */
async function bb(workspaceDir: string, args: string[]): Promise<SpawnResult> {
  return runProcess(bbCommand(), ['-C', workspaceDir, ...args], workspaceDir);
}

/**
 * `bb` prints deprecation warnings and permission hints to stdout before the
 * JSON payload in some environments. Slice from the first `[` or `{` so
 * JSON.parse doesn't choke on the preamble.
 */
export function extractJson(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return 'null';
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const candidates = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (candidates.length === 0) return trimmed;
  return trimmed.slice(Math.min(...candidates));
}

async function bbJson<T>(workspaceDir: string, args: string[]): Promise<T> {
  const res = await bb(workspaceDir, [...args, '--json', '--no-pager']);
  if (res.code !== 0) {
    // Never surface stdout/stderr verbatim — bb can echo the Dolt DSN. Keep the
    // exit code and the last stderr line, which is the actionable part.
    const lastLine = res.stderr.trim().split('\n').filter(Boolean).pop() || `exit ${res.code}`;
    throw new Error(`bb ${args[0] ?? ''} failed: ${lastLine}`);
  }
  return JSON.parse(extractJson(res.stdout) || 'null') as T;
}

// ---------------------------------------------------------------------------
// Binding discovery
// ---------------------------------------------------------------------------

/** Split a path-list env (`:`/`,` separated) into trimmed, non-empty entries. */
export function parseWorkspaceList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isBeadsWorkspace(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.beads')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve `bb` workspace dirs to offer as bindings. Precedence:
 *   1. NIMBALYST_BB_WORKSPACES — explicit `:`/`,`-separated list of dirs.
 *   2. MX_BEADS_PROJECT_DIR — a single explicit workspace dir.
 *   3. Scan NIMBALYST_MX_BEADS_ROOT (default `~/mx`) for immediate subdirs
 *      that contain a `.beads/` directory.
 * Only dirs that actually contain `.beads/` are returned.
 */
export function resolveWorkspaceDirs(env: NodeJS.ProcessEnv, homedir: string): string[] {
  const explicit = parseWorkspaceList(env.NIMBALYST_BB_WORKSPACES);
  if (explicit.length > 0) return explicit.filter(isBeadsWorkspace);

  if (env.MX_BEADS_PROJECT_DIR) {
    return [env.MX_BEADS_PROJECT_DIR].filter(isBeadsWorkspace);
  }

  const root = env.NIMBALYST_MX_BEADS_ROOT || path.join(homedir, 'mx');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(root, e.name))
    .filter(isBeadsWorkspace)
    .sort();
}

// ---------------------------------------------------------------------------
// externalId / URN
// ---------------------------------------------------------------------------

export function buildExternalId(workspaceDir: string, id: string): string {
  return `${workspaceDir}${EXTERNAL_ID_SEP}${id}`;
}

export function parseExternalId(externalId: string): { workspaceDir: string; id: string } {
  const sep = externalId.lastIndexOf(EXTERNAL_ID_SEP);
  if (sep < 0) throw new Error(`Invalid beads externalId: ${externalId}`);
  const workspaceDir = externalId.slice(0, sep);
  const id = externalId.slice(sep + EXTERNAL_ID_SEP.length);
  if (!workspaceDir || !id) throw new Error(`Invalid beads externalId: ${externalId}`);
  return { workspaceDir, id };
}

export function buildUrn(workspaceDir: string, id: string): string {
  return `${URN_SCHEME}://${path.basename(workspaceDir)}/${id}`;
}

// ---------------------------------------------------------------------------
// Field mapping (bb -> tracker)
// ---------------------------------------------------------------------------

/** bb stored statuses: open, in_progress, blocked, deferred, closed. */
export function mapStatus(raw: string | undefined): string {
  switch ((raw || '').toLowerCase()) {
    case 'open':
    case 'ready':
      return 'to-do';
    case 'in_progress':
    case 'in-progress':
      return 'in-progress';
    case 'blocked':
      return 'blocked';
    case 'deferred':
      return 'to-do';
    case 'closed':
    case 'done':
      return 'done';
    default:
      return raw || 'to-do';
  }
}

/** bb priority is 0-4 (0=highest) or a "P0".."P4" string. */
export function mapPriority(raw: number | string | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    const m = /^[pP]?([0-4])$/.exec(raw.trim());
    if (!m) return undefined;
    n = Number(m[1]);
  }
  switch (n) {
    case 0:
      return 'critical';
    case 1:
      return 'high';
    case 2:
      return 'medium';
    case 3:
    case 4:
      return 'low';
    default:
      return undefined;
  }
}

/** Constrain a bb issue_type to a tracker type the manifest declares. */
export function mapType(issueType: string | undefined, allowed: string[]): string {
  const t = (issueType || '').toLowerCase();
  const direct: Record<string, string> = {
    bug: 'bug',
    feature: 'feature',
    task: 'task',
    chore: 'task',
    epic: 'plan',
    goal: 'plan',
    plan: 'plan',
  };
  const mapped = direct[t] || 'task';
  return allowed.includes(mapped) ? mapped : allowed[0] || 'task';
}

export function normalizeLabels(
  labels: BeadRow['labels'],
): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l?.name || l?.label))
    .filter((n): n is string => Boolean(n));
}

/** Compose the tracker body markdown from a bead's rich fields. */
export function composeBody(row: BeadRow, urn: string): string {
  const sections: string[] = [];
  if (row.description) sections.push(row.description.trim());
  if (row.design) sections.push(`## Design\n\n${row.design.trim()}`);
  const acceptance = row.acceptance || row.acceptance_criteria;
  if (acceptance) sections.push(`## Acceptance\n\n${acceptance.trim()}`);
  if (row.notes) sections.push(`## Notes\n\n${row.notes.trim()}`);
  const kind = row.issue_type ? `, type \`${row.issue_type}\`` : '';
  sections.push(`---\n\n_Imported from memexia beads \`${row.id ?? ''}\` (\`${urn}\`)${kind}._`);
  return sections.join('\n\n');
}

/** Turn one bead row into an import snapshot for the host. */
export function rowToSnapshot(
  row: BeadRow,
  workspaceDir: string,
  allowedTypes: string[],
): TrackerSnapshot {
  const id = String(row.id ?? '');
  const urn = buildUrn(workspaceDir, id);
  const assignee = row.assignee || undefined;
  return {
    external: {
      providerId: PROVIDER_ID,
      externalId: buildExternalId(workspaceDir, id),
      urn,
      url: row.source_url || urn,
      titleSnapshot: row.title || id,
      stateSnapshot: row.status || undefined,
    },
    primaryType: mapType(row.issue_type, allowedTypes),
    title: row.title || id,
    body: composeBody(row, urn),
    status: mapStatus(row.status),
    priority: mapPriority(row.priority),
    labels: normalizeLabels(row.labels),
    authorIdentity: assignee
      ? { email: assignee.includes('@') ? assignee : null, displayName: assignee, gitName: assignee }
      : null,
    upstreamCreatedAt: row.created_at || undefined,
    upstreamUpdatedAt: row.updated_at || undefined,
  };
}

/** Map an importer state filter to `bb list` status args. */
export function stateToListArgs(state: ImporterListFilter['state']): string[] {
  switch (state) {
    case 'closed':
      return ['--status', 'closed'];
    case 'all':
      return ['--all'];
    case 'open':
    default:
      // bb's default filter already excludes closed; be explicit about the
      // open-ish lane so deferred/blocked show too.
      return ['--status', 'open,in_progress,blocked,deferred'];
  }
}

// Every bead imports as the dedicated `bead` tracker type (declared in the
// manifest's importsAs). The bead's original bb issue_type is preserved in the
// body footer rather than fanning out across task/plan/bug/feature.
const ALLOWED_TYPES = ['bead'];

export function activate(ctx: ActivateCtx) {
  const { log } = ctx.services;

  return {
    methods: {
      'importer.isAuthenticated': async (): Promise<boolean> => {
        // Authenticated == at least one bb workspace reachable with valid Dolt
        // creds. Probe the first binding with a cheap listing; rc 0 == good.
        const dirs = resolveWorkspaceDirs(process.env, os.homedir());
        if (dirs.length === 0) return false;
        const res = await bb(dirs[0], ['list', '--limit', '1', '--json', '--no-pager']);
        return res.code === 0;
      },

      'importer.listBindings': async (): Promise<ImporterBinding[]> => {
        const dirs = resolveWorkspaceDirs(process.env, os.homedir());
        log('debug', `memexia-beads: ${dirs.length} workspace binding(s)`);
        return dirs.map((dir) => ({ id: dir, label: path.basename(dir) }));
      },

      'importer.list': async (params: {
        binding: ImporterBinding;
        filters: ImporterListFilter;
      }): Promise<ImporterListPage> => {
        const workspaceDir = params.binding.id;
        const filters = params.filters ?? {};
        const limit = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const args = [
          'list',
          ...stateToListArgs(filters.state),
          '--sort',
          'updated',
          '--limit',
          String(limit),
        ];
        if (filters.labels && filters.labels.length > 0) {
          args.push('--label-any', filters.labels.join(','));
        }
        const rows = (await bbJson<BeadRow[]>(workspaceDir, args)) || [];
        let entries: ImporterListEntry[] = rows.map((row) => {
          const id = String(row.id ?? '');
          const urn = buildUrn(workspaceDir, id);
          return {
            externalId: buildExternalId(workspaceDir, id),
            urn,
            url: row.source_url || urn,
            title: row.title || id,
            state: row.status || 'open',
            updatedAt: row.updated_at || row.created_at || '',
          };
        });
        if (filters.search) {
          const needle = filters.search.toLowerCase();
          entries = entries.filter(
            (e) => e.title.toLowerCase().includes(needle) || e.externalId.toLowerCase().includes(needle),
          );
        }
        // bb `--offset` is only honoured under --proxied-server, so v1 returns a
        // single page (no cursor). The `limit` bound is applied server-side.
        return { items: entries };
      },

      'importer.fetch': async (params: { externalId: string }): Promise<TrackerSnapshot> => {
        const { workspaceDir, id } = parseExternalId(params.externalId);
        const payload = await bbJson<BeadRow | BeadRow[]>(workspaceDir, ['show', id]);
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (!row) throw new Error(`Bead ${id} not found in ${path.basename(workspaceDir)}`);
        return rowToSnapshot(row, workspaceDir, ALLOWED_TYPES);
      },
    },
  };
}
