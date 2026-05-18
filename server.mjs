/**
 * Clara Avatar Kiosk — Server
 *
 * Run with: node server.mjs
 *
 * Reads config and the expressions directory on boot.
 * Nothing is cached between requests beyond the initial directory listing.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = join(DIR, 'config.json');

const DEFAULT_CONFIG = {
  port: 2747,
  host: '127.0.0.1',
  theme: 'dark',
  maskColor: '#000000',
  switchMs: 400,
  switchTimingFunction: 'ease-in-out',
  snapScrollMs: 50,
  snapTimingFunction: 'ease-in-out',
  snapHoldMs: 120,
  pollIntervalMs: 500,
  glitchIntervalMs: [20, 60],
  glitchDurationMs: [20, 50],
  glitchForceHorizontal: true,
  glitchForceVertical: false,
  glitchDiff: [20, 100],
  glitchRandomEmotion: false,
  driftEnabled: true,
  driftIntervalMs: [3500, 12000],
  driftPixels: [1, 4],
  driftDurationMs: [80, 180],
  driftTimingFunction: 'cubic-bezier(.16, 1, .3, 1)',
  driftHoldMs: [40, 160],
  driftReturnMs: [120, 280],
  driftReturnTimingFunction: 'cubic-bezier(.45, 0, .2, 1)',
  horizontalDriftEnabled: true,
  horizontalDriftIntervalMs: [45, 220],
  horizontalDriftPixels: [1, 4],
  horizontalDriftDurationMs: [20, 70],
  horizontalDriftTimingFunction: 'cubic-bezier(.2, 0, 0, 1)',
  maxBodyBytes: 65536,
  controlToken: '',
};

function failConfig(message) {
  console.error(`Invalid config.json: ${message}`);
  process.exit(1);
}

function requirePort(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    failConfig(`${name} must be an integer port from 0 to 65535`);
  }
  return value;
}

function requireNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failConfig(`${name} must be a finite number`);
  }
  return value;
}

function requireBoolean(name, value) {
  if (typeof value !== 'boolean') failConfig(`${name} must be a boolean`);
  return value;
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    failConfig(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumberRange(name, value) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    failConfig(`${name} must be a two-number array`);
  }
  return value;
}

function validateConfig(rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };

  config.port = requirePort('port', config.port);
  config.host = requireString('host', config.host);
  config.theme = requireString('theme', config.theme);
  if (!/^[a-zA-Z0-9_-]+$/.test(config.theme)) {
    failConfig('theme must be a safe path segment');
  }
  config.maskColor = requireString('maskColor', config.maskColor);

  config.switchMs = requireNumber('switchMs', config.switchMs);
  config.switchTimingFunction = String(config.switchTimingFunction);
  config.snapScrollMs = requireNumber('snapScrollMs', config.snapScrollMs);
  config.snapTimingFunction = String(config.snapTimingFunction);
  config.snapHoldMs = requireNumber('snapHoldMs', config.snapHoldMs);
  config.pollIntervalMs = requireNumber('pollIntervalMs', config.pollIntervalMs);
  config.glitchIntervalMs = requireNumberRange('glitchIntervalMs', config.glitchIntervalMs);
  config.glitchDurationMs = requireNumberRange('glitchDurationMs', config.glitchDurationMs);
  config.glitchForceHorizontal = requireBoolean('glitchForceHorizontal', config.glitchForceHorizontal);
  config.glitchForceVertical = requireBoolean('glitchForceVertical', config.glitchForceVertical);
  config.glitchRandomEmotion = requireBoolean('glitchRandomEmotion', config.glitchRandomEmotion);
  config.glitchDiff = requireNumberRange('glitchDiff', config.glitchDiff);
  config.driftEnabled = requireBoolean('driftEnabled', config.driftEnabled);
  config.driftIntervalMs = requireNumberRange('driftIntervalMs', config.driftIntervalMs);
  config.driftPixels = requireNumberRange('driftPixels', config.driftPixels);
  config.driftDurationMs = requireNumberRange('driftDurationMs', config.driftDurationMs);
  config.driftTimingFunction = String(config.driftTimingFunction);
  config.driftHoldMs = requireNumberRange('driftHoldMs', config.driftHoldMs);
  config.driftReturnMs = requireNumberRange('driftReturnMs', config.driftReturnMs);
  config.driftReturnTimingFunction = String(config.driftReturnTimingFunction);
  config.horizontalDriftEnabled = requireBoolean('horizontalDriftEnabled', config.horizontalDriftEnabled);
  config.horizontalDriftIntervalMs = requireNumberRange('horizontalDriftIntervalMs', config.horizontalDriftIntervalMs);
  config.horizontalDriftPixels = requireNumberRange('horizontalDriftPixels', config.horizontalDriftPixels);
  config.horizontalDriftDurationMs = requireNumberRange('horizontalDriftDurationMs', config.horizontalDriftDurationMs);
  config.horizontalDriftTimingFunction = String(config.horizontalDriftTimingFunction);
  config.maxBodyBytes = requireNumber('maxBodyBytes', config.maxBodyBytes);
  if (typeof config.controlToken !== 'string') failConfig('controlToken must be a string');

  return config;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Load config with graceful error handling.
let bootConfig;
try {
  bootConfig = validateConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
} catch (err) {
  console.error('Failed to load config.json:', err.message);
  process.exit(1);
}

const PORT = bootConfig.port;
const HOST = bootConfig.host;
const THEME = bootConfig.theme;
const AUTH_TOKEN = bootConfig.controlToken;
const EXPRESSIONS_DIR = join(DIR, 'images', 'expressions', THEME);

if (!AUTH_TOKEN && !isLoopbackHost(HOST)) {
  failConfig('controlToken is required when host is not loopback');
}

async function loadExpressionDescriptions(expressionNames) {
  const descriptions = {};
  for (const name of expressionNames) {
    try {
      descriptions[name] = (await readFile(join(EXPRESSIONS_DIR, `${name}.txt`), 'utf8')).trim();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      descriptions[name] = '';
    }
  }
  return descriptions;
}

// Cache valid expression names (strip .png) and descriptions from the directory.
let validExpressions;
let expressionDescriptions;
try {
  const expressionNames = (await readdir(EXPRESSIONS_DIR))
    .filter(f => /\.png$/i.test(f))
    .map(f => f.replace(/\.png$/i, ''))
    .sort();
  validExpressions = new Set(expressionNames);
  expressionDescriptions = await loadExpressionDescriptions(expressionNames);
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`Expressions directory not found: ${EXPRESSIONS_DIR}`);
  } else {
    console.error('Failed to read expressions directory:', err.message);
  }
  process.exit(1);
}

// Inject config once at boot.
const injectedConfig = {
  maskColor: bootConfig.maskColor,
  expressionsUrl: `/images/expressions/${THEME}/`,
  switchMs: bootConfig.switchMs,
  switchTimingFunction: bootConfig.switchTimingFunction,
  snapScrollMs: bootConfig.snapScrollMs,
  snapTimingFunction: bootConfig.snapTimingFunction,
  snapHoldMs: bootConfig.snapHoldMs,
  pollIntervalMs: bootConfig.pollIntervalMs,
  glitchIntervalMs: bootConfig.glitchIntervalMs,
  glitchDurationMs: bootConfig.glitchDurationMs,
  glitchForceHorizontal: bootConfig.glitchForceHorizontal,
  glitchForceVertical: bootConfig.glitchForceVertical,
  glitchDiff: bootConfig.glitchDiff,
  glitchRandomEmotion: bootConfig.glitchRandomEmotion,
  driftEnabled: bootConfig.driftEnabled,
  driftIntervalMs: bootConfig.driftIntervalMs,
  driftPixels: bootConfig.driftPixels,
  driftDurationMs: bootConfig.driftDurationMs,
  driftTimingFunction: bootConfig.driftTimingFunction,
  driftHoldMs: bootConfig.driftHoldMs,
  driftReturnMs: bootConfig.driftReturnMs,
  driftReturnTimingFunction: bootConfig.driftReturnTimingFunction,
  horizontalDriftEnabled: bootConfig.horizontalDriftEnabled,
  horizontalDriftIntervalMs: bootConfig.horizontalDriftIntervalMs,
  horizontalDriftPixels: bootConfig.horizontalDriftPixels,
  horizontalDriftDurationMs: bootConfig.horizontalDriftDurationMs,
  horizontalDriftTimingFunction: bootConfig.horizontalDriftTimingFunction,
};
const configScript = `<script>window.__CONFIG__=${JSON.stringify(injectedConfig)}</script>`;

// Current expression state — initialized to idle.
let currentRevision = 0;
let currentState = { expression: 'idle', value: 0, revision: currentRevision };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
};

// Cache-Control per extension: HTML/JS no-store, PNGs long-lived.
const CACHE = {
  '.html': 'no-store, no-cache, must-revalidate',
  '.json': 'no-store, no-cache, must-revalidate',
  '.js': 'no-store, no-cache, must-revalidate',
  '.png': 'public, max-age=31536000, immutable',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': CACHE['.json'] });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE['.html'] });
  res.end(text);
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  return (
    req.headers.authorization === `Bearer ${AUTH_TOKEN}` ||
    req.headers['x-clara-avatar-token'] === AUTH_TOKEN
  );
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > bootConfig.maxBodyBytes) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeExpressionValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= 0 &&
    value[0] <= 1 &&
    value[1] >= 0 &&
    value[1] <= 1
  ) {
    return value[0] <= value[1] ? value : [value[1], value[0]];
  }

  return null;
}

function getStaticFilePath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return { status: 400, message: 'Bad request' };
  }

  if (decodedPath === '/') decodedPath = '/index.html';

  if (decodedPath === '/index.html') return { filePath: join(DIR, 'index.html'), servePath: decodedPath };
  if (decodedPath === '/renderer.js') return { filePath: join(DIR, 'renderer.js'), servePath: decodedPath };

  const imagePrefix = `/images/expressions/${THEME}/`;
  if (decodedPath.startsWith(imagePrefix)) {
    const imageName = decodedPath.slice(imagePrefix.length);
    if (!/^[a-zA-Z0-9_.-]+\.png$/.test(imageName)) return { status: 404, message: 'Not found' };

    const filePath = resolve(EXPRESSIONS_DIR, imageName);
    const dirPrefix = resolve(EXPRESSIONS_DIR) + '/';
    if (!filePath.startsWith(dirPrefix)) return { status: 403, message: 'Forbidden' };
    return { filePath, servePath: decodedPath };
  }

  return { status: 404, message: 'Not found' };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // POST /expression — validate against cached expression names
    if (req.method === 'POST' && pathname === '/expression') {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }

      let parsed;
      try {
        parsed = JSON.parse(await readRequestBody(req));
      } catch (err) {
        if (err.status === 413) return sendJson(res, 413, { error: 'Request body too large' });
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return sendJson(res, 400, { error: 'Request body must be a JSON object' });
      }

      const { expression, value } = parsed;
      if (typeof expression !== 'string' || !expression) {
        return sendJson(res, 400, { error: 'Missing or invalid "expression" field (string required)' });
      }
      const normalizedValue = normalizeExpressionValue(value);
      if (normalizedValue === null) {
        return sendJson(res, 400, { error: '"value" must be a number from 0 to 1 or a two-number range [min,max] from 0 to 1' });
      }
      if (!validExpressions.has(expression)) {
        return sendJson(res, 400, { error: `Unknown expression: "${expression}"` });
      }

      currentRevision += 1;
      currentState = { expression, value: normalizedValue, revision: currentRevision };
      return sendJson(res, 200, { ok: true, expression, value: normalizedValue, revision: currentRevision });
    }

    // GET /status — return current expression state
    if (req.method === 'GET' && pathname === '/status') {
      return sendJson(res, 200, currentState);
    }

    // GET /expressions — return available expression names and usage notes
    if (req.method === 'GET' && pathname === '/expressions') {
      return sendJson(res, 200, expressionDescriptions);
    }

    // Static files
    if (req.method === 'GET') {
      const staticTarget = getStaticFilePath(pathname);
      if (!staticTarget.filePath) return sendText(res, staticTarget.status, staticTarget.message);
      const { filePath, servePath } = staticTarget;

      let data;
      try { data = await readFile(filePath); }
      catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') return sendText(res, 404, 'Not found');
        throw err;
      }

      const ext = extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const cacheControl = CACHE[ext] || CACHE['.html'];

      let body = data;
      if (servePath === '/index.html') {
        // Case-insensitive replace for </head>
        body = data.toString('utf8').replace(/<\/head\s*>/i, configScript + '\n</head>');
      }

      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
      return res.end(body);
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE['.html'] });
    res.end('Method not allowed');
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
  }
});

server.listen(PORT, HOST, () => console.log(`Clara Avatar Kiosk → http://${HOST}:${PORT}`));
