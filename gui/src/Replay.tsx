import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadJudges, loadSynthesis, loadTurns } from './data';
import { humanizePlugin } from './format';
import { href } from './router';
import type { JudgeScore, LeaderboardEntry, RunManifest, ScenarioScore, Synthesis } from './types';

const COMMANDS = `git clone https://github.com/samalbanese/mcp-tournament.git
cd mcp-tournament
npm install && npm run build
npm --prefix gui install && npm --prefix gui run build
node dist/cli.js gui   # open http://localhost:4600, paste your key in Settings`;

type InlineRenderer = (text: string) => ReactNode;
type JudgeRecord = { role: string; score: JudgeScore };

interface ReplayLane {
  entry: LeaderboardEntry;
  scenario: ScenarioScore;
  prompt?: string;
  response: string;
  judges: JudgeRecord[];
  synthesis?: Synthesis;
}

interface TimedJudge extends JudgeRecord {
  revealAt: number;
}

interface TimedLane extends ReplayLane {
  responseChunks: string[];
  candidateEnd: number;
  timedJudges: TimedJudge[];
  synthesisChunks: string[];
  synthesisWordStart: number;
}

interface Timeline {
  lanes: TimedLane[];
  candidatesEnd: number;
  arbiterStart: number;
  arbiterEnd: number;
  synthesisWords: number;
  leaderboardStart: number;
  ctaAt: number;
  total: number;
}

