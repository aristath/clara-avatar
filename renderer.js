/**
 * Clara Avatar Kiosk — Renderer
 *
 * Two stacked divs, CSS background-position for frame/drift animation,
 * CSS transform for expression switches. Pure CSS transitions, no canvas.
 */

const {
  maskColor: MASK_COLOR,
  expressionsUrl: EXPRESSIONS_URL,
  switchMs: SWITCH_MS,
  switchTimingFunction: SWITCH_TIMING_FUNCTION,
  pollIntervalMs: POLL_INTERVAL_MS,
  glitchIntervalMs: GLITCH_INTERVAL_MS,
  glitchDurationMs: GLITCH_DURATION_MS,
  glitchForceHorizontal: GLITCH_FORCE_HORIZONTAL,
  glitchForceVertical: GLITCH_FORCE_VERTICAL,
  glitchDiff: GLITCH_DIFF,
  glitchRandomEmotion: GLITCH_RANDOM_EMOTION,
  driftEnabled: DRIFT_ENABLED,
  driftIntervalMs: DRIFT_INTERVAL_MS,
  driftPixels: DRIFT_PIXELS,
  driftDurationMs: DRIFT_DURATION_MS,
  driftTimingFunction: DRIFT_TIMING_FUNCTION,
  driftHoldMs: DRIFT_HOLD_MS,
  driftReturnMs: DRIFT_RETURN_MS,
  driftReturnTimingFunction: DRIFT_RETURN_TIMING_FUNCTION,
  horizontalDriftEnabled: HORIZONTAL_DRIFT_ENABLED = false,
  horizontalDriftIntervalMs: HORIZONTAL_DRIFT_INTERVAL_MS = [0, 0],
  horizontalDriftPixels: HORIZONTAL_DRIFT_PIXELS = [0, 0],
  horizontalDriftDurationMs: HORIZONTAL_DRIFT_DURATION_MS = [0, 0],
  horizontalDriftTimingFunction: HORIZONTAL_DRIFT_TIMING_FUNCTION = 'linear',
  snapScrollMs: SNAP_SCROLL_MS,
  snapTimingFunction: SNAP_TIMING_FUNCTION,
  snapHoldMs: SNAP_HOLD_MS,
} = window.__CONFIG__;

const FRAME_COUNT = 9;
const FRAME_HEIGHT = 420;

// DOM refs
const divA = document.getElementById('div-a');
const divB = document.getElementById('div-b');
const glitchDiv = document.getElementById('div-glitch');
divA.style.backgroundColor = MASK_COLOR;
divB.style.backgroundColor = MASK_COLOR;
document.documentElement.style.backgroundColor = MASK_COLOR;
document.body.style.backgroundColor = MASK_COLOR;

// State
let activeDiv = null;
let phase = 'idle';
let currentExpression = null;
let currentFrame = 0;
let pending = null;
let imageCache = new Map();
let loadingPromises = new Map();
let lastExpression = null;
let lastValueKey = '';
let latestRevision = -1;
let pollInFlight = false;
let activeValueSpec = null;
let rangeTimer = null;
let rangeDirection = 1;
let horizontalDriftX = 0;
let verticalDriftY = 0;
let verticalDriftTimer = null;
let verticalDriftReturnTimer = null;
let verticalDriftRescheduleTimer = null;
let horizontalDriftTimer = null;
let horizontalDriftTransition = null;
let verticalDriftTransition = null;
const backgroundX = new Map();
const backgroundY = new Map();

// Single unified handler ref + target, for explicit cleanup.
let phaseHandler = null;
let phaseTarget = null;

// Helpers
function yForFrame(frame) {
  return -(frame * FRAME_HEIGHT);
}

function frameForValue(value) {
  return Math.round(value * (FRAME_COUNT - 1));
}

