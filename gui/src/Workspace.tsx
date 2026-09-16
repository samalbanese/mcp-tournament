import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  buildReport,
  criteriaFor,
  criterionAverage,
  criterionLabel,
  disagreementCount,
  weightedRanking,
} from "./analysis";
import { loadRun, loadSynthesis, loadTurns } from "./data";
import { humanizePlugin } from "./format";
import EvidenceText from "./EvidenceText";
import { href, type Route } from "./router";
import type { LeaderboardEntry, RunManifest, Synthesis, Turn } from "./types";

type IconName =
  | "grid"
  | "compare"
  | "sliders"
  | "play"
  | "arrow"
  | "download"
  | "book"
  | "plus"
  | "settings"
  | "code"
  | "check";
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    compare: (
      <>
        <path d="M9 3v18M15 3v18M3 7h6M3 17h6M15 7h6M15 17h6" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h7m6 0h3M4 17h3m6 0h7" />
        <circle cx="14" cy="7" r="3" />
        <circle cx="10" cy="17" r="3" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8Z" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    book: (
      <>
        <path d="M12 5v16M3 3c5-1 9 2 9 2s4-3 9-2v15c-5-1-9 3-9 3s-4-4-9-3Z" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function WorkspaceShell({
  children,
  runs,
  activeRun,
  route,
  appMode,
}: {
  children: ReactNode;
  runs: string[];
  activeRun?: string;
  route: Route;
  appMode: boolean;
}) {
  const [catalog, setCatalog] = useState<RunManifest[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled(runs.map(loadRun)).then((results) => {
      if (active)
        setCatalog(
          results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        );
    });
    return () => {
      active = false;
    };
  }, [runs]);
  const current = catalog.find((run) => run.runId === activeRun);
  const nav = [
    { view: "home", title: "Overview", icon: "grid" },
    { view: "compare", title: "Compare evidence", icon: "compare" },
    { view: "lab", title: "Decision lab", icon: "sliders" },
    { view: "replay", title: "Run replay", icon: "play" },
  ] as const;
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="workspace-sidebar">
        <a className="workspace-brand" href="#/">
          <span className="tournament-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            tournament
            <span className="brand-caption">MODEL EVALUATION STUDIO</span>
          </span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">S</span>
          <div>
            Personal workspace
            <small>{appMode ? "Local runner" : "Public demo collection"}</small>
          </div>
          <span className="workspace-badge">MCP</span>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav className="workspace-nav" aria-label="Workspace">
          {nav.map((item) => (
            <a
              key={item.view}
              href={href({ view: item.view, runId: activeRun })}
              aria-current={route.view === item.view ? "page" : undefined}
            >
              <Icon name={item.icon} />
              {item.title}
              {item.view === "lab" && <small>TRY IT</small>}
            </a>
          ))}
        </nav>
        <div className="nav-section-heading">
          <p className="nav-caption">EXPERIMENTS</p>
          <span>{runs.length.toString().padStart(2, "0")}</span>
        </div>
        <nav className="experiment-nav" aria-label="Experiments">
          {catalog.map((run) => (
            <a
              key={run.runId}
              href={href({ view: "home", runId: run.runId })}
              aria-current={activeRun === run.runId ? "true" : undefined}
            >
              <span className="experiment-dot" />
              <span>
                {humanizePlugin(run.plugin)}
                <small>
                  {run.candidates.length} model
                  {run.candidates.length === 1 ? "" : "s"} ·{" "}
                  {new Date(run.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </small>
              </span>
              <span className="experiment-arrow">↗</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a className="new-experiment" href={appMode ? "#/new" : "#/about"}>
            <Icon name="plus" />
            {appMode ? "New experiment" : "Run your own experiment"}
          </a>
          <p>
            Your scenarios. Your criteria.
            <br />A model choice you can explain.
          </p>
          <nav className="workspace-nav" aria-label="Resources">
            <a
              href="#/why"
              aria-current={route.view === "why" ? "page" : undefined}
            >
              <Icon name="book" />
              Methodology
            </a>
            {appMode && (
              <>
                <a href="#/build">
                  <Icon name="plus" />
                  Build a benchmark
                </a>
                <a href="#/settings">
                  <Icon name="settings" />
                  Settings
                </a>
              </>
            )}
            <a
              href="https://github.com/samalbanese/mcp-tournament"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="code" />
              View source <span className="external-arrow">↗</span>
            </a>
          </nav>
          <div className="local-status">
            <span />
            {appMode
              ? "Running on your machine"
              : "Recorded runs · No key needed"}
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-topbar">
          <div>
            <span>Experiments</span>
            <i>/</i>
            <b className="desktop-experiment-name">
              {current ? humanizePlugin(current.plugin) : "Evaluation studio"}
            </b>
            <select
              className="mobile-experiment-select"
              aria-label="Choose experiment"
              value={activeRun ?? ""}
              onChange={(event) => {
                location.hash = href({
                  view: "home",
                  runId: event.target.value,
                });
              }}
            >
              {catalog.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {humanizePlugin(run.plugin)} · {run.candidates.length} model
                  {run.candidates.length === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <span className="demo-status">
            <span />
            {appMode ? "LOCAL WORKSPACE" : "EXPLORE THE DEMO"}
          </span>
          <details className="mobile-workspace-menu">
            <summary aria-label="Workspace menu">
              <Icon name="settings" size={17} />
            </summary>
            <nav aria-label="More workspace options">
              <a href="#/why">Methodology</a>
              <a href="#/about">Run your own experiment</a>
              {appMode && (
                <>
                  <a href="#/new">New experiment</a>
                  <a href="#/build">Build a benchmark</a>
                  <a href="#/settings">Settings</a>
                </>
              )}
              <a
                href="https://github.com/samalbanese/mcp-tournament"
                target="_blank"
                rel="noreferrer"
              >
                View source ↗
              </a>
            </nav>
          </details>
        </header>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="workspace-footer">
          <span>
            MCP TOURNAMENT <i>/</i> Evidence over intuition.
          </span>
          <span>
            Local-first. Open source. Built by{" "}
            <a
              href="https://samalbanese.com/portfolio"
              target="_blank"
              rel="noreferrer"
            >
              Sam Albanese ↗
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

function ModelMark({
  entry,
  index,
}: {
  entry: LeaderboardEntry;
  index: number;
}) {
  return (
    <span className={`model-mark model-color-${index % 4}`} aria-hidden="true">
      {entry.modelId.startsWith("deepseek")
        ? "ds"
        : entry.modelId.startsWith("google")
          ? "✦"
          : entry.modelId.startsWith("meta")
            ? "∞"
            : entry.modelName.slice(0, 2)}
    </span>
  );
}

function ExportButton({
  run,
  entries,
  weights,
}: {
  run: RunManifest;
  entries: LeaderboardEntry[];
  weights?: Record<string, number>;
}) {
  const [downloaded, setDownloaded] = useState(false);
  function download() {
    const url = URL.createObjectURL(
      new Blob([buildReport(run, entries, weights)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${run.runId}${weights ? "-weighted" : ""}-report.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  }
  return (
    <button className="studio-button secondary" onClick={download}>
      <Icon name={downloaded ? "check" : "download"} size={15} />
      {downloaded ? "Report downloaded" : "Export report"}
    </button>
  );
}

export default function RunWorkspace({
  run,
  entries,
  view,
}: {
  run: RunManifest;
  entries: LeaderboardEntry[];
  view: "home" | "compare" | "lab";
}) {
  const criteria = criteriaFor(entries);
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(criteria.map((criterion) => [criterion, 1])),
  );
  if (!entries.length)
    return (
      <div className="studio-page">
        <h1>No completed candidates yet.</h1>
        <p>
          This run has no scores to compare. Choose another experiment or
          inspect the run locally.
        </p>
      </div>
    );
  const dissent = entries.reduce(
    (sum, entry) => sum + disagreementCount(entry),
    0,
  );
  const titles = {
    home: "Find your model advantage.",
    compare: "Put the evidence side by side.",
    lab: "Your priorities. Your ranking.",
  };
  return (
    <div className="studio-page reveal">
      <section className="studio-heading">
        <div>
          <p className="studio-eyebrow">
            <span /> BENCHMARK INTELLIGENCE{" "}
            <span className="heading-separator">/</span>{" "}
            {humanizePlugin(run.plugin).toUpperCase()}
          </p>
          <h1>{titles[view]}</h1>
          <p className="studio-description">
            {view === "home"
              ? "The right model depends on the work. Compare the answers, inspect the judges, and make a choice you can explain."
              : view === "compare"
                ? "One scenario. Independent answers. Inspect the original output and the reasoning behind each score."
                : "Give each criterion a weight and watch the tradeoffs change. Explore recorded results without running another model."}
          </p>
        </div>
        <ExportButton
          run={run}
          entries={entries}
          weights={view === "lab" ? weights : undefined}
        />
      </section>
      <div className="experiment-context">
        <span className="complete-badge">
          <Icon name="check" size={12} /> RECORDED RUN
        </span>
        <span>{run.scenarios[0]?.name ?? humanizePlugin(run.plugin)}</span>
        <time dateTime={run.createdAt}>
          {new Date(run.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })}
        </time>
      </div>
      <nav className="studio-tabs" aria-label="Experiment views">
        <a
          href={href({ view: "home", runId: run.runId })}
          aria-current={view === "home" ? "page" : undefined}
        >
          Results overview
        </a>
        <a
          href={href({ view: "compare", runId: run.runId })}
          aria-current={view === "compare" ? "page" : undefined}
        >
          Compare evidence
        </a>
        <a
          href={href({ view: "lab", runId: run.runId })}
          aria-current={view === "lab" ? "page" : undefined}
        >
          Decision lab <span>INTERACTIVE</span>
        </a>
        <a
          className="replay-tab"
          href={href({ view: "replay", runId: run.runId })}
        >
          <Icon name="play" size={12} /> Replay run
        </a>
      </nav>
      {view === "home" ? (
        <Overview
          run={run}
          entries={entries}
          criteria={criteria}
          dissent={dissent}
        />
      ) : view === "compare" ? (
        <CompareEvidence key={run.runId} run={run} entries={entries} />
      ) : (
        <DecisionLab
          key={run.runId}
          run={run}
          entries={entries}
          criteria={criteria}
          weights={weights}
          setWeights={setWeights}
        />
      )}
      <details className="methodology-note">
        <summary>
          How to read these results{" "}
          <span>Scenario-specific evidence, not a universal ranking</span>
          <Icon name="plus" size={14} />
        </summary>
        <p>
          Each candidate answers the same scenario. Judges evaluate
          independently; the synthesizer arbitrates their scores and preserves
          dissent. These recorded runs are small samples, with no statistical
          significance claim. AI judges can make mistakes, and some candidate
          and judge models overlap. Scores describe this experiment, not the
          best model for every task.
        </p>
        <p>
          Panel:{" "}
          {run.judges
            .map((judge) => `${judge.name} (${judge.model})`)
            .join(" · ")}
          . Synthesizer: {run.synthesizer.model}.
        </p>
        <code>{run.runId}</code>
      </details>
    </div>
  );
}

function Overview({
  run,
  entries,
  criteria,
  dissent,
}: {
  run: RunManifest;
  entries: LeaderboardEntry[];
  criteria: string[];
  dissent: number;
}) {
  const ordered = [...entries].sort(
    (a, b) => b.overallAverage - a.overallAverage,
  );
  const leader = ordered[0];
  const gap = ordered[1]
    ? leader.overallAverage - ordered[1].overallAverage
    : null;
  const flagged = entries
    .flatMap((entry) =>
      entry.scenarioScores.flatMap((scenario) =>
        Object.entries(scenario.scores)
          .filter(
            ([, score]) =>
              score.outliers.length || score.confidence === "contested",
          )
          .map(([criterion, score]) => ({ entry, scenario, criterion, score })),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.score.confidence === "contested") -
        Number(a.score.confidence === "contested"),
    );
  const insight = flagged[0];
  return (
    <>
      <div className="overview-metrics">
        <div>
          <span>CANDIDATE MODELS</span>
          <strong>{String(entries.length).padStart(2, "0")}</strong>
          <small>Same scenario, different approaches</small>
        </div>
        <div>
          <span>INDEPENDENT JUDGES</span>
          <strong>
            {String(run.judges.length).padStart(2, "0")}
            <i> + arbiter</i>
          </strong>
          <small>Separate perspectives, shared rubric</small>
        </div>
        <div>
          <span>EVALUATION CRITERIA</span>
          <strong>{String(criteria.length).padStart(2, "0")}</strong>
          <small>
            Across {run.scenarios.length} scenario
            {run.scenarios.length === 1 ? "" : "s"}
          </small>
        </div>
        <div>
          <span>CRITERIA WITH DISSENT</span>
          <strong className="dissent-value">
            {String(dissent).padStart(2, "0")}
            <span className="signal-bars" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </strong>
          <small>Disagreements kept in the record</small>
        </div>
      </div>
      <div className="overview-grid">
        <section className="ranking-panel">
          <div className="studio-section-head">
            <div>
              <p className="studio-kicker">THE RESULTS</p>
              <h2>Model leaderboard</h2>
            </div>
            <span className="muted-label">RECORDED SCORE / 10</span>
          </div>
          <div className="ranking-list">
            {ordered.map((entry, index) => (
              <a
                className={`ranking-row ${index === 0 ? "first-place" : ""}`}
                key={entry.modelId}
                href={href({
                  view: "model",
                  runId: run.runId,
                  modelId: entry.modelId,
                })}
              >
                <span className="position">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <ModelMark entry={entry} index={index} />
                <div className="ranking-name">
                  <h3>{entry.modelName}</h3>
                  <p>
                    {entry.modelId.split("/")[0]} <span>·</span>{" "}
                    {disagreementCount(entry)
                      ? `${disagreementCount(entry)} criteria with dissent`
                      : "No recorded dissent"}
                  </p>
                  <div className="ranking-track">
                    <span
                      className={`model-color-${index % 4}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, entry.overallAverage * 10))}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="ranking-score">
                  <b>{entry.overallAverage.toFixed(2)}</b>
                  <span>
                    {index === 0
                      ? gap === 0
                        ? "JOINT LEAD"
                        : entries.length === 1
                          ? "SINGLE MODEL"
                          : "TOP SCORE"
                      : "OVERALL"}
                  </span>
                </div>
                <Icon name="arrow" size={16} />
              </a>
            ))}
          </div>
          <div className="ranking-footnote">
            <span className="tiny-dot" />
            Scores preserved from the original run. Select a model to audit its
            scorecard.
          </div>
        </section>
        <aside className="finding-panel">
          <div className="finding-top">
            <span className="studio-kicker">THE TAKEAWAY</span>
            <span className="finding-icon">↗</span>
          </div>
          <span className="finding-label">
            {gap === 0
              ? "Joint highest score"
              : entries.length === 1
                ? "Evaluated candidate"
                : "Highest recorded score"}
          </span>
          <h2>{leader.modelName}</h2>
          <div className="finding-score">
            {leader.overallAverage.toFixed(2)}
            <span>/ 10</span>
          </div>
          <p>
            {gap === null
              ? "One candidate was evaluated. Add more models locally to establish a comparison."
              : gap === 0
                ? "The leaders are tied. Inspect their criterion scores to understand the tradeoffs."
                : `${gap.toFixed(2)} points ahead of the next candidate in this experiment. Inspect the evidence before choosing.`}
          </p>
          <a href={href({ view: "lab", runId: run.runId })}>
            Would your priorities change this?
            <Icon name="arrow" size={17} />
          </a>
          <div className="finding-decoration" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </aside>
      </div>
      <div className="analysis-grid">
        <section className="criteria-panel">
          <div className="studio-section-head">
            <div>
              <p className="studio-kicker">BEYOND THE AVERAGE</p>
              <h2>Where each model stands</h2>
            </div>
            <Icon name="sliders" />
          </div>
          <div className="criteria-table-wrap">
            <table className="criteria-table">
              <caption className="sr-only">
                Final criterion scores averaged across scenarios. A dash means
                incomplete data.
              </caption>
              <thead>
                <tr>
                  <th>CRITERION</th>
                  {ordered.map((entry, index) => (
                    <th key={entry.modelId}>
                      <span className={`legend-dot model-color-${index % 4}`} />
                      {entry.modelName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {criteria.map((criterion) => (
                  <tr key={criterion}>
                    <th>{criterionLabel(criterion)}</th>
                    {ordered.map((entry, index) => {
                      const score = criterionAverage(entry, criterion);
                      return (
                        <td key={entry.modelId}>
                          <div className="matrix-cell">
                            <span className="mini-track">
                              <i
                                className={`model-color-${index % 4}`}
                                style={{ width: `${(score ?? 0) * 10}%` }}
                              />
                            </span>
                            <b>{score?.toFixed(1) ?? "—"}</b>
                            {entry.scenarioScores.some(
                              (s) =>
                                s.scores[criterion]?.confidence === "contested",
                            ) && (
                              <span
                                className="contested-dot"
                                title="Contested by judges"
                                role="img"
                                aria-label="Contested by judges"
                              />
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="criteria-legend">
            <span>
              <i className="contested-dot" />
              Contested score
            </span>
            <span>Arbitrated criteria · 0–10 scale</span>
          </div>
        </section>
        <section className="dissent-panel">
          <div className="studio-section-head">
            <div>
              <p className="studio-kicker">DISAGREEMENT IS DATA</p>
              <h2>
                {insight
                  ? "A closer look at the dissent"
                  : "A panel in agreement"}
              </h2>
            </div>
            <span className="dissent-symbol">≠</span>
          </div>
          {insight ? (
            <>
              <div className="dissent-tag">
                {insight.score.confidence === "contested"
                  ? "CONTESTED"
                  : "JUDGE DISSENT"}
                <span>{criterionLabel(insight.criterion)}</span>
              </div>
              <p className="dissent-model">{insight.entry.modelName}</p>
              <blockquote>
                {insight.score.outliers[0] ??
                  "The synthesizer marked this criterion as contested. Open the judge panel to inspect the individual scores."}
              </blockquote>
              <a
                className="studio-text-link"
                href={href({
                  view: "judges",
                  runId: run.runId,
                  modelId: insight.entry.modelId,
                  scenarioId: insight.scenario.scenarioId,
                })}
              >
                Inspect judge evidence <Icon name="arrow" size={15} />
              </a>
            </>
          ) : (
            <p>
              No dissent was recorded for these criteria. Agreement among AI
              judges is useful evidence, but it does not establish correctness.
            </p>
          )}
        </section>
      </div>
      <section className="pipeline-strip" aria-label="Evaluation process">
        <span>
          ONE QUESTION.
          <br />
          <b>FOUR ACCOUNTABLE STAGES.</b>
        </span>
        {[
          { n: "01", title: "Execute", detail: "Capture every answer" },
          { n: "02", title: "Judge", detail: "Independent perspectives" },
          { n: "03", title: "Arbitrate", detail: "Preserve the disagreement" },
          { n: "04", title: "Decide", detail: "Follow the evidence" },
        ].map((step) => (
          <div key={step.n}>
            <span>{step.n}</span>
            <div>
              <b>{step.title}</b>
              <small>{step.detail}</small>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function DecisionLab({
  run,
  entries,
  criteria,
  weights,
  setWeights,
}: {
  run: RunManifest;
  entries: LeaderboardEntry[];
  criteria: string[];
  weights: Record<string, number>;
  setWeights: (weights: Record<string, number>) => void;
}) {
  const ranking = useMemo(
    () => weightedRanking(entries, weights),
    [entries, weights],
  );
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const max = ranking[0]?.score;
  const leaders = ranking.filter(
    (item) =>
      item.score !== null &&
      max !== null &&
      Math.abs(item.score! - max!) < 0.00001,
  );
  return (
    <div className="lab-grid">
      <section className="weight-panel">
        <p className="studio-kicker">DEFINE WHAT GOOD MEANS</p>
        <h2>What matters to you?</h2>
        <p>
          Move the sliders to change the relative importance of each criterion.
          Zero excludes a criterion.
        </p>
        <div className="weight-presets">
          <button
            onClick={() =>
              setWeights(Object.fromEntries(criteria.map((c) => [c, 1])))
            }
          >
            Equal weights
          </button>
          {criteria.map((criterion) => (
            <button
              key={criterion}
              onClick={() =>
                setWeights(
                  Object.fromEntries(
                    criteria.map((c) => [c, c === criterion ? 5 : 1]),
                  ),
                )
              }
            >
              {criterionLabel(criterion)} first
            </button>
          ))}
        </div>
        {criteria.map((criterion) => (
          <div className="weight-control" key={criterion}>
            <label htmlFor={`weight-${criterion}`}>
              {criterionLabel(criterion)}
              <output>
                {total ? Math.round((weights[criterion] / total) * 100) : 0}%
              </output>
            </label>
            <input
              id={`weight-${criterion}`}
              type="range"
              min="0"
              max="5"
              step="1"
              value={weights[criterion]}
              aria-valuetext={`${weights[criterion]} of 5, ${total ? Math.round((weights[criterion] / total) * 100) : 0} percent of total weight`}
              onChange={(event) =>
                setWeights({
                  ...weights,
                  [criterion]: Number(event.target.value),
                })
              }
            />
            <div>
              <span>Excluded</span>
              <span>Essential</span>
            </div>
          </div>
        ))}
        <div className="lab-formula">
          <Icon name="sliders" size={17} />
          <p>
            Weighted score = sum of (criterion average × weight) ÷ total weight.
          </p>
        </div>
      </section>
      <section className="weighted-results">
        <div className="studio-section-head">
          <div>
            <p className="studio-kicker">LIVE WHAT-IF ANALYSIS</p>
            <h2>Your weighted ranking</h2>
          </div>
          <span className="live-dot" />
        </div>
        <p className="lab-verdict" aria-live="polite">
          {!total
            ? "Choose at least one criterion to see a ranking."
            : !leaders.length
              ? "No candidate has complete data for these weights."
              : leaders.length > 1
                ? `${leaders.map((item) => item.entry.modelName).join(" and ")} are tied.`
                : `${leaders[0].entry.modelName} leads with these priorities.`}
        </p>
        <div className="weighted-list">
          {ranking.map(({ entry, score }, index) => (
            <div className="weighted-row" key={entry.modelId}>
              <div>
                <ModelMark
                  entry={entry}
                  index={entries.findIndex((e) => e.modelId === entry.modelId)}
                />
                <h3>{entry.modelName}</h3>
                <strong>{score?.toFixed(2) ?? "—"}</strong>
              </div>
              <div className="weighted-track">
                <span style={{ width: `${(score ?? 0) * 10}%` }} />
              </div>
              <p>
                Recorded overall: {entry.overallAverage.toFixed(2)}{" "}
                <span>
                  {score === null ? "Not ranked" : "Recomputed from criteria"}
                </span>
              </p>
            </div>
          ))}
        </div>
        <div className="lab-disclaimer">
          <b>An exploration, not a new evaluation.</b>
          <p>
            Recorded overall scores may include the synthesizer’s holistic
            judgment. These scores are calculated from the final criteria
            instead, so equal weighting can differ from the original ranking. No
            model calls or stored results are changed.
          </p>
        </div>
        <ExportButton run={run} entries={entries} weights={weights} />
      </section>
    </div>
  );
}

type Evidence = {
  modelId: string;
  turns?: Turn[];
  synthesis?: Synthesis;
  errors: string[];
};
function CompareEvidence({
  run,
  entries,
}: {
  run: RunManifest;
  entries: LeaderboardEntry[];
}) {
  const [scenarioId, setScenarioId] = useState(run.scenarios[0]?.id ?? "");
  const [selected, setSelected] = useState(
    entries.slice(0, 2).map((entry) => entry.modelId),
  );
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setEvidence([]);
    void Promise.all(
      entries.map(async (entry) => {
        const scenario = entry.scenarioScores.find(
          (s) => s.scenarioId === scenarioId,
        );
        if (!scenario)
          return {
            modelId: entry.modelId,
            errors: ["This candidate has no result for this scenario."],
          };
        const [turns, synthesis] = await Promise.allSettled([
          loadTurns(
            run.runId,
            entry.modelId,
            scenarioId,
            scenario.scenarioName,
          ),
          loadSynthesis(
            run.runId,
            entry.modelId,
            scenarioId,
            scenario.scenarioName,
          ),
        ]);
        return {
          modelId: entry.modelId,
          turns: turns.status === "fulfilled" ? turns.value : undefined,
          synthesis:
            synthesis.status === "fulfilled" ? synthesis.value : undefined,
          errors: [
            turns.status === "rejected"
              ? "The recorded transcript could not be loaded."
              : "",
            synthesis.status === "rejected"
              ? "The arbiter assessment could not be loaded."
              : "",
          ].filter(Boolean),
        };
      }),
    ).then((result) => {
      if (active) {
        setEvidence(result);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [run.runId, entries, scenarioId]);
  const selectedEntries = entries.filter((entry) =>
    selected.includes(entry.modelId),
  );
  const prompt = evidence
    .flatMap((item) => item.turns ?? [])
    .find((turn) => turn.role === "participant")?.content;
  return (
    <>
      <div className="comparison-controls">
        <fieldset>
          <legend>Compare up to three candidates</legend>
          {entries.map((entry, index) => (
            <label
              className={selected.includes(entry.modelId) ? "selected" : ""}
              key={entry.modelId}
            >
              <input
                type="checkbox"
                checked={selected.includes(entry.modelId)}
                disabled={
                  !selected.includes(entry.modelId) && selected.length >= 3
                }
                onChange={() =>
                  setSelected((previous) =>
                    previous.includes(entry.modelId)
                      ? previous.filter((id) => id !== entry.modelId)
                      : [...previous, entry.modelId],
                  )
                }
              />
              <span className={`legend-dot model-color-${index % 4}`} />
              {entry.modelName}
            </label>
          ))}
        </fieldset>
        <label className="scenario-picker">
          Scenario
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
          >
            {run.scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {prompt && (
        <details className="shared-prompt">
          <summary>
            <span>THE SHARED PROMPT</span>
            {run.scenarios.find((s) => s.id === scenarioId)?.name}
            <Icon name="plus" size={15} />
          </summary>
          <p>{prompt}</p>
        </details>
      )}
      {loading ? (
        <p className="evidence-loading" role="status">
          Loading original answers and judge assessments…
        </p>
      ) : !selected.length ? (
        <div className="evidence-empty">
          <Icon name="compare" size={30} />
          <h2>Choose the models to compare.</h2>
          <p>
            Select up to three candidates above to bring their evidence
            together.
          </p>
        </div>
      ) : (
        <div
          className="evidence-grid"
          style={
            { "--evidence-columns": selectedEntries.length } as CSSProperties
          }
        >
          {selectedEntries.map((entry) => {
            const item = evidence.find(
              (value) => value.modelId === entry.modelId,
            );
            const scenario = entry.scenarioScores.find(
              (s) => s.scenarioId === scenarioId,
            );
            const turns =
              item?.turns?.filter((turn) => turn.role === "candidate") ?? [];
            return (
              <article className="evidence-column" key={entry.modelId}>
                <header>
                  <ModelMark entry={entry} index={entries.indexOf(entry)} />
                  <div>
                    <h2>{entry.modelName}</h2>
                    <span>{entry.modelId}</span>
                  </div>
                  <b>{scenario?.average.toFixed(2) ?? "—"}</b>
                </header>
                {item?.errors.map((error) => (
                  <p role="status" className="evidence-error" key={error}>
                    {error}
                  </p>
                ))}
                <div className="evidence-criteria">
                  {Object.entries(scenario?.scores ?? {}).map(
                    ([criterion, score]) => (
                      <div key={criterion}>
                        <span>{criterionLabel(criterion)}</span>
                        <b>{score.score.toFixed(1)}</b>
                        <small
                          className={
                            score.confidence === "contested"
                              ? "contested-text"
                              : ""
                          }
                        >
                          {score.confidence}
                        </small>
                      </div>
                    ),
                  )}
                </div>
                {item?.synthesis && (
                  <div className="evidence-assessment">
                    <p className="studio-kicker">ARBITER ASSESSMENT</p>
                    <p>{item.synthesis.assessment}</p>
                  </div>
                )}
                <div className="evidence-answer">
                  <p className="studio-kicker">
                    ORIGINAL MODEL OUTPUT{" "}
                    <span>
                      {turns.length} turn{turns.length === 1 ? "" : "s"}
                    </span>
                  </p>
                  {turns.map((turn, index) => (
                    <details key={turn.turn} open={index === 0}>
                      <summary>
                        Response {index + 1}
                        <span>
                          {turn.metrics?.outputTokens
                            ? `${turn.metrics.outputTokens.toLocaleString()} tokens`
                            : "Recorded answer"}
                        </span>
                      </summary>
                      <div
                        className="answer-text"
                        tabIndex={0}
                        role="region"
                        aria-label={`${entry.modelName} response ${index + 1}`}
                      >
                        <EvidenceText text={turn.content} />
                      </div>
                    </details>
                  ))}
                </div>
                <a
                  className="studio-text-link evidence-footer"
                  href={href({
                    view: "judges",
                    runId: run.runId,
                    modelId: entry.modelId,
                    scenarioId,
                  })}
                >
                  Inspect independent judges
                  <Icon name="arrow" size={15} />
                </a>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
