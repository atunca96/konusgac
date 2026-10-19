// 41 bits of milliseconds since EPOCH, 22 bits of per-millisecond sequence.
const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z

let lastTime = 0n;
let sequence = 0n;

export function snowflake(): string {
  let now = BigInt(Date.now());
  if (now <= lastTime) {
    now = lastTime;
    sequence = (sequence + 1n) & 0x3fffffn;
    if (sequence === 0n) now = lastTime + 1n;
  } else {
    sequence = 0n;
  }
  lastTime = now;
  return (((now - EPOCH) << 22n) | sequence).toString();
}

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + EPOCH);
}