function valueSpecFor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const frame = frameForValue(value);
    return { key: String(value), isRange: false, minFrame: frame, maxFrame: frame, targetFrame: frame };
  }

  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    const low = Math.min(value[0], value[1]);
    const high = Math.max(value[0], value[1]);
    const minFrame = frameForValue(low);
    const maxFrame = frameForValue(high);
    return {
      key: JSON.stringify([low, high]),
      isRange: minFrame !== maxFrame,
      minFrame,
      maxFrame,
      targetFrame: minFrame,
    };
  }

  return null;
}

function isStaleRevision(revision) {
  return Number.isInteger(revision) && revision < latestRevision;
}

function xPosition(offset) {
  return `calc(50% + ${offset}px)`;
}

function setBackgroundX(div, baseX) {
  backgroundX.set(div, baseX);
  div.style.backgroundPositionX = xPosition(baseX + horizontalDriftX);
}

function setBackgroundY(div, baseY) {
  backgroundY.set(div, baseY);
  div.style.backgroundPositionY = `${baseY + verticalDriftY}px`;
}

function applyDriftOffset() {
  for (const [div, baseX] of backgroundX) {
    div.style.backgroundPositionX = xPosition(baseX + horizontalDriftX);
  }
  for (const [div, baseY] of backgroundY) {
    div.style.backgroundPositionY = `${baseY + verticalDriftY}px`;
  }
}

function getExpressionUrl(name) {
  return `${EXPRESSIONS_URL}${name}.png`;
}

function preloadImage(name) {
  const url = getExpressionUrl(name);
  if (imageCache.has(name)) return Promise.resolve(url);
  if (loadingPromises.has(name)) return loadingPromises.get(name);

  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(name, url);
      loadingPromises.delete(name);
      resolve(url);
    };
    img.onerror = () => {
      loadingPromises.delete(name);
      reject(new Error(`Failed to load: ${url}`));
    };
    img.src = url;
  });

  loadingPromises.set(name, p);
  return p;
}

function setTransition(prop, duration, div, timingFunction) {
  if (duration <= 0) {
    clearTransition(div);
    return;
  }
  div.style.transition = `${prop} ${duration}ms ${timingFunction}`;
}

function clearTransition(div) {
  div.style.transition = 'none';
}

// Force reflow: ensures CSS changes apply instantly before animation starts.
function forceReflow(div) {
  void div.offsetHeight;
}

// Remove the active transition handler. Call before setting a new one.
function cleanupPhase() {
  if (phaseHandler && phaseTarget) {
    phaseTarget.removeEventListener('transitionend', phaseHandler);
    phaseHandler = null;
    phaseTarget = null;
  }
}

// Set up a transition handler with shared boilerplate.
// Always calls cleanupPhase() first to enforce the invariant.
// `prop` is the CSS property to listen for.
// `onDone` is called when the transition completes for the correct property.
function setupPhase(div, prop, duration, timingFunction, onDone) {
  cleanupPhase();
  setTransition(prop, duration, div, timingFunction);

  if (duration <= 0) {
    queueMicrotask(onDone);
    return;
  }

  phaseHandler = (e) => {
    if (e.propertyName !== prop) {
      // Accept shorthand: browsers may fire 'background-position' for
      // 'background-position-y' transitions.
      if (!(prop === 'background-position-y' && e.propertyName === 'background-position')) return;
    }
    cleanupPhase();
    onDone();
  };
  phaseTarget = div;
  div.addEventListener('transitionend', phaseHandler);
}

// Snap from one frame to another, one step at a time.
// Each step: scroll SNAP_SCROLL_MS, hold SNAP_HOLD_MS, repeat until target.
function snapToFrame(fromFrame, toFrame, onDone) {
  const direction = toFrame > fromFrame ? 1 : -1;
  let current = fromFrame;

  function step() {
    if (current === toFrame) {
      onDone();
      return;
    }
    current += direction;
    const targetY = yForFrame(current);
    setupPhase(activeDiv, 'background-position-y', SNAP_SCROLL_MS, SNAP_TIMING_FUNCTION, () => {
      if (current === toFrame) {
        onDone();
      } else {
        setTimeout(step, SNAP_HOLD_MS);
      }
    });
    setBackgroundY(activeDiv, targetY);
  }

  step();
}

