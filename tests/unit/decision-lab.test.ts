import { describe, expect, it } from "vitest";
import {
  buildReport,
  criterionAverage,
  disagreementCount,
  weightedRanking,
} from "../../gui/src/analysis";
import type { LeaderboardEntry, RunManifest } from "../../gui/src/types";

const candidate = (
  name: string,
  accuracy: number,
  creativity: number,
): LeaderboardEntry => ({
  modelId: name,
  modelName: name,
  tier: "test",
  overallAverage: 7,
  scenarioScores: [
    {
      scenarioId: "one",
      scenarioName: "One",
      average: 7,
      flags: [],
      ruleErrors: [],
      scores: {
        accuracy: { score: accuracy, confidence: "high", outliers: [] },
        creativity: {
          score: creativity,
          confidence: "medium",
          outliers: ["Judge dissent"],
        },
      },
    },
  ],
});
const entries = [candidate("Precise", 9, 5), candidate("Creative", 6, 10)];

describe("exploratory weighting", () => {
  it("changes the leading candidate when the priorities change", () => {
    const precise = weightedRanking(entries, { accuracy: 5, creativity: 1 });
    const creative = weightedRanking(entries, { accuracy: 1, creativity: 5 });
    expect(precise[0].entry.modelName).toBe("Precise");
    expect(precise[0].score).toBeCloseTo(50 / 6);
    expect(creative[0].entry.modelName).toBe("Creative");
    expect(creative[0].score).toBeCloseTo(56 / 6);
    expect(entries.map((entry) => entry.overallAverage)).toEqual([7, 7]);
  });
  it("leaves every model unranked when all criteria are excluded", () => {
    expect(
      weightedRanking(entries, { accuracy: 0, creativity: 0 }).map(
        (item) => item.score,
      ),
    ).toEqual([null, null]);
  });
  it("does not turn missing evidence into zero or silently renormalize it", () => {
    const incomplete = structuredClone(entries[0]);
    delete incomplete.scenarioScores[0].scores.accuracy;
    expect(criterionAverage(incomplete, "accuracy")).toBeNull();
    expect(
      weightedRanking([incomplete], { accuracy: 5, creativity: 1 })[0].score,
    ).toBeNull();
    expect(
      weightedRanking([incomplete], { accuracy: 0, creativity: 1 })[0].score,
    ).toBe(5);
  });
  it("requires evidence in every scenario for an active criterion", () => {
    const multiple = structuredClone(entries[0]);
    multiple.scenarioScores.push({
      ...structuredClone(multiple.scenarioScores[0]),
      scenarioId: "two",
      scores: {},
    });
    expect(criterionAverage(multiple, "accuracy")).toBeNull();
  });
  it("keeps ties stable and ignores invalid weights", () => {
    const tied = weightedRanking([candidate("A", 8, 8), candidate("B", 8, 8)], {
      accuracy: 1,
      creativity: -1,
      invalid: NaN,
    });
    expect(tied.map((item) => item.score)).toEqual([8, 8]);
    expect(tied.map((item) => item.entry.modelName)).toEqual(["A", "B"]);
  });
  it("counts dissent by candidate and criterion, without double-counting contested scores", () => {
    const entry = structuredClone(entries[0]);
    entry.scenarioScores[0].scores.creativity.confidence = "contested";
    expect(disagreementCount(entry)).toBe(1);
  });
  it("exports provenance, dissent and exploratory scores separately from recorded scores", () => {
    const run: RunManifest = {
      runId: "run-test",
      plugin: "test",
      createdAt: "2026-09-16",
      candidates: [],
      scenarios: [],
      judges: [{ name: "Rules", role: "rules", model: "judge/model" }],
      synthesizer: { model: "arbiter/model" },
    };
    const report = buildReport(run, entries, { accuracy: 5, creativity: 1 });
    expect(report).toContain("## Recorded ranking");
    expect(report).toContain("## Exploratory weighting");
    expect(report).toContain("Precise: 8.33");
    expect(report).toContain("Judge dissent");
    expect(report).toContain("judge/model");
    expect(report).toContain("run-test");
    expect(report).toContain(
      "Small samples do not establish statistical significance",
    );
  });
});
