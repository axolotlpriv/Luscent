let counter = 0;

/** Short, collision-resistant id (time + counter + randomness). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0x10000;
  const rand = Math.floor(Math.random() * 0x1000000).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
