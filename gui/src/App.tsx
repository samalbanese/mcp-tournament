import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { detectAppMode, loadDefaults, loadModels, loadPlugins, loadRunProgress, saveBench, startRun, suggestCriteria, type ApiDefaults, type ApiModel, type ApiPlugin, type BenchCriterion, type RunProgress } from './api';
import { loadIndex, loadJudges, loadLeaderboard, loadRun, loadSynthesis, loadTurns } from './data';
import { humanizePlugin } from './format';
import JudgeSpread from './JudgeSpread';
import Replay, { RunItYourself } from './Replay';
import { href, useRoute, type Route } from './router';
import type { Confidence, JudgeScore, LeaderboardEntry, RunManifest, ScenarioScore, Turn } from './types';

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
const ROUTING_STORAGE_KEY = 'tournament.routing';

interface RoutingSettings {
  candidates: string[];
  judgeModels: Record<string, string>;
  synthesizerModel: string;
}

function readStoredRouting(): RoutingSettings | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROUTING_STORAGE_KEY) ?? '') as Partial<RoutingSettings>;
    if (!Array.isArray(parsed.candidates)
      || parsed.candidates.length < 1
      || parsed.candidates.length > 4
      || !parsed.candidates.every(model => typeof model === 'string' && model.length > 0)
      || !parsed.judgeModels
      || typeof parsed.judgeModels !== 'object'
      || Array.isArray(parsed.judgeModels)
      || !Object.values(parsed.judgeModels).every(model => typeof model === 'string' && model.length > 0)
      || typeof parsed.synthesizerModel !== 'string'
      || !parsed.synthesizerModel) return undefined;
    return parsed as RoutingSettings;
  } catch {
    return undefined;
  }
}

function routingFromDefaults(defaults: ApiDefaults): RoutingSettings {
  const stored = readStoredRouting();
  return {
    candidates: stored?.candidates ?? defaults.candidates,
    judgeModels: Object.fromEntries(defaults.judges.map(judge => [
      judge.role,
      stored?.judgeModels[judge.role] ?? judge.model,
    ])),
    synthesizerModel: stored?.synthesizerModel ?? defaults.synthesizer,
  };
}

function routingOverrides(routing: RoutingSettings, defaults: ApiDefaults) {
  const judgeModels = Object.fromEntries(defaults.judges.flatMap(judge =>
    routing.judgeModels[judge.role] !== judge.model
      ? [[judge.role, routing.judgeModels[judge.role]]]
      : []));
  return {
    ...(Object.keys(judgeModels).length ? { judgeModels } : {}),
    ...(routing.synthesizerModel !== defaults.synthesizer
      ? { synthesizerModel: routing.synthesizerModel }
      : {}),
  };
}

function Shell({ children, runs, activeRun, route, appMode }: { children: ReactNode; runs: string[]; activeRun?: string; route: Route; appMode: boolean }) {
  const selectRun = (runId: string) => { location.hash = href({ view: 'home', runId }); };
  return <>
    <div className="ambient" aria-hidden="true" />
    <header className={`masthead ${appMode ? 'app-mode' : ''}`}>
      <a className="brand" href={href({ view: 'home', runId: activeRun })}><span className="brand-mark">MCP</span><span>TOURNAMENT</span><small>{appMode ? 'LOCAL RUNNER' : 'RESULTS TERMINAL'}</small></a>
      <div className="run-control"><label htmlFor="run-select">ACTIVE RUN</label><select id="run-select" value={activeRun ?? ''} onChange={(event) => selectRun(event.target.value)}>{runs.map((run) => <option key={run}>{run}</option>)}</select></div>
      {appMode && <a className={route.view === 'new' ? 'nav-link active' : 'nav-link'} href="#/new">NEW RUN</a>}
      {appMode && <a className={route.view === 'build' ? 'nav-link active' : 'nav-link'} href="#/build">BUILD BENCH</a>}
      {appMode && <a className={route.view === 'settings' ? 'nav-link active' : 'nav-link'} href="#/settings">SETTINGS</a>}
      <a className={route.view === 'why' ? 'nav-link active' : 'nav-link'} href="#/why">WHY</a>
      <a className={route.view === 'about' ? 'nav-link active' : 'nav-link'} href="#/about">ABOUT</a>
    </header>
    <main>{children}</main>
    <footer><span>MCP TOURNAMENT / {appMode ? 'LOCAL APP' : 'STATIC RESULTS VIEWER'}</span><span>DATA LOCAL · NO TELEMETRY</span></footer>
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
    <section className="page-heading"><div><p className="eyebrow">AGGREGATED MODEL RANKING</p><h1>{spotlight ? 'Scorecard spotlight' : 'Leaderboard'}</h1><p>{humanizePlugin(run.plugin)} evaluation · {run.scenarios.length} scenario{run.scenarios.length === 1 ? '' : 's'} · {run.judges.length} independent judges</p></div><div className="run-stamp"><span>RUN CREATED</span><b>{new Date(run.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })}</b><small>{new Date(run.createdAt).toLocaleTimeString()}</small></div></section>
    {spotlight && <p className="spotlight-note"><span>SOLE CANDIDATE</span> One model was evaluated in this run. Its scorecard is shown at full resolution.</p>}
    <div className="leaderboard-entry"><a className="watch-replay" href={href({ view: 'replay', runId: run.runId })}>▶ WATCH THIS RUN HAPPEN <span>→</span></a></div>
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

