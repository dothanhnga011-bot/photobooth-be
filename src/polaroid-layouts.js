// Package rules for new Polaroid sessions; an existing booking keeps its time snapshot.
const DURATIONS = { 1: 3, 2: 5 };
export const polaroidDuration = (count) => DURATIONS[Number(count)] || null;
export function polaroidPackage(pack) {
  const duration = pack?.printSize === "instax" && polaroidDuration(pack.selectCount);
  return duration ? { ...pack, duration, shots: 0, prints: 1 } : pack;
}
