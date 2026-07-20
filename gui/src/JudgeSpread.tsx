type SpreadJudge = { role: string; name?: string; score: number };

export interface JudgeSpreadProps {
  judges: SpreadJudge[];
  final?: number;
  outlierRoles?: string[];
  compact?: boolean;
}

const clampScore = (score: number) => Math.min(10, Math.max(0, score));
const scoreClass = (score: number) => score <= 3 ? 'score-low' : score <= 6 ? 'score-mid' : 'score-high';
const displayRole = (role: string) => role.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());

export default function JudgeSpread({ judges, final, outlierRoles = [], compact = false }: JudgeSpreadProps) {
  if (!judges.length) return null;
  const scores = judges.map((judge) => clampScore(judge.score));
  const min = Math.min(...scores), max = Math.max(...scores);
  const outliers = new Set(outlierRoles.map((role) => role.toLowerCase()));
  return <div className={`judge-spread ${compact ? 'compact' : ''}`} role="img" aria-label={`Judge scores range from ${min.toFixed(1)} to ${max.toFixed(1)} out of 10${final == null ? '' : `; synthesized score ${clampScore(final).toFixed(1)}`}`}>
    <div className="judge-spread-axis">
      <span className="judge-spread-band" style={{ left: `${min * 10}%`, width: `${(max - min) * 10}%` }}/>
      {!compact && Array.from({ length: 11 }, (_, tick) => <i className={tick === 0 || tick === 5 || tick === 10 ? 'major' : ''} style={{ left: `${tick * 10}%` }} key={tick}/>)}
      {final != null && <span className="judge-spread-final" style={{ left: `${clampScore(final) * 10}%` }} title={`Synthesized score — ${clampScore(final).toFixed(1)}`}/>}
      {judges.map((judge, index) => {
        const score = scores[index] ?? 0;
        const outlier = outliers.has(judge.role.toLowerCase());
        return <svg className={`judge-spread-dot ${scoreClass(score)} ${outlier ? 'outlier' : ''}`} style={{ left: `${score * 10}%` }} viewBox="0 0 12 12" aria-hidden="true" key={`${judge.role}-${index}`}>
          <title>{judge.name ?? displayRole(judge.role)} — {score.toFixed(1)}</title>
          {outlier && <circle className="judge-spread-halo" cx="6" cy="6" r="5"/>}
          <circle cx="6" cy="6" r="3"/>
        </svg>;
      })}
    </div>
  </div>;
}
