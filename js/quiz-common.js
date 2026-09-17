// 퀴즈로 알아보는 정읍 — 공통 로직 (Firebase Realtime Database 버전)
//
// 예전 server.js가 하던 일(상태 관리·채점·view-model 조립)을 그대로 클라이언트에서 합니다.
// 서버가 없으므로 컴퓨터를 꺼도, 진행자가 새로고침해도 데이터는 Firebase에 남습니다.
//
// 상태 모델 (Realtime Database)
//   rooms/jeongup2026/
//     state/    phase(lobby|quiz|outro|final), index, open, revealed, openedAt
//     answers/  {문항ID}/{팀번호} = { choice, ms }
//     joined/   {팀번호} = 처음 접속한 시각 (한 번이라도 들어온 팀 — 순위·분모 기준)
//     asked/    {문항ID} = true (한 번이라도 출제된 문항)
//     present/  {팀번호} = true (지금 그 팀 화면이 열려 있는 동안만 — onDisconnect로 자동 제거)
(function (global) {
  "use strict";

  var ROOM_ID = "jeongup2026";
  var ACCESS_KEY = "jeongup2026";
  var DATA_PATH_FROM_ROOT = "data/jeongeup-quiz-2026.json";
  // 배포된 고정 주소. 여기서 열었을 때만 QR이 유효합니다.
  var PROD_ORIGIN = "https://lalaseohyun.github.io/jeongup-sdgs";

  var serverOffset = 0;

  function getQueryParam(name) {
    return new URLSearchParams(global.location.search).get(name);
  }

  function checkAccessKey() {
    return getQueryParam("k") === ACCESS_KEY;
  }

  function dataPath() {
    // host/, 루트 어디서 열든 항상 루트 기준 data 폴더를 가리키게 한다.
    var inHost = /\/host\/?(index\.html)?$/.test(global.location.pathname);
    return (inHost ? "../" : "") + DATA_PATH_FROM_ROOT;
  }

  function loadQuizData() {
    // GitHub Pages는 캐시를 오래 물고 있을 수 있어 항상 재검증한다 (내용이 같으면 304라 비용은 거의 없음).
    return fetch(dataPath(), { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("퀴즈 데이터를 불러오지 못했습니다 (" + res.status + ")");
      return res.json();
    });
  }

  function initFirebase() {
    if (!global.FIREBASE_CONFIG || !global.FIREBASE_CONFIG.databaseURL) {
      throw new Error("js/firebase-config.js 에 Firebase 프로젝트 설정을 채워주세요.");
    }
    if (!firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
    var db = firebase.database();
    db.ref(".info/serverTimeOffset").on("value", function (snap) {
      serverOffset = snap.val() || 0;
    });
    return db;
  }

  function now() {
    return Date.now() + serverOffset;
  }

  function roomRef(db, path) {
    var base = "rooms/" + ROOM_ID;
    return db.ref(path ? base + "/" + path : base);
  }

  function emptyState() {
    return { phase: "lobby", index: -1, open: false, revealed: false, openedAt: null };
  }

  function initialRoomData() {
    return { state: emptyState(), answers: {}, joined: {}, asked: {}, present: {} };
  }

  // practice가 있으면 맨 앞에 붙인 전체 진행 목록. index는 이 배열 기준.
  function buildItems(quiz) {
    var list = [];
    if (quiz.practice) list.push(quiz.practice);
    return list.concat(quiz.questions);
  }

  function buildMaps(quiz) {
    var LABEL = {}; // 팀 번호 -> 화면 표시 이름
    (quiz.teams || []).forEach(function (t) {
      LABEL[t.no] = t.label;
    });
    var SHORT = {}; // 의제 번호 -> 짧은 이름
    (quiz.agendas || []).forEach(function (a) {
      SHORT[a.no] = a.short;
    });
    return { LABEL: LABEL, SHORT: SHORT };
  }

  // Firebase는 숫자 키가 촘촘하면 배열([null, {...}])로 돌려준다. 빈 자리(null)는 없는 것으로 친다.
  function objKeysNum(obj) {
    obj = obj || {};
    return Object.keys(obj)
      .filter(function (k) {
        return obj[k] !== null && obj[k] !== undefined;
      })
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
  }

  // 본문제(scored)만 집계. 동점이면 정답을 빨리 누른 팀이 앞서고,
  // 공동 순위 없이 1등부터 끝까지 가른다.
  function computeRanking(quiz, ITEMS, answers) {
    var scored = ITEMS.filter(function (q) {
      return q.scored;
    });
    var rows = (quiz.teams || []).map(function (t) {
      var correct = 0;
      var ms = 0;
      scored.forEach(function (q) {
        var a = answers[q.id] && answers[q.id][t.no];
        if (a && a.choice === q.answerIndex) {
          correct += 1;
          ms += a.ms || 0;
        }
      });
      return { team: t.no, label: t.label, agenda: t.agenda, score: correct, ms: ms };
    });
    rows.sort(function (a, b) {
      return b.score - a.score || a.ms - b.ms;
    });
    rows.forEach(function (r, i) {
      r.rank = i + 1;
    });
    return rows;
  }

  // 예전 server.js의 payloadFor()와 동일한 모양의 view-model을 만든다.
  // ctx: { quiz, ITEMS, LABEL, SHORT, state, answers, joined, present, role, team }
  function buildPayload(ctx) {
    var quiz = ctx.quiz,
      ITEMS = ctx.ITEMS,
      LABEL = ctx.LABEL,
      SHORT = ctx.SHORT,
      state = ctx.state || emptyState(),
      answers = ctx.answers || {},
      joined = ctx.joined || {},
      present = ctx.present || {};

    var item = state.index >= 0 && state.index < ITEMS.length ? ITEMS[state.index] : null;
    var answersForItem = item ? answers[item.id] || {} : {};
    var answeredTeams = objKeysNum(answersForItem);
    var scoredTotal = ITEMS.filter(function (i) {
      return i.scored;
    }).length;

    var out = {
      meta: quiz.meta,
      outro: quiz.outro,
      teams: quiz.teams,
      total: ITEMS.length,
      scoredTotal: scoredTotal,
      phase: state.phase,
      index: state.index,
      open: state.open,
      revealed: state.revealed,
      serverNow: now(),
      answeredTeams: answeredTeams,
      joined: objKeysNum(joined),
      connected: objKeysNum(present),
      asked: !!(item && ctx.asked && ctx.asked[item.id]),
      item: item && {
        id: item.id,
        scored: item.scored,
        table: item.table,
        agendaNo: item.agendaNo || null,
        agenda: item.agenda,
        agendaShort: SHORT[item.agendaNo] || null,
        tableLabel: LABEL[item.table] || null,
        question: item.question,
        choices: item.choices,
        note: item.note || null,
        order: item.scored
          ? ITEMS.filter(function (i) {
              return i.scored;
            }).indexOf(item) + 1
          : 0,
      },
    };

    if (state.revealed && item) {
      out.reveal = {
        answerIndex: item.answerIndex,
        answerLabel: item.answerLabel,
        highlight: item.highlight,
        explanation: item.explanation,
        source: item.source,
        results: quiz.teams.map(function (t) {
          var a = answersForItem[t.no];
          return { team: t.no, choice: a ? a.choice : null, correct: a ? a.choice === item.answerIndex : false };
        }),
        tally: item.choices.map(function (_, i) {
          return Object.keys(answersForItem).filter(function (no) {
            return answersForItem[no] && answersForItem[no].choice === i;
          }).length;
        }),
      };
    }

    if (state.revealed || state.phase === "final" || ctx.role === "host") {
      out.ranking = computeRanking(quiz, ITEMS, answers);
    }

    if (ctx.role === "host") {
      var n = 0;
      out.list = ITEMS.map(function (it, i) {
        return {
          index: i,
          label: (it.scored ? "Q" + ++n : "연습") + ". " + it.question,
          answered: objKeysNum(answers[it.id]).length,
        };
      });
    }

    if (ctx.role === "team") {
      var a = answersForItem[ctx.team];
      out.my = { team: ctx.team, choice: a ? a.choice : null };
    }

    return out;
  }

  global.QuizCommon = {
    ROOM_ID: ROOM_ID,
    ACCESS_KEY: ACCESS_KEY,
    PROD_ORIGIN: PROD_ORIGIN,
    getQueryParam: getQueryParam,
    checkAccessKey: checkAccessKey,
    loadQuizData: loadQuizData,
    initFirebase: initFirebase,
    now: now,
    roomRef: roomRef,
    emptyState: emptyState,
    initialRoomData: initialRoomData,
    buildItems: buildItems,
    buildMaps: buildMaps,
    computeRanking: computeRanking,
    buildPayload: buildPayload,
  };
})(window);
