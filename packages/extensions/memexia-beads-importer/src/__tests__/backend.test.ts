import { describe, it, expect } from 'vitest';
import {
  buildExternalId,
  parseExternalId,
  buildUrn,
  mapStatus,
  mapPriority,
  mapType,
  normalizeLabels,
  composeBody,
  parseWorkspaceList,
  stateToListArgs,
  extractJson,
  parseDotenv,
  rowToSnapshot,
} from '../backend';

const ALLOWED = ['task', 'plan', 'bug', 'feature'];

describe('externalId <-> workspace/id round-trip', () => {
  it('builds and parses consistently (absolute posix path)', () => {
    const ext = buildExternalId('/home/steven/mx/mx_brain', 'mx-123');
    expect(ext).toBe('/home/steven/mx/mx_brain::mx-123');
    expect(parseExternalId(ext)).toEqual({ workspaceDir: '/home/steven/mx/mx_brain', id: 'mx-123' });
  });

  it('uses the LAST separator so ids containing colons survive', () => {
    const ext = buildExternalId('/home/steven/mx/mx_brain', 'bb-9');
    expect(parseExternalId(ext).id).toBe('bb-9');
  });

  it('rejects malformed external ids', () => {
    expect(() => parseExternalId('no-separator')).toThrow();
    expect(() => parseExternalId('::mx-1')).toThrow();
    expect(() => parseExternalId('/dir::')).toThrow();
  });
});

describe('buildUrn', () => {
  it('uses the workspace basename as the urn host', () => {
    expect(buildUrn('/home/steven/mx/mx_brain', 'mx-123')).toBe('beads://mx_brain/mx-123');
  });
});

describe('mapStatus', () => {
  it('maps bb stored statuses to tracker statuses', () => {
    expect(mapStatus('open')).toBe('to-do');
    expect(mapStatus('in_progress')).toBe('in-progress');
    expect(mapStatus('blocked')).toBe('blocked');
    expect(mapStatus('deferred')).toBe('to-do');
    expect(mapStatus('closed')).toBe('done');
  });
  it('passes unknown statuses through, defaulting empty to to-do', () => {
    expect(mapStatus('triage')).toBe('triage');
    expect(mapStatus(undefined)).toBe('to-do');
  });
});

describe('mapPriority', () => {
  it('maps numeric bb priority (0=highest)', () => {
    expect(mapPriority(0)).toBe('critical');
    expect(mapPriority(1)).toBe('high');
    expect(mapPriority(2)).toBe('medium');
    expect(mapPriority(3)).toBe('low');
    expect(mapPriority(4)).toBe('low');
  });
  it('maps P0..P4 string forms', () => {
    expect(mapPriority('P0')).toBe('critical');
    expect(mapPriority('p1')).toBe('high');
    expect(mapPriority('2')).toBe('medium');
  });
  it('returns undefined for missing/invalid', () => {
    expect(mapPriority(null)).toBeUndefined();
    expect(mapPriority(undefined)).toBeUndefined();
    expect(mapPriority('')).toBeUndefined();
    expect(mapPriority('urgent')).toBeUndefined();
  });
});

describe('mapType', () => {
  it('maps bb issue types to allowed tracker types', () => {
    expect(mapType('bug', ALLOWED)).toBe('bug');
    expect(mapType('feature', ALLOWED)).toBe('feature');
    expect(mapType('task', ALLOWED)).toBe('task');
    expect(mapType('epic', ALLOWED)).toBe('plan');
    expect(mapType('goal', ALLOWED)).toBe('plan');
  });
  it('falls back to task for unknown types', () => {
    expect(mapType('reference', ALLOWED)).toBe('task');
    expect(mapType(undefined, ALLOWED)).toBe('task');
  });
  it('falls back to the first allowed type when mapped type is not allowed', () => {
    expect(mapType('epic', ['task', 'bug'])).toBe('task');
  });
});

