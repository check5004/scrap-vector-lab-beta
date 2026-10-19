import type { SearchResult } from './auto-tune';

/** Same-mask refinement must never forget a warning learned at another epsilon/threshold. */
export function mergeSearchResults(previous: SearchResult, refinement: SearchResult): SearchResult {
  const all=[...previous.candidates,...refinement.candidates];
  const merged=new Map(previous.candidates.map(c=>[c.id,c]));
  refinement.candidates.forEach(c=>merged.set(c.id,c));
  const min=(values:number[])=>Math.min(...values),max=(values:number[])=>Math.max(...values);
  const holeMin=all.length?min(all.map(c=>c.metrics.observedHoleCountMin)):0;
  const holeMax=all.length?max(all.map(c=>c.metrics.observedHoleCountMax)):0;
  const componentMin=all.length?min(all.map(c=>c.metrics.observedComponentCountMin)):0;
  const componentMax=all.length?max(all.map(c=>c.metrics.observedComponentCountMax)):0;
  const topology=holeMin!==holeMax||componentMin!==componentMax||all.some(c=>c.metrics.topologyVariesAcrossThresholds);
  const region=all.some(c=>c.metrics.regionVariesAcrossThresholds)||(all.length>1&&min(all.map(c=>c.metrics.selectedComponentPixels))/max(all.map(c=>c.metrics.selectedComponentPixels))<0.75);
  const candidates=[...merged.values()].map(c=>({
    ...c,metrics:{...c.metrics,observedHoleCountMin:holeMin,observedHoleCountMax:holeMax,observedComponentCountMin:componentMin,observedComponentCountMax:componentMax,topologyVariesAcrossThresholds:topology,regionVariesAcrossThresholds:region},
    warnings:[...new Set([...c.warnings,...(topology||region?['Later search found hole/component/region ambiguity in this same neural mask. Earlier candidates also require manual adoption.']:[])])],
    grade:topology||region?'ambiguous' as const:c.grade,
    safeToAutoApply:c.safeToAutoApply&&!topology&&!region,
  })).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  return {...refinement,candidates,best:candidates[0],attempts:[...previous.attempts,...refinement.attempts],elapsedMs:previous.elapsedMs+refinement.elapsedMs,universalWarnings:[...new Set([...previous.universalWarnings,...refinement.universalWarnings])]};
}
