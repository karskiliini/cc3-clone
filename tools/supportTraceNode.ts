import { writeFileSync } from 'node:fs';
import { supportTrace } from './supportTrace';
const limit = Number(process.argv[3]);
writeFileSync(process.argv[2], JSON.stringify([false, true].map(night =>
  supportTrace(night, Number.isFinite(limit) && limit > 0 ? limit : undefined))));
