#!/usr/bin/env node
// Encoder bench for the clip pipeline: encodes a corpus of real clips with a matrix of
// presets and scores every output against its source with VMAF.
//
// This exists because the phase 2 preset was tuned on a single gameplay clip and then
// produced a 56 MB AV1 file - larger than the H.264 fallback - on the first real clip that
// went through the phase 4 automatic path. One clip is not a curve. See the video-encoding
// skill for the numbers this produced and for what was decided from them.
//
//   node apps/desktop/scripts/bench-encoders.mjs --corpus easy,medium,hard
//   node apps/desktop/scripts/bench-encoders.mjs --only svtav1-p6-cap5 --clip hard
//
// Results are cached in <out>/results.json and keyed by clip + config, so re-running only
// measures what is new. Delete a key (or the file) to force a re-measure.
//
// Two rules this script enforces, both learned the hard way:
//
//   - Encodes run strictly one at a time. The AMF media engine is a single shared resource
//     and concurrent encodes ruin the timings. The desktop app's replay buffer is also on it,
//     which is realistic (that is when clips really encode) but worth knowing when reading
//     the seconds column.
//   - libvmaf's log_path is parsed as filter options, so a Windows path with a drive colon
//     breaks the filter graph. Everything runs with cwd set to the output directory and a
//     bare filename.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

// ---- corpus ------------------------------------------------------------------------------

// Three clips spanning the difficulty range, all 1080p60 off this machine's replay buffer at
// ~20 Mbps. Difficulty is what the AV1 encoder actually has to spend, not the source size:
// every source is the same constant-bitrate capture.
const CORPUS = {
  easy: '2026-09-10 18-47-22.mp4', // desktop and a browser, mostly static
  medium: '2026-09-10 18-09-08.mp4', // Wardogs, moderate motion
  hard: '2026-09-11 11-19-06.mp4', // Wardogs, high motion - the clip that started this
};

const CLIP_DIR = process.env.COS_CLIP_DIR ?? join(process.env.USERPROFILE ?? '', 'Videos', 'Cos Nostra');

// ---- the matrix --------------------------------------------------------------------------

// `args` are video arguments only; audio is dropped (-an) so sizes compare like for like.
// Opus at 128k adds about 0.5 MB per 30 s to every AV1 row in production, AAC 160k about
// 0.6 MB to every H.264 row, equally, so leaving audio out changes no ordering.
const GOP = ['-g', '120'];

