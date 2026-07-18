import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadIndex, loadJudges, loadLeaderboard, loadRun, loadSynthesis, loadTurns } from './data';
import { href, useRoute, type Route } from './router';
import type { Confidence, JudgeScore, LeaderboardEntry, RunManifest, ScenarioScore, Synthesis, Turn } from './types';

type LoadState<T> = { data?: T; error?: string; loading: boolean };
function useLoad<T>(loader: (() => Promise<T>) | null, deps: unknown[]): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ loading: Boolean(loader) });
  useEffect(() => {
    let active = true;
    if (!loader) { setState({ loading: false }); return; }
    setState({ loading: true });
    loader().then((data) => active && setState({ data, loading: false })).catch((error: Error) => active && setState({ error: error.message, loading: false }));
    return () => { active = false; };
    // Call sites pass every value captured by loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
const label = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
const scoreClass = (score: number) => score <= 3 ? 'score-low' : score <= 6 ? 'score-mid' : 'score-high';

function Shell({ children, runs, activeRun, route }: { children: ReactNode; runs: string[]; activeRun?: string; route: Route }) {
  const selectRun = (runId: string) => { location.hash = href({ view: 'home', runId }); };
  return <>
    <div className="ambient" aria-hidden="true" />
    <header className="masthead">
      <a className="brand" href={href({ view: 'home', runId: activeRun })}><span className="brand-mark">MCP</span><span>TOURNAMENT</span><small>RESULTS TERMINAL</small></a>
      <div className="run-control"><label htmlFor="run-select">ACTIVE RUN</label><select id="run-select" value={activeRun ?? ''} onChange={(event) => selectRun(event.target.value)}>{runs.map((run) => <option key={run}>{run}</option>)}</select></div>
      <a className={route.view === 'about' ? 'nav-link active' : 'nav-link'} href="#/about">ABOUT</a>
    </header>
    <main>{children}</main>
    <footer><span>MCP TOURNAMENT / STATIC RESULTS VIEWER</span><span>DATA LOCAL · NO TELEMETRY</span></footer>
  </>;
}

function Skeleton() { return <div className="skeleton-stack" aria-label="Loading results"><span/><span/><span/></div>; }
function Empty({ title = 'No tournament data found', detail }: { title?: string; detail?: string }) {
  return <section className="empty"><div className="empty-glyph">∅</div><p className="eyebrow">PIPELINE STANDBY</p><h1>{title}</h1><p>{detail ?? 'Import a completed run to populate this results terminal.'}</p><Pipeline /></section>;
}
function Pipeline() { return <div className="pipeline" aria-label="Evaluation pipeline"><span><b>01</b> EXECUTE</span><i>→</i><span><b>02</b> JUDGE PANEL</span><i>→</i><span><b>03</b> SYNTHESIZE</span><i>→</i><span><b>04</b> AGGREGATE</span></div>; }
function ConfidenceChip({ value }: { value: Confidence }) { return <span className={`confidence ${value}`}>{value}</span>; }
function ScoreBar({ score, compact = false }: { score: number; compact?: boolean }) { return <div className={`score-bar ${compact ? 'compact' : ''}`}><span className={scoreClass(score)} style={{ width: `${score * 10}%` }} /><b>{score.toFixed(1)}</b></div>; }

function Breadcrumbs({ run, model, scenario }: { run: string; model?: LeaderboardEntry; scenario?: ScenarioScore }) {
  return <nav className="crumbs" aria-label="Breadcrumb"><a href={href({ view: 'home', runId: run })}>{run}</a>{model && <><i>/</i><a href={href({ view: 'model', runId: run, modelId: model.modelId })}>{model.modelName}</a></>}{scenario && <><i>/</i><span>{scenario.scenarioName}</span></>}</nav>;
}

function Leaderboard({ run, entries }: { run: RunManifest; entries: LeaderboardEntry[] }) {
  const criteria = [...new Set(entries.flatMap((entry) => entry.scenarioScores.flatMap((scenario) => Object.keys(scenario.scores))))];
  const spotlight = entries.length === 1;
  return <div className="page reveal">
    <Breadcrumbs run={run.runId}/>
    <section className="page-heading"><div><p className="eyebrow">AGGREGATED MODEL RANKING</p><h1>{spotlight ? 'Scorecard spotlight' : 'Leaderboard'}</h1><p>{run.plugin.toUpperCase()} evaluation · {run.scenarios.length} scenario{run.scenarios.length === 1 ? '' : 's'} · {run.judges.length} independent judges</p></div><div className="run-stamp"><span>RUN CREATED</span><b>{new Date(run.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })}</b><small>{new Date(run.createdAt).toLocaleTimeString()}</small></div></section>
    {spotlight && <p className="spotlight-note"><span>SOLE CANDIDATE</span> One model was evaluated in this run. Its scorecard is shown at full resolution.</p>}
    <section className={`leaderboard ${spotlight ? 'spotlight' : ''}`}>
      <div className="leader-head"><span>RANK / MODEL</span><span>CRITERION SIGNAL</span><span>OVERALL</span></div>
      {entries.map((entry, index) => <a className="leader-row" key={entry.modelId} href={href({ view: 'model', runId: run.runId, modelId: entry.modelId })}>
        <div className="model-cell"><span className="rank">{String(index + 1).padStart(2, '0')}</span><div><h2>{entry.modelName}</h2><span className="tier">{entry.tier} tier</span><small>{entry.modelId}</small></div></div>
        <div className="criterion-strip">{criteria.map((criterion) => { const scores = entry.scenarioScores.map((s) => s.scores[criterion]?.score).filter((v): v is number => v != null); const score = scores.reduce((a,b) => a+b, 0) / scores.length; return <div key={criterion}><label>{label(criterion)}</label><ScoreBar compact score={score}/></div>; })}</div>
        <div className={`overall ${scoreClass(entry.overallAverage)}`}><b>{entry.overallAverage.toFixed(2)}</b><span>/ 10</span><small>{entry.scenarioScores.filter((s) => Object.values(s.scores).some((v) => v.confidence === 'contested')).length ? 'CONTESTED SIGNALS' : 'STABLE SIGNAL'}</small></div>
      </a>)}
    </section>
  </div>;
}

function ScenarioSynthesis({ runId, modelId, scenario }: { runId: string; modelId: string; scenario: ScenarioScore }) {
  const state = useLoad(() => loadSynthesis(runId, modelId, scenario.scenarioId, scenario.scenarioName), [runId, modelId, scenario.scenarioId]);
  if (state.loading) return <Skeleton/>;
  const synthesis = state.data;
  if (!synthesis) return <div className="inline-empty">Synthesizer record unavailable for this scenario.</div>;
  const outliers = Object.entries(synthesis.final_scores).flatMap(([criterion, score]) => score.outliers.map((note) => ({ criterion, note })));
  return <>
    {outliers.length > 0 && <section className="outliers"><div className="section-label"><span>JUDGE DISAGREEMENTS</span><b>{outliers.length} MATERIAL OUTLIER{outliers.length === 1 ? '' : 'S'}</b></div>{outliers.map((item, index) => <article className="outlier" key={`${item.criterion}-${index}`}><span>{label(item.criterion)}</span><p>{item.note}</p></article>)}</section>}
    <div className="detail-grid">
      <section className="score-panel"><div className="section-label"><span>FINAL CRITERIA</span><b>{synthesis.average_score.toFixed(2)} AVG</b></div>{Object.entries(synthesis.final_scores).map(([criterion, score]) => <div className="criterion-score" key={criterion}><div><b>{label(criterion)}</b><ConfidenceChip value={score.confidence}/></div><ScoreBar score={score.score}/></div>)}</section>
      <section className="assessment"><p className="eyebrow">SYNTHESIZER ASSESSMENT</p><blockquote>{synthesis.assessment}</blockquote><div className="agreement"><span>JUDGE AGREEMENT</span><b>{synthesis.judge_agreement}</b></div></section>
    </div>
    <section className="errors"><div className="section-label"><span>CONFIRMED RULE ERRORS</span><b>{synthesis.rule_errors_confirmed.length}</b></div>{synthesis.rule_errors_confirmed.length ? <ol>{synthesis.rule_errors_confirmed.map((error, index) => <li key={index}>{error}</li>)}</ol> : <p className="clean">No confirmed rule errors.</p>}</section>
  </>;
}

function ModelDetail({ run, entry, selectedScenario }: { run: RunManifest; entry: LeaderboardEntry; selectedScenario?: string }) {
  const scenario = entry.scenarioScores.find((item) => item.scenarioId === selectedScenario) ?? entry.scenarioScores[0];
  if (!scenario) return <Empty title="No scenario results"/>;
  return <div className="page reveal"><Breadcrumbs run={run.runId} model={entry} scenario={scenario}/>
    <section className="model-hero"><div><p className="eyebrow">CANDIDATE SCORECARD / {entry.tier.toUpperCase()} TIER</p><h1>{entry.modelName}</h1><p className="model-id">{entry.modelId}</p></div><div className={`hero-score ${scoreClass(entry.overallAverage)}`}><span>OVERALL</span><b>{entry.overallAverage.toFixed(2)}</b><small>OUT OF 10</small></div></section>
    <div className="scenario-tabs" role="navigation" aria-label="Scenarios">{entry.scenarioScores.map((item) => <a className={item.scenarioId === scenario.scenarioId ? 'active' : ''} href={href({ view: 'model', runId: run.runId, modelId: entry.modelId, scenarioId: item.scenarioId })} key={item.scenarioId}><span>{item.scenarioName}</span><b>{item.average.toFixed(2)}</b></a>)}</div>
    <div className="view-switch"><a href={href({ view: 'judges', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}>JUDGE MATRIX <span>↗</span></a><a href={href({ view: 'transcript', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}>READ TRANSCRIPT <span>↗</span></a></div>
    <ScenarioSynthesis runId={run.runId} modelId={entry.modelId} scenario={scenario}/>
  </div>;
}

function JudgePanel({ run, entry, scenario }: { run: RunManifest; entry: LeaderboardEntry; scenario: ScenarioScore }) {
  const state = useLoad(() => loadJudges(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName, run.judges.map((judge) => judge.role)), [run.runId, entry.modelId, scenario.scenarioId]);
  const judges = state.data ?? [];
  const criteria = [...new Set(judges.flatMap((judge) => Object.keys(judge.score.scores)))];
  return <div className="page reveal"><Breadcrumbs run={run.runId} model={entry} scenario={scenario}/><ViewHeader eyebrow="INDEPENDENT EVALUATION" title="Judge panel" detail="Scores before synthesizer arbitration" back={href({ view: 'model', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}/>
    {state.loading ? <Skeleton/> : state.error ? <Empty title="Judge panel unavailable" detail={state.error}/> : <>
      <section className="matrix-wrap"><table className="matrix"><thead><tr><th>CRITERION</th>{judges.map(({role}) => <th key={role}><span>{run.judges.find((j) => j.role === role)?.name ?? label(role)}</span><small>{run.judges.find((j) => j.role === role)?.model}</small></th>)}</tr></thead><tbody>{criteria.map((criterion) => { const values = judges.map((judge) => judge.score.scores[criterion]?.score).filter((v): v is number => v != null); const spread = Math.max(...values)-Math.min(...values); return <tr className={spread >= 3 ? 'disputed' : ''} key={criterion}><th>{label(criterion)}{spread >= 3 && <small>▲ {spread} PT SPREAD</small>}</th>{judges.map(({ role, score }) => <td key={role} className={scoreClass(score.scores[criterion]?.score ?? 0)}><b>{score.scores[criterion]?.score ?? '—'}</b></td>)}</tr>; })}</tbody></table></section>
      <section className="judge-notes"><div className="section-label"><span>JUDGE EVIDENCE</span><b>EXPAND TO INSPECT</b></div>{judges.map(({role, score}) => <JudgeNotes key={role} role={role} score={score} name={run.judges.find((judge) => judge.role === role)?.name}/>)}</section>
    </>}
  </div>;
}
function JudgeNotes({ role, score, name }: { role: string; score: JudgeScore; name?: string }) { return <details><summary><span>{name ?? label(role)}</span><small>{score.overall_impression}</small><b>+</b></summary><div className="judge-detail">{Object.entries(score.scores).map(([criterion, item]) => <article key={criterion}><header><span>{label(criterion)}</span><b>{item.score}/10</b></header><p>{item.justification}</p>{item.quotes.length > 0 && <div className="quotes">{item.quotes.map((quote, i) => <blockquote key={i}>“{quote}”</blockquote>)}</div>}<p className="improvement"><strong>Improvement</strong>{item.improvement}</p></article>)}</div></details>; }

function Transcript({ run, entry, scenario }: { run: RunManifest; entry: LeaderboardEntry; scenario: ScenarioScore }) {
  const state = useLoad(() => loadTurns(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName), [run.runId, entry.modelId, scenario.scenarioId]);
  return <div className="page transcript-page reveal"><Breadcrumbs run={run.runId} model={entry} scenario={scenario}/><ViewHeader eyebrow="RAW EXECUTION RECORD" title="Transcript" detail={`${entry.modelName} × ${scenario.scenarioName}`} back={href({ view: 'model', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}/>
    {state.loading ? <Skeleton/> : state.error ? <Empty title="Transcript unavailable" detail={state.error}/> : <section className="transcript">{state.data?.map((turn) => <TurnCard turn={turn} key={turn.turn}/>)}</section>}
  </div>;
}
/**
 * Transcript text arrives as raw model output with markdown emphasis
 * (**bold** / *italic*). Render just those two inline marks as React nodes —
 * no HTML parsing, so model output can never inject markup.
 */
function formatMessage(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function TurnCard({ turn }: { turn: Turn }) { return <article className={`turn ${turn.role}`}><header><span>{turn.role === 'candidate' ? 'CANDIDATE' : 'PARTICIPANT'}</span><b>TURN {String(turn.turn).padStart(2, '0')}</b></header><div className="message">{turn.content ? formatMessage(turn.content) : <em>[No text response]</em>}</div>{turn.toolCalls && turn.toolCalls.length > 0 && <div className="tools">{turn.toolCalls.map((tool, index) => <details className={tool.valid ? '' : 'invalid'} key={`${tool.name}-${index}`}><summary><span>{tool.valid ? '◇' : '⚠'} {tool.name}</span><small>{tool.valid ? 'VALID CALL' : 'INVALID CALL'}</small></summary><div><label>ARGUMENTS</label><pre>{JSON.stringify(tool.arguments, null, 2)}</pre><label>RESULT</label><pre>{tool.result}</pre></div></details>)}</div>}{turn.metrics && <footer><span>TTFB {turn.metrics.ttfbMs == null ? '—' : `${(turn.metrics.ttfbMs/1000).toFixed(2)}s`}</span><span>TOTAL {(turn.metrics.totalTimeMs/1000).toFixed(2)}s</span><span>IN {turn.metrics.inputTokens.toLocaleString()} tok</span><span>OUT {turn.metrics.outputTokens.toLocaleString()} tok</span></footer>}</article>; }

function ViewHeader({ eyebrow, title, detail, back }: { eyebrow: string; title: string; detail: string; back: string }) { return <section className="view-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></div><a href={back}>← SCORECARD</a></section>; }
function About() { return <div className="page about reveal"><p className="eyebrow">HOW SCORES BECOME SIGNAL</p><h1>One run.<br/>Four accountable stages.</h1><p className="about-copy">EXECUTE captures every candidate response, tool call, and timing metric. A multi-judge panel scores the evidence independently, then a synthesizer resolves disagreements and documents its reasoning. Finally, AGGREGATE ranks candidates across scenarios without hiding the underlying transcript.</p><Pipeline/><div className="about-grid"><article><b>01</b><h2>Evidence first</h2><p>Every score links back to the exact conversation and tool behavior that produced it.</p></article><article><b>02</b><h2>Disagreement visible</h2><p>Outliers are surfaced as signal, not averaged into silence.</p></article><article><b>03</b><h2>Static by design</h2><p>This viewer reads local JSON only. No backend, accounts, tracking, or live model calls.</p></article></div></div>; }

export default function App() {
  const route = useRoute();
  const index = useLoad(loadIndex, []);
  const runs = useMemo(() => [...(index.data?.runs ?? [])].sort().reverse(), [index.data]);
  const activeRun = route.runId ?? runs[0];
  const runState = useLoad(activeRun ? () => loadRun(activeRun) : null, [activeRun]);
  const leaderboardState = useLoad(activeRun ? () => loadLeaderboard(activeRun) : null, [activeRun]);
  const entry = leaderboardState.data?.find((item) => item.modelId === route.modelId);
  const scenario = entry?.scenarioScores.find((item) => item.scenarioId === route.scenarioId) ?? entry?.scenarioScores[0];
  const content = useMemo(() => {
    if (route.view === 'about') return <About/>;
    if (index.loading || runState.loading || leaderboardState.loading) return <div className="page"><Skeleton/></div>;
    if (!activeRun || index.error || runState.error || leaderboardState.error || !runState.data || !leaderboardState.data) return <Empty detail={index.error ?? runState.error ?? leaderboardState.error}/>;
    if (route.view === 'home') return <Leaderboard run={runState.data} entries={leaderboardState.data}/>;
    if (!entry) return <Empty title="Model not found" detail="This share link does not match a candidate in the selected run."/>;
    if (route.view === 'model') return <ModelDetail run={runState.data} entry={entry} selectedScenario={route.scenarioId}/>;
    if (!scenario) return <Empty title="Scenario not found"/>;
    return route.view === 'judges' ? <JudgePanel run={runState.data} entry={entry} scenario={scenario}/> : <Transcript run={runState.data} entry={entry} scenario={scenario}/>;
  }, [route, index, activeRun, runState, leaderboardState, entry, scenario]);
  return <Shell runs={runs} activeRun={activeRun} route={route}>{content}</Shell>;
}