// One-off: pulls the latin + latin-ext subsets of the three design fonts and writes a
// self-hosted @font-face sheet. The desktop app must render the same with no network.
// All three are variable fonts, so Google serves one file per family and subset covering
// every weight we ask for; the sheet declares the weight range rather than one face each.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.argv[2];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const URL_CSS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700&family=Rubik:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap";

const css = await (await fetch(URL_CSS, { headers: { "User-Agent": UA } })).text();
const blocks = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
const want = new Set(["latin", "latin-ext"]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pick = (re, body) => (re.exec(body) ?? [])[1];

/** family+subset -> one face, with the weights folded into a range. */
const faces = new Map();
for (const [, subset, body] of blocks) {
  if (!want.has(subset)) continue;
  const family = pick(/font-family:\s*'([^']+)'/, body);
  const key = `${family}|${subset}`;
  const weight = Number(pick(/font-weight:\s*(\d+)/, body));
  const face = faces.get(key);
  if (face) {
    face.min = Math.min(face.min, weight);
    face.max = Math.max(face.max, weight);
    continue;
  }
  faces.set(key, {
    family,
    subset,
    min: weight,
    max: weight,
    stretch: pick(/font-stretch:\s*([^;]+);/, body),
    range: pick(/unicode-range:\s*([^;]+);/, body).trim(),
    url: pick(/src:\s*url\(([^)]+)\)/, body),
    file: `${slug(family)}-${subset}.woff2`,
  });
}

await mkdir(OUT, { recursive: true });
const rules = [];
for (const f of faces.values()) {
  const bytes = Buffer.from(await (await fetch(f.url, { headers: { "User-Agent": UA } })).arrayBuffer());
  await writeFile(path.join(OUT, f.file), bytes);
  console.log(`${f.file} ${bytes.length} bytes`);
  rules.push(
    [
      "@font-face {",
      `  font-family: "${f.family}";`,
      "  font-style: normal;",
      `  font-weight: ${f.min === f.max ? f.min : `${f.min} ${f.max}`};`,
      ...(f.stretch ? [`  font-stretch: ${f.stretch.trim()};`] : []),
      "  font-display: block;",
      `  src: url("./${f.file}") format("woff2");`,
      `  unicode-range: ${f.range};`,
      "}",
    ].join("\n"),
  );
}

const header =
  "/* Self-hosted subsets of the three design fonts, so the app renders the same with no\n" +
  " * network. Each file is the variable font covering the weights the UI uses.\n" +
  " * Bricolage Grotesque, Rubik and JetBrains Mono are SIL Open Font License 1.1; see\n" +
  " * OFL.txt. Regenerate with scripts/fetch-fonts.mjs. */\n\n";
await writeFile(path.join(OUT, "fonts.css"), header + rules.join("\n\n") + "\n");
console.log(`${rules.length} faces`);
