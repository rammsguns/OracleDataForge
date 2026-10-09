import test from 'node:test';
import assert from 'node:assert/strict';
import { readPerformanceResources } from './performanceResources.ts';

test('missing privileges leave resources unavailable rather than reporting zero', async () => {
  const report = await readPerformanceResources(async () => []);
  assert.ok(report.groups.flatMap(g => g.metrics).every(m => m.value === 'Unavailable'));
  assert.deepEqual(report.waits, []);
});

test('resource units, cumulative shares, interval preference, and zero values', async () => {
  const report = await readPerformanceResources(async sql => {
    if (sql.includes('v$osstat')) return [
      { n: 'PHYSICAL_MEMORY_BYTES', v: 16 * 1024 ** 3 }, { n: 'FREE_MEMORY_BYTES', v: 4 * 1024 ** 3 },
      { n: 'BUSY_TIME', v: 200 }, { n: 'IDLE_TIME', v: 800 }, { n: 'USER_TIME', v: 100 },
    ];
    if (sql.includes('v$con_sysmetric')) return [{ n: 'Executions Per Sec', v: 0, interval: 6000 }];
    if (sql.includes('v$sysmetric')) return [
      { n: 'Executions Per Sec', v: 90, interval: 6000 },
      { n: 'CPU Usage Per Sec', v: 150, interval: 6000 },
      { n: 'Physical Read Total Bytes Per Sec', v: 2 * 1024 ** 2, interval: 6000 },
    ];
    if (sql.includes('v$iostat_file')) return [{ reads: 20, readMs: 100, writes: 0, writeMs: 0 }];
    return [];
  });
  const metric = (name: string) => report.groups.flatMap(g => g.metrics).find(m => m.label === name)!;
  assert.equal(metric('Physical RAM').value, '16 GiB');
  assert.equal(metric('Non-free host RAM').value, '12 GiB');
  assert.equal(metric('User CPU share').value, '10 %');
  assert.equal(metric('Idle CPU share').value, '80 %');
  assert.equal(metric('Executions').value, '0 /s');
  assert.match(metric('Executions').detail, /Container.*60 s/);
  assert.equal(metric('Database CPU').value, '1.5 CPU seconds/s');
  assert.equal(metric('Read throughput').value, '2 MiB/s');
  assert.equal(metric('Average file read latency').value, '5 ms');
  assert.equal(metric('Average file write latency').value, 'Unavailable');
});
