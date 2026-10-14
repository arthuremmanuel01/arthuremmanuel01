// Gera uma cobrinha animada (SVG) que percorre o gráfico de contribuições,
// cresce a cada quadrado que come e, depois do último, bate em si mesma e reinicia.
//
// Uso:
//   GITHUB_TOKEN=... GITHUB_USER=arthuremmanuel01 node scripts/generate-snake.mjs dist/snake.svg
//   node scripts/generate-snake.mjs dist/snake.svg --mock   (dados aleatórios, para testar)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const out = process.argv[2] ?? "dist/snake.svg";
const mock = process.argv.includes("--mock");

const COLORS = {
  empty: "#161b22",
  levels: ["#1e3a4f", "#3d6f91", "#6aa8d4", "#cfe3f1"],
  snake: "#8fcaf2",
  head: "#eef0ec",
  crash: "#ff6b6b",
};
const CELL = 11;
const GAP = 4;
const P = CELL + GAP; // distância entre centros de quadrados
const PAD = 10;
const STEP = 0.08; // segundos por casa
const CRASH = { blink: 1.4, fade: 0.5, restore: 0.4, pause: 0.6 };

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

/** grid[col][row] = nível 0..4, ou -1 para dias que não existem (antes do início / futuro). */
async function loadGrid() {
  if (mock) {
    return Array.from({ length: 53 }, (_, c) =>
      Array.from({ length: 7 }, (_, r) => {
        if ((c === 0 && r < 3) || (c === 52 && r > 2)) return -1;
        return Math.random() < 0.55 ? 0 : 1 + Math.floor(Math.random() * 4);
      }),
    );
  }
  const login = process.env.GITHUB_USER;
  const token = process.env.GITHUB_TOKEN;
  if (!login || !token) throw new Error("Defina GITHUB_USER e GITHUB_TOKEN (ou use --mock).");

  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { weekday contributionLevel } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));

  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  return weeks.map((week) => {
    const col = Array(7).fill(-1);
    for (const day of week.contributionDays) col[day.weekday] = LEVEL[day.contributionLevel] ?? 0;
    return col;
  });
}

function build(grid) {
  const W = grid.length;

  // Caminho em zigue-zague pelas colunas: nunca cruza a si mesmo enquanto a cobra cresce.
  const path = [];
  const indexOf = new Map();
  for (let c = 0; c < W; c++) {
    for (let i = 0; i < 7; i++) {
      const r = c % 2 === 0 ? i : 6 - i;
      indexOf.set(`${c},${r}`, path.length);
      path.push([c, r]);
    }
  }

  // Termina no último quadrado com contribuição.
  let end = 7;
  path.forEach(([c, r], i) => {
    if (grid[c][r] > 0) end = i;
  });

  const eatenAt = new Map(); // "c,r" -> passo
  const lengths = []; // tamanho da cobra (em casas) a cada passo
  let food = 0;
  for (let k = 0; k <= end; k++) {
    const [c, r] = path[k];
    if (grid[c][r] > 0) {
      food++;
      eatenAt.set(`${c},${r}`, k);
    }
    lengths.push(Math.min(k + 1, 1 + food));
  }

  // Batida: vira para a coluna anterior, onde está o próprio corpo. Se ainda for curta, volta no pescoço.
  const [hc, hr] = path[end];
  const len = lengths[end];
  const westIdx = indexOf.get(`${hc - 1},${hr}`);
  const hitsBody = westIdx !== undefined && westIdx >= end - len + 1;
  const crashCell = hitsBody ? [hc - 1, hr] : path[Math.max(0, end - 1)];

  return { W, path: path.slice(0, end + 1), crashCell, lengths, eatenAt };
}

const center = ([c, r]) => [PAD + c * P + CELL / 2, PAD + r * P + CELL / 2];
const fmt = (n) => +n.toFixed(2);