function ScenarioSynthesis({ run, modelId, scenario }: { run: RunManifest; modelId: string; scenario: ScenarioScore }) {
  const runId = run.runId;
  const state = useLoad(() => loadSynthesis(runId, modelId, scenario.scenarioId, scenario.scenarioName), [runId, modelId, scenario.scenarioId]);
  const judgesState = useLoad(() => loadJudges(runId, modelId, scenario.scenarioId, scenario.scenarioName, run.judges.map((judge) => judge.role)), [runId, modelId, scenario.scenarioId]);
  if (state.loading) return <Skeleton/>;
  const synthesis = state.data;
  if (!synthesis) return <div className="inline-empty">Synthesizer record unavailable for this scenario.</div>;
  const outliers = Object.entries(synthesis.final_scores).flatMap(([criterion, score]) => score.outliers.map((note) => ({ criterion, note })));
  return <>
    {outliers.length > 0 && <section className="outliers"><div className="section-label"><span>JUDGE DISAGREEMENTS</span><b>{outliers.length} MATERIAL OUTLIER{outliers.length === 1 ? '' : 'S'}</b></div>{outliers.map((item, index) => <article className="outlier" key={`${item.criterion}-${index}`}><span>{label(item.criterion)}</span><p>{item.note}</p></article>)}</section>}
    <div className="detail-grid">
      <section className="score-panel"><div className="section-label"><span>FINAL CRITERIA</span><b>{synthesis.average_score.toFixed(2)} AVG</b></div>{Object.entries(synthesis.final_scores).map(([criterion, score]) => { const notes = score.outliers.join(' ').toLowerCase(); const spreadJudges = (judgesState.data ?? []).flatMap(({ role, score: judgeScore }) => { const value = judgeScore.scores[criterion]?.score; const manifest = run.judges.find((judge) => judge.role === role); return value == null ? [] : [{ role, name: manifest?.name, score: value }]; }); const outlierRoles = spreadJudges.filter(({ role, name }) => [role, role.replaceAll('_', ' '), name].some((candidate) => candidate && notes.includes(candidate.toLowerCase()))).map(({ role }) => role); return <div className="criterion-score" key={criterion}><div><b>{label(criterion)}</b><ConfidenceChip value={score.confidence}/></div><div className="criterion-signal"><ScoreBar score={score.score}/><JudgeSpread judges={spreadJudges} final={score.score} outlierRoles={outlierRoles}/></div></div>; })}</section>
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
    <ScenarioSynthesis run={run} modelId={entry.modelId} scenario={scenario}/>
  </div>;
}

