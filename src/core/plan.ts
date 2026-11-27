import type { Hunk, Layer, Plan, Risk } from './types.ts';
import { UNPLACED_ID, UNSTACKED_ID } from './types.ts';

export const LIMITS = { title: 60, why: 800, explain: 2000, minLayers: 1, maxLayers: 30 } as const;
const RISKS: readonly Risk[] = ['low', 'med', 'high'];

export type ValidationFailure = {
  ok: false;
  missing: { id: string; path: string; header: string }[];
  duplicated: { id: string; layers: string[] }[];
  unknown: string[];
  errors: string[];
};
export type ValidationResult = { ok: true; plan: Plan } | ValidationFailure;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate an agent-submitted plan against the hunks in the current diff. */
export function validatePlan(input: unknown, hunks: Hunk[]): ValidationResult {
  const errors: string[] = [];
  const fail = (): ValidationFailure => ({ ok: false, missing: [], duplicated: [], unknown: [], errors });
  if (!isRecord(input)) {
    errors.push('plan must be a JSON object');
    return fail();
  }
  if (input.version !== 1) errors.push('version must be 1');
  if (typeof input.title !== 'string' || input.title.trim() === '') errors.push('title must be a non-empty string');
  if (input.summary !== undefined && typeof input.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(input.layers)) {
    errors.push('layers must be an array');
    return fail();
  }
  const rawLayers = input.layers as unknown[];
  if (rawLayers.length < LIMITS.minLayers || rawLayers.length > LIMITS.maxLayers) {
    errors.push(`plan must have ${LIMITS.minLayers} to ${LIMITS.maxLayers} layers, got ${rawLayers.length}`);
  }

  const layers: Layer[] = [];
  const positions = new Map<string, number>();
  rawLayers.forEach((raw, idx) => {
    const label = isRecord(raw) && typeof raw.id === 'string' && raw.id ? raw.id : `layers[${idx}]`;
    if (!isRecord(raw)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') errors.push(`${label}.id must be a non-empty string`);
    else if (positions.has(raw.id)) errors.push(`duplicate layer id ${raw.id}`);
    else positions.set(raw.id, idx);
    if (typeof raw.title !== 'string' || raw.title.trim() === '') errors.push(`${label}.title must be a non-empty string`);
    else if ([...raw.title].length > LIMITS.title)
      errors.push(`${label}.title is ${[...raw.title].length} characters, the limit is ${LIMITS.title}`);
    if (typeof raw.why !== 'string') errors.push(`${label}.why must be a string`);
    else if ([...raw.why].length > LIMITS.why)
      errors.push(`${label}.why is ${[...raw.why].length} characters, the limit is ${LIMITS.why}`);
    if (typeof raw.risk !== 'string' || !RISKS.includes(raw.risk as Risk))
      errors.push(`${label}.risk must be one of low, med, high`);
    if (raw.group !== undefined && typeof raw.group !== 'string') errors.push(`${label}.group must be a string`);
    if (raw.explain !== undefined && typeof raw.explain !== 'string') errors.push(`${label}.explain must be a string`);
    else if (typeof raw.explain === 'string' && [...raw.explain].length > LIMITS.explain)
      errors.push(`${label}.explain is ${[...raw.explain].length} characters, the limit is ${LIMITS.explain}`);
    if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== 'string')))
      errors.push(`${label}.dependsOn must be an array of layer ids`);
    let hunkIds: string[] = [];
    if (!Array.isArray(raw.hunks) || raw.hunks.some((h) => typeof h !== 'string')) {
      errors.push(`${label}.hunks must be an array of hunk ids`);
    } else {
      hunkIds = raw.hunks as string[];
      if (hunkIds.length === 0) errors.push(`${label} has no hunks`);
    }
    layers.push({
      id: typeof raw.id === 'string' ? raw.id : label,
      group: typeof raw.group === 'string' && raw.group.trim() ? raw.group : undefined,
      title: typeof raw.title === 'string' ? raw.title : '',
      why: typeof raw.why === 'string' ? raw.why : '',
      risk: (RISKS.includes(raw.risk as Risk) ? raw.risk : 'low') as Risk,
      dependsOn: Array.isArray(raw.dependsOn) ? (raw.dependsOn.filter((d) => typeof d === 'string') as string[]) : undefined,
      hunks: hunkIds,
      explain: typeof raw.explain === 'string' && raw.explain.trim() ? raw.explain : undefined,
    });
  });

  layers.forEach((layer, idx) => {
    for (const dep of layer.dependsOn ?? []) {
      const pos = positions.get(dep);
      if (dep === layer.id) errors.push(`${layer.id}.dependsOn references itself`);
      else if (pos === undefined) errors.push(`${layer.id}.dependsOn references ${dep}, which does not exist`);
      else if (pos > idx) errors.push(`${layer.id}.dependsOn references ${dep}, which comes later`);
    }
  });

  const known = new Map(hunks.map((h) => [h.id, h]));
  const placements = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const layer of layers) {
    for (const id of layer.hunks) {
      if (!known.has(id)) {
        if (!unknown.includes(id)) unknown.push(id);
        continue;
      }
      const list = placements.get(id) ?? [];
      list.push(layer.id);
      placements.set(id, list);
    }
  }
  const missing = hunks
    .filter((h) => !placements.has(h.id))
    .map((h) => ({ id: h.id, path: h.path, header: h.header }));
  const duplicated = [...placements.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(([id, ls]) => ({ id, layers: ls }));

  if (errors.length || missing.length || duplicated.length || unknown.length) {
    return { ok: false, missing, duplicated, unknown, errors };
  }
  const plan: Plan = {
    version: 1,
    title: input.title as string,
    summary: typeof input.summary === 'string' ? input.summary : undefined,
    layers: layers.map((l) => ({
      id: l.id,
      ...(l.group ? { group: l.group } : {}),
      title: l.title,
      why: l.why,
      risk: l.risk,
      ...(l.dependsOn && l.dependsOn.length ? { dependsOn: l.dependsOn } : {}),
      hunks: l.hunks,
      ...(l.explain ? { explain: l.explain } : {}),
    })),
  };
  return { ok: true, plan };
}