function render(grid, { W, path, crashCell, lengths, eatenAt }) {
  const end = path.length - 1;
  const tCrash = (end + 1) * STEP;
  const tBlinkEnd = tCrash + CRASH.blink;
  const tFadeEnd = tBlinkEnd + CRASH.fade;
  const tRestoreEnd = tFadeEnd + CRASH.restore;
  const D = tRestoreEnd + CRASH.pause;
  const pct = (t) => `${+((t / D) * 100).toFixed(4)}%`;

  const width = PAD * 2 + W * P - GAP;
  const height = PAD * 2 + 7 * P - GAP;
  const total = (end + 1) * P;
  const points = [...path, crashCell].map(center);
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)} ${fmt(y)}`).join("");

  // Corpo: um traço só, revelado com stroke-dasharray. Cabeça a k*P do início, cauda (len-1)*P atrás.
  const bodyFrames = [];
  const headFrames = [];
  for (let k = 0; k <= end + 1; k++) {
    const len = lengths[Math.min(k, end)];
    const head = k * P;
    const visible = (len - 1) * P;
    bodyFrames.push(
      `${pct(k * STEP)}{stroke-dasharray:${fmt(visible)} ${fmt(total * 2)};stroke-dashoffset:${fmt(-(head - visible))}}`,
    );
    const [x, y] = points[k];
    headFrames.push(`${pct(k * STEP)}{transform:translate(${fmt(x)}px,${fmt(y)}px)}`);
  }
  bodyFrames.push(`100%{stroke-dasharray:${fmt((lengths[end] - 1) * P)} ${fmt(total * 2)};stroke-dashoffset:${fmt(-(total - (lengths[end] - 1) * P))}}`);
  headFrames.push(`100%{transform:translate(${fmt(points.at(-1)[0])}px,${fmt(points.at(-1)[1])}px)}`);

  // Batida: pisca em vermelho, some, e o gráfico volta.
  const blinks = 4;
  const crashFrames = [`0%,${pct(tCrash - 0.001)}{opacity:1}`];
  for (let i = 0; i < blinks; i++) {
    const t = tCrash + (CRASH.blink / blinks) * i;
    crashFrames.push(`${pct(t)}{opacity:1}`, `${pct(t + CRASH.blink / blinks / 2)}{opacity:.25}`);
  }
  crashFrames.push(`${pct(tBlinkEnd)}{opacity:1}`, `${pct(tFadeEnd)},100%{opacity:0}`);
  const colorFrames = (prop, base) =>
    `0%,${pct(tCrash - 0.001)}{${prop}:${base}}${pct(tCrash)},100%{${prop}:${COLORS.crash}}`;

  const cells = [];
  const cellCss = [];
  grid.forEach((col, c) =>
    col.forEach((level, r) => {
      if (level < 0) return;
      const color = level > 0 ? COLORS.levels[level - 1] : COLORS.empty;
      const step = eatenAt.get(`${c},${r}`);
      let cls = "";
      if (step !== undefined) {
        const id = `e${c}_${r}`;
        cls = ` class="${id}"`;
        const t = step * STEP;
        cellCss.push(
          `.${id}{animation-name:${id}}@keyframes ${id}{0%,${pct(t)}{fill:${color}}${pct(t + STEP * 0.4)},${pct(tFadeEnd)}{fill:${COLORS.empty}}${pct(tRestoreEnd)},100%{fill:${color}}}`,
        );
      }
      cells.push(`<rect${cls} x="${PAD + c * P}" y="${PAD + r * P}" width="${CELL}" height="${CELL}" rx="2.5" fill="${color}"/>`);
    }),
  );

  const anim = `${fmt(D)}s linear infinite`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
rect,.snake,.body,.head{animation:${anim}}
.snake{animation-name:crash}
.body{animation-name:body,bodycolor;fill:none;stroke-width:${CELL - 1};stroke-linecap:round;stroke-linejoin:round}
.head{animation-name:head,headcolor}
@keyframes body{${bodyFrames.join("")}}
@keyframes head{${headFrames.join("")}}
@keyframes crash{${crashFrames.join("")}}
@keyframes bodycolor{${colorFrames("stroke", COLORS.snake)}}
@keyframes headcolor{${colorFrames("fill", COLORS.head)}}
${cellCss.join("\n")}
</style>
${cells.join("\n")}
<g class="snake">
<path class="body" d="${d}" stroke="${COLORS.snake}"/>
<circle class="head" r="${CELL / 2 + 1}" fill="${COLORS.head}"/>
</g>
</svg>
`;
}

const grid = await loadGrid();
const svg = render(grid, build(grid));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, svg);
console.log(`Gerado ${out} (${(svg.length / 1024).toFixed(1)} KB)`);
