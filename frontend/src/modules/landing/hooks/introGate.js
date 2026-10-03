/**
 * One-shot gate between the intro curtain and the hero animation.
 *
 * The hero timeline must not build its hidden state until the curtain is
 * actually about to lift, otherwise a curtain that never finishes would leave the
 * hero invisible behind it. Everything that waits on the intro goes through
 * `onIntro`, and `markIntroDone` is called unconditionally — including from the
 * preloader's own hard timeout — so the gate always opens.
 */

const KEY = 'connect-bharat:intro-played';
const EVENT = 'connect-bharat:intro-done';

let done = false;
try {
  done = sessionStorage.getItem(KEY) === '1';
} catch {
  // private mode / storage disabled — just play the intro again
}

export const introAlreadyPlayed = () => done;

export function markIntroDone() {
  if (done) return;
  done = true;
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `cb` once the intro is over, or immediately if it already is. */
export function onIntro(cb) {
  if (done) {
    cb();
    return () => {};
  }
  window.addEventListener(EVENT, cb, { once: true });
  return () => window.removeEventListener(EVENT, cb);
}
