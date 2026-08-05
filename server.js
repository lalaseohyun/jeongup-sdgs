"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const QRCode = require("qrcode");

const ROOT = __dirname;
const QUIZ = JSON.parse(fs.readFileSync(path.join(ROOT, "jeongeup-quiz-2026.json"), "utf8"));
const STATE_FILE = path.join(ROOT, "state.json");
const PORT = Number(process.env.PORT || 3000);
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString("hex");

const ITEMS = [QUIZ.practice, ...QUIZ.questions];
const TEAMS = QUIZ.teams;
const TEAM_NOS = new Set(TEAMS.map((t) => t.no));
const LABEL = new Map(TEAMS.map((t) => [t.no, t.label]));      // 팀 번호 → 화면에 보이는 이름 (1-1, 3 …)
const SHORT = new Map((QUIZ.agendas || []).map((a) => [a.no, a.short]));

const blank = () => ({
  phase: "lobby", // lobby | quiz | outro | final
  index: -1,
  open: false,
  revealed: false,
  openedAt: null,
  answers: {}, // { [qid]: { [teamNo]: { choice, ms } } }
  joined: {}, // { [teamNo]: joinedAtMs }
  asked: {}, // { [qid]: true } — 한 번이라도 출제한 문제
});

let S = blank();
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  S = Object.assign(blank(), saved, { open: false, openedAt: null });
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(S), () => {});
  }, 200);
}

/* ---------- scoring ---------- */

function computeRanking() {
  const scored = ITEMS.filter((q) => q.scored);
  const rows = TEAMS.map((t) => {
    let correct = 0;
    let ms = 0;
    let answered = 0;
    for (const q of scored) {
      const a = S.answers[q.id] && S.answers[q.id][t.no];
      if (!a) continue;
      answered++;
      if (a.choice === q.answerIndex) {
        correct++;
        ms += a.ms;
      }
    }
    return { team: t.no, label: t.label, agenda: t.agenda, score: correct, answered, ms };
  });
  // 점수가 같으면 정답을 더 빨리 누른 팀이 앞선다. 공동 순위 없이 1위부터 끝까지 가른다.
  rows.sort((a, b) => b.score - a.score || a.ms - b.ms);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/* ---------- state payload ---------- */

function currentItem() {
  return S.index >= 0 && S.index < ITEMS.length ? ITEMS[S.index] : null;
}

function payloadFor(client) {
  const item = currentItem();
  const now = Date.now();
  const answersForItem = item ? S.answers[item.id] || {} : {};
  const answeredTeams = Object.keys(answersForItem).map(Number).sort((a, b) => a - b);

  const out = {
    meta: QUIZ.meta,
    outro: QUIZ.outro,
    teams: TEAMS,
    total: ITEMS.length,
    scoredTotal: ITEMS.filter((i) => i.scored).length,
    phase: S.phase,
    index: S.index,
    open: S.open,
    revealed: S.revealed,
    serverNow: now,
    answeredTeams,
    joined: Object.keys(S.joined).map(Number).sort((a, b) => a - b),
    connected: connectedTeams(),
    asked: !!(item && S.asked[item.id]), // 한 번이라도 출제했는지 — 진행 버튼이 되돌아가지 않게 한다
    item: item && {
      id: item.id,
      scored: item.scored,
      table: item.table,
      agendaNo: item.agendaNo || null,
      agenda: item.agenda,
      agendaShort: SHORT.get(item.agendaNo) || null,
      tableLabel: LABEL.get(item.table) || null,
      question: item.question,
      choices: item.choices,
      note: item.note || null,
      order: item.scored ? ITEMS.filter((i) => i.scored).indexOf(item) + 1 : 0,
    },
  };

  if (S.revealed && item) {
    out.reveal = {
      answerIndex: item.answerIndex,
      answerLabel: item.answerLabel,
      highlight: item.highlight,
      explanation: item.explanation,
      source: item.source,
      results: TEAMS.map((t) => {
        const a = answersForItem[t.no];
        return {
          team: t.no,
          choice: a ? a.choice : null,
          correct: a ? a.choice === item.answerIndex : false,
        };
      }),
      tally: item.choices.map(
        (_, i) => Object.values(answersForItem).filter((a) => a.choice === i).length
      ),
    };
  }

  if (S.revealed || S.phase === "final" || client.role === "host") {
    out.ranking = computeRanking();
  }

  if (client.role === "host") {
    let n = 0;
    out.list = ITEMS.map((it, i) => ({
      index: i,
      label: (it.scored ? `Q${++n}` : "연습") + ". " + it.question,
      answered: Object.keys(S.answers[it.id] || {}).length,
    }));
  }

  if (client.role === "team") {
    const a = answersForItem[client.team];
    out.my = { team: client.team, choice: a ? a.choice : null };
  }
  return out;
}

/* ---------- SSE ---------- */

const clients = new Set();

const seen = new Map(); // 폴링 방식으로 접속한 팀의 마지막 요청 시각
function touch(team) {
  seen.set(team, Date.now());
}

function connectedTeams() {
  const s = new Set();
  for (const c of clients) if (c.role === "team" && c.team) s.add(c.team);
  const now = Date.now();
  for (const [team, at] of seen) if (now - at < 8000) s.add(team);
  return [...s].sort((a, b) => a - b);
}

function broadcast() {
  for (const c of clients) {
    try {
      c.res.write(`data: ${JSON.stringify(payloadFor(c))}\n\n`);
    } catch {}
  }
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(": ping\n\n");
    } catch {}
  }
}, 20000);

