import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOutbox } from '../src/outbox.js';

const OUTBOX_URL = pathToFileURL(join(import.meta.dirname, '../src/outbox.js')).href;

/** Lets a test hold a send() open and release it on demand. */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  /** @type {(reason?: unknown) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Runs pending microtasks and immediates, so "nothing else happened" is provable. */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A sleeper that records the delays it was asked for instead of waiting. Every test
 * that exercises retries uses one, so the suite never sleeps for real.
 * @param {number[]} napped
 */
const fakeSleep = (napped) => async (ms) => {
  napped.push(ms);
};

test('a successful job is sent exactly once', async () => {
  const sent = [];
  const outbox = createOutbox({ send: async (job) => void sent.push(job) });
  const job = { kind: 'vote', messageId: 'm1' };

  assert.equal(outbox.enqueue(job), undefined, 'enqueue is fire-and-forget');
  await outbox.drain();

  assert.deepEqual(sent, [job]);
  assert.equal(outbox.size(), 0);
});

test('a job that fails twice then succeeds is sent three times, consuming the delays in order', async () => {
  const napped = [];
  let attempts = 0;
  const outbox = createOutbox({
    send: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error(`attempt ${attempts} failed`);
    },
    delays: [10, 20, 30],
    sleep: fakeSleep(napped),
    onError: () => assert.fail('onError must not fire for a job that eventually succeeds'),
  });

  outbox.enqueue({ id: 'flaky' });
  await outbox.drain();

  assert.equal(attempts, 3);
  assert.deepEqual(napped, [10, 20], 'waited delays[0] then delays[1], and no more');
  assert.equal(outbox.size(), 0);
});

test('a job that always fails is dropped after delays.length + 1 attempts and reported once', async () => {
  const napped = [];
  const errors = [];
  const delays = [1, 2, 3];
  let attempts = 0;
  let lastThrown;
  const job = { id: 'doomed' };
  const outbox = createOutbox({
    send: async () => {
      attempts += 1;
      lastThrown = new Error(`boom ${attempts}`);
      throw lastThrown;
    },
    delays,
    sleep: fakeSleep(napped),
    onError: (failedJob, error) => errors.push({ failedJob, error }),
  });

  outbox.enqueue(job);
  await outbox.drain();

  assert.equal(attempts, delays.length + 1, '1 first attempt + 3 retries');
  assert.deepEqual(napped, delays, 'every delay used, in order');
  assert.equal(errors.length, 1, 'onError fires exactly once');
  assert.equal(errors[0].failedJob, job, 'onError gets the job itself');
  assert.equal(errors[0].error, lastThrown, 'onError gets the error from the last attempt');
  assert.equal(outbox.size(), 0, 'the dropped job leaves the queue');
});

test('the default retry schedule matches the backend: 1 s, 3 s, 9 s', async () => {
  const napped = [];
  const outbox = createOutbox({
    send: async () => {
      throw new Error('always');
    },
    sleep: fakeSleep(napped),
  });

  outbox.enqueue({ id: 'defaults' });
  await outbox.drain();

  assert.deepEqual(napped, [1_000, 3_000, 9_000]);
});

test('jobs are processed strictly FIFO, one at a time, across failures', async () => {
  // The ordering guarantee this module exists for: a reaction add and the matching
  // remove must reach the backend in the order Discord delivered them, even when the
  // add needs retries and even when a job in between is dropped.
  const observed = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const failuresLeft = new Map([
    ['add', 1], // succeeds on its second attempt
    ['stray', 99], // never succeeds: dropped after 4 attempts
  ]);
  const dropped = [];
  const outbox = createOutbox({
    send: async (job) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      observed.push(job.id);
      try {
        const left = failuresLeft.get(job.id) ?? 0;
        if (left > 0) {
          failuresLeft.set(job.id, left - 1);
          throw new Error(`${job.id} failed`);
        }
      } finally {
        inFlight -= 1;
      }
    },
    delays: [0, 0, 0],
    sleep: fakeSleep([]),
    onError: (job) => dropped.push(job.id),
  });

  for (const id of ['add', 'remove', 'stray', 'add2']) outbox.enqueue({ id });
  await outbox.drain();

  assert.deepEqual(
    observed,
    ['add', 'add', 'remove', 'stray', 'stray', 'stray', 'stray', 'add2'],
    'every attempt of a job finishes before the next job starts',
  );
  assert.equal(maxInFlight, 1, 'never more than one send in flight');
  assert.deepEqual(dropped, ['stray']);
});

