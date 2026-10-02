export function mergeStudyIndex(index, studyId) {
  return { ...index, runs: index.runs ?? [], studies: [...new Set([studyId, ...(index.studies ?? [])])] };
}

export function validateStudyImport(studyId, document) {
  if (!/^[a-z0-9-]{3,40}$/.test(studyId)) throw new Error('Invalid study id. Use 3 to 40 lowercase letters, numbers, or hyphens.');
  if (document.study?.id !== studyId) throw new Error('The study id must match study.json.');
  const runIds = document.meta?.runIds;
  if (!Array.isArray(runIds) || runIds.some(id => typeof id !== 'string' || !/^run-[a-zA-Z0-9-]+$/.test(id))
    || new Set(runIds).size !== runIds.length) throw new Error('study.json meta.runIds must contain unique, safe run ids.');
  return runIds;
}