function clearRangeTimer() {
  clearTimeout(rangeTimer);
  rangeTimer = null;
}

function scheduleRangeAnimation() {
  if (!activeValueSpec || !activeValueSpec.isRange || phase !== 'idle') return;
  if (rangeTimer) return;

  const atRangeEndpoint =
    currentFrame === activeValueSpec.minFrame ||
    currentFrame === activeValueSpec.maxFrame;
  const delay = atRangeEndpoint
    ? SNAP_HOLD_MS * randomRange(10, 40)
    : SNAP_HOLD_MS;

  rangeTimer = setTimeout(() => {
    rangeTimer = null;
    stepRangeAnimation();
  }, delay);
}

function stepRangeAnimation() {
  if (!activeValueSpec || !activeValueSpec.isRange) return;
  if (phase !== 'idle') {
    scheduleRangeAnimation();
    return;
  }

  const { minFrame, maxFrame } = activeValueSpec;
  if (currentFrame <= minFrame) rangeDirection = 1;
  if (currentFrame >= maxFrame) rangeDirection = -1;

  const targetFrame = rangeDirection > 0 ? maxFrame : minFrame;
  if (targetFrame === currentFrame) {
    scheduleRangeAnimation();
    return;
  }

  resetDrift();
  phase = 'animating';
  snapToFrame(currentFrame, targetFrame, () => {
    phase = 'idle';
    currentFrame = targetFrame;
    scheduleDrift();
    if (!drainPending()) scheduleRangeAnimation();
  });
}

// --- Phase machine ---

function startRampDown(expression, fromFrame, toFrame, targetFrame) {
  phase = 'animating';
  const startY = yForFrame(fromFrame);
  const endY = yForFrame(toFrame);

  // If already at target, skip to switch
  if (startY === endY) {
    startSwitch(expression, toFrame, targetFrame);
    return;
  }

  snapToFrame(fromFrame, toFrame, () => {
    startSwitch(expression, toFrame, targetFrame);
  });
}

function startSwitch(expression, _toFrame, targetFrame) {
  const otherDiv = activeDiv === divA ? divB : divA;
  const direction = Math.random() < 0.5 ? 'left' : 'right';
  const slideOut = direction === 'left' ? -420 : 420;
  const slideIn = -slideOut;

  // Clean up old handlers before starting new phase.
  cleanupPhase();

  // Pre-position other div off-screen with new expression at Y=0.
  // No transition on background-position-y — set directly.
  clearTransition(otherDiv);
  forceReflow(otherDiv);
  otherDiv.style.transform = `translateX(${slideIn}px)`;
  setBackgroundX(otherDiv, 0);
  setBackgroundY(otherDiv, 0);

  const url = imageCache.get(expression);
  if (!url) {
    // Image not in cache — shouldn't happen since setExpression preloads first.
    console.error(`Expression "${expression}" not in cache during switch`);
    phase = 'idle';
    drainPending();
    return;
  }
  otherDiv.style.backgroundImage = `url('${url}')`;

  // Animate both: active slides out, other slides in.
  // Only animate transform — background-position-y is set statically at 0.
  setTransition('transform', SWITCH_MS, activeDiv, SWITCH_TIMING_FUNCTION);
  setTransition('transform', SWITCH_MS, otherDiv, SWITCH_TIMING_FUNCTION);
  activeDiv.style.transform = `translateX(${slideOut}px)`;
  otherDiv.style.transform = 'translateX(0px)';

  setupPhase(otherDiv, 'transform', SWITCH_MS, SWITCH_TIMING_FUNCTION, () => {
    currentExpression = expression;
    currentFrame = targetFrame;
    activeDiv = otherDiv; // swap roles

    startRampUp(expression, 0, targetFrame);
  });
}

