import { useEffect, useState } from 'react';

export type Route = { view: 'home' | 'model' | 'judges' | 'transcript' | 'about'; runId?: string; modelId?: string; scenarioId?: string };
export function href(route: Route) {
  const p = ['/'];
  if (route.runId) p.push('run', encodeURIComponent(route.runId));
  if (route.modelId) p.push('model', encodeURIComponent(route.modelId));
  if (route.scenarioId) p.push('scenario', encodeURIComponent(route.scenarioId));
  if (route.view === 'judges' || route.view === 'transcript') p.push(route.view);
  if (route.view === 'about') return '#/about';
  return `#${p.join('/').replaceAll('//', '/')}`;
}
function parse(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'about') return { view: 'about' };
  const runAt = parts.indexOf('run'), modelAt = parts.indexOf('model'), scenarioAt = parts.indexOf('scenario');
  const tail = parts.at(-1);
  return { view: tail === 'judges' || tail === 'transcript' ? tail : modelAt >= 0 ? 'model' : 'home', runId: runAt >= 0 ? parts[runAt + 1] : undefined, modelId: modelAt >= 0 ? parts[modelAt + 1] : undefined, scenarioId: scenarioAt >= 0 ? parts[scenarioAt + 1] : undefined };
}
export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => { const update = () => setRoute(parse()); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  return route;
}