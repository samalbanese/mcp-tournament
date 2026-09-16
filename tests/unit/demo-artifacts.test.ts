import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadJudges,
  loadLeaderboard,
  loadRun,
  loadSynthesis,
  loadTurns,
} from "../../gui/src/data";

const publicRoot = path.resolve("gui/public");
const index = JSON.parse(
  await readFile(path.join(publicRoot, "data/index.json"), "utf8"),
) as { runs: string[] };
afterEach(() => vi.unstubAllGlobals());

it.each(index.runs)(
  "loads every evidence record in the shipped demo %s",
  async (runId) => {
    vi.stubGlobal("fetch", async (url: string) => {
      const filename = path.resolve(publicRoot, url);
      if (!filename.startsWith(publicRoot + path.sep))
        throw new Error("Unexpected fixture path");
      try {
        return new Response(await readFile(filename, "utf8"), { status: 200 });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    const run = await loadRun(runId);
    const entries = await loadLeaderboard(runId);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      for (const scenario of entry.scenarioScores) {
        const args = [
          runId,
          entry.modelId,
          scenario.scenarioId,
          scenario.scenarioName,
        ] as const;
        const turns = await loadTurns(...args);
        expect(
          turns.some(
            (turn) => turn.role === "candidate" && turn.content.length > 0,
          ),
        ).toBe(true);
        expect(
          (await loadSynthesis(...args)).assessment.length,
        ).toBeGreaterThan(0);
        const judges = await loadJudges(
          ...args,
          run.judges.map((judge) => judge.role),
        );
        // This original D&D recording shipped without two rules-judge files.
        // Keep the known partial archive explicit; don't invent replacement scores.
        const knownMissing =
          runId === "run-2026-07-18-004130" &&
          ["google/gemini-2.5-flash-lite", "meta-llama/llama-4-scout"].includes(
            entry.modelId,
          )
            ? ["rules"]
            : [];
        expect(
          run.judges
            .filter(
              (judge) => !judges.some((record) => record.role === judge.role),
            )
            .map((judge) => judge.role),
        ).toEqual(knownMissing);
      }
    }
  },
);