describe('single-type import (bead config)', () => {
  it('maps every bb issue_type to the sole `bead` type', () => {
    for (const t of ['task', 'bug', 'feature', 'epic', 'goal', 'reference', 'fact', undefined]) {
      expect(mapType(t as string | undefined, ['bead'])).toBe('bead');
    }
  });
});

describe('normalizeLabels', () => {
  it('accepts string arrays and object arrays', () => {
    expect(normalizeLabels(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeLabels([{ name: 'x' }, { label: 'y' }])).toEqual(['x', 'y']);
    expect(normalizeLabels(null)).toEqual([]);
    expect(normalizeLabels(undefined)).toEqual([]);
  });
});

describe('composeBody', () => {
  it('includes only present sections and a provenance footer', () => {
    const body = composeBody(
      { id: 'mx-1', description: 'desc', design: 'the design', notes: 'a note' },
      'beads://mx_brain/mx-1',
    );
    expect(body).toContain('desc');
    expect(body).toContain('## Design');
    expect(body).toContain('the design');
    expect(body).toContain('## Notes');
    expect(body).toContain('Imported from memexia beads `mx-1`');
    expect(body).not.toContain('## Acceptance');
  });
  it('prefers acceptance over acceptance_criteria', () => {
    const body = composeBody({ id: 'x', acceptance: 'AC-A', acceptance_criteria: 'AC-B' }, 'beads://w/x');
    expect(body).toContain('AC-A');
    expect(body).not.toContain('AC-B');
  });
});

describe('parseWorkspaceList', () => {
  it('splits on colon and comma, trims, drops empties', () => {
    expect(parseWorkspaceList('/a/b:/c/d')).toEqual(['/a/b', '/c/d']);
    expect(parseWorkspaceList('/a , /b ,')).toEqual(['/a', '/b']);
    expect(parseWorkspaceList(undefined)).toEqual([]);
    expect(parseWorkspaceList('')).toEqual([]);
  });
});

describe('stateToListArgs', () => {
  it('maps importer states to bb list args', () => {
    expect(stateToListArgs('closed')).toEqual(['--status', 'closed']);
    expect(stateToListArgs('all')).toEqual(['--all']);
    expect(stateToListArgs('open')).toEqual(['--status', 'open,in_progress,blocked,deferred']);
    expect(stateToListArgs(undefined)).toEqual(['--status', 'open,in_progress,blocked,deferred']);
  });
});

describe('extractJson', () => {
  it('strips a warning preamble before the JSON payload', () => {
    expect(extractJson('Warning: foo\n[{"id":"x"}]')).toBe('[{"id":"x"}]');
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
    expect(extractJson('')).toBe('null');
  });
});

describe('parseDotenv', () => {
  it('parses KEY=VALUE, ignores comments/blanks, strips quotes', () => {
    const env = parseDotenv('# comment\nA=1\nB="two"\n\nC=\'three\'\nBAD\n=x');
    expect(env).toEqual({ A: '1', B: 'two', C: 'three' });
  });
});

describe('rowToSnapshot', () => {
  it('produces a well-formed snapshot with provenance', () => {
    const snap = rowToSnapshot(
      {
        id: 'mx-42',
        issue_type: 'bug',
        title: 'A bug',
        description: 'body',
        status: 'in_progress',
        priority: 1,
        assignee: 'steven@digiital.agency',
        labels: ['agent:work'],
        updated_at: '2026-07-13T00:00:00Z',
      },
      '/home/steven/mx/mx_brain',
      ['bead'],
    );
    expect(snap.external.providerId).toBe('memexia-beads');
    expect(snap.external.externalId).toBe('/home/steven/mx/mx_brain::mx-42');
    expect(snap.external.urn).toBe('beads://mx_brain/mx-42');
    expect(snap.primaryType).toBe('bead');
    expect(snap.status).toBe('in-progress');
    expect(snap.priority).toBe('high');
    expect(snap.labels).toEqual(['agent:work']);
    expect(snap.authorIdentity?.email).toBe('steven@digiital.agency');
    expect(snap.title).toBe('A bug');
    // Original bb kind is preserved in the body footer, not the primaryType.
    expect(snap.body).toContain('type `bug`');
  });
});