const CONFIGS = [
  {
    id: 'amf-cqp95',
    label: 'av1_amf cqp 95',
    note: 'what ships today, uncapped constant quality',
    args: ['-c:v', 'av1_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '95', '-qp_p', '95'],
  },
  {
    id: 'amf-qvbr28-cap5',
    label: 'av1_amf qvbr 28 @5M',
    note: "AMD's own quality-VBR, capped",
    args: [
      '-c:v', 'av1_amf', '-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', '28',
      '-maxrate', '5M', '-bufsize', '10M',
    ],
  },
  {
    id: 'svtav1-p8-crf34',
    label: 'libsvtav1 p8 crf 34',
    note: 'the software fallback today, uncapped',
    args: ['-c:v', 'libsvtav1', '-preset', '8', '-crf', '34', '-svtav1-params', 'tune=0'],
  },
  {
    id: 'svtav1-p8-cap5',
    label: 'libsvtav1 p8 crf 34 @5M',
    note: 'capped CRF, fast preset',
    args: [
      '-c:v', 'libsvtav1', '-preset', '8', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '5M', '-bufsize', '10M',
    ],
  },
  {
    id: 'svtav1-p6-cap5',
    label: 'libsvtav1 p6 crf 34 @5M',
    note: 'capped CRF, slower preset',
    args: [
      '-c:v', 'libsvtav1', '-preset', '6', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '5M', '-bufsize', '10M',
    ],
  },
  {
    id: 'svtav1-p4-cap5',
    label: 'libsvtav1 p4 crf 34 @5M',
    note: 'capped CRF, slow preset - is the extra time worth anything?',
    args: [
      '-c:v', 'libsvtav1', '-preset', '4', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '5M', '-bufsize', '10M',
    ],
  },
  {
    id: 'svtav1-p6-cap3',
    label: 'libsvtav1 p6 crf 34 @3M',
    note: 'tighter cap: how much quality does halving the ceiling cost?',
    args: [
      '-c:v', 'libsvtav1', '-preset', '6', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '3M', '-bufsize', '6M',
    ],
  },
  {
    id: 'h264-amf-8m',
    label: 'h264_amf 8M vbr_peak',
    note: 'the Discord/compatibility copy that ships today',
    args: [
      '-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', '8M', '-maxrate', '12M',
    ],
  },
  {
    id: 'x264-crf23-cap5',
    label: 'libx264 crf 23 @5M',
    note: 'software H.264, capped, for the same-codec comparison',
    args: [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-maxrate', '5M', '-bufsize', '10M',
    ],
  },

  // Rate-quality curve points. A single preset per encoder cannot answer "which encoder is
  // better", because av1_amf's cqp and libsvtav1's crf are not the same dial and the offset
  // between them moves with content: on the easy clip cqp 95 and crf 34 land 1.6 VMAF apart,
  // on the medium clip 2.5 apart and 6x apart in size. Three points each makes the two curves
  // comparable at matched quality, which is the only honest way to pick.
  {
    id: 'amf-cqp110',
    label: 'av1_amf cqp 110',
    note: 'curve point',
    args: ['-c:v', 'av1_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '110', '-qp_p', '110'],
  },
  {
    id: 'amf-cqp128',
    label: 'av1_amf cqp 128',
    note: 'curve point',
    args: ['-c:v', 'av1_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '128', '-qp_p', '128'],
  },
  {
    id: 'svtav1-p6-crf40',
    label: 'libsvtav1 p6 crf 40',
    note: 'curve point',
    args: ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '40', '-svtav1-params', 'tune=0'],
  },
  {
    id: 'svtav1-p6-crf46',
    label: 'libsvtav1 p6 crf 46',
    note: 'curve point',
    args: ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '46', '-svtav1-params', 'tune=0'],
  },

  // The three levels the app actually ships, so the table can be checked against what the
  // Settings picker really does. Keep these in step with ffmpeg::av1_args / h264_args.
  {
    id: 'ship-av1-small',
    label: 'SHIP av1 Smaller files',
    note: 'libsvtav1 p6 crf 46, ceiling 8M',
    args: ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '46', '-svtav1-params', 'tune=0', '-maxrate', '8M', '-bufsize', '16M'],
  },
  {
    id: 'ship-av1-balanced',
    label: 'SHIP av1 Balanced',
    note: 'libsvtav1 p6 crf 40, ceiling 12M',
    args: ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '40', '-svtav1-params', 'tune=0', '-maxrate', '12M', '-bufsize', '24M'],
  },
  {
    id: 'ship-av1-high',
    label: 'SHIP av1 Best quality',
    note: 'libsvtav1 p6 crf 34, ceiling 20M',
    args: ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '34', '-svtav1-params', 'tune=0', '-maxrate', '20M', '-bufsize', '40M'],
  },
  {
    id: 'ship-h264-balanced',
    label: 'SHIP h264 Balanced',
    note: 'libx264 medium crf 22, ceiling 12M - the copy Discord streams',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-maxrate', '12M', '-bufsize', '24M'],
  },
  // The H.264 copy is not the fallback its name suggests: og:video on the player page points
  // at it, so Discord's inline player streams H.264 for every viewer in the server and never
  // touches the AV1. Confirmed 2026-09-11 from a live embed object, which carries
  // `video.url = .../clips/<id>/h264` behind a discordapp.net proxy. These rows decide what
  // the community actually sees.
  {
    id: 'x264-crf20-cap8',
    label: 'libx264 crf 20 @8M',
    note: 'the hot copy, given a real quality target instead of a starved bitrate',
    args: [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M',
    ],
  },
  {
    id: 'h264-amf-qvbr24-cap8',
    label: 'h264_amf qvbr 24 @8M',
    note: 'same idea on hardware: quality-driven with a ceiling',
    args: [
      '-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', '24',
      '-maxrate', '8M', '-bufsize', '16M',
    ],
  },
  {
    id: 'svtav1-p6-cap8',
    label: 'libsvtav1 p6 crf 34 @8M',
    note: 'AV1 at a looser ceiling, to see where the cap stops costing anything',
    args: [
      '-c:v', 'libsvtav1', '-preset', '6', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '8M', '-bufsize', '16M',
    ],
  },
  {
    id: 'svtav1-p4-cap8',
    note: 'the slow preset where it actually pays: p8 -> p4 at a 5M cap on hard footage was '
      + 'worth 7.3 VMAF, because a tight ceiling is exactly where better decisions matter',
    label: 'libsvtav1 p4 crf 34 @8M',
    args: [
      '-c:v', 'libsvtav1', '-preset', '4', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '8M', '-bufsize', '16M',
    ],
  },
  {
    id: 'svtav1-p6-cap5-g300',
    label: 'libsvtav1 p6 crf 34 @5M g300',
    note: 'a 5 s GOP instead of 2 s - clips are watched start to finish, not seeked',
    args: [
      '-c:v', 'libsvtav1', '-preset', '6', '-crf', '34', '-svtav1-params', 'tune=0',
      '-maxrate', '5M', '-bufsize', '10M',
    ],
    gop: ['-g', '300'],
  },
];