export function unstackedPlan(hunks: Hunk[]): Plan {
  return {
    version: 1,
    title: 'Unstacked',
    layers: [{ id: UNSTACKED_ID, title: 'Unstacked', why: '', risk: 'low', hunks: hunks.map((h) => h.id) }],
  };
}

export type Reconciled = {
  /** The agent plan with vanished hunks dropped (no Unplaced layer); null when there is no plan. */
  stored: Plan | null;
  /** The plan the UI shows: stored plus an Unplaced layer, or the Unstacked plan. */
  view: Plan;
  stale: boolean;
  newHunks: string[];
  hasPlan: boolean;
};

/** Keep a plan across a diff reload: drop hunks that disappeared and collect new ones in an Unplaced layer. */
export function reconcilePlan(plan: Plan | null, hunks: Hunk[]): Reconciled {
  if (!plan) return { stored: null, view: unstackedPlan(hunks), stale: false, newHunks: [], hasPlan: false };
  const known = new Set(hunks.map((h) => h.id));
  const placed = new Set<string>();
  const layers: Layer[] = [];
  for (const l of plan.layers) {
    if (l.id === UNPLACED_ID) continue;
    const kept = l.hunks.filter((id) => known.has(id) && !placed.has(id));
    kept.forEach((id) => placed.add(id));
    if (kept.length) layers.push({ ...l, hunks: kept });
  }
  const ids = new Set(layers.map((l) => l.id));
  for (const l of layers) if (l.dependsOn) l.dependsOn = l.dependsOn.filter((d) => ids.has(d));
  const newHunks = hunks.filter((h) => !placed.has(h.id)).map((h) => h.id);
  const stored: Plan = { ...plan, layers };
  const viewLayers = [...layers];
  if (newHunks.length) {
    viewLayers.push({
      id: UNPLACED_ID,
      title: 'Unplaced',
      why: 'Hunks that appeared after the plan was made. Ask the agent to re-plan, or review them here.',
      risk: 'med',
      hunks: newHunks,
    });
  }
  return { stored, view: { ...plan, layers: viewLayers }, stale: newHunks.length > 0, newHunks, hasPlan: true };
}
