import { useEffect, useState } from 'react';

export type Route = { view: 'home' | 'model' | 'judges' | 'transcript' | 'replay' | 'about' | 'settings' | 'new' | 'build' | 'progress'; runId?: string; modelId?: string; scenarioId?: string };
export function href(route: Route) {
  if (route.view === 'about') return '#/about';
  if (route.view === 'settings') return '#/settings';
  if (route.view === 'new') return '#/new';
  if (route.view === 'build') return '#/build';
  if (route.view === 'progress') return `#/progress/${encodeURIComponent(route.runId ?? '')}`;
  if (route.view === 'replay') return route.runId ? `#/replay/${encodeURIComponent(route.runId)}` : '#/replay';
  const p = ['/'];
  if (route.runId) p.push('run', encodeURIComponent(route.runId));
  if (route.modelId) p.push('model', encodeURIComponent(route.modelId));
  if (route.scenarioId) p.push('scenario', encodeURIComponent(route.scenarioId));
  if (route.view === 'judges' || route.view === 'transcript') p.push(route.view);
  return `#${p.join('/').replaceAll('//', '/')}`;
}
function parse(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'about') return { view: 'about' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'new') return { view: 'new' };
  if (parts[0] === 'build') return { view: 'build' };
  if (parts[0] === 'progress') return { view: 'progress', runId: parts[1] };
  if (parts[0] === 'replay') return { view: 'replay', runId: parts[1] };
  const runAt = parts.indexOf('run'), modelAt = parts.indexOf('model'), scenarioAt = parts.indexOf('scenario');
  const tail = parts.at(-1);
  return { view: tail === 'judges' || tail === 'transcript' ? tail : modelAt >= 0 ? 'model' : 'home', runId: runAt >= 0 ? parts[runAt + 1] : undefined, modelId: modelAt >= 0 ? parts[modelAt + 1] : undefined, scenarioId: scenarioAt >= 0 ? parts[scenarioAt + 1] : undefined };
}
export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => { const update = () => setRoute(parse()); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  return route;
}
