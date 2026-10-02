import { describe, expect, it } from 'vitest';
import { mergeStudyIndex, validateStudyImport } from '../../gui/scripts/study-import-lib.mjs';
import { countStudyScorecards } from '../../gui/src/data.js';

describe('study import helpers', () => {
  it('counts actual scorecards once across criteria, including quoted CSV fields', () => {
    const csv = 'runId,scenarioId,candidateRef,judgeRef,criterion,score\r\n'
      + 'run-a,"scenario, one",model-a,judge-a,"clarity\nwith detail",7\r\n'
      + 'run-a,"scenario, one",model-a,judge-a,"a ""quote""",8\r\n'
      + 'run-a,"scenario, one",model-a,judge-b,clarity,6\r\n'
      + 'run-b,scenario-two,model-a,judge-a,clarity,9';
    expect(countStudyScorecards(csv)).toBe(3);
    expect(countStudyScorecards('runId,scenarioId,candidateRef,judgeRef\n')).toBe(0);
    expect(() => countStudyScorecards('<html>missing</html>')).toThrow();
    expect(() => countStudyScorecards('"unfinished')).toThrow();
  });
  it('keeps runs and unrelated metadata while adding a study without mutation', () => {
    const index = { runs: ['run-b', 'run-a'], studies: ['older'], note: 'keep' };
    expect(mergeStudyIndex(index, 'new-study')).toEqual({ ...index, studies: ['new-study', 'older'] });
    expect(index.studies).toEqual(['older']);
  });

  it('adds a study only once, even on repeated imports', () => {
    const index = { runs: ['run-a'], studies: ['older', 'example', 'example'] };
    const merged = mergeStudyIndex(index, 'example');
    expect(merged.studies).toEqual(['example', 'older']);
    expect(mergeStudyIndex(merged, 'example')).toEqual(merged);
  });

  it('supports a first import and an existing run-only index', () => {
    expect(mergeStudyIndex({}, 'example')).toEqual({ runs: [], studies: ['example'] });
    expect(mergeStudyIndex({ runs: ['run-a'] }, 'example')).toEqual({ runs: ['run-a'], studies: ['example'] });
  });

  it('accepts only matching study identities and safe batch run ids', () => {
    expect(validateStudyImport('example', { study: { id: 'example' }, meta: { runIds: ['run-study-example-1-1'] } })).toEqual(['run-study-example-1-1']);
    for (const id of ['../example', 'a/b', 'C:\\study', '']) {
      expect(() => validateStudyImport(id, {})).toThrow('study');
    }
    expect(() => validateStudyImport('example', { study: { id: 'different' } })).toThrow('match');
    for (const runIds of [undefined, ['../run-a'], ['run-a', 'run-a'], ['C:\\run-a']]) {
      expect(() => validateStudyImport('example', { study: { id: 'example' }, meta: { runIds } })).toThrow('runIds');
    }
  });
});
