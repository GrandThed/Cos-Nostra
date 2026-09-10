// The bot's retry queue ("outbox") for backend writes. Phase 4 resilience: a backend
// deploy or a network blip must never lose a vote, so reaction writes go through here
// instead of straight to fetch. It is the mirror image of the backend's
// `plugins/bot.js` retry chain (same 1 s, 3 s, 9 s schedule), for the other direction.
//
// ORDERING GUARANTEE, and the whole point of this module: jobs are processed strictly
// FIFO, one at a time. A job's retries all finish -- or the job is dropped -- before
// the next job is attempted. A reaction add and the matching remove on the same
// message arrive as two jobs; if they were sent concurrently, or if a retry of the add
// could overtake the remove, the backend would store the wrong vote and the count
// would be wrong forever. So: never make this pump concurrent, never reorder or
// prioritize the queue, and never start a second pump loop.
//
// Nothing here is persisted. A crash loses the backlog; that is the accepted tradeoff
// for phase 4 (votes are recoverable from Discord's reaction lists), and the interface
// leaves room for a durable store later without touching the callers.

import { setTimeout as sleepFor } from 'node:timers/promises';

const DEFAULT_DELAYS = [1_000, 3_000, 9_000];

/**
 * @typedef {(ms: number, signal: AbortSignal) => unknown} Sleeper
 */

/**
 * Waits `ms`, or rejects when `signal` aborts. `ref: false` unrefs the timer, so a
 * pending retry never keeps the process alive after the bot has been told to exit.
 * @type {Sleeper}
 */
const realSleep = (ms, signal) => sleepFor(ms, undefined, { ref: false, signal });

/**
 * @typedef {object} OutboxOptions
 * @property {(job: any) => Promise<unknown>} send  Performs one delivery attempt. A
 *   rejection (or a synchronous throw) means "retry".
 * @property {(job: any, error: unknown) => unknown} [onError]  Called once, with the
 *   last error, when a job is dropped after the final attempt.
 * @property {number[]} [delays]  Retry schedule in ms; `delays.length + 1` attempts in
 *   total. Defaults to the backend's 1 s, 3 s, 9 s. `[]` disables retries.
 * @property {{ warn?: Function, error?: Function }} [log]  pino-style logger.
 * @property {Sleeper} [sleep]  Tests only, to keep the suite instant. Production always
 *   uses the unref'd `node:timers/promises` sleep.
 */

/**
 * @typedef {object} Outbox
 * @property {(job: any) => void} enqueue
 * @property {() => number} size
 * @property {() => Promise<void>} drain
 * @property {() => void} stop
 */

/**
 * @param {OutboxOptions} options
 * @returns {Outbox}
 */
export function createOutbox({ send, onError, delays, log, sleep: napFor = realSleep } = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createOutbox requires a send(job) function');
  }
  // Copied so a caller mutating its array cannot change the schedule mid-flight.
  const schedule = Array.isArray(delays) ? [...delays] : [...DEFAULT_DELAYS];

  /** Waiting jobs, oldest first. The in-flight job stays at index 0 until it settles. */
  const queue = [];
  /** Resolvers handed out by drain(). All of them fire together. */
  const waiters = [];
  const abort = new AbortController();
  /** True while a pump loop is active. */
  let running = false;
  let stopped = false;

  function settleWaiters() {
    while (waiters.length > 0) waiters.shift()();
  }

  /**
   * Logging must never be able to break delivery, so every call is guarded.
   * @param {'warn' | 'error'} level
   * @param {any} job
   * @param {number | null} attempt
   * @param {unknown} err
   * @param {string} msg
   */
  function report(level, job, attempt, err, msg) {
    try {
      log?.[level]?.({ job, attempt, err: err instanceof Error ? err.message : String(err) }, msg);
    } catch {
      // A broken logger is not a reason to lose a vote.
    }
  }

  /**
   * Sleeps between attempts.
   * @param {number} ms
   * @returns {Promise<boolean>} false when the outbox was stopped meanwhile.
   */
  async function nap(ms) {
    try {
      await napFor(ms, abort.signal);
    } catch {
      return false; // aborted by stop()
    }
    return !stopped;
  }

  /**
   * Runs the first attempt and the whole retry chain for one job. Never rejects.
   * @param {any} job
   * @returns {Promise<boolean>} true when the job is finished with (delivered or
   *   dropped) and can leave the queue; false when we bailed out because of stop().
   */
  async function deliver(job) {
    for (let attempt = 0; attempt <= schedule.length; attempt++) {
      try {
        await send(job);
        return true;
      } catch (err) {
        const error = err ?? new Error('send() rejected without an error');
        // Shutting down: do not retry and do not report. The backlog is abandoned on
        // purpose so stop() cannot hang, and size() still shows what never went out.
        if (stopped) return false;
        const last = attempt === schedule.length;
        report(
          last ? 'error' : 'warn',
          job,
          attempt,
          error,
          last ? 'outbox job failed, giving up' : 'outbox job failed, will retry',
        );
        if (last) {
          if (onError) {
            try {
              // Awaited so a slow onError cannot let the next job overtake this one.
              await onError(job, error);
            } catch (hookErr) {
              report('error', job, attempt, hookErr, 'outbox onError threw');
            }
          }
          return true; // dropped, but done with: continue with the next job
        }
        if (!(await nap(schedule[attempt]))) return false;
      }
    }
    return true; // unreachable: the loop always returns
  }

  /** The single serial pump. Never rejects. At most one instance runs at a time. */
  async function pump() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length > 0) {
        const job = queue[0]; // stays at the head so size() counts the in-flight job
        const done = await deliver(job);
        if (done) queue.shift();
        if (stopped) break;
      }
    } finally {
      running = false;
      if (stopped || queue.length === 0) settleWaiters();
    }
  }

  return {
    /**
     * Append a job and kick the pump. Synchronous and fire-and-forget: callers are
     * Discord event handlers, where a throw or an unhandled rejection would take the
     * process down, so this never throws and never returns a promise. A no-op after
     * stop().
     * @param {any} job
     * @returns {void}
     */
    enqueue(job) {
      try {
        if (stopped) return;
        queue.push(job);
        // pump() swallows everything itself; this catch is the last line of defence.
        pump().catch((err) => report('error', job, null, err, 'outbox pump crashed'));
      } catch (err) {
        report('error', job, null, err, 'outbox enqueue failed');
      }
    },

    /** Jobs still waiting, including the one in flight. */
    size() {
      return queue.length;
    },

    /**
     * Resolves when the queue is empty and nothing is in flight, immediately if the
     * outbox is already idle or stopped. Any number of callers may wait at once.
     * @returns {Promise<void>}
     */
    drain() {
      if (stopped || (!running && queue.length === 0)) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },

    /**
     * Stop delivering. Cancels a pending retry sleep, makes further enqueue calls
     * no-ops and releases every drain() waiter, so shutdown can never hang on the
     * outbox. Not resumable: build a new outbox instead.
     */
    stop() {
      if (stopped) return;
      stopped = true;
      abort.abort();
      settleWaiters();
    },
  };
}
