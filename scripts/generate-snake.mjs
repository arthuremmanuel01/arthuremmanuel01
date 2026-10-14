// Gera uma cobrinha animada (SVG) que caça os quadrados do gráfico de contribuições,
// cresce a cada um que come e, depois do último, bate em si mesma e reinicia.
// O trajeto é sorteado a cada execução (semente = data do dia), então muda todo dia.
//
// Uso:
//   GITHUB_TOKEN=... GITHUB_USER=arthuremmanuel01 node scripts/generate-snake.mjs dist/snake.svg
//   node scripts/generate-snake.mjs dist/snake.svg --mock=0.3   (dados aleatórios, 30% de dias com contribuição)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const out = process.argv[2] ?? "dist/snake.svg";
const mockArg = process.argv.find((a) => a.startsWith("--mock"));
const seedArg = process.argv.find((a) => a.startsWith("--seed="));

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
const STEP = 0.07; // segundos por casa
const CRASH = { blink: 1.4, fade: 0.5, restore: 0.4, pause: 0.6 };
const ROWS = 7;

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

/** Gerador pseudoaleatório com semente (mulberry32). */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** grid[col][row] = nível 0..4, ou -1 para dias que não existem (antes do início / futuro). */
async function loadGrid(rand) {
  if (mockArg) {
    const density = Number(mockArg.split("=")[1] ?? 0.3);
    return Array.from({ length: 53 }, (_, c) =>
      Array.from({ length: ROWS }, (_, r) => {
        if ((c === 0 && r < 3) || (c === 52 && r > 2)) return -1;
        return rand() < density ? 1 + Math.floor(rand() * 4) : 0;
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
    const col = Array(ROWS).fill(-1);
    for (const day of week.contributionDays) col[day.weekday] = LEVEL[day.contributionLevel] ?? 0;
    return col;
  });
}

// ---------------------------------------------------------------------------
// Simulação: casas são números (col * 7 + linha); o corpo é uma lista com a cabeça em [0].

function makeBoard(W) {
  const neighbors = Array.from({ length: W * ROWS }, (_, k) => {
    const c = Math.floor(k / ROWS);
    const r = k % ROWS;
    return [
      [c + 1, r],
      [c - 1, r],
      [c, r + 1],
      [c, r - 1],
    ]
      .filter(([x, y]) => x >= 0 && x < W && y >= 0 && y < ROWS)
      .map(([x, y]) => x * ROWS + y);
  });
  return { size: W * ROWS, neighbors };
}

function shuffled(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** BFS a partir de `start`, sem passar por `blocked`. Vizinhos embaralhados = caminhos variados. */
function bfs(board, start, blocked, rand) {
  const prev = new Int32Array(board.size).fill(-2);
  const dist = new Int32Array(board.size).fill(-1);
  prev[start] = -1;
  dist[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    for (const n of shuffled(board.neighbors[k], rand)) {
      if (prev[n] !== -2 || blocked.has(n)) continue;
      prev[n] = k;
      dist[n] = dist[k] + 1;
      queue.push(n);
    }
  }
  return { prev, dist };
}

function pathTo(prev, target) {
  const path = [];
  for (let k = target; prev[k] !== -1; k = prev[k]) path.push(k);
  return path.reverse();
}

/** Corpo depois de seguir `moves` (o rabo só anda quando não come). */
function advance(body, food, moves) {
  const next = [...body];
  const left = new Set(food);
  for (const m of moves) {
    next.unshift(m);
    if (left.has(m)) left.delete(m);
    else next.pop();
  }
  return next;
}

/** Seguro = a cabeça ainda consegue alcançar o rabo (há saída). */
function isSafe(board, body, rand) {
  if (body.length < 4) return true;
  const tail = body.at(-1);
  const blocked = new Set(body.slice(1, -1));
  return bfs(board, body[0], blocked, rand).dist[tail] !== -1;
}

function simulate(board, foodCells, rand, maxSteps) {
  const free = [...Array(board.size).keys()].filter((k) => !foodCells.has(k));
  const start = free[Math.floor(rand() * free.length)] ?? 0;
  let body = [start];
  const food = new Set(foodCells);
  const trail = [start];
  const lengths = [1];
  const eatenAt = new Map();

  const move = (m) => {
    body.unshift(m);
    if (food.has(m)) {
      food.delete(m);
      eatenAt.set(m, trail.length);
    } else body.pop();
    trail.push(m);
    lengths.push(body.length);
  };

  // Bloqueado: todo o corpo menos o rabo (que sai do lugar), e o pescoço sempre.
  const blockedNow = () => new Set(body.length > 1 ? body.slice(0, -1).concat(body[1]) : body);

  const planToFood = () => {
    const { prev, dist } = bfs(board, body[0], blockedNow(), rand);
    const options = [...food]
      .filter((k) => dist[k] > 0)
      .map((k) => ({ k, score: dist[k] + rand() * 6 }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);
    for (const { k } of options) {
      const path = pathTo(prev, k);
      if (isSafe(board, advance(body, food, path), rand)) return path;
    }
    return null;
  };

  const wander = () => {
    const blocked = blockedNow();
    const moves = shuffled(board.neighbors[body[0]], rand).filter((n) => !blocked.has(n));
    return moves.find((n) => isSafe(board, advance(body, food, [n]), rand)) ?? moves[0] ?? null;
  };

  while (food.size > 0 && trail.length < maxSteps) {
    // De vez em quando dá uma volta à toa antes de ir atrás da comida.
    const plan = rand() < 0.12 ? null : planToFood();
    if (plan) {
      // Só segue parte do plano: na próxima decisão pode mudar de ideia.
      const take = Math.max(1, Math.ceil(plan.length * (0.4 + rand() * 0.6)));
      plan.slice(0, take).forEach(move);
      continue;
    }
    const m = wander();
    if (m === null) break; // presa
    move(m);
  }

  // Fim: procura o próprio corpo para bater.
  let crash = null;
  for (let i = 0; i < 40 && crash === null; i++) {
    const head = body[0];
    const hits = board.neighbors[head].filter((n) => body.indexOf(n) > 1 && n !== body.at(-1));
    if (hits.length) {
      crash = hits[Math.floor(rand() * hits.length)];
      break;
    }
    const occupied = new Set(body);
    const moves = board.neighbors[head].filter((n) => !occupied.has(n));
    if (!moves.length) break;
    const hugging = (n) => board.neighbors[n].filter((x) => occupied.has(x) && x !== head).length + rand();
    move(moves.sort((a, b) => hugging(b) - hugging(a))[0]);
  }
  crash ??= body[1] ?? board.neighbors[body[0]][0];

  return { trail, lengths, eatenAt, crash, left: food.size };
}

function build(grid, rand) {
  const W = grid.length;
  const board = makeBoard(W);
  const foodCells = new Set();
  grid.forEach((col, c) => col.forEach((level, r) => level > 0 && foodCells.add(c * ROWS + r)));

  // Várias tentativas; fica com a mais curta que comeu tudo.
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const run = simulate(board, foodCells, rand, 3000);
    const better =
      !best || run.left < best.left || (run.left === best.left && run.trail.length < best.trail.length);
    if (better) best = run;
  }

  const toCell = (k) => [Math.floor(k / ROWS), k % ROWS];
  return {
    W,
    path: best.trail.map(toCell),
    crashCell: toCell(best.crash),
    lengths: best.lengths,
    eatenAt: new Map([...best.eatenAt].map(([k, step]) => [toCell(k).join(","), step])),
    left: best.left,
  };
}

// ---------------------------------------------------------------------------
// Renderização

const center = ([c, r]) => [PAD + c * P + CELL / 2, PAD + r * P + CELL / 2];
const fmt = (n) => +n.toFixed(2);

/** Mantém só os quadros onde o movimento muda (entre eles a interpolação linear basta). */
function keyIndexes(values) {
  return values
    .map((v, i) => {
      if (i === 0 || i === values.length - 1) return i;
      const linear = v.every((x, j) => Math.abs(x - values[i - 1][j] - (values[i + 1][j] - x)) < 1e-6);
      return linear ? -1 : i;
    })
    .filter((i) => i >= 0);
}

function render(grid, { W, path, crashCell, lengths, eatenAt }) {
  const end = path.length - 1;
  const tCrash = (end + 1) * STEP;
  const tBlinkEnd = tCrash + CRASH.blink;
  const tFadeEnd = tBlinkEnd + CRASH.fade;
  const tRestoreEnd = tFadeEnd + CRASH.restore;
  const D = tRestoreEnd + CRASH.pause;
  const pct = (t) => `${+((t / D) * 100).toFixed(4)}%`;

  const width = PAD * 2 + W * P - GAP;
  const height = PAD * 2 + ROWS * P - GAP;
  const total = (end + 1) * P;
  const points = [...path, crashCell].map(center);
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)} ${fmt(y)}`).join("");

  // Corpo: um traço só, revelado com stroke-dasharray. Cabeça a k*P do início, cauda (len-1)*P atrás.
  const body = points.map((_, k) => {
    const visible = (lengths[Math.min(k, end)] - 1) * P;
    return [visible, -(k * P - visible)];
  });
  const bodyFrames = keyIndexes(body).map(
    (k) => `${pct(k * STEP)}{stroke-dasharray:${fmt(body[k][0])} ${fmt(total * 2)};stroke-dashoffset:${fmt(body[k][1])}}`,
  );
  const headFrames = keyIndexes(points).map(
    (k) => `${pct(k * STEP)}{transform:translate(${fmt(points[k][0])}px,${fmt(points[k][1])}px)}`,
  );
  const [lastVisible, lastOffset] = body.at(-1);
  bodyFrames.push(`100%{stroke-dasharray:${fmt(lastVisible)} ${fmt(total * 2)};stroke-dashoffset:${fmt(lastOffset)}}`);
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

const today = new Date().toISOString().slice(0, 10);
const seed = Number(seedArg?.split("=")[1] ?? today.replaceAll("-", ""));
const rand = random(seed);
const grid = await loadGrid(rand);
const result = build(grid, rand);
const svg = render(grid, result);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, svg);
const seconds = (result.path.length * STEP).toFixed(0);
console.log(
  `Gerado ${out} (${(svg.length / 1024).toFixed(1)} KB, ${result.path.length} passos, ~${seconds}s` +
    (result.left ? `, ${result.left} quadrados não comidos` : "") +
    ")",
);
