/**
 * Memexia Beads Importer — renderer entry.
 *
 * This importer has no renderer surface in v1: workspace access and Dolt auth
 * are handled by the user's `bb` CLI, and the import targets (bindings) are
 * derived from the `bb` workspaces on disk. All behaviour lives in the backend
 * module (see src/backend.ts). The manifest still requires a `main`, so this is
 * an inert module.
 */
export {};
