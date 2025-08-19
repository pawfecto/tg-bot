const albumMap = new Map<string, string>();           // mgid -> shipmentId
const debounceTimers = new Map<string, NodeJS.Timeout>();
const TTL = 5 * 60 * 1000;

export function rememberAlbum(mgid: string, shipmentId: string) {
  albumMap.set(mgid, shipmentId);
  setTimeout(() => albumMap.delete(mgid), TTL).unref?.();
}
export function getShipmentIdByMgid(mgid?: string|null) {
  return mgid ? albumMap.get(mgid) ?? null : null;
}
export function scheduleDebounce(mgid: string, cb: (shipmentId: string)=>void, delayMs=1500) {
  const old = debounceTimers.get(mgid); if (old) clearTimeout(old);
  const t = setTimeout(() => {
    debounceTimers.delete(mgid);
    const sid = albumMap.get(mgid);
    if (sid) cb(sid);
  }, delayMs);
  debounceTimers.set(mgid, t);
}