test('size() counts the backlog including the in-flight job', async () => {
  const gate = deferred();
  let sends = 0;
  const outbox = createOutbox({
    send: async () => {
      sends += 1;
      await gate.promise;
    },
  });

  assert.equal(outbox.size(), 0, 'empty to start');
  outbox.enqueue({ id: 1 });
  outbox.enqueue({ id: 2 });
  outbox.enqueue({ id: 3 });
  await flush();

  assert.equal(sends, 1, 'only the head is being sent');
  assert.equal(outbox.size(), 3, 'two waiting plus the one in flight');

  gate.resolve();
  await outbox.drain();
  assert.equal(sends, 3);
  assert.equal(outbox.size(), 0);
});

test('drain() resolves only after the last job settles, and concurrent drains all resolve', async () => {
  const gate = deferred();
  const settled = [];
  const outbox = createOutbox({
    send: async (job) => {
      await gate.promise;
      settled.push(job.id);
    },
  });

  outbox.enqueue({ id: 'a' });
  outbox.enqueue({ id: 'b' });

  let first = false;
  let second = false;
  const drains = [
    outbox.drain().then(() => {
      first = true;
    }),
    outbox.drain().then(() => {
      second = true;
    }),
  ];
  await flush();
  assert.deepEqual(settled, [], 'nothing has finished yet');
  assert.equal(first, false, 'drain does not resolve while a job is in flight');
  assert.equal(second, false);

  gate.resolve();
  await Promise.all(drains);

  assert.deepEqual(settled, ['a', 'b'], 'both jobs settled before the drains resolved');
  assert.equal(first, true);
  assert.equal(second, true, 'the second concurrent drain resolves too');
  assert.equal(outbox.size(), 0);
});

test('drain() on an idle outbox resolves immediately', async () => {
  const outbox = createOutbox({ send: async () => {} });
  await outbox.drain();

  outbox.enqueue({ id: 'x' });
  await outbox.drain();
  await outbox.drain(); // idle again
  assert.equal(outbox.size(), 0);
});

test('stop() prevents further sends and enqueue after stop() is a no-op', async () => {
  const gate = deferred();
  const sent = [];
  const napped = [];
  const outbox = createOutbox({
    send: async (job) => {
      sent.push(job.id);
      await gate.promise;
    },
    delays: [5, 5, 5],
    sleep: fakeSleep(napped),
    onError: () => assert.fail('a stopped outbox must not report dropped jobs'),
  });

  outbox.enqueue({ id: 'a' });
  outbox.enqueue({ id: 'b' });
  await flush();
  assert.deepEqual(sent, ['a']);

  outbox.stop();
  gate.reject(new Error('backend went away mid-flight'));
  await flush();

  assert.deepEqual(sent, ['a'], 'the in-flight failure is not retried and b is never sent');
  assert.deepEqual(napped, [], 'no retry was scheduled after stop()');

  assert.equal(outbox.enqueue({ id: 'c' }), undefined);
  await flush();
  assert.deepEqual(sent, ['a'], 'enqueue after stop() is a no-op');
  assert.equal(outbox.size(), 2, 'the undelivered backlog is still visible, not sent');

  await outbox.drain(); // must not hang
  outbox.stop(); // idempotent
});