function startRampUp(expression, fromFrame, toFrame) {
  const startY = yForFrame(fromFrame);
  const endY = yForFrame(toFrame);

  if (startY === endY) {
    phase = 'idle';
    currentExpression = expression;
    currentFrame = toFrame;
    scheduleDrift();
    if (!drainPending()) scheduleRangeAnimation();
    return;
  }

  snapToFrame(fromFrame, toFrame, () => {
    phase = 'idle';
    currentExpression = expression;
    currentFrame = toFrame;
    scheduleDrift();
    if (!drainPending()) scheduleRangeAnimation();
  });
}

// Single pending item: last request wins. Acceptable for kiosk use.
function drainPending() {
  if (pending) {
    const next = pending;
    pending = null;
    setExpression(next.expression, next.value, next.revision);
    return true;
  }
  return false;
}

// --- Main entry point ---

async function setExpression(expression, value, revision = null) {
  const valueSpec = valueSpecFor(value);
  if (!valueSpec) return;

  // Ensure image is loaded
  try {
    await preloadImage(expression);
  } catch (err) {
    console.error(err);
    return;
  }

  if (isStaleRevision(revision)) return;

  // If currently animating, queue pending and move on.
  // The image was already preloaded above.
  if (phase === 'animating') {
    pending = { expression, value, revision };
    return;
  }

  clearRangeTimer();
  activeValueSpec = valueSpec;

  // Same expression: direct vertical transition
  if (expression === currentExpression) {
    let frame = valueSpec.targetFrame;
    if (valueSpec.isRange) {
      if (currentFrame < valueSpec.minFrame) frame = valueSpec.minFrame;
      else if (currentFrame > valueSpec.maxFrame) frame = valueSpec.maxFrame;
      else frame = currentFrame;
    }

    if (frame === currentFrame) {
      scheduleDrift();
      scheduleRangeAnimation();
      return;
    }

    resetDrift();
    phase = 'animating';
    snapToFrame(currentFrame, frame, () => {
      phase = 'idle';
      currentExpression = expression;
      currentFrame = frame;
      scheduleDrift();
      if (!drainPending()) scheduleRangeAnimation();
    });
    return;
  }

  // Different expression: three-phase. frame is the target intensity frame.
  resetDrift();
  startRampDown(expression, currentFrame, 0, valueSpec.targetFrame);
}

// --- Glitch ---

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

// Pick a value near `base` at a distance of `diff`, clamped to [min, max].
// Randomly goes above or below base.
function pickWithDiff(base, diff, min, max) {
  const up = Math.random() < 0.5;
  let val = up ? base + diff : base - diff;
  // Clamp; if clamped to one side, try the other direction.
  if (val < min || val > max) {
    val = up ? base - diff : base + diff;
  }
  return Math.max(min, Math.min(max, val));
}

// --- Film Drift ---

function applyDriftTransitions() {
  const transitions = [horizontalDriftTransition, verticalDriftTransition].filter(Boolean);
  const transition = transitions.length ? transitions.join(', ') : 'none';
  divA.style.transition = transition;
  divB.style.transition = transition;
}

function setHorizontalDrift(x, duration, easing) {
  horizontalDriftTransition = duration > 0
    ? `background-position-x ${duration}ms ${easing}`
    : null;
  applyDriftTransitions();
  horizontalDriftX = x;
  applyDriftOffset();
}

function setVerticalDrift(y, duration, easing) {
  verticalDriftTransition = duration > 0
    ? `background-position-y ${duration}ms ${easing}`
    : null;
  applyDriftTransitions();
  verticalDriftY = y;
  applyDriftOffset();
}

function rangeHasDrift(range) {
  return range[0] !== 0 || range[1] !== 0;
}

function pickAxisDrift(range) {
  if (!rangeHasDrift(range)) return 0;
  const magnitude = randomRange(range[0], range[1]);
  return (Math.random() < 0.5 ? -1 : 1) * magnitude;
}