/* ---------- host actions ---------- */

// 문제를 고르면 곧바로 답변을 받는다. 별도의 "출제" 단계도, 타이머도 없다.
// 답변은 진행자가 "정답 공개"를 누르는 순간 마감된다.
function selectIndex(i) {
  S.index = Math.max(0, Math.min(ITEMS.length - 1, i));
  S.phase = "quiz";
  S.revealed = false;
  S.open = true;
  S.openedAt = Date.now();
  const cur = currentItem();
  if (cur) S.asked[cur.id] = true;
}

const ACTIONS = {
  lobby() {
    S.phase = "lobby";
    S.open = false;
    S.revealed = false;
  },
  select(body) {
    selectIndex(Number(body.index));
  },
  open() {
    selectIndex(S.index < 0 ? 0 : S.index); // 다시 열기
  },
  lock() {
    S.open = false;
  },
  reveal() {
    S.open = false;
    S.revealed = true;
  },
  // 마지막 문제 다음은 최종 순위, 그 다음이 마무리 문구
  next() {
    if (S.index < ITEMS.length - 1) selectIndex(S.index + 1);
    else {
      S.phase = "final";
      S.open = false;
      S.revealed = false;
    }
  },
  prev() {
    if (S.phase === "outro" || S.phase === "final") {
      S.phase = "quiz";
      selectIndex(ITEMS.length - 1);
      S.revealed = true;
    } else if (S.index > 0) selectIndex(S.index - 1);
  },
  outro() {
    S.phase = "outro";
    S.open = false;
  },
  final() {
    S.phase = "final";
    S.open = false;
    S.revealed = false;
  },
  resetQuestion() {
    const item = currentItem();
    if (item) { delete S.answers[item.id]; delete S.asked[item.id]; }
    S.revealed = false;
    S.open = false;
  },
  // 전체 초기화 — 답변·점수는 물론 접속한 팀 목록까지 모두 지운다
  resetAll() {
    S = blank();
    seen.clear();
  },
  resetEverything() {
    S = blank();
    seen.clear();
  },
};

/* ---------- http ---------- */

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function serveFile(res, file, type) {
  fs.readFile(path.join(ROOT, "public", file), (err, buf) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (p === "/" || p === "/team" || p === "/index.html") return serveFile(res, "team.html", "text/html; charset=utf-8");

  if (p === "/host") {
    if (url.searchParams.get("k") !== HOST_KEY) {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      return res.end("<h1 style='font-family:sans-serif;padding:40px'>진행자 키가 필요합니다.<br><small>서버 콘솔에 표시된 주소로 접속하세요.</small></h1>");
    }
    return serveFile(res, "host.html", "text/html; charset=utf-8");
  }

  if (p === "/qr.svg") {
    const d = url.searchParams.get("d") || "";
    try {
      const svg = await QRCode.toString(d, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#0d1b2a", light: "#ffffff" },
      });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      return res.end(svg);
    } catch {
      return res.writeHead(400).end("bad qr");
    }
  }

  if (p === "/api/public-url") {
    // 지금 유효한 인터넷 주소 — 참가자 QR이 진행자 화면 위치(localhost든 터널이든)와
    // 무관하게 항상 맞는 곳을 가리키도록 진행자 화면이 이걸 물어본다.
    return json(res, 200, { url: publicUrl });
  }

  if (p === "/api/state") {
    const role = url.searchParams.get("role") === "host" ? "host" : "team";
    if (role === "host" && url.searchParams.get("k") !== HOST_KEY) return json(res, 403, { error: "forbidden" });
    const team = Number(url.searchParams.get("team")) || null;
    if (team) touch(team);
    return json(res, 200, payloadFor({ role, team }));
  }

  if (p === "/api/stream") {
    const role = url.searchParams.get("role") === "host" ? "host" : "team";
    if (role === "host" && url.searchParams.get("k") !== HOST_KEY) return json(res, 403, { error: "forbidden" });
    const team = Number(url.searchParams.get("team")) || null;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // 프록시(Cloudflare 등)가 응답을 버퍼링하지 않도록 앞머리를 채워 즉시 흘려보낸다
    res.write(":" + " ".repeat(4096) + "\n\n");
    res.write("retry: 2000\n\n");
    const client = { res, role, team };
    clients.add(client);
    res.write(`data: ${JSON.stringify(payloadFor(client))}\n\n`);
    if (role === "team" && team) broadcast();
    req.on("close", () => {
      clients.delete(client);
      if (role === "team" && team) broadcast();
    });
    return;
  }

  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const team = Number(body.team);
    if (!TEAM_NOS.has(team)) return json(res, 400, { error: "bad team" });
    if (!S.joined[team]) S.joined[team] = Date.now();
    save();
    broadcast();
    return json(res, 200, { ok: true, team });
  }

  if (p === "/api/answer" && req.method === "POST") {
    const body = await readBody(req);
    const team = Number(body.team);
    const choice = Number(body.choice);
    const item = currentItem();
    if (!TEAM_NOS.has(team)) return json(res, 400, { error: "bad team" });
    if (!item || !S.open) return json(res, 409, { error: "closed" });
    if (!(choice >= 0 && choice < item.choices.length)) return json(res, 400, { error: "bad choice" });
    if (!S.answers[item.id]) S.answers[item.id] = {};
    S.answers[item.id][team] = { choice, ms: Math.max(0, Date.now() - (S.openedAt || Date.now())) };
    save();
    broadcast();
    return json(res, 200, { ok: true, choice });
  }

  if (p.startsWith("/api/host/") && req.method === "POST") {
    if (req.headers["x-host-key"] !== HOST_KEY) return json(res, 403, { error: "forbidden" });
    const action = p.slice("/api/host/".length);
    const fn = ACTIONS[action];
    if (!fn) return json(res, 404, { error: "unknown action" });
    fn(await readBody(req));
    save();
    broadcast();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404).end("not found");
});