function JudgePanel({ run, entry, scenario }: { run: RunManifest; entry: LeaderboardEntry; scenario: ScenarioScore }) {
  const state = useLoad(() => loadJudges(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName, run.judges.map((judge) => judge.role)), [run.runId, entry.modelId, scenario.scenarioId]);
  const judges = state.data ?? [];
  const criteria = [...new Set(judges.flatMap((judge) => Object.keys(judge.score.scores)))];
  return <div className="page reveal"><Breadcrumbs run={run.runId} model={entry} scenario={scenario}/><ViewHeader eyebrow="INDEPENDENT EVALUATION" title="Judge panel" detail="Scores before synthesizer arbitration" back={href({ view: 'model', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}/>
    {state.loading ? <Skeleton/> : state.error ? <Empty title="Judge panel unavailable" detail={state.error}/> : <>
      <section className="matrix-wrap"><table className="matrix"><thead><tr><th>CRITERION</th>{judges.map(({role}) => <th key={role}><span>{run.judges.find((j) => j.role === role)?.name ?? label(role)}</span><small>{run.judges.find((j) => j.role === role)?.model}</small></th>)}</tr></thead><tbody>{criteria.flatMap((criterion) => { const values = judges.map((judge) => judge.score.scores[criterion]?.score).filter((v): v is number => v != null); const spread = Math.max(...values)-Math.min(...values); const spreadJudges = judges.flatMap(({ role, score }) => { const value = score.scores[criterion]?.score; return value == null ? [] : [{ role, name: run.judges.find((judge) => judge.role === role)?.name, score: value }]; }); return [<tr className={spread >= 3 ? 'disputed' : ''} key={criterion}><th>{label(criterion)}{spread >= 3 && <small>▲ {spread} PT SPREAD</small>}</th>{judges.map(({ role, score }) => <td key={role} className={scoreClass(score.scores[criterion]?.score ?? 0)}><b>{score.scores[criterion]?.score ?? '—'}</b></td>)}</tr>, <tr className="matrix-spread-row" key={`${criterion}-spread`}><td colSpan={judges.length + 1}><JudgeSpread judges={spreadJudges} compact/></td></tr>]; })}</tbody></table></section>
      <section className="judge-notes"><div className="section-label"><span>JUDGE EVIDENCE</span><b>EXPAND TO INSPECT</b></div>{judges.map(({role, score}) => <JudgeNotes key={role} role={role} score={score} name={run.judges.find((judge) => judge.role === role)?.name}/>)}</section>
    </>}
  </div>;
}
function JudgeNotes({ role, score, name }: { role: string; score: JudgeScore; name?: string }) { return <details><summary><span>{name ?? label(role)}</span><small>{score.overall_impression}</small><b>+</b></summary><div className="judge-detail">{Object.entries(score.scores).map(([criterion, item]) => <article key={criterion}><header><span>{label(criterion)}</span><b>{item.score}/10</b></header><p>{item.justification}</p>{item.quotes.length > 0 && <div className="quotes">{item.quotes.map((quote, i) => <blockquote key={i}>“{quote}”</blockquote>)}</div>}<p className="improvement"><strong>Improvement</strong>{item.improvement}</p></article>)}</div></details>; }

function Transcript({ run, entry, scenario }: { run: RunManifest; entry: LeaderboardEntry; scenario: ScenarioScore }) {
  const state = useLoad(() => loadTurns(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName), [run.runId, entry.modelId, scenario.scenarioId]);
  const turns = state.data ?? [];
  const jumpToTurn = (turn: number) => document.getElementById(`turn-${String(turn).padStart(2, '0')}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  return <div className="page transcript-page reveal"><Breadcrumbs run={run.runId} model={entry} scenario={scenario}/><ViewHeader eyebrow="RAW EXECUTION RECORD" title="Transcript" detail={`${entry.modelName} × ${scenario.scenarioName}`} back={href({ view: 'model', runId: run.runId, modelId: entry.modelId, scenarioId: scenario.scenarioId })}/>
    {state.loading ? <Skeleton/> : state.error ? <Empty title="Transcript unavailable" detail={state.error}/> : <div className="transcript-layout"><nav className="turn-rail" aria-label="Transcript turns">{turns.map((turn) => { const invalid = turn.toolCalls?.some((tool) => !tool.valid); const hasTools = Boolean(turn.toolCalls?.length); return <a href={`#turn-${String(turn.turn).padStart(2, '0')}`} onClick={(event) => { event.preventDefault(); jumpToTurn(turn.turn); }} title={`Jump to turn ${turn.turn}`} key={turn.turn}><span>{String(turn.turn).padStart(2, '0')}</span>{hasTools && <b className={invalid ? 'invalid' : ''}>{invalid ? '⚠' : '◇'}</b>}</a>; })}</nav><section className="transcript">{turns.map((turn) => <TurnCard turn={turn} key={turn.turn}/>)}</section></div>}
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

function TurnCard({ turn }: { turn: Turn }) { const long = turn.content.length > 1_400; const [expanded, setExpanded] = useState(() => Boolean(turn.toolCalls?.some((tool) => !tool.valid))); const id = `turn-${String(turn.turn).padStart(2, '0')}`; return <article id={id} className={`turn ${turn.role} ${long ? 'long' : ''} ${long && !expanded ? 'collapsed' : ''}`}><header><span>{turn.role === 'candidate' ? 'CANDIDATE' : 'PARTICIPANT'}</span><b>TURN {String(turn.turn).padStart(2, '0')}</b></header><div className="turn-content"><div className="message">{turn.content ? formatMessage(turn.content) : <em>[No text response]</em>}</div>{turn.toolCalls && turn.toolCalls.length > 0 && <div className="tools">{turn.toolCalls.map((tool, index) => <details className={tool.valid ? '' : 'invalid'} key={`${tool.name}-${index}`}><summary><span>{tool.valid ? '◇' : '⚠'} {tool.name}</span><small>{tool.valid ? 'VALID CALL' : 'INVALID CALL'}</small></summary><div><label>ARGUMENTS</label><pre>{JSON.stringify(tool.arguments, null, 2)}</pre><label>RESULT</label><pre>{tool.result}</pre></div></details>)}</div>}</div>{long && <button className="turn-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? 'COLLAPSE TURN ▴' : 'EXPAND TURN ▾'}</button>}{turn.metrics && <footer><span>TTFB {turn.metrics.ttfbMs == null ? '—' : `${(turn.metrics.ttfbMs/1000).toFixed(2)}s`}</span><span>TOTAL {(turn.metrics.totalTimeMs/1000).toFixed(2)}s</span><span>IN {turn.metrics.inputTokens.toLocaleString()} tok</span><span>OUT {turn.metrics.outputTokens.toLocaleString()} tok</span></footer>}</article>; }

function ViewHeader({ eyebrow, title, detail, back }: { eyebrow: string; title: string; detail: string; back: string }) { return <section className="view-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></div><a href={back}>← SCORECARD</a></section>; }

function ModelRouteSelect({ id, models, value, onChange }: { id: string; models: ApiModel[]; value: string; onChange: (model: string) => void }) {
  const selectedInCatalog = models.some(model => model.id === value);
  return <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
    {!selectedInCatalog && <option value={value}>{value}</option>}
    {models.map(model => <option value={model.id} key={model.id}>{model.name} — {model.id}</option>)}
  </select>;
}

function Settings({ apiKey, onKeyChange }: { apiKey: string; onKeyChange: (key: string) => void }) {
  const defaultsState = useLoad(loadDefaults, []);
  const modelsState = useLoad(loadModels, []);
  const [routing, setRouting] = useState<RoutingSettings>();
  const [search, setSearch] = useState('');
  const [keyStorageError, setKeyStorageError] = useState<string>();
  const secureStorage = window.tournamentSecure;
  useEffect(() => {
    if (!routing && defaultsState.data) setRouting(routingFromDefaults(defaultsState.data));
  }, [routing, defaultsState.data]);
  const updateKey = async (key: string) => {
    onKeyChange(key);
    setKeyStorageError(undefined);
    try {
      if (secureStorage) await secureStorage.setApiKey(key || null);
      else localStorage.setItem('or-key', key);
    } catch {
      setKeyStorageError('The key is available for this session, but could not be saved securely.');
    }
  };
  const updateRouting = (update: (current: RoutingSettings) => RoutingSettings) => {
    setRouting(current => {
      if (!current) return current;
      const next = update(current);
      localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const toggleCandidate = (model: string) => updateRouting(current => {
    if (current.candidates.includes(model)) {
      return current.candidates.length === 1
        ? current
        : { ...current, candidates: current.candidates.filter(candidate => candidate !== model) };
    }
    return current.candidates.length < 4
      ? { ...current, candidates: [...current.candidates, model] }
      : current;
  });
  const resetRouting = () => {
    if (!defaultsState.data) return;
    localStorage.removeItem(ROUTING_STORAGE_KEY);
    setRouting(routingFromDefaults(defaultsState.data));
  };
  const routingError = defaultsState.error ?? modelsState.error;
  return <div className="page app-page reveal">
    <section className="app-heading"><div><p className="eyebrow">LOCAL CONTROL</p><h1>Settings</h1><p>1. paste key → 2. set routing below (optional) → 3. NEW RUN or BUILD BENCH</p></div>{apiKey && <span className="key-chip">● KEY SET</span>}</section>
    <section className="settings-panel"><label htmlFor="or-key">OPENROUTER API KEY</label><input id="or-key" type="password" value={apiKey} onChange={(event) => void updateKey(event.target.value)} placeholder="sk-or-v1-…" autoComplete="off"/><p>{secureStorage ? 'stored with OS encryption when available, otherwise kept for this session only; sent only to your local server' : 'stays in your browser, sent only to your local server'}</p>{keyStorageError && <strong className="run-error">{keyStorageError}</strong>}</section>
    <section className="routing-panel">
      <div className="routing-head"><div><p className="eyebrow">MODEL ROUTING</p><h2>Defaults for every new run</h2><p>Choose the field and the models that score it. You can still edit candidates on New Run.</p></div><button type="button" className="routing-reset" disabled={!routing || !defaultsState.data} onClick={resetRouting}>RESET TO DEFAULTS</button></div>
      {routingError ? <p className="run-error">{routingError}</p> : (defaultsState.loading || modelsState.loading || !routing) ? <Skeleton/> : <>
        <div className="routing-block candidates-routing">
          <div className="section-label"><span>DEFAULT CANDIDATES</span><b>SELECT 1–4</b></div>
          <ModelPicker models={modelsState.data ?? []} selected={routing.candidates} search={search} onSearch={setSearch} onToggle={toggleCandidate} minimum={1}/>
        </div>
        <div className="routing-block">
          <div className="section-label"><span>JUDGE PANEL</span><b>ORDERED / FIRST N RUN</b></div>
          <p className="routing-note">New Run's judge count selects the first N roles in this order.</p>
          <div className="judge-routes">{defaultsState.data?.judges.map((judge, index) => <div className="judge-route" key={judge.role}><div><span>{String(index + 1).padStart(2, '0')}</span><label htmlFor={`judge-${judge.role}`}>{judge.name}</label><small>{judge.role.replaceAll('_', ' ')}</small></div><ModelRouteSelect id={`judge-${judge.role}`} models={modelsState.data ?? []} value={routing.judgeModels[judge.role]} onChange={(model) => updateRouting(current => ({ ...current, judgeModels: { ...current.judgeModels, [judge.role]: model } }))}/></div>)}</div>
        </div>
        <div className="routing-block synthesizer-routing">
          <div className="section-label"><span>SYNTHESIZER</span><b>FINAL ARBITRATION</b></div>
          <label htmlFor="synthesizer-model">SYNTHESIS MODEL</label>
          <ModelRouteSelect id="synthesizer-model" models={modelsState.data ?? []} value={routing.synthesizerModel} onChange={(model) => updateRouting(current => ({ ...current, synthesizerModel: model }))}/>
        </div>
      </>}
    </section>
  </div>;
}

function BenchBuilder({ apiKey }: { apiKey: string }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState(1);
  const [persona, setPersona] = useState('');
  const [criteria, setCriteria] = useState<BenchCriterion[]>([{ name: '', description: '' }]);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateCriterion = (index: number, field: keyof BenchCriterion, value: string) => {
    setCriteria((current) => current.map((criterion, criterionIndex) => criterionIndex === index ? { ...criterion, [field]: value } : criterion));
  };
  const getValidationError = () => {
    if (!name.trim()) return 'Enter a bench name.';
    if (!description.trim()) return 'Describe what this bench evaluates.';
    if (!question.trim()) return 'Enter the candidate question or task.';
    if (criteria.some((criterion) => !criterion.name.trim() || !criterion.description.trim())) return 'Give every criterion a name and description.';
    if (criteria.some((criterion) => !/^[a-z0-9_]+$/.test(criterion.name))) return 'Criterion names must use lowercase letters, numbers, and underscores.';
    return undefined;
  };
  const requestSuggestions = async () => {
    setSuggesting(true); setError(undefined);
    try {
      const result = await suggestCriteria(apiKey, question.trim());
      setCriteria(result.criteria);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSuggesting(false);
    }
  };
  const submit = async () => {
    const validationError = getValidationError();
    if (validationError) { setError(validationError); return; }
    setSaving(true); setError(undefined);
    const trimmedName = name.trim();
    try {
      const result = await saveBench({
        name: trimmedName,
        description: description.trim(),
        scenarios: [{
          id: 'primary-scenario',
          name: `${trimmedName} Scenario`,
          description: description.trim(),
          prompt: question.trim(),
          rounds,
          ...(rounds > 1 && persona.trim() ? { participantPersona: persona.trim() } : {}),
          criteria: criteria.map((criterion) => ({ name: criterion.name.trim(), description: criterion.description.trim() })),
        }],
      });
      localStorage.setItem('bench-plugin-preset', result.name);
      location.hash = '#/new';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return <div className="page app-page reveal">
    <section className="app-heading"><div><p className="eyebrow">DECLARATIVE EVALUATION</p><h1>Build bench</h1><p>Turn one real task into a repeatable model benchmark.</p></div><span className="step-mark">01 / DEFINE</span></section>
    <form className="bench-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <section className="bench-section bench-identity"><div className="section-label"><span>BENCH IDENTITY</span><b>REQUIRED</b></div><div className="bench-fields"><div className="form-block"><label htmlFor="bench-name">BENCH NAME</label><input id="bench-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="sales-coaching"/></div><div className="form-block"><label htmlFor="bench-description">DESCRIPTION</label><textarea id="bench-description" value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} placeholder="Tests consultative discovery and practical recommendations."/></div></div></section>
      <section className="bench-section"><div className="section-label"><span>SCENARIO / 01</span><b>SINGLE SCENARIO V1</b></div><div className="form-block"><label htmlFor="bench-question">QUESTION OR TASK</label><textarea className="question-input" id="bench-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Give the candidate a specific situation, constraints, and a clear outcome to address."/></div><div className="bench-rounds"><div className="form-block"><label htmlFor="bench-rounds">ROUNDS</label><select id="bench-rounds" value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>{[1,2,3,4,5].map((round) => <option value={round} key={round}>{round}</option>)}</select></div>{rounds > 1 && <div className="form-block persona-block"><label htmlFor="bench-persona">PARTICIPANT PERSONA</label><textarea id="bench-persona" value={persona} onChange={(event) => setPersona(event.target.value)} placeholder="a skeptical small business owner who pushes back and asks for specifics"/></div>}</div></section>
      <section className="bench-section criteria-section"><div className="section-label"><span>SCORING CRITERIA</span><b>{criteria.length} / 6</b></div><div className="criteria-actions"><p>Use exact score keys that describe what a strong answer must do.</p><button type="button" className="secondary-action" disabled={!apiKey || !question.trim() || suggesting} onClick={() => void requestSuggestions()}>{suggesting ? 'SUGGESTING…' : 'SUGGEST CRITERIA'}</button></div><div className="criteria-editor">{criteria.map((criterion, index) => <div className="criteria-row" key={index}><span>{String(index + 1).padStart(2, '0')}</span><input aria-label={`Criterion ${index + 1} name`} value={criterion.name} onChange={(event) => updateCriterion(index, 'name', event.target.value.toLowerCase().replace(/\s+/g, '_'))} placeholder="specificity"/><textarea aria-label={`Criterion ${index + 1} description`} value={criterion.description} onChange={(event) => updateCriterion(index, 'description', event.target.value)} placeholder="What strong performance looks like…"/><button type="button" aria-label={`Remove criterion ${index + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((_, criterionIndex) => criterionIndex !== index))}>×</button></div>)}</div>{criteria.length < 6 && <button type="button" className="add-criterion" onClick={() => setCriteria((current) => [...current, { name: '', description: '' }])}>+ ADD CRITERION</button>}{!apiKey && <p className="bench-hint">Add an OpenRouter key in Settings to use suggested criteria. Manual criteria work without a key.</p>}</section>
      <div className="run-submit bench-submit"><p>Saves a JSON bench locally and makes it available immediately.</p>{error && <strong>{error}</strong>}<button type="submit" disabled={saving}>{saving ? 'SAVING…' : 'SAVE BENCH'} <span>→</span></button></div>
    </form>
  </div>;
}

function ModelPicker({ models, selected, search, onSearch, onToggle, minimum = 0 }: { models: ApiModel[]; selected: string[]; search: string; onSearch: (value: string) => void; onToggle: (id: string) => void; minimum?: number }) {
  // Selected models sort to the top so current picks stay visible in a 300+ model catalog.
  const visible = models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)))
    .slice(0, 80);
  return <div className="model-picker"><input aria-label="Search models" type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search model catalog…"/><div className="model-list">{visible.map((model) => { const checked = selected.includes(model.id); return <label className={checked ? 'selected' : ''} key={model.id}><input type="checkbox" checked={checked} disabled={checked ? selected.length <= minimum : selected.length >= 4} onChange={() => onToggle(model.id)}/><span><b>{model.name}</b><small>{model.id}</small></span><em>${model.completionPrice.toFixed(2)}/M OUT</em></label>; })}</div><p className="pick-count">{selected.length}/4 MODELS SELECTED</p></div>;
}

function NewRun({ apiKey }: { apiKey: string }) {
  const pluginsState = useLoad(loadPlugins, []);
  const modelsState = useLoad(loadModels, []);
  const defaultsState = useLoad(loadDefaults, []);
  const plugins = pluginsState.data ?? [];
  const [pluginName, setPluginName] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [routing, setRouting] = useState<RoutingSettings>();
  const [search, setSearch] = useState('');
  const [judges, setJudges] = useState(3);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!pluginName && plugins[0]) {
      const preset = localStorage.getItem('bench-plugin-preset');
      setPluginName(plugins.find((item) => item.name === preset)?.name ?? plugins[0].name);
      localStorage.removeItem('bench-plugin-preset');
    }
  }, [pluginName, plugins]);
  useEffect(() => {
    if (!routing && defaultsState.data) {
      const effective = routingFromDefaults(defaultsState.data);
      setRouting(effective);
      setModels(effective.candidates);
    }
  }, [routing, defaultsState.data]);
  const plugin: ApiPlugin | undefined = plugins.find((item) => item.name === pluginName);
  const toggleModel = (id: string) => setModels((current) => current.includes(id) ? current.filter((model) => model !== id) : current.length < 4 ? [...current, id] : current);
  const submit = async () => {
    setSubmitting(true); setError(undefined);
    try {
      const result = await startRun({
        apiKey,
        plugin: pluginName,
        models,
        scenarioId: scenarioId || undefined,
        judges,
        ...(routing && defaultsState.data ? routingOverrides(routing, defaultsState.data) : {}),
      });
      location.hash = href({ view: 'progress', runId: result.runId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };
  return <div className="page app-page reveal">
    <section className="app-heading"><div><p className="eyebrow">TOURNAMENT CONTROL</p><h1>New run</h1><p>Choose the field, the evidence scenario, and the size of the judge panel.</p></div><span className="step-mark">01 / CONFIGURE</span></section>
    {(pluginsState.error || modelsState.error || defaultsState.error) ? <Empty title="Local catalog unavailable" detail={pluginsState.error ?? modelsState.error ?? defaultsState.error}/> : (pluginsState.loading || modelsState.loading || defaultsState.loading || !routing) ? <Skeleton/> : <form className="run-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <section className="form-block"><label htmlFor="plugin">PLUGIN</label><select id="plugin" value={pluginName} onChange={(event) => { setPluginName(event.target.value); setScenarioId(''); }}>{plugins.map((item) => <option value={item.name} key={item.name}>{item.name} — {item.description}</option>)}</select></section>
      <section className="form-block"><label htmlFor="scenario">SCENARIO</label><select id="scenario" value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}><option value="">ALL SCENARIOS</option>{plugin?.scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.name}</option>)}</select></section>
      <section className="form-block model-block"><div className="form-label"><label>MODEL FIELD</label><span>SELECT 1–4</span></div><ModelPicker models={modelsState.data ?? []} selected={models} search={search} onSearch={setSearch} onToggle={toggleModel}/></section>
      <section className="form-block judge-block"><label htmlFor="judges">JUDGES</label><input id="judges" type="number" min="1" max="5" value={judges} onChange={(event) => setJudges(Number(event.target.value))}/><span>independent scoring perspectives</span><a href="#/settings">judge models set in SETTINGS</a></section>
      <div className="run-submit"><p>budget defaults — a run like the demo costs cents</p>{!apiKey && <a href="#/settings">ADD YOUR OPENROUTER KEY →</a>}{error && <strong>{error}</strong>}<button type="submit" disabled={!apiKey || models.length < 1 || submitting}>{submitting ? 'STARTING…' : 'RUN TOURNAMENT'} <span>→</span></button></div>
    </form>}
  </div>;
}

function Progress({ runId, onViewResults }: { runId: string; onViewResults: (runId: string) => Promise<void> }) {
  const [progress, setProgress] = useState<RunProgress>();
  const [error, setError] = useState<string>();
  const terminal = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await loadRunProgress(runId);
        if (!active) return;
        setProgress(next);
        if (next.status === 'running') timer = window.setTimeout(poll, 2000);
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : String(cause)); timer = window.setTimeout(poll, 2000); }
      }
    };
    void poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [runId]);
  useEffect(() => { if (terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight; }, [progress?.logTail]);
  const status = progress?.status ?? 'running';
  return <div className="page app-page reveal">
    <section className="app-heading"><div><p className="eyebrow">LIVE EVALUATION</p><h1>{status === 'done' ? 'Run complete' : status === 'error' ? 'Run stopped' : 'Running'}</h1><p className="model-id">{runId}</p></div><span className={`status-chip ${status}`}>{status === 'running' ? '● IN PROGRESS' : status === 'done' ? '✓ DONE' : '× ERROR'}</span></section>
    <section className="progress-panel"><div className="terminal-head"><span>TOURNAMENT LOG / LAST 50 LINES</span><b>{progress?.logTail.length ?? 0} LINES</b></div><pre ref={terminal}>{progress?.logTail.length ? progress.logTail.join('\n') : 'Waiting for pipeline output…'}</pre></section>
    {(progress?.error || error) && <p className="run-error">{progress?.error ?? error}</p>}
    {status === 'done' && <div className="progress-action"><button onClick={() => void onViewResults(runId)}>VIEW RESULTS <span>→</span></button></div>}
  </div>;
}
function Why() { return <div className="page about why reveal"><p className="eyebrow">WHY A PANEL / NOT A SCORE</p><h1>One judge lies.<br/>A panel argues.</h1><p className="about-copy">Single-evaluator scores average away exactly the information you need — <strong>where</strong> models fail. Disagreement is not noise to remove. It is evidence about the boundary between plausible output and dependable behavior.</p><section className="why-example outliers"><div className="section-label"><span>COMMITTED RUN / D&amp;D DEMO</span><b>REAL DISSENT</b></div><article className="outlier"><span>RULES ACCURACY</span><div><strong>Rules Judge / 3.0</strong><p>The Rules Judge scored Rules Accuracy 3/10, citing initiative-order violations, while the panel median was 6. The confirmed error list proves the dissent right: “Initiative order error: Goblin 1 (12) acted before Goblin 2 (13).”</p><small>A mean would have buried it at 5.3. The synthesizer surfaced it as contested and kept the dissent on the record.</small></div></article></section><div className="about-grid"><article><b>01</b><h2>Independent first</h2><p>Judges never see each other’s scores. Each perspective reaches its verdict without social pressure from the panel.</p></article><article><b>02</b><h2>Arbitrated, not averaged</h2><p>The synthesizer resolves conflicts with reasons, flags outliers, and preserves contested signals.</p></article><article><b>03</b><h2>Evidence attached</h2><p>Every score links back to the transcript and tool calls that produced it.</p></article></div><a className="why-replay-link" href="#/replay/run-2026-07-18-194500">WATCH A COMMITTED RUN UNFOLD <span>→</span></a><RunItYourself/></div>; }
function About() { return <div className="page about reveal"><p className="eyebrow">HOW SCORES BECOME SIGNAL</p><h1>One run.<br/>Four accountable stages.</h1><p className="about-copy">EXECUTE captures every candidate response, tool call, and timing metric. A multi-judge panel scores the evidence independently, then a synthesizer resolves disagreements and documents its reasoning. Finally, AGGREGATE ranks candidates across scenarios without hiding the underlying transcript.</p><Pipeline/><div className="about-grid"><article><b>01</b><h2>Evidence first</h2><p>Every score links back to the exact conversation and tool behavior that produced it.</p></article><article><b>02</b><h2>Disagreement visible</h2><p>Outliers are surfaced as signal, not averaged into silence.</p></article><article><b>03</b><h2>Static by design</h2><p>This viewer reads local JSON only. No backend, accounts, tracking, or live model calls.</p></article></div><RunItYourself/></div>; }

export default function App() {
  const route = useRoute();
  const [appMode, setAppMode] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState(() => window.tournamentSecure ? '' : localStorage.getItem('or-key') ?? '');
  const [freshRuns, setFreshRuns] = useState<string[]>([]);
  useEffect(() => {
    const secureStorage = window.tournamentSecure;
    if (!secureStorage) return;
    localStorage.removeItem('or-key');
    let active = true;
    void secureStorage.getApiKey()
      .then((key) => { if (active) setApiKey(key ?? ''); })
      .catch(() => { if (active) setApiKey(''); });
    return () => { active = false; };
  }, []);
  useEffect(() => { void detectAppMode().then((health) => setAppMode(Boolean(health))); }, []);
  const index = useLoad(loadIndex, []);
  const runs = useMemo(() => [...new Set([...freshRuns, ...(index.data?.runs ?? [])])].sort().reverse(), [freshRuns, index.data]);
  const activeRun = route.runId ?? runs[0];
  const isAppRoute = route.view === 'settings' || route.view === 'new' || route.view === 'build' || route.view === 'progress';
  const runState = useLoad(!isAppRoute && activeRun ? () => loadRun(activeRun) : null, [isAppRoute, activeRun]);
  const leaderboardState = useLoad(!isAppRoute && activeRun ? () => loadLeaderboard(activeRun) : null, [isAppRoute, activeRun]);
  const entry = leaderboardState.data?.find((item) => item.modelId === route.modelId);
  const scenario = entry?.scenarioScores.find((item) => item.scenarioId === route.scenarioId) ?? entry?.scenarioScores[0];
  const viewResults = async (runId: string) => {
    const refreshed = await loadIndex();
    setFreshRuns(refreshed.runs);
    location.hash = href({ view: 'home', runId });
  };
  const content = useMemo(() => {
    if (route.view === 'why') return <Why/>;
    if (route.view === 'about') return <About/>;
    if (isAppRoute) {
      if (appMode === null) return <div className="page"><Skeleton/></div>;
      if (!appMode) return <Empty title="Local app mode unavailable" detail="Start the viewer with the local GUI command to run tournaments."/>;
      if (route.view === 'settings') return <Settings apiKey={apiKey} onKeyChange={setApiKey}/>;
      if (route.view === 'build') return <BenchBuilder apiKey={apiKey}/>;
      if (route.view === 'new') return <NewRun apiKey={apiKey}/>;
      return route.runId ? <Progress runId={route.runId} onViewResults={viewResults}/> : <Empty title="Run not found"/>;
    }
    if (index.loading || runState.loading || leaderboardState.loading) return <div className="page"><Skeleton/></div>;
    if (!activeRun || index.error || runState.error || leaderboardState.error || !runState.data || !leaderboardState.data) return <Empty detail={index.error ?? runState.error ?? leaderboardState.error}/>;
    if (route.view === 'home') return <Leaderboard run={runState.data} entries={leaderboardState.data}/>;
    if (route.view === 'replay') return <Replay run={runState.data} entries={leaderboardState.data} renderInline={formatMessage}/>;
    if (!entry) return <Empty title="Model not found" detail="This share link does not match a candidate in the selected run."/>;
    if (route.view === 'model') return <ModelDetail run={runState.data} entry={entry} selectedScenario={route.scenarioId}/>;
    if (!scenario) return <Empty title="Scenario not found"/>;
    return route.view === 'judges' ? <JudgePanel run={runState.data} entry={entry} scenario={scenario}/> : <Transcript run={runState.data} entry={entry} scenario={scenario}/>;
  }, [route, isAppRoute, appMode, apiKey, index, activeRun, runState, leaderboardState, entry, scenario]);
  return <Shell runs={runs} activeRun={activeRun} route={route} appMode={appMode === true}>{content}</Shell>;
}
