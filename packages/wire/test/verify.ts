import { readFileSync } from 'node:fs';
import {
  Job,
  gateVerdict,
  GATE_DEFAULT_TIMEOUT_MS,
} from '../../srv/patch/packages/wire/src/jobs.js';

const raw = JSON.parse(readFileSync('/tmp/foreman-gate-work/job.json', 'utf8'));
const parsed = Job.safeParse(raw);
if (!parsed.success) {
  console.error('SCHEMA REJECTED:');
  console.error(JSON.stringify(parsed.error.issues, null, 2));
  process.exit(1);
}
const job = parsed.data;
console.log('SCHEMA OK — Job.parse accepted the file');
console.log('  id          :', job.id);
console.log('  name        :', job.name);
console.log('  enabled     :', job.enabled);
console.log('  trigger     :', JSON.stringify(job.trigger));
console.log('  filter      :', job.filter);
console.log('  concurrency :', job.concurrency);
console.log('  gate.daemon :', job.gate?.daemonId);
console.log('  gate.folder :', job.gate?.folder);
console.log('  gate.lines  :', job.gate?.command.split('\n').length);
console.log(
  '  gate.timeout:',
  job.gate?.timeoutMs ?? `(unset → GATE_DEFAULT_TIMEOUT_MS ${GATE_DEFAULT_TIMEOUT_MS}ms)`,
);
console.log('  action      :', JSON.stringify(job.action));
console.log('  no `script` action left:', job.action.type !== 'script');
console.log('  no `patch chats spawn` in the gate:', !job.gate!.command.includes('chats spawn'));
console.log(
  '  no ~/.foreman/gate.json in the gate:',
  !job.gate!.command.includes('.foreman/gate.json'),
);
console.log(
  '  verdicts: exit0 ->',
  gateVerdict(0, 'due — starting the coach'),
  '| exit1+reason ->',
  gateVerdict(1, 'quiet hours — holding'),
  '| exit1+silent ->',
  gateVerdict(1, ''),
  '| exit3 ->',
  gateVerdict(3, ''),
);
