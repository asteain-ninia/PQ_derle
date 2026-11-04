import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  DEFAULT_MAX_RENDER_DIMENSION,
  filterSvgNamedLayers,
  listSvgNamedLayers,
  renderSvgToPng,
} from '../src/svg-rasterize.js';

const DEFAULT_FONT_FILES = [
  'C:\\Windows\\Fonts\\meiryo.ttc',
  'C:\\Windows\\Fonts\\meiryob.ttc',
  'C:\\Windows\\Fonts\\msgothic.ttc',
  'C:\\Windows\\Fonts\\YuGothR.ttc',
  'C:\\Windows\\Fonts\\YuGothB.ttc',
];

function printUsage() {
  console.log(`Usage:
  npm run svg-png -- <input.svg> <output.png> [--width=12000] [--height=6000] [--zoom=2]
    [--include-layer=_海,_第二分高面] [--exclude-layer=_文字,_境界] [--background=white]
    [--max-default-dimension=${DEFAULT_MAX_RENDER_DIMENSION}] [--font-file=C:\\path\\font.ttf]
  npm run svg-png -- <input.svg> --list-layers
`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [key, rawValue] = arg.slice(2).split('=');
    const value = rawValue ?? 'true';
    if (options[key]) {
      options[key].push(value);
    } else {
      options[key] = [value];
    }
  }
  return { positional, options };
}

function getOption(options, key) {
  return options[key]?.at(-1);
}

function hasFlag(options, key) {
  return getOption(options, key) === 'true';
}

function getListOption(options, key) {
  return (options[key] || [])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getAutoFontFiles() {
  const existing = [];
  for (const fontFile of DEFAULT_FONT_FILES) {
    if (await fileExists(fontFile)) {
      existing.push(fontFile);
    }
  }
  return existing;
}

function formatLayerLine(layer) {
  const indent = '  '.repeat(layer.depth);
  const id = layer.id || '(no id)';
  const name = layer.name || '(no name)';
  return `${indent}${id}  ${name}`;
}

function printLayerList(layers) {
  if (!layers.length) {
    console.log('No named <g> layers found.');
    return;
  }
  for (const layer of layers) {
    console.log(formatLayerLine(layer));
  }
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const listLayersOnly = hasFlag(options, 'list-layers');

  if (!positional.length || (!listLayersOnly && positional.length < 2)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const [inputPath, outputPath] = positional;
  const sourceSvg = await fs.readFile(inputPath, 'utf8');

  if (listLayersOnly) {
    printLayerList(listSvgNamedLayers(sourceSvg, { DOMParser, XMLSerializer }));
    if (!outputPath) {
      return;
    }
  }

  const includeLayers = getListOption(options, 'include-layer');
  const excludeLayers = getListOption(options, 'exclude-layer');
  const filtered = filterSvgNamedLayers(
    sourceSvg,
    { includeLayers, excludeLayers },
    { DOMParser, XMLSerializer },
  );

  const fontFiles = [
    ...(await getAutoFontFiles()),
    ...getListOption(options, 'font-file'),
  ];

  const render = renderSvgToPng(filtered.svgText, {
    width: getOption(options, 'width') ? Number(getOption(options, 'width')) : null,
    height: getOption(options, 'height') ? Number(getOption(options, 'height')) : null,
    zoom: getOption(options, 'zoom') ? Number(getOption(options, 'zoom')) : null,
    background: getOption(options, 'background') || undefined,
    dpi: getOption(options, 'dpi') ? Number(getOption(options, 'dpi')) : undefined,
    maxDefaultDimension: getOption(options, 'max-default-dimension')
      ? Number(getOption(options, 'max-default-dimension'))
      : DEFAULT_MAX_RENDER_DIMENSION,
    loadSystemFonts: true,
    defaultFontFamily: getOption(options, 'default-font-family') || 'Meiryo UI',
    fontFiles: [...new Set(fontFiles)],
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, render.pngBuffer);

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    sourceWidth: render.sourceWidth,
    sourceHeight: render.sourceHeight,
    outputWidth: render.outputWidth,
    outputHeight: render.outputHeight,
    fitTo: render.fitTo,
    scaledByDefault: render.scaledByDefault,
    includedLayers: filtered.matchedIncludeLayers,
    excludedLayers: filtered.matchedExcludeLayers,
    remainingLayerCount: filtered.remainingLayers.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