function scheduleDrift() {
  scheduleVerticalDrift();
  scheduleHorizontalDrift();
}

function scheduleVerticalDrift() {
  if (!DRIFT_ENABLED || !rangeHasDrift(DRIFT_PIXELS)) return;
  if (verticalDriftTimer || verticalDriftReturnTimer || verticalDriftRescheduleTimer) return;
  const delay = randomRange(DRIFT_INTERVAL_MS[0], DRIFT_INTERVAL_MS[1]);
  verticalDriftTimer = setTimeout(() => {
    verticalDriftTimer = null;
    triggerVerticalDrift();
  }, delay);
}

function triggerVerticalDrift() {
  if (phase !== 'idle') {
    scheduleVerticalDrift();
    return;
  }

  const offset = pickAxisDrift(DRIFT_PIXELS);
  const driftDuration = randomRange(DRIFT_DURATION_MS[0], DRIFT_DURATION_MS[1]);
  const driftHold = randomRange(DRIFT_HOLD_MS[0], DRIFT_HOLD_MS[1]);
  const returnDuration = randomRange(DRIFT_RETURN_MS[0], DRIFT_RETURN_MS[1]);

  setVerticalDrift(offset, driftDuration, DRIFT_TIMING_FUNCTION);
  verticalDriftReturnTimer = setTimeout(() => {
    verticalDriftReturnTimer = null;
    setVerticalDrift(0, returnDuration, DRIFT_RETURN_TIMING_FUNCTION);
    verticalDriftRescheduleTimer = setTimeout(() => {
      verticalDriftRescheduleTimer = null;
      scheduleVerticalDrift();
    }, returnDuration);
  }, driftDuration + driftHold);
}

function scheduleHorizontalDrift() {
  if (!HORIZONTAL_DRIFT_ENABLED || !rangeHasDrift(HORIZONTAL_DRIFT_PIXELS)) return;
  if (horizontalDriftTimer) return;
  const delay = randomRange(HORIZONTAL_DRIFT_INTERVAL_MS[0], HORIZONTAL_DRIFT_INTERVAL_MS[1]);
  horizontalDriftTimer = setTimeout(() => {
    horizontalDriftTimer = null;
    triggerHorizontalDrift();
  }, delay);
}

function triggerHorizontalDrift() {
  if (phase !== 'idle') {
    scheduleHorizontalDrift();
    return;
  }

  const offset = pickAxisDrift(HORIZONTAL_DRIFT_PIXELS);
  const duration = randomRange(HORIZONTAL_DRIFT_DURATION_MS[0], HORIZONTAL_DRIFT_DURATION_MS[1]);

  setHorizontalDrift(offset, duration, HORIZONTAL_DRIFT_TIMING_FUNCTION);
  horizontalDriftTimer = setTimeout(() => {
    horizontalDriftTimer = null;
    scheduleHorizontalDrift();
  }, duration);
}

function clearVerticalDriftTimers() {
  clearTimeout(verticalDriftTimer);
  clearTimeout(verticalDriftReturnTimer);
  clearTimeout(verticalDriftRescheduleTimer);
  verticalDriftTimer = null;
  verticalDriftReturnTimer = null;
  verticalDriftRescheduleTimer = null;
}

function resetDrift() {
  clearVerticalDriftTimers();
  horizontalDriftTransition = null;
  verticalDriftTransition = null;
  applyDriftTransitions();
  if (verticalDriftY !== 0) {
    verticalDriftY = 0;
    applyDriftOffset();
  }
}

function scheduleGlitch() {
  const delay = randomInt(GLITCH_INTERVAL_MS[0], GLITCH_INTERVAL_MS[1]);
  setTimeout(triggerGlitch, delay);
}

