import { useEffect, useState, type CSSProperties } from 'react';
import { loadStudy, loadStudyScorecards, studyScoresUrl } from './data';
import { href } from './router';
import type { Interval, StudyAnalysis, StudyDocument } from './types';
// The production build stages scripts separately from their source stylesheets.
import '../src/study.css';

const number = (value: number) => value.toFixed(2);
const signed = (value: number) => {
  const rounded = number(value);
  return Number(rounded) === 0 ? '0.00' : `${value > 0 ? '+' : ''}${rounded}`;
};
const familyName = (family: string) => ({ anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', qwen: 'Qwen' })[family] ?? family;
const date = (value: string) => Number.isNaN(Date.parse(value)) ? 'Not recorded' : new Date(value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const money = (value: number | null) => value === null ? 'Not recorded' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

function SectionHeading({ number: index, title, detail }: { number: string; title: string; detail: string }) {
  return <header className="study-section-heading"><span className="study-section-number">{index}</span><div><h2>{title}</h2><p>{detail}</p></div></header>;
}

function ScoreInterval({ score, label, showAxis }: { score: Interval; label: string; showAxis: boolean }) {
  const x = (value: number) => 12 + (Math.min(10, Math.max(1, value)) - 1) / 9 * 336;
  return <svg className="study-interval" viewBox="0 0 360 55" role="img" aria-label={`${label}: mean ${number(score.mean)}, 95% interval ${number(score.low)} to ${number(score.high)}, on a 1 to 10 scale.`}>
    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value => <g key={value}><line className="study-grid-line" x1={x(value)} x2={x(value)} y1="6" y2="30"/>{showAxis && <text x={x(value)} y="48" textAnchor="middle">{value}</text>}</g>)}
    <g className="study-whisker"><line x1={x(score.low)} x2={x(score.high)} y1="18" y2="18"/><line x1={x(score.low)} x2={x(score.low)} y1="10" y2="26"/><line x1={x(score.high)} x2={x(score.high)} y1="10" y2="26"/><circle cx={x(score.mean)} cy="18" r="5"/></g>
  </svg>;
}

function Leaderboards({ analysis, candidateName }: { analysis: StudyAnalysis; candidateName: (ref: string) => string }) {
  const [bench, setBench] = useState('overall');
  const board = analysis.leaderboards.find(item => item.bench === bench) ?? analysis.leaderboards[0];
  return <section className="study-section">
    <SectionHeading number="02" title="Who leads in this study?" detail="Compare the panel average across all scenarios or one area of work."/>
    <div className="study-tabs" role="tablist" aria-label="Leaderboard scope">
      {analysis.leaderboards.map((item, index) => <button key={item.bench} id={`study-tab-${index}`} role="tab" type="button" aria-selected={board?.bench === item.bench} aria-controls="study-ranking" tabIndex={board?.bench === item.bench ? 0 : -1} onClick={() => setBench(item.bench)} onKeyDown={event => {
        const length = analysis.leaderboards.length;
        const next = event.key === 'ArrowRight' ? (index + 1) % length : event.key === 'ArrowLeft' ? (index - 1 + length) % length : event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : null;
        if (next !== null) { event.preventDefault(); setBench(analysis.leaderboards[next].bench); document.getElementById(`study-tab-${next}`)?.focus(); }
      }}>{item.label}</button>)}
    </div>
    <div id="study-ranking" role="tabpanel" aria-labelledby={`study-tab-${analysis.leaderboards.indexOf(board)}`} tabIndex={0} className="study-panel">
      <figure className="study-ranking-figure">
        {board?.rows.length ? board.rows.map((row, index) => <div className="study-ranking-row" key={row.candidateRef}>
          <div className="study-candidate"><span className="study-rank">{String(row.rank).padStart(2, '0')}</span><div><h3>{board.bench !== 'overall' && row.runIds[0] ? <a href={href({ view: 'model', runId: row.runIds[0], modelId: row.candidateRef })}>{row.label} <span aria-hidden="true">↗</span></a> : row.label}</h3><p>{row.tiedWith.length ? `Tied with ${row.tiedWith.map(candidateName).join(', ')}` : 'No overlapping intervals'}</p></div></div>
          <ScoreInterval score={row.score} label={row.label} showAxis={index === board.rows.length - 1}/>
          <div className="study-score"><strong>{number(row.score.mean)}</strong><small>{number(row.score.low)} to {number(row.score.high)}</small></div>
        </div>) : <p className="study-empty">No answers have enough judge scores for a ranking.</p>}
        <figcaption>Dots show mean scores in this study; whiskers show 95% intervals from repeatedly sampling the scenarios, and overlapping intervals are labeled tied.</figcaption>
      </figure>
    </div>
    <p className="study-note">A tie label describes interval overlap, not proof of equal performance. Choose an area of work to open a candidate scorecard.</p>
  </section>;
}

function Heatmap({ analysis, families }: { analysis: StudyAnalysis; families: string[] }) {
  const maximum = Math.max(0.01, ...analysis.selfPreference.flatMap(row => Object.values(row.matrix).map(value => Math.abs(value ?? 0))));
  const scale = Math.ceil(maximum * 10) / 10;
  const description = analysis.selfPreference.map(row => `${familyName(row.judgeFamily)} judge: ${families.map(family => `${familyName(family)} ${row.matrix[family] == null ? 'n/a' : signed(row.matrix[family]!)}`).join(', ')}`).join('; ');
  return <section className="study-section">
    <SectionHeading number="03" title="Do judges favor their own family?" detail="Each cell compares a judge with the rest of the panel on the same answers."/>
    <figure className="study-panel study-heatmap-figure">
      <div className="study-heatmap-scroll" tabIndex={0} role="region" aria-label="Judge offset heatmap, scroll horizontally to inspect every family">
        <div role="img" aria-label={`Offsets in score points. Outlined cells pair a judge with its own family. ${description}`}>
          <table className="study-heatmap"><thead><tr><th scope="col">Judge ↓<br/>Candidate →</th>{families.map(family => <th scope="col" key={family}>{familyName(family)}</th>)}</tr></thead>
            <tbody>{analysis.selfPreference.map(row => <tr key={row.judgeFamily}><th scope="row">{familyName(row.judgeFamily)}</th>{families.map(family => {
              const value = row.matrix[family];
              const style = { '--heat-color': value != null && value < 0 ? 'var(--study-negative)' : 'var(--study-positive)', '--heat-strength': `${value == null ? 0 : Math.abs(value) / scale * 35}%` } as CSSProperties;
              return <td key={family}><span style={style} className={`study-heat-cell${family === row.judgeFamily ? ' study-own-family' : ''}`}>{value == null ? 'n/a' : signed(value)}</span></td>;
            })}</tr>)}</tbody></table>
        </div>
      </div>
      <div className="study-heat-legend"><span><i className="study-negative-swatch"/> {signed(-scale)} lower</span><span>0 panel average</span><span><i className="study-positive-swatch"/> {signed(scale)} higher</span><span><i className="study-outline-swatch"/> Own family</span></div>
      <figcaption>An offset is a judge’s score minus the other judges’ average on the same answer, so positive cells mean higher scores in this study.</figcaption>
    </figure>
    <div className="study-preference-list">{analysis.selfPreference.map(row => {
      const interval = row.ownFamily;
      const excludesZero = interval !== null && (interval.low > 0 || interval.high < 0);
      const lift = excludesZero && interval.mean > 0;
      const status = !interval ? 'No same-family candidate' : lift ? 'Clear own-family lift in this study' : excludesZero && interval.mean < 0 ? 'Scores own family lower in this study' : 'No clear preference in this study';
      return <div key={row.judgeFamily}><span>{familyName(row.judgeFamily)}</span><strong>{interval ? signed(interval.mean) : 'n/a'}</strong><small>{interval ? `95% interval ${signed(interval.low)} to ${signed(interval.high)}` : families.includes(row.judgeFamily) ? 'Not enough comparison scores' : 'No candidate from this family'}</small><small className={`study-preference-status${lift ? ' study-preference-lift' : ''}`}>{status}</small></div>;
    })}</div>
    <p className="study-note">Own-family preference subtracts the judge’s average offset on other families from its offset on its own family. The intervals above reflect variation across scenarios.</p>
  </section>;
}

function AgreementMeter({ label, value }: { label: string; value: number | null }) {
  const interpretation = value === null ? 'Not enough overlapping scores' : value < 0.4 ? 'Judges often disagree' : value <= 0.67 ? 'Moderate' : 'Strong';
  return <figure className="study-agreement-meter">
    <div className="study-meter-heading"><h3>{label}</h3><strong>{value === null ? 'n/a' : number(value)}</strong></div>
    {value !== null && <div role="img" aria-label={`${label} agreement score ${number(value)}: ${interpretation}. Scale 0 to 1; negative values are below chance agreement.`}>
      <div className="study-meter-track"><span style={{ left: `${Math.max(0, Math.min(1, value)) * 100}%` }}/></div><div className="study-meter-scale"><span>0</span><span>0.4</span><span>0.67</span><span>1</span></div>
    </div>}
    <figcaption>{interpretation}{value !== null ? ' in this study.' : ''}{value !== null && value < 0 ? ' The negative value is below chance agreement; the marker sits at the scale minimum.' : ''}</figcaption>
  </figure>;
}

function Report({ document, scorecards }: { document: StudyDocument; scorecards?: number | null }) {
  const { study, meta, analysis } = document;
  const families = [...new Set(study.candidates.map(candidate => candidate.family))];
  const scenarioCount = study.benches.reduce((total, bench) => total + bench.scenarios.length, 0);
  const candidateName = (ref: string) => study.candidates.find(candidate => candidate.ref === ref)?.label ?? ref;
  const overallWinner = analysis.leaderboards.find(board => board.bench === 'overall')?.rows[0];
  const fixture = study.id === 'fixture';
  return <article className="study-report">
    <header className="study-hero">
      <p className="study-eyebrow">Research report <span>/</span> {fixture ? 'Synthetic preview' : 'Model study'}</p>
      <h1>{study.title}</h1>
      <p className="study-intro">Who leads, who favors their own family, and where the judges disagree in this study.</p>
      <div className="study-dateline"><span>{families.length} labs · {scenarioCount} scenarios · {scorecards == null ? scorecards === null ? 'Judge scorecard count unavailable' : 'Counting judge scorecards' : `${scorecards.toLocaleString()} judge scorecards`}</span><time dateTime={meta.finishedAt}>{date(meta.finishedAt)}</time></div>
      {fixture && <p className="study-fixture-note">Synthetic fixture with seeded scores and planted preferences. These placeholder findings do not describe real model performance. Batch scorecards are not included in this preview.</p>}
    </header>

    <section className="study-findings" aria-label="Headline findings">
      {meta.headlines?.length ? meta.headlines.slice(0, 3).map((finding, index) => <article key={index}><span className="study-section-number">01.{index + 1}</span><h2>{finding.title}</h2><p>{finding.body}</p></article>) : <div className="study-pending"><h2>Findings pending</h2><p>The scores are available below. Written findings have not been published for this study.</p></div>}
    </section>

    <Leaderboards analysis={analysis} candidateName={candidateName}/>
    <Heatmap analysis={analysis} families={families}/>

    <section className="study-section">
      <SectionHeading number="04" title="Who you ask changes who wins" detail="Each judge’s top mean score, compared with the full panel’s highest mean."/>
      <div className="study-panel study-winners">
        <p>Panel leader in this study: <strong>{overallWinner?.label ?? 'No ranked answers'}</strong>{overallWinner?.tiedWith.length ? `, with overlapping intervals for ${overallWinner.tiedWith.map(candidateName).join(', ')}.` : '.'}</p>
        {analysis.singleJudgeWinners.map(row => {
          const differs = overallWinner && row.winnerRef !== overallWinner.candidateRef;
          return <div className={`study-winner-row${differs ? ' study-different' : ''}`} key={row.judgeFamily}><span>{familyName(row.judgeFamily)} judge</span><strong>{row.winnerLabel}</strong><span className="study-winner-score">{number(row.scores[row.winnerRef])}/10</span><small>{differs ? 'Different winner' : overallWinner ? 'Same as panel leader' : 'No panel comparison'}</small></div>;
        })}
        {!analysis.singleJudgeWinners.length && <p>No single-judge rankings are available.</p>}
      </div>
      <p className="study-note">Winners use each judge’s available scores; exact ties are resolved by model ID, so a listed winner need not be a clear lead.</p>
    </section>

    <section className="study-section">
      <SectionHeading number="05" title="How much do the judges agree?" detail="The agreement score (Krippendorff’s alpha) measures consistency beyond chance, not whether an answer is correct."/>
      <div className="study-agreement-grid study-panel"><AgreementMeter label="Overall" value={analysis.agreement.overall}/>{study.benches.map(bench => <AgreementMeter key={bench.bench} label={bench.label} value={analysis.agreement.byBench[bench.bench] ?? null}/>)}</div>
      <p className="study-note">Below 0.4: judges often disagree. From 0.4 through 0.67: moderate agreement. Above 0.67: strong agreement. These are descriptive labels in this study.</p>
      <h3 className="study-subheading">The most contested answers</h3>
      <p className="study-note">Spread is the highest judge score minus the lowest for an answer; open the evidence to inspect their reasoning.</p>
      <ol className="study-contested">{analysis.contested.map(answer => <li key={`${answer.runId}/${answer.scenarioId}/${answer.candidateRef}`}>
        <div><a href={href({ view: 'judges', runId: answer.runId, modelId: answer.candidateRef, scenarioId: answer.scenarioId })}>{answer.scenarioName} <span aria-hidden="true">↗</span></a><p>{candidateName(answer.candidateRef)} · {study.benches.find(bench => bench.bench === answer.bench)?.label ?? answer.bench}</p></div>
        <strong className="study-spread">{number(answer.spread)}<small>point spread</small></strong>
        <ul className="study-judge-scores">{Object.entries(answer.byJudge).map(([family, score]) => {
          const scores = Object.values(answer.byJudge);
          const highest = score === Math.max(...scores);
          const lowest = score === Math.min(...scores);
          const extreme = highest && lowest ? 'highest and lowest score (all judges tied)' : highest ? 'highest score' : lowest ? 'lowest score' : '';
          const tone = highest && !lowest ? ' study-judge-highest' : lowest && !highest ? ' study-judge-lowest' : '';
          return <li key={family} className={tone || undefined}><span>{familyName(family)}</span><b role="img" aria-label={`${familyName(family)}: ${number(score)}${extreme ? `, ${extreme}` : ''}`}>{extreme && <span aria-hidden="true">{highest && lowest ? '↕' : highest ? '↑' : '↓'} </span>}{number(score)}</b></li>;
        })}</ul>
      </li>)}</ol>
      {!analysis.contested.length && <p className="study-empty">No contested answers are available.</p>}
    </section>

    <section className="study-section">
      <SectionHeading number="06" title="Method and limits" detail="The choices behind the numbers, and the boundaries of what they can tell us."/>
      <div className="study-method-grid">
        <div><h3>How scores become a ranking</h3><p>Judges score answers independently with one shared lens and without candidate names. Each judge’s answer score is the mean of the criteria it returned. An answer needs at least two judges to enter this analysis.</p><p>We average the judge scores for each answer, then average answers for each candidate. The 95% bootstrap intervals repeatedly sample whole scenarios, preserving the scores attached to each one. The analysis uses raw judge scores, not the synthesizer’s verdict.</p><h3>Shared judge lens</h3><p>{study.judgeLens}</p></div>
        <dl className="study-method-facts">
          <div><dt>Planned sample</dt><dd>{study.candidates.length} candidates × {scenarioCount} scenarios; one answer each</dd></div>
          <div><dt>Observed answers</dt><dd>{analysis.answers.total} recorded · {analysis.answers.analyzed} analyzed · {analysis.answers.dropped} dropped</dd></div>
          <div><dt>Unobserved answers</dt><dd>{Math.max(0, study.candidates.length * scenarioCount - analysis.answers.total)} planned answers without score rows</dd></div>
          <div><dt>Judges and scorecards</dt><dd>{study.judges.length} judges · {scorecards == null ? 'Count unavailable' : `${scorecards} recorded scorecards`}</dd></div>
          <div><dt>Reasoning effort</dt><dd>{study.reasoningEffort ?? 'Not set (provider default)'}{study.reasoningEffort && ' for candidates and judges'}</dd></div>
          <div><dt>Dates (UTC)</dt><dd>Started {meta.startedAt || 'Not recorded'}<br/>Finished {meta.finishedAt || 'Not recorded'}</dd></div>
          <div><dt>Estimated cost</dt><dd>{money(meta.estimateUsd)}</dd></div>
          <div><dt>Recorded cost</dt><dd>{money(meta.actualUsd)}</dd></div>
        </dl>
      </div>
      <h3 className="study-subheading">Models and roles</h3>
      <div className="study-roster">{study.candidates.map(candidate => <div key={candidate.ref}><span>Candidate · {familyName(candidate.family)}</span><strong>{candidate.label}</strong><code>{candidate.ref}</code></div>)}{study.judges.map(judge => <div key={`judge-${judge.ref}`}><span>Judge · {familyName(judge.family)}</span><code>{judge.ref}</code></div>)}<div><span>Simulated participant</span><code>{study.participant}</code></div><div><span>Synthesizer</span><code>{study.synthesizer}</code></div></div>
      <div className="study-limits"><h3>What this does not show</h3><ul><li>A universal best model: results apply to these scenarios, criteria, and settings in this study.</li><li>Repeat-run reliability: one answer per candidate and scenario cannot measure variation across repeated attempts.</li><li>Proof of intentional favoritism: own-family offsets can reflect style preferences or the scoring criteria.</li><li>Human correctness or production readiness: agreement among model judges does not establish either.</li><li>A controlled test of answer order or reasoning effort: neither is varied here.</li></ul><p>Answers with fewer than two judges are dropped. Missing criteria use only returned scores; missing scores are never replaced with zero. Answers with no score rows are unobserved, separate from the dropped count.</p></div>
      <p className="study-note">Batch runs: {meta.runIds.map((runId, index) => <span key={runId}>{index > 0 && ' · '}<a href={href({ view: 'home', runId })}>{runId}</a></span>)}</p>
    </section>

    <section className="study-section study-download">
      <SectionHeading number="07" title="Inspect the raw data" detail="Every recorded criterion score, with its candidate, judge, scenario, and batch run."/>
      <a className="study-download-link" href={studyScoresUrl(study.id)} download>Download scores.csv <span aria-hidden="true">↓</span></a>
    </section>
  </article>;
}

export default function Study({ studyId, onLoad }: { studyId?: string; onLoad?: (study: StudyDocument['study']) => void }) {
  const [document, setDocument] = useState<StudyDocument>();
  const [error, setError] = useState<string>();
  const [scorecards, setScorecards] = useState<number | null>();
  useEffect(() => {
    let active = true;
    setDocument(undefined); setError(undefined); setScorecards(undefined);
    if (!studyId || !/^[a-z0-9-]{3,40}$/.test(studyId)) { setError('This link needs a valid study id.'); return; }
    void loadStudy(studyId).then(value => {
      if (value.study.id !== studyId) throw new Error('The study file does not match this link.');
      if (active) { setDocument(value); onLoad?.(value.study); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    void loadStudyScorecards(studyId).then(value => { if (active) setScorecards(value); }).catch(() => { if (active) setScorecards(null); });
    return () => { active = false; };
  }, [studyId, onLoad]);
  if (error) return <section className="study-report study-empty" role="alert"><h1>Study unavailable</h1><p>{error}</p><p>Check the study link or import its completed results, then reload this page.</p><a href="#/">Back to the workspace</a></section>;
  if (!document) return <div className="study-report" role="status">Loading the study report…</div>;
  return <Report key={document.study.id} document={document} scorecards={scorecards}/>;
}