// ---- plumbing ----------------------------------------------------------------------------

/** Sidecar ffmpeg if it is there, else whatever is on PATH. */
function findFfmpeg() {
  const sidecar = join(REPO, 'apps/desktop/src-tauri/target/debug/ffmpeg.exe');
  return existsSync(sidecar) ? sidecar : 'ffmpeg';
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string, seconds: number }>}
 */
function run(bin, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolvePromise({ code: code ?? -1, stdout, stderr, seconds: (Date.now() - started) / 1000 }),
    );
  });
}

/** @param {number} n */
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

// ---- measurement -------------------------------------------------------------------------

/**
 * Encodes one clip with one config and scores it. Returns null when ffmpeg failed; the
 * caller records the failure and carries on, because one dead config must not lose a run
 * that takes half an hour.
 *
 * @param {object} o
 * @param {string} o.ffmpeg
 * @param {string} o.source   absolute path to the source clip
 * @param {typeof CONFIGS[number]} o.config
 * @param {string} o.outDir   cwd for both ffmpeg calls; must contain no drive colon in paths
 *                            passed *inside* the filter graph (see the header)
 * @param {number} o.duration source duration in seconds, for the bitrate column
 */
async function measure({ ffmpeg, source, config, outDir, duration }) {
  const name = `${basename(source, '.mp4')}__${config.id}`;
  const outFile = `${name}.mp4`;

  const encode = await run(
    ffmpeg,
    ['-v', 'error', '-y', '-i', source, ...config.args, ...(config.gop ?? GOP), '-an', '-f', 'mp4', outFile],
    outDir,
  );
  if (encode.code !== 0) {
    return { error: `encode exited ${encode.code}: ${encode.stderr.trim().split('\n').pop()}` };
  }

  const size = readFileSync(join(outDir, outFile)).byteLength;

  // Distorted stream first, reference second. A bare log filename: a drive colon inside
  // -lavfi is parsed as more filter options and kills the graph.
  const logName = `${name}.vmaf.json`;
  const vmaf = await run(
    ffmpeg,
    [
      '-hide_banner', '-v', 'error', '-y',
      '-i', outFile,
      '-i', source,
      '-lavfi',
      '[0:v]setpts=PTS-STARTPTS,format=yuv420p[dist];' +
        '[1:v]setpts=PTS-STARTPTS,format=yuv420p[ref];' +
        `[dist][ref]libvmaf=n_threads=6:n_subsample=3:log_fmt=json:log_path=${logName}`,
      '-f', 'null', '-',
    ],
    outDir,
  );
  if (vmaf.code !== 0) {
    return { error: `vmaf exited ${vmaf.code}: ${vmaf.stderr.trim().split('\n').pop()}`, size };
  }

  const report = JSON.parse(readFileSync(join(outDir, logName), 'utf8'));
  return {
    size,
    bitrateMbps: Number(((size * 8) / duration / 1e6).toFixed(2)),
    encodeSeconds: Number(encode.seconds.toFixed(1)),
    vmaf: Number(report.pooled_metrics.vmaf.mean.toFixed(2)),
  };
}

