// [foundation] Tiny synchronous event bus. engine.events = createEvents()
export function createEvents() {
  const map = new Map();
  const bus = {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => bus.off(name, fn);
    },
    off(name, fn) { map.get(name)?.delete(fn); },
    once(name, fn) {
      const wrap = (p) => { bus.off(name, wrap); fn(p); };
      return bus.on(name, wrap);
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set || set.size === 0) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(`[events:${name}] listener error`, e); }
      }
    },
    clear() { map.clear(); },
  };
  return bus;
}
