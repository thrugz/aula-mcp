/** Non-secret cache that outlives a process: the last working API version. */

import { paths, readIfExists, writeFileAtomic } from './files.js';

export interface State {
  apiVersion?: number;
}

export async function loadState(): Promise<State> {
  try {
    return JSON.parse((await readIfExists(paths.state())) ?? '{}') as State;
  } catch {
    return {};
  }
}

export async function saveState(patch: Partial<State>): Promise<void> {
  await writeFileAtomic(paths.state(), JSON.stringify({ ...(await loadState()), ...patch }));
}
