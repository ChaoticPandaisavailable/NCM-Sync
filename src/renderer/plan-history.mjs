export function createPlanHistory(targets) { return { targets, past: [], future: [] }; }

export function planHistory(state, event) {
  if (event.type === 'move') {
    const from = state.targets[event.id];
    if (!from || from === event.to || !['add', 'remove', 'keep'].includes(event.to)) return state;
    const change = { id: event.id, from, to: event.to };
    return { targets: { ...state.targets, [event.id]: event.to }, past: [...state.past.slice(-99), change], future: [] };
  }
  if (event.type === 'undo' && state.past.length) {
    const change = state.past.at(-1);
    return { targets: { ...state.targets, [change.id]: change.from }, past: state.past.slice(0, -1), future: [...state.future, change] };
  }
  if (event.type === 'redo' && state.future.length) {
    const change = state.future.at(-1);
    return { targets: { ...state.targets, [change.id]: change.to }, past: [...state.past, change], future: state.future.slice(0, -1) };
  }
  return state;
}