/**
 * Container duration in seconds, used only for the bitrate column.
 * @param {string} ffmpeg
 * @param {string} file
 */
async function probeDuration(ffmpeg, file) {
  const ffprobe = ffmpeg.endsWith('ffmpeg') ? 'ffprobe' : ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
  const r = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    process.cwd(),
  );
  const seconds = Number(r.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`could not read a duration from ${file}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return seconds;
}

// ---- report ------------------------------------------------------------------------------

/** @param {Record<string, Record<string, any>>} results */
function toMarkdown(results, clipNames) {
  const out = [];
  for (const clip of clipNames) {
    const rows = results[clip] ?? {};
    out.push(`### ${clip} (${CORPUS[clip]})`, '');
    out.push('| preset | size | bitrate | encode | VMAF |');
    out.push('|---|---|---|---|---|');
    const ordered = CONFIGS.filter((c) => rows[c.id]);
    for (const c of ordered) {
      const r = rows[c.id];
      if (r.error) {
        out.push(`| \`${c.label}\` | failed | | | ${r.error} |`);
        continue;
      }
      out.push(
        `| \`${c.label}\` | ${mb(r.size)} MB | ${r.bitrateMbps} Mbps | ${r.encodeSeconds} s | ${r.vmaf} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

// ---- main --------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = resolve(arg('out', join(REPO, 'apps/desktop/.bench')));
const clipNames = arg('corpus', 'easy,medium,hard').split(',').map((s) => s.trim());
const onlyConfig = arg('only', null);
const ffmpeg = findFfmpeg();

mkdirSync(outDir, { recursive: true });
const resultsPath = join(outDir, 'results.json');
/** @type {Record<string, Record<string, any>>} */
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};

console.log(`ffmpeg:  ${ffmpeg}`);
console.log(`clips:   ${CLIP_DIR}`);
console.log(`out:     ${outDir}`);
console.log(`corpus:  ${clipNames.join(', ')}`);
console.log('');

const only = onlyConfig ? new Set(onlyConfig.split(',').map((s) => s.trim())) : null;
const wanted = only ? CONFIGS.filter((c) => only.has(c.id)) : CONFIGS;
if (wanted.length === 0) throw new Error(`no config matches --only ${onlyConfig}`);

for (const clip of clipNames) {
  const file = CORPUS[clip];
  if (!file) throw new Error(`unknown corpus entry ${clip}; have ${Object.keys(CORPUS).join(', ')}`);
  const source = join(CLIP_DIR, file);
  if (!existsSync(source)) {
    console.log(`SKIP ${clip}: ${source} is missing`);
    continue;
  }
  const duration = await probeDuration(ffmpeg, source);
  results[clip] ??= {};

  for (const config of wanted) {
    if (results[clip][config.id] && !results[clip][config.id].error) {
      console.log(`cached  ${clip.padEnd(7)} ${config.id}`);
      continue;
    }
    process.stdout.write(`run     ${clip.padEnd(7)} ${config.id.padEnd(18)} ... `);
    const r = await measure({ ffmpeg, source, config, outDir, duration });
    results[clip][config.id] = r;
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(
      r.error ? `FAILED ${r.error}` : `${mb(r.size)} MB  ${r.bitrateMbps} Mbps  ${r.encodeSeconds}s  VMAF ${r.vmaf}`,
    );
  }
}

const md = toMarkdown(results, clipNames);
writeFileSync(join(outDir, 'report.md'), md);
console.log('\n' + md);
console.log(`report written to ${join(outDir, 'report.md')}`);