const LINE = "─".repeat(62);

server.listen(PORT, "0.0.0.0", async () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  console.log(`\n${LINE}`);
  console.log(`  ${QUIZ.meta.title} — 실시간 퀴즈 서버 실행 중`);
  console.log(LINE);
  console.log(`  진행자 화면   http://localhost:${PORT}/host?k=${HOST_KEY}`);
  console.log(`  팀 참여 화면   http://localhost:${PORT}/`);
  ips.forEach((ip) => console.log(`                http://${ip}:${PORT}/   (같은 와이파이)`));
  console.log(LINE);

  if (process.argv.includes("--tunnel")) await startTunnel();
  else console.log(`  인터넷 공개가 필요하면 :  npm run live\n${LINE}\n`);
});

// 지금 유효한 공개(인터넷) 주소. 진행자 화면이 어디서 열렸든(localhost든 터널 주소든)
// QR을 맞게 그릴 수 있도록 /api/public-url로 알려준다.
let publicUrl = null;

async function startTunnel() {
  let cf;
  try {
    cf = require("cloudflared");
  } catch {
    console.log("  [터널] cloudflared 패키지가 없습니다. npm install cloudflared\n");
    return;
  }
  if (!fs.existsSync(cf.bin)) {
    console.log("  [터널] cloudflared 내려받는 중… (최초 1회, 약 30초)");
    await cf.install(cf.bin);
  }
  console.log("  [터널] 인터넷 주소 만드는 중…");

  let t = null;
  let stopping = false;
  let restarting = false;

  const spawn = () => {
    restarting = false;
    t = cf.Tunnel.quick(`http://localhost:${PORT}`);
    t.on("url", (url) => {
      publicUrl = url;
      console.log(`\n${LINE}`);
      console.log(`  🌐 인터넷 주소 (휴대폰 데이터로 접속 가능)`);
      console.log(LINE);
      console.log(`  팀 참여 화면   ${url}/`);
      console.log(`  진행자 화면   ${url}/host?k=${HOST_KEY}`);
      console.log(`  진행자 화면(권장)   http://localhost:${PORT}/host?k=${HOST_KEY}`);
      console.log(LINE);
      console.log(`  ※ 팀 참여 QR은 자동으로 이 주소를 가리킵니다. 진행자 화면은`);
      console.log(`     인터넷이 아니라 위 localhost 주소로 여는 편이 훨씬 안전합니다`);
      console.log(`     (터널이 죽어도 진행자 화면은 멀쩡히 돌아갑니다).`);
      console.log(`  ※ 이 창을 닫으면 서버가 꺼집니다. 행사 끝날 때까지 켜두세요.\n`);
    });
    t.on("error", (e) => console.log("  [터널] 오류:", e.message));
    t.on("exit", () => {
      publicUrl = null;
      if (stopping || restarting) return;
      console.log("  [터널] 연결이 끊겼습니다. 5초 후 새 주소를 만듭니다…");
      setTimeout(spawn, 5000);
    });
  };
  spawn();

  // cloudflared 무료 터널은 프로세스는 살아있는데 주소만 조용히 죽는 경우가 있다
  // (exit 이벤트가 안 온다). 그래서 주기적으로 실제로 열리는지 직접 확인한다.
  const healthCheck = setInterval(async () => {
    if (!publicUrl || stopping || restarting) return;
    try {
      const r = await fetch(publicUrl + "/qr.svg?d=x", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
    } catch {
      if (restarting) return;
      restarting = true;
      console.log(`  [터널] 주소가 응답하지 않습니다. 새로 만듭니다…`);
      publicUrl = null;
      try { t && t.stop(); } catch {}
      setTimeout(spawn, 3000);
    }
  }, 45000);

  process.on("SIGINT", () => {
    stopping = true;
    clearInterval(healthCheck);
    try { t && t.stop(); } catch {}
    process.exit(0);
  });
}