function triggerGlitch() {
  const cached = Array.from(imageCache.keys());
  if (cached.length === 0) {
    scheduleGlitch();
    return;
  }

  const name = GLITCH_RANDOM_EMOTION
    ? cached[randomInt(0, cached.length - 1)]
    : currentExpression;
  const frame = randomInt(0, FRAME_COUNT - 1);
  const url = imageCache.get(name);

  // Random rectangle. Forced horizontal/vertical strips if configured.
  // glitchDiff constrains the distance between start and end coordinates.
  let x1, y1, x2, y2;

  const diff = GLITCH_DIFF
    ? randomInt(GLITCH_DIFF[0], GLITCH_DIFF[1])
    : null;

  if (GLITCH_FORCE_HORIZONTAL) {
    x1 = 0;
    x2 = 420;
    y1 = randomInt(0, 419);
    y2 = diff ? pickWithDiff(y1, diff, 0, 420) : randomInt(0, 419);
  } else if (GLITCH_FORCE_VERTICAL) {
    y1 = 0;
    y2 = 420;
    x1 = randomInt(0, 419);
    x2 = diff ? pickWithDiff(x1, diff, 0, 420) : randomInt(0, 419);
  } else {
    x1 = randomInt(0, 419);
    x2 = diff ? pickWithDiff(x1, diff, 0, 420) : randomInt(0, 419);
    y1 = randomInt(0, 419);
    y2 = diff ? pickWithDiff(y1, diff, 0, 420) : randomInt(0, 419);
  }

  // Ensure x1 < x2 and y1 < y2 (swap if needed).
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];

  // Position overlay background so the random frame shows, clipped to the rectangle.
  glitchDiv.style.backgroundImage = `url('${url}')`;
  glitchDiv.style.transition = 'none';
  glitchDiv.style.backgroundPositionY = yForFrame(frame) + 'px';
  glitchDiv.style.clipPath = `inset(${y1}px ${420 - x2}px ${420 - y2}px ${x1}px)`;
  glitchDiv.style.opacity = '1';

  setTimeout(() => {
    glitchDiv.style.opacity = '0';
    scheduleGlitch();
  }, randomInt(GLITCH_DURATION_MS[0], GLITCH_DURATION_MS[1]));
}

async function init() {
  // Load idle expression at frame 0
  try {
    await preloadImage('idle');
  } catch (err) {
    console.error('Failed to load idle expression:', err);
    return;
  }

  const idleUrl = imageCache.get('idle');
  divA.style.backgroundImage = `url('${idleUrl}')`;
  // Keep the inactive black buffer from covering the initial idle frame.
  divA.style.transform = 'translateX(0px)';
  divB.style.transform = 'translateX(420px)';
  setBackgroundX(divA, 0);
  setBackgroundX(divB, 0);
  setBackgroundY(divA, 0);
  setBackgroundY(divB, 0);
  glitchDiv.style.backgroundPositionX = 'center';
  glitchDiv.style.backgroundPositionY = '0px';
  activeDiv = divA;
  currentExpression = 'idle';
  currentFrame = 0;
  lastExpression = 'idle';
  lastValueKey = '0';
  activeValueSpec = valueSpecFor(0);
  latestRevision = 0;

  startPolling();
  scheduleGlitch();
  scheduleDrift();
}

async function pollStatus() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const res = await fetch('/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const valueSpec = data ? valueSpecFor(data.value) : null;
    if (!data || typeof data.expression !== 'string' || !valueSpec) return;

    const revision = Number.isInteger(data.revision) ? data.revision : null;
    if (revision !== null) {
      if (revision <= latestRevision) return;
      latestRevision = revision;
    } else if (data.expression === lastExpression && valueSpec.key === lastValueKey) {
      return;
    }

    lastExpression = data.expression;
    lastValueKey = valueSpec.key;
    setExpression(data.expression, data.value, revision);
  } catch (err) {
    console.warn('Poll error:', err.message);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  pollStatus();
  setInterval(pollStatus, POLL_INTERVAL_MS);
}

init();
