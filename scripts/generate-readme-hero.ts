import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const outputPath = path.resolve(
  outputFlag >= 0 && process.argv[outputFlag + 1]
    ? process.argv[outputFlag + 1]
    : path.join(repositoryRoot, 'docs/assets/readme-hero.png'),
);
const captureRoot = await mkdtemp(path.join(tmpdir(), 'codex-anywhere-hero-'));
const sessionPath = path.join(captureRoot, 'session.png');
const conversationPath = path.join(captureRoot, 'conversation.png');
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;

function browserPath() {
  const candidates = [
    process.env.CODEX_ANYWHERE_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const browser = candidates.find((candidate) => existsSync(candidate));
  if (!browser) {
    throw new Error('No supported browser found. Set CODEX_ANYWHERE_BROWSER to an Edge or Chrome executable.');
  }
  return browser;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPage(url: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Vite process is still starting.
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(100);
  }
  throw new Error(`Browser did not create ${filePath}`);
}

async function capture(browser: string, view: string, viewportHeight: number, destination: string) {
  const profile = path.join(captureRoot, `browser-${view}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-background-networking',
    '--force-device-scale-factor=2',
    `--window-size=390,${viewportHeight}`,
    '--virtual-time-budget=2200',
    `--user-data-dir=${profile}`,
    `--screenshot=${destination}`,
    `${baseUrl}/promo.html?view=${view}`,
  ], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 || existsSync(destination)
      ? resolve()
      : reject(new Error(`Browser capture exited with code ${code}`)));
  });
  await waitForFile(destination);
}

const width = 1400;
const height = 720;
const background = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#07101e"/><stop offset=".56" stop-color="#0b1628"/><stop offset="1" stop-color="#111b31"/>
      </linearGradient>
      <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#5b91ff"/><stop offset="1" stop-color="#765fff"/>
      </linearGradient>
      <radialGradient id="glow">
        <stop stop-color="#4f7cff" stop-opacity=".3"/><stop offset="1" stop-color="#4f7cff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="branch" x1="0" y1="0" x2="1" y2="0">
        <stop stop-color="#345f9f" stop-opacity=".14"/><stop offset=".55" stop-color="#5c8de9" stop-opacity=".52"/><stop offset="1" stop-color="#7968f0" stop-opacity=".28"/>
      </linearGradient>
    </defs>
    <rect width="1400" height="720" rx="30" fill="url(#bg)"/>
    <circle cx="1080" cy="245" r="390" fill="url(#glow)"/>
    <circle cx="180" cy="690" r="260" fill="#2865d8" opacity=".08"/>
    <circle cx="1008" cy="348" r="264" fill="none" stroke="#608cef" stroke-opacity=".055" stroke-width="52"/>
    <circle cx="1008" cy="348" r="214" fill="none" stroke="#6d65ed" stroke-opacity=".045" stroke-width="1.5"/>
    <path d="M0 604C250 515 460 690 735 620s426-85 665-24v124H0Z" fill="#fff" opacity=".018"/>
    <g fill="none" stroke="url(#branch)" stroke-linecap="round">
      <path d="M616 365C673 365 697 320 749 282" stroke-width="3"/>
      <path d="M647 365C770 380 896 323 1032 215" stroke-width="3.5"/>
      <path d="M649 365C728 410 799 478 864 548" stroke-width="1.5" stroke-opacity=".34"/>
    </g>
    <rect x="610" y="358" width="13" height="13" fill="#13243d" stroke="#527ed0" stroke-opacity=".65" transform="rotate(45 616.5 364.5)"/>
    <g fill="#79a2f4">
      <rect x="676" y="179" width="4" height="4" rx="2" opacity=".38"/>
      <rect x="957" y="61" width="5" height="5" rx="2.5" opacity=".35"/>
      <rect x="1329" y="187" width="4" height="4" rx="2" opacity=".28"/>
      <rect x="706" y="575" width="5" height="5" rx="2.5" opacity=".25"/>
    </g>

    <g transform="translate(76 68)" font-family="Inter,Segoe UI,Arial,sans-serif">
      <rect width="214" height="38" rx="19" fill="#142542" stroke="#31568f"/>
      <circle cx="21" cy="19" r="7" fill="#6c9cff"/>
      <path d="M17.5 19h7M21 15.5v7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
      <text x="40" y="25" fill="#bfd2f5" font-size="14" font-weight="700" letter-spacing="2">CODEX ANYWHERE</text>
    </g>

    <g font-family="Inter,Segoe UI,Arial,sans-serif">
      <text x="76" y="192" fill="#f5f8ff" font-size="60" font-weight="760" letter-spacing="-2.1">Take Codex</text>
      <text x="76" y="258" fill="url(#brand)" font-size="60" font-weight="760" letter-spacing="-2.1">anywhere.</text>
      <text x="78" y="314" fill="#9aabc3" font-size="19">Follow live work. Continue from any browser.</text>
      <text x="78" y="345" fill="#71839e" font-size="15">Single-user · self-hosted · project files stay local</text>

      <g transform="translate(76 394)">
        <g>
          <rect width="250" height="84" rx="16" fill="#101c30" stroke="#243e65"/>
          <circle cx="32" cy="29" r="12" fill="#1a3965"/>
          <path d="M27 29l4 4 7-9" fill="none" stroke="#73a4ff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="55" y="33" fill="#e8eef9" font-size="15" font-weight="700">Live progress</text>
          <text x="20" y="62" fill="#7e91ad" font-size="12">Follow work as it happens</text>
        </g>
        <g transform="translate(266)">
          <rect width="250" height="84" rx="16" fill="#101c30" stroke="#243e65"/>
          <circle cx="32" cy="29" r="12" fill="#1a3965"/>
          <rect x="26" y="23" width="12" height="12" rx="2" fill="none" stroke="#73a4ff" stroke-width="1.8"/>
          <path d="M27.5 32l3-3 2.5 2 2.5-3 2.5 4" fill="none" stroke="#73a4ff" stroke-width="1.5"/>
          <text x="55" y="33" fill="#e8eef9" font-size="15" font-weight="700">Code &amp; files</text>
          <text x="20" y="62" fill="#7e91ad" font-size="12">Preview source. Download results.</text>
        </g>
        <g transform="translate(0 100)">
          <rect width="250" height="84" rx="16" fill="#101c30" stroke="#243e65"/>
          <circle cx="32" cy="29" r="12" fill="#182f53"/>
          <path d="M32 20l8 3v6c0 6-3 10-8 13-5-3-8-7-8-13v-6zM28 30l3 3 6-7" fill="none" stroke="#7ca7f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="55" y="33" fill="#e8eef9" font-size="15" font-weight="700">Private by design</text>
          <text x="20" y="62" fill="#7e91ad" font-size="12">Your computer stays off the public web</text>
        </g>
        <g transform="translate(266 100)">
          <rect width="250" height="84" rx="16" fill="#101c30" stroke="#243e65"/>
          <circle cx="32" cy="29" r="12" fill="#163a35"/>
          <path d="M26 29a6 6 0 1 0 2-4M26 21v5h5" fill="none" stroke="#55e6a5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="55" y="33" fill="#e8eef9" font-size="15" font-weight="700">Auto reconnect</text>
          <text x="20" y="62" fill="#7e91ad" font-size="12">Recovers after network changes</text>
        </g>
      </g>
    </g>
  </svg>
`);

async function roundedScreenshot(
  filePath: string,
  targetWidth: number,
  targetHeight: number,
  radius: number,
) {
  const mask = Buffer.from(`<svg width="${targetWidth}" height="${targetHeight}"><rect width="${targetWidth}" height="${targetHeight}" rx="${radius}" fill="#fff"/></svg>`);
  return sharp(filePath)
    .resize(targetWidth, targetHeight, { fit: 'cover' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function phoneCapture(
  filePath: string,
  screenWidth: number,
  screenHeight: number,
  radius: number,
  angle: number,
  borderColor: string,
) {
  const frame = 9;
  const padding = 23;
  const shellWidth = screenWidth + frame * 2;
  const shellHeight = screenHeight + frame * 2;
  const canvasWidth = shellWidth + padding * 2;
  const canvasHeight = shellHeight + padding * 2;
  const screenshot = await roundedScreenshot(filePath, screenWidth, screenHeight, radius);
  const shell = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
      <defs><filter id="shadow" x="-40%" y="-30%" width="180%" height="190%"><feDropShadow dx="0" dy="17" stdDeviation="15" flood-color="#020712" flood-opacity=".72"/></filter></defs>
      <rect x="${padding}" y="${padding}" width="${shellWidth}" height="${shellHeight}" rx="${radius + 9}" fill="#040813" stroke="${borderColor}" stroke-width="3" filter="url(#shadow)"/>
    </svg>
  `);
  const flattenedPhone = await sharp(shell)
    .composite([{ input: screenshot, left: padding + frame, top: padding + frame }])
    .png()
    .toBuffer();
  return sharp(flattenedPhone)
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

const viteCli = path.join(repositoryRoot, 'node_modules/vite/bin/vite.js');
const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: repositoryRoot,
  stdio: 'ignore',
  windowsHide: true,
});

try {
  await waitForPage(`${baseUrl}/promo.html`);
  const browser = browserPath();
  await capture(browser, 'session', 844, sessionPath);
  await capture(browser, 'conversation', 720, conversationPath);

  const session = await phoneCapture(sessionPath, 238, 515, 30, -5, '#30486f');
  const conversation = await phoneCapture(conversationPath, 276, 510, 35, 4, '#3b5685');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(background)
    .composite([
      { input: session, left: 721, top: 55 },
      { input: conversation, left: 984, top: 52 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
  console.log(outputPath);
} finally {
  vite.kill();
  await rm(captureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