test('stop() cancels the pending retry timer', async () => {
  // The injected sleeper stands in for the unref'd timer and only settles when the
  // outbox aborts it, so the abort is directly observable: if stop() did not cancel
  // the sleep, `pending` below would never settle and the pump would stay parked on
  // the retry forever.
  const sent = [];
  /** @type {AbortSignal} */
  let signal;
  /** @type {Promise<never>} */
  let pending;
  const outbox = createOutbox({
    send: async (job) => {
      sent.push(job.id);
      throw new Error('backend is deploying');
    },
    delays: [600_000],
    sleep: (ms, abortSignal) => {
      signal = abortSignal;
      pending = new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('sleep aborted')), {
          once: true,
        });
      });
      return pending;
    },
  });

  outbox.enqueue({ id: 'pending' });
  await flush();
  assert.deepEqual(sent, ['pending'], 'first attempt ran, retry sleep is pending');
  assert.equal(signal.aborted, false);

  outbox.stop();
  assert.equal(signal.aborted, true, 'stop() aborts the signal the retry sleep waits on');
  await assert.rejects(pending, /sleep aborted/, 'the pending retry sleep was cancelled');
  await outbox.drain(); // must not hang
  await flush();
  assert.deepEqual(sent, ['pending'], 'the cancelled retry never fired');
});

test('stop() while a real retry timer is pending still lets drain() resolve', async () => {
  // Same shutdown path, but through the production sleeper: a ten-minute delay is
  // armed for real, so if drain() waited on it this test would never finish.
  const sent = [];
  const outbox = createOutbox({
    send: async (job) => {
      sent.push(job.id);
      throw new Error('backend is deploying');
    },
    delays: [600_000],
  });

  outbox.enqueue({ id: 'pending' });
  await flush();
  assert.deepEqual(sent, ['pending']);

  outbox.stop();
  await outbox.drain();
  await flush();
  assert.deepEqual(sent, ['pending'], 'no retry after stop()');
});

test('enqueue never throws, even when send throws synchronously', async () => {
  const errors = [];
  const outbox = createOutbox({
    // Deliberately not async: a synchronous throw must be treated like a rejection.
    send: (job) => {
      throw new Error(`sync boom for ${job.id}`);
    },
    delays: [],
    onError: (job, error) => errors.push({ job, error }),
  });

  const job = { id: 'sync' };
  assert.doesNotThrow(() => outbox.enqueue(job));
  await outbox.drain();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].job, job);
  assert.equal(errors[0].error.message, 'sync boom for sync');
  assert.equal(outbox.size(), 0);

  // A later good job still goes out: one bad send does not wedge the pump.
  const sent = [];
  const ok = createOutbox({ send: async (j) => void sent.push(j.id) });
  ok.enqueue({ id: 'after' });
  await ok.drain();
  assert.deepEqual(sent, ['after']);
});

test('a throwing onError does not wedge the queue', async () => {
  const sent = [];
  const outbox = createOutbox({
    send: async (job) => {
      sent.push(job.id);
      if (job.id === 'bad') throw new Error('nope');
    },
    delays: [],
    onError: () => {
      throw new Error('onError is broken');
    },
  });

  outbox.enqueue({ id: 'bad' });
  outbox.enqueue({ id: 'good' });
  await outbox.drain();

  assert.deepEqual(sent, ['bad', 'good']);
  assert.equal(outbox.size(), 0);
});

test('a pending retry timer does not keep the process alive', async () => {
  // unref() proof: a child process whose only remaining work is a ten-minute retry
  // sleep must exit on its own. Without ref: false it would sit there for ten minutes.
  const script = [
    `const { createOutbox } = await import(${JSON.stringify(OUTBOX_URL)});`,
    `const outbox = createOutbox({`,
    `  send: async () => { console.log('attempted'); throw new Error('down'); },`,
    `  delays: [600000],`,
    `});`,
    `outbox.enqueue({ id: 'only' });`,
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const watchdog = setTimeout(() => child.kill(), 5_000);
  const { code, signal } = await new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(watchdog);

  assert.equal(signal, null, 'child had to be killed: the pending retry kept it alive');
  assert.equal(code, 0, `child exited badly: ${stderr}`);
  assert.match(stdout, /attempted/, 'the child really did schedule a retry');
});
