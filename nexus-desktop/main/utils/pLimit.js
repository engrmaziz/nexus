'use strict';

/**
 * Inline concurrency limiter – CommonJS replacement for the ESM-only p-limit package.
 *
 * @param {number} concurrency  Maximum number of promises running at once.
 * @returns {function}          A `limit` function that wraps async tasks.
 */
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  function run() {
    while (active < concurrency && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; run(); });
    }
  }
  return function limit(fn) {
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
  };
}

module.exports = pLimit;