function chunks(text: string) {
  return text.match(/\S+(?:\s+|$)/g) ?? (text ? [text] : []);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function averageJudgeScore(score: JudgeScore) {
  const values = Object.values(score.scores).map((item) => item.score);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function shortJustification(score: JudgeScore) {
  const text = Object.values(score.scores)[0]?.justification?.replace(/\s+/g, ' ').trim() ?? score.overall_impression.trim();
  const sentence = text.match(/^.*?(?:[.!?](?=\s|$)|$)/)?.[0] ?? text;
  return sentence.length > 170 ? `${sentence.slice(0, 167).trimEnd()}…` : sentence;
}

function scoreClass(score: number) {
  return score <= 3 ? 'score-low' : score <= 6 ? 'score-mid' : 'score-high';
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function buildTimeline(lanes: ReplayLane[]): Timeline {
  const laneRates = [0.82, 1.18, 0.94, 1.09];
  let synthesisWordStart = 0;
  const timedLanes = lanes.map((lane, index) => {
    const responseChunks = chunks(lane.response);
    const candidateEnd = Math.max(1_400, responseChunks.length / (70 * (laneRates[index % laneRates.length] ?? 1)) * 1_000);
    const timedJudges = lane.judges.map((judge, judgeIndex) => ({ ...judge, revealAt: candidateEnd + judgeIndex * 600 }));
    const synthesisChunks = chunks(lane.synthesis?.assessment ?? '');
    const result: TimedLane = { ...lane, responseChunks, candidateEnd, timedJudges, synthesisChunks, synthesisWordStart };
    synthesisWordStart += synthesisChunks.length;
    return result;
  });
  const candidatesEnd = Math.max(0, ...timedLanes.map((lane) => lane.candidateEnd));
  const judgesEnd = Math.max(candidatesEnd, ...timedLanes.map((lane) => lane.timedJudges.length
    ? (lane.timedJudges.at(-1)?.revealAt ?? lane.candidateEnd) + 700
    : lane.candidateEnd));
  const arbiterStart = judgesEnd + 500;
  const arbiterDuration = Math.max(1_600, synthesisWordStart / 55 * 1_000);
  const arbiterEnd = arbiterStart + arbiterDuration;
  const leaderboardStart = arbiterEnd + 450;
  const leaderboardEnd = leaderboardStart + Math.max(0, lanes.length - 1) * 420 + 700;
  const ctaAt = leaderboardEnd + 500;
  return {
    lanes: timedLanes,
    candidatesEnd,
    arbiterStart,
    arbiterEnd,
    synthesisWords: synthesisWordStart,
    leaderboardStart,
    ctaAt,
    total: ctaAt,
  };
}

export function RunItYourself() {
  const commandBlock = useRef<HTMLPreElement>(null);
  const resetTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
  }, []);

  const selectCommands = () => {
    if (!commandBlock.current) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(commandBlock.current);
    selection?.removeAllRanges();
    selection?.addRange(range);
    try { document.execCommand('copy'); } catch { /* Selection remains available for manual copy. */ }
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(COMMANDS);
    } catch {
      selectCommands();
    }
    setCopied(true);
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  return <section className="run-it-yourself">
    <div className="cta-copy">
      <p className="eyebrow">EVERY WORD ABOVE IS REAL MODEL OUTPUT</p>
      <h2>Run it yourself</h2>
      <p>Bring your own OpenRouter key. A full run costs cents, and the evidence stays on your machine.</p>
      <a href="https://github.com/samalbanese/mcp-tournament#readme">Or wire it into Claude Desktop / Cursor — see the README <span>↗</span></a>
    </div>
    <div className="command-block">
      <div><span>LOCAL SETUP / POWERSHELL OR TERMINAL</span><button type="button" onClick={() => void copy()}>{copied ? 'COPIED' : 'COPY'}</button></div>
      <pre ref={commandBlock} tabIndex={0}>{COMMANDS}</pre>
    </div>
  </section>;
}

function JudgeCard({ judge, run, elapsed }: { judge: TimedJudge; run: RunManifest; elapsed: number }) {
  const manifest = run.judges.find((item) => item.role === judge.role);
  const finalScore = averageJudgeScore(judge.score);
  const progress = clamp((elapsed - judge.revealAt) / 700);
  return <article className="replay-judge-card">
    <header><span>{manifest?.name ?? judge.role}</span><small>{judge.role.toUpperCase()}</small></header>
    <div><b className={scoreClass(finalScore)}>{(finalScore * progress).toFixed(1)}</b><span>/ 10</span></div>
    <q>{shortJustification(judge.score)}</q>
  </article>;
}

function CandidateLane({ lane, run, elapsed, renderInline }: { lane: TimedLane; run: RunManifest; elapsed: number; renderInline: InlineRenderer }) {
  const response = useRef<HTMLDivElement>(null);
  const complete = elapsed >= lane.candidateEnd;
  const visibleCount = complete ? lane.responseChunks.length : Math.floor(clamp(elapsed / lane.candidateEnd) * lane.responseChunks.length);
  const visibleText = lane.responseChunks.slice(0, visibleCount).join('');
  useEffect(() => {
    if (response.current) response.current.scrollTop = response.current.scrollHeight;
  }, [visibleText, complete]);
  return <article className={`replay-lane ${complete ? 'complete' : ''}`}>
    <header className="replay-lane-head"><div><span>CANDIDATE / {lane.entry.tier.toUpperCase()}</span><h2>{lane.entry.modelName}</h2><small>{lane.entry.modelId}</small></div><span className={`status-chip ${complete ? 'done' : 'running'}`}>{complete ? 'DONE' : 'GENERATING'}</span></header>
    <div className="replay-response" ref={response}>{complete ? renderInline(lane.response) : visibleText}{!complete && <span className="block-cursor" aria-hidden="true">▮</span>}</div>
    <div className="replay-judges" aria-label={`Judgments for ${lane.entry.modelName}`}>
      {lane.timedJudges.filter((judge) => elapsed >= judge.revealAt).map((judge) => <JudgeCard judge={judge} run={run} elapsed={elapsed} key={judge.role}/>)}
    </div>
  </article>;
}

function ArbiterPanel({ timeline, elapsed, renderInline }: { timeline: Timeline; elapsed: number; renderInline: InlineRenderer }) {
  const progress = clamp((elapsed - timeline.arbiterStart) / (timeline.arbiterEnd - timeline.arbiterStart));
  const visibleWords = Math.floor(progress * timeline.synthesisWords);
  const complete = elapsed >= timeline.arbiterEnd;
  const outliers = timeline.lanes.flatMap((lane) => Object.entries(lane.synthesis?.final_scores ?? {}).flatMap(([criterion, result]) =>
    result.outliers.map((note) => ({ model: lane.entry.modelName, criterion, note }))));
  return <section className="replay-arbiter stage-arrival">
    <div className="stage-heading"><div><p className="eyebrow">STAGE 03 / SYNTHESIZER ARBITRATION</p><h2>Signal from disagreement</h2></div><span>ARBITER / {timeline.lanes[0]?.entry.scenarioScores[0]?.scenarioName ?? 'SCENARIO'}</span></div>
    <div className="arbiter-assessments">
      {timeline.lanes.map((lane) => {
        const laneVisible = clamp(visibleWords - lane.synthesisWordStart, 0, lane.synthesisChunks.length);
        const laneStarted = visibleWords >= lane.synthesisWordStart;
        const laneComplete = complete || laneVisible >= lane.synthesisChunks.length;
        return <article key={lane.entry.modelId}><header><span>{lane.entry.modelName}</span><b>{lane.synthesis?.average_score.toFixed(2) ?? '—'}</b></header><p>{lane.synthesis
          ? laneComplete ? renderInline(lane.synthesis.assessment) : lane.synthesisChunks.slice(0, laneVisible).join('')
          : <em>Synthesis record unavailable.</em>}{lane.synthesis && laneStarted && !laneComplete && <span className="block-cursor" aria-hidden="true">▮</span>}</p></article>;
      })}
    </div>
    {complete && outliers.length > 0 && <div className="replay-outliers"><div className="section-label"><span>OUTLIER NOTES</span><b>{outliers.length} FLAGGED</b></div>{outliers.map((item, index) => <article className="outlier" key={`${item.model}-${item.criterion}-${index}`}><span>▲ {item.criterion.replaceAll('_', ' ')}</span><p><b>{item.model}</b> — {item.note}</p></article>)}</div>}
  </section>;
}

function ReplayLeaderboard({ timeline, entries, elapsed, runId }: { timeline: Timeline; entries: LeaderboardEntry[]; elapsed: number; runId: string }) {
  return <section className="replay-ranking stage-arrival">
    <div className="stage-heading"><div><p className="eyebrow">STAGE 04 / AGGREGATE</p><h2>Leaderboard assembled</h2></div><span>FINAL / {entries.length} CANDIDATES</span></div>
    <div className="replay-ranks">
      {entries.map((entry, index) => {
        const revealAt = timeline.leaderboardStart + index * 420;
        if (elapsed < revealAt) return null;
        const scoreProgress = clamp((elapsed - revealAt) / 700);
        return <a className="replay-rank-row" href={href({ view: 'model', runId, modelId: entry.modelId })} key={entry.modelId}>
          <span className="rank">{String(index + 1).padStart(2, '0')}</span><div><h3>{entry.modelName}</h3><small>{entry.modelId}</small></div><div className={`replay-overall ${scoreClass(entry.overallAverage)}`}><b>{(entry.overallAverage * scoreProgress).toFixed(2)}</b><span>/ 10</span></div>
        </a>;
      })}
    </div>
  </section>;
}

export default function Replay({ run, entries, renderInline }: { run: RunManifest; entries: LeaderboardEntry[]; renderInline: InlineRenderer }) {
  const reducedMotion = useReducedMotion();
  const [lanes, setLanes] = useState<ReplayLane[]>();
  const [loadError, setLoadError] = useState<string>();
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<1 | 4>(1);

  useEffect(() => {
    let active = true;
    setLanes(undefined);
    setLoadError(undefined);
    void Promise.all(entries.map(async (entry): Promise<ReplayLane | null> => {
      const scenario = entry.scenarioScores[0];
      if (!scenario) return null;
      const [turns, judges, synthesis] = await Promise.all([
        loadTurns(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName).catch(() => []),
        loadJudges(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName, run.judges.map((judge) => judge.role)),
        loadSynthesis(run.runId, entry.modelId, scenario.scenarioId, scenario.scenarioName).catch(() => undefined),
      ]);
      const prompt = turns.find((turn) => turn.role === 'participant')?.content;
      const response = [...turns].reverse().find((turn) => turn.role === 'candidate')?.content ?? '[No candidate text response was recorded.]';
      return { entry, scenario, prompt, response, judges, synthesis };
    })).then((loaded) => {
      if (!active) return;
      const available = loaded.filter((lane): lane is ReplayLane => lane !== null);
      if (!available.length) setLoadError('This run has no scenario evidence to replay.');
      else setLanes(available);
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [run, entries]);

  const timeline = useMemo(() => lanes ? buildTimeline(lanes) : undefined, [lanes]);

  useEffect(() => {
    if (!timeline) return;
    const startAt = reducedMotion ? timeline.total : 0;
    elapsedRef.current = startAt;
    setElapsed(startAt);
    setPlaying(!reducedMotion);
  }, [run.runId, timeline, reducedMotion]);

  useEffect(() => {
    if (!timeline || reducedMotion || !playing || elapsedRef.current >= timeline.total) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(timeline.total, elapsedRef.current + (now - last) * speed);
      last = now;
      elapsedRef.current = next;
      setElapsed(next);
      if (next < timeline.total) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [timeline, reducedMotion, playing, speed]);

  if (loadError) return <div className="page replay-page"><section className="empty"><p className="eyebrow">REPLAY UNAVAILABLE</p><h1>No playback data</h1><p>{loadError}</p></section></div>;
  if (!timeline) return <div className="page replay-page"><div className="skeleton-stack" aria-label="Loading replay"><span/><span/><span/></div></div>;

  const stage = elapsed < timeline.candidatesEnd ? 1 : elapsed < timeline.arbiterStart ? 2 : elapsed < timeline.arbiterEnd ? 3 : elapsed < timeline.ctaAt ? 4 : 5;
  const promptLane = timeline.lanes.find((lane) => lane.prompt);
  const skip = () => {
    elapsedRef.current = timeline.total;
    setElapsed(timeline.total);
    setPlaying(false);
  };
  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (elapsedRef.current >= timeline.total) {
      elapsedRef.current = 0;
      setElapsed(0);
    }
    setPlaying(true);
  };

  return <div className="page replay-page reveal">
    <nav className="crumbs"><a href={href({ view: 'home', runId: run.runId })}>{run.runId}</a><i>/</i><span>Replay theater</span></nav>
    <section className="replay-hero"><div><p className="eyebrow">REAL RUN / STAGED PLAYBACK</p><h1>Replay theater</h1><p>{humanizePlugin(run.plugin)} · {entries.length} models · {run.judges.length} judges · no simulation</p></div><span className="replay-live">● STAGE 0{stage} / 05</span></section>
    <div className={`replay-controls ${reducedMotion ? 'reduced' : ''}`}>
      {reducedMotion ? <p>REDUCED MOTION ENABLED / COMPLETE RUN SHOWN</p> : <>
        <button type="button" onClick={togglePlayback} aria-pressed={!playing}>{playing ? 'Ⅱ PAUSE' : '▶ PLAY'}</button>
        <button type="button" onClick={() => setSpeed((current) => current === 1 ? 4 : 1)}>SPEED {speed}×</button>
        <button type="button" onClick={skip}>SKIP TO END <span>→</span></button>
      </>}
    </div>
    {promptLane?.prompt && <section className="replay-prompt" aria-labelledby="replay-prompt-title">
      <header><p className="eyebrow">THE PROMPT</p><span>WHAT EVERY MODEL WAS ASKED</span></header>
      <h2 id="replay-prompt-title">{promptLane.scenario.scenarioName}</h2>
      <p>{promptLane.prompt}</p>
    </section>}
    <section className="replay-candidates">
      <div className="stage-heading"><div><p className="eyebrow">STAGE 01 + 02 / EXECUTE → JUDGE PANEL</p><h2>Candidate field</h2></div><span>WORD STREAM / REAL OUTPUT</span></div>
      <div className="replay-lanes">{timeline.lanes.map((lane) => <CandidateLane lane={lane} run={run} elapsed={elapsed} renderInline={renderInline} key={lane.entry.modelId}/>)}</div>
    </section>
    {elapsed >= timeline.arbiterStart && <ArbiterPanel timeline={timeline} elapsed={elapsed} renderInline={renderInline}/>}
    {elapsed >= timeline.leaderboardStart && <ReplayLeaderboard timeline={timeline} entries={entries} elapsed={elapsed} runId={run.runId}/>}
    {elapsed >= timeline.ctaAt && <div className="stage-arrival replay-cta"><RunItYourself/></div>}
  </div>;
}
