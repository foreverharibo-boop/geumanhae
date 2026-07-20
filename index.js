// ===== 그만해 (Geumanhae) - ST 사용량 관리 확장 =====
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const EXT_ID = "geumanhae";
const EXT_VERSION = "1.2.0"; // 콘솔에 이 버전이 안 뜨면 캐시된 옛날 index.js가 실행 중인 것
const ACTIVE_TICK_MS = 30 * 1000; // 30초마다 활성 시간 누적 체크
const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3분 이상 입력/조작 없으면 비활성으로 간주

const defaultSettings = {
  enabled: true,
  limitType: "usage",     // "usage" | "schedule" - 사용량 기반 vs 시간대 기반, 양자택일
  timeLimitMin: 150,       // 0 = 무제한
  msgLimit: 80,            // 0 = 무제한
  resetTime: "00:00",      // HH:MM, 하루 기준 리셋 시각
  scheduleMode: "curfew",  // "curfew"(이 시간대 금지) | "window"(이 시간대만 허용)
  scheduleStart: "23:00",
  scheduleEnd: "07:00",
  mode: "bypass",          // "bypass" | "block" - 리밋(사용량이든 시간대든) 초과 시 공통 동작
  nudgeEnabled: true,
  nudgeIntervalMin: 30,
  // ---- 아래는 트래킹 데이터, 사용자가 UI로 직접 안 건드림 ----
  data: {
    periodStart: null,     // 현재 카운트 주기가 시작된 ISO 시각(=마지막 리셋 시각)
    totalActiveMs: 0,
    messageCount: 0,
    lastNudgeAt: null,     // ISO
  },
};

let lastActivityAt = Date.now();
let isPageVisible = !document.hidden;
let tickTimer = null;
let bypassOnce = false; // "그래도 계속" 눌렀을 때 한 번만 통과시키는 플래그

function getSettings() {
  if (!extension_settings[EXT_ID]) {
    extension_settings[EXT_ID] = structuredClone(defaultSettings);
  }
  // 새로 추가된 필드가 기존 설정에 없으면 채워넣기 (마이그레이션)
  const s = extension_settings[EXT_ID];
  for (const k of Object.keys(defaultSettings)) {
    if (s[k] === undefined) s[k] = structuredClone(defaultSettings[k]);
  }
  if (!s.data) s.data = structuredClone(defaultSettings.data);
  for (const k of Object.keys(defaultSettings.data)) {
    if (s.data[k] === undefined) s.data[k] = defaultSettings.data[k];
  }
  return s;
}

function save() {
  saveSettingsDebounced();
}

// ---- 리셋 주기 계산 ----
// resetTime(HH:MM) 기준으로, "현재 시각이 속한 주기의 시작 시각"을 구한다.
function currentPeriodStart(resetTime) {
  const [h, m] = resetTime.split(":").map(Number);
  const now = new Date();
  const boundary = new Date(now);
  boundary.setHours(h, m, 0, 0);
  if (now < boundary) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.toISOString();
}

function checkAndRollPeriod() {
  const s = getSettings();
  const expectedStart = currentPeriodStart(s.resetTime);
  if (s.data.periodStart !== expectedStart) {
    s.data.periodStart = expectedStart;
    s.data.totalActiveMs = 0;
    s.data.messageCount = 0;
    s.data.lastNudgeAt = null;
    bypassOnce = false;
    save();
  }
}

// ---- 활성 시간 트래킹 ----
function markActivity() {
  lastActivityAt = Date.now();
}

function tick() {
  checkAndRollPeriod();
  const s = getSettings();
  if (!s.enabled) return updateStatUI();

  const idle = Date.now() - lastActivityAt > IDLE_THRESHOLD_MS;
  if (!idle && isPageVisible) {
    s.data.totalActiveMs += ACTIVE_TICK_MS;
    save();
  }

  maybeNudge();
  updateStatUI();
}

// ---- 넛지 ----
function maybeNudge() {
  const s = getSettings();
  if (!s.enabled || !s.nudgeEnabled) return;
  const intervalMs = s.nudgeIntervalMin * 60 * 1000;
  if (intervalMs <= 0) return;

  const last = s.data.lastNudgeAt ? new Date(s.data.lastNudgeAt).getTime() : new Date(s.data.periodStart).getTime();
  if (Date.now() - last >= intervalMs) {
    s.data.lastNudgeAt = new Date().toISOString();
    save();
    showNudgeToast(`연속 사용 ${s.nudgeIntervalMin}분 경과했어. 잠깐 쉬어가는 건 어때?`);
  }
}

function showNudgeToast(message) {
  let toast = document.getElementById("gmh-nudge-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "gmh-nudge-toast";
    toast.setAttribute("popover", "manual"); // top layer 렌더링, 부모 transform 영향 안 받음
    document.documentElement.appendChild(toast);
  }
  toast.textContent = message;
  const set = (k, v) => toast.style.setProperty(k, v, "important");
  set("position", "fixed");
  set("top", "50%");
  set("left", "50%");
  set("margin", "0");
  set("color", "var(--SmartThemeBodyColor)");
  set("filter", "none");
  set("text-shadow", "none");
  if (!toast.matches(":popover-open")) {
    try { toast.showPopover(); } catch (err) { console.error("[그만해] 넛지 토스트 표시 실패:", err); }
  }
  requestAnimationFrame(() => {
    toast.classList.add("gmh-show");
    set("opacity", "1");
    set("transform", "translate(-50%, -50%) scale(1)");
  });
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove("gmh-show");
    toast.style.removeProperty("opacity");
    setTimeout(() => { try { toast.hidePopover(); } catch (err) {} }, 300);
  }, 6000);
}

// ---- 통계 UI 갱신 ----
function updateStatUI() {
  const s = getSettings();
  const panel = document.getElementById("geumanhae-panel");
  if (!panel) return;

  const usedMin = Math.floor(s.data.totalActiveMs / 60000);
  const usedMsg = s.data.messageCount;

  const timeVal = panel.querySelector("#gmh-stat-time-val");
  const timeLabel = panel.querySelector("#gmh-stat-time-label");
  const msgVal = panel.querySelector("#gmh-stat-msg-val");
  const msgLabel = panel.querySelector("#gmh-stat-msg-label");
  if (timeVal) timeVal.textContent = usedMin;
  if (msgVal) msgVal.textContent = usedMsg;
  if (timeLabel) timeLabel.textContent = s.timeLimitMin > 0 ? `목표 ${s.timeLimitMin}분` : "제한 없음";
  if (msgLabel) msgLabel.textContent = s.msgLimit > 0 ? `목표 ${s.msgLimit}개` : "제한 없음";

  const timeRatio = (s.limitType === "usage" && s.timeLimitMin > 0) ? usedMin / s.timeLimitMin : 0;
  const msgRatio = (s.limitType === "usage" && s.msgLimit > 0) ? usedMsg / s.msgLimit : 0;
  const ratio = Math.max(timeRatio, msgRatio);

  const fill = panel.querySelector("#gmh-progress-fill");
  if (fill) {
    fill.style.width = `${Math.min(ratio, 1) * 100}%`;
    fill.classList.toggle("gmh-warn", ratio >= 0.7 && ratio < 1);
    fill.classList.toggle("gmh-danger", ratio >= 1);
  }
  const timeBox = panel.querySelector("#gmh-stat-time-box");
  const msgBox = panel.querySelector("#gmh-stat-msg-box");
  if (timeBox) timeBox.classList.toggle("gmh-danger", s.limitType === "usage" && s.timeLimitMin > 0 && usedMin >= s.timeLimitMin);
  if (msgBox) msgBox.classList.toggle("gmh-danger", s.limitType === "usage" && s.msgLimit > 0 && usedMsg >= s.msgLimit);

  // 제한 방식에 따라 일일제한/시간대제한 패널 표시 전환
  const usagePanel = panel.querySelector("#gmh-usage-panel");
  const schedulePanel = panel.querySelector("#gmh-schedule-panel");
  if (usagePanel) usagePanel.style.display = s.limitType === "usage" ? "" : "none";
  if (schedulePanel) schedulePanel.style.display = s.limitType === "schedule" ? "" : "none";

  // 시간대 기반 현재 상태 표시
  const scheduleStatus = panel.querySelector("#gmh-schedule-status");
  if (scheduleStatus && s.limitType === "schedule") {
    const blocked = isScheduleBlocked();
    const next = getNextUnlockTime();
    const nextStr = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
    scheduleStatus.textContent = blocked
      ? `🚫 지금은 차단 중 (${nextStr}에 풀림)`
      : `✅ 지금은 사용 가능 (${nextStr}부터 ${s.scheduleMode === "curfew" ? "차단" : "제한"})`;
  }

  updateSendButtonState();
}

// ---- 전송 버튼 실제 비활성화 (완전 차단 모드에서 클릭/터치 자체를 막음) ----
function updateSendButtonState() {
  const s = getSettings();
  const shouldBlock = s.enabled && s.mode === "block" && isOverLimit();
  const sendBtn = document.getElementById("send_but");
  const textarea = document.getElementById("send_textarea");
  const panel = document.getElementById("geumanhae-panel");
  const resetBtn = panel ? panel.querySelector("#gmh-reset-today-btn") : null;

  if (sendBtn) {
    sendBtn.classList.toggle("gmh-send-disabled", shouldBlock);
    sendBtn.setAttribute("aria-disabled", shouldBlock ? "true" : "false");
    if ("disabled" in sendBtn) sendBtn.disabled = shouldBlock; // 실제 <button>인 경우 대비
  }
  if (textarea) {
    textarea.classList.toggle("gmh-send-disabled", shouldBlock);
  }
  if (resetBtn) {
    // 완전 차단 중엔 초기화 버튼으로 우회 못 하게 같이 잠금
    resetBtn.disabled = shouldBlock;
    resetBtn.classList.toggle("gmh-send-disabled", shouldBlock);
    resetBtn.title = shouldBlock ? "완전 차단 중엔 초기화할 수 없어 (리셋 시각까지 대기)" : "";
  }

  const enabledToggle = panel ? panel.querySelector("#gmh-enabled-toggle") : null;
  const modeGroup = panel ? panel.querySelector("#gmh-mode-group") : null;
  if (enabledToggle) {
    enabledToggle.classList.toggle("gmh-send-disabled", shouldBlock);
    enabledToggle.title = shouldBlock ? "완전 차단 중엔 끌 수 없어 (리셋 시각까지 대기)" : "";
  }
  if (modeGroup) {
    modeGroup.classList.toggle("gmh-send-disabled", shouldBlock);
    modeGroup.title = shouldBlock ? "완전 차단 중엔 모드를 바꿀 수 없어 (리셋 시각까지 대기)" : "";
  }

  // 리밋 숫자 자체를 늘려서 우회하는 것도 막음
  const timeLimitInput = panel ? panel.querySelector("#gmh-time-limit-input") : null;
  const msgLimitInput = panel ? panel.querySelector("#gmh-msg-limit-input") : null;
  [timeLimitInput, msgLimitInput].forEach(inp => {
    if (!inp) return;
    inp.disabled = shouldBlock;
    inp.classList.toggle("gmh-send-disabled", shouldBlock);
    inp.title = shouldBlock ? "완전 차단 중엔 제한값을 바꿀 수 없어 (리셋 시각까지 대기)" : "";
  });

  // 리셋 시각을 앞당겨서 강제로 새 주기로 넘기는 우회도 막음
  const resetTimeInput = panel ? panel.querySelector("#gmh-reset-time-input") : null;
  if (resetTimeInput) {
    resetTimeInput.disabled = shouldBlock;
    resetTimeInput.classList.toggle("gmh-send-disabled", shouldBlock);
    resetTimeInput.title = shouldBlock ? "완전 차단 중엔 리셋 시각을 바꿀 수 없어" : "";
  }

  // 제한 방식/시간대 설정도 완전 차단 중엔 못 바꾸게 (사용량↔시간대 전환, 시간대 값 조작 등 우회 방지)
  const limitTypeGroup = panel ? panel.querySelector("#gmh-limittype-group") : null;
  const scheduleModeGroup = panel ? panel.querySelector("#gmh-schedulemode-group") : null;
  const scheduleStartInput = panel ? panel.querySelector("#gmh-schedule-start-input") : null;
  const scheduleEndInput = panel ? panel.querySelector("#gmh-schedule-end-input") : null;
  [limitTypeGroup, scheduleModeGroup].forEach(el => {
    if (!el) return;
    el.classList.toggle("gmh-send-disabled", shouldBlock);
    el.title = shouldBlock ? "완전 차단 중엔 바꿀 수 없어" : "";
  });
  [scheduleStartInput, scheduleEndInput].forEach(inp => {
    if (!inp) return;
    inp.disabled = shouldBlock;
    inp.classList.toggle("gmh-send-disabled", shouldBlock);
    inp.title = shouldBlock ? "완전 차단 중엔 바꿀 수 없어" : "";
  });
}

// ---- 시간대 기반 판정 ----
// start~end(HH:MM) 구간에 현재 시각이 포함되는지. start>end면 자정 넘어가는 구간으로 처리 (예: 23:00~07:00)
function isWithinTimeRange(startStr, endStr) {
  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return true; // 시작=종료면 하루 종일로 취급
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // 자정을 넘어가는 구간 (예: 23:00 ~ 07:00)
  return nowMin >= startMin || nowMin < endMin;
}

function isScheduleBlocked() {
  const s = getSettings();
  const inRange = isWithinTimeRange(s.scheduleStart, s.scheduleEnd);
  return s.scheduleMode === "curfew" ? inRange : !inRange;
}

// ---- 리밋 판정 ----
function isOverLimit() {
  const s = getSettings();
  if (s.limitType === "schedule") {
    return isScheduleBlocked();
  }
  const usedMin = s.data.totalActiveMs / 60000;
  const overTime = s.timeLimitMin > 0 && usedMin >= s.timeLimitMin;
  const overMsg = s.msgLimit > 0 && s.data.messageCount >= s.msgLimit;
  return overTime || overMsg;
}

// ---- 전송 버튼 인터셉트 ----
function interceptSend(e) {
  const s = getSettings();
  checkAndRollPeriod();
  console.log("[그만해] 전송 감지 - enabled:", s.enabled, "메시지:", s.data.messageCount, "/", s.msgLimit, "시간(분):", Math.floor(s.data.totalActiveMs / 60000), "/", s.timeLimitMin);
  if (!s.enabled) return; // 통과
  if (bypassOnce) { bypassOnce = false; return; } // 이번 한 번은 통과
  if (!isOverLimit()) return; // 아직 안 넘음, 통과

  console.log("[그만해] 리밋 초과 → 모달 표시, mode:", s.mode);
  // 리밋 초과 → 여기서 막는다
  e.preventDefault();
  e.stopImmediatePropagation();

  if (s.mode === "bypass") {
    showBypassModal();
  } else {
    showBlockModal();
  }
}

// ---- 다음 잠금 해제 시각 계산 ----
function getNextUnlockTime() {
  const s = getSettings();
  const now = new Date();
  let boundaryH, boundaryM;

  if (s.limitType === "schedule") {
    // curfew: 커퓨 구간이 끝나는 시각(end)이 해제 시각
    // window: 허용 구간이 시작되는 시각(start)이 해제 시각
    const [sh, sm] = s.scheduleStart.split(":").map(Number);
    const [eh, em] = s.scheduleEnd.split(":").map(Number);
    boundaryH = s.scheduleMode === "curfew" ? eh : sh;
    boundaryM = s.scheduleMode === "curfew" ? em : sm;
  } else {
    [boundaryH, boundaryM] = s.resetTime.split(":").map(Number);
  }

  const next = new Date(now);
  next.setHours(boundaryH, boundaryM, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function closeModal() {
  const dlg = document.getElementById("gmh-limit-modal-native");
  if (dlg) {
    dlg.close();
    dlg.remove();
  }
}

function openDialog(innerHtml) {
  closeModal();
  const dlg = document.createElement("dialog");
  dlg.id = "gmh-limit-modal-native";
  dlg.innerHTML = innerHtml;
  document.documentElement.appendChild(dlg);
  // native <dialog>.showModal()은 top layer에 렌더링돼서
  // 조상 요소의 transform/overflow/z-index에 영향을 안 받음
  dlg.showModal();
  dlg.addEventListener("cancel", closeModal); // ESC/뒤로가기 대응
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeModal(); // 바깥 클릭 시 닫기
  });
  return dlg;
}

function showBypassModal() {
  const s = getSettings();
  const isSchedule = s.limitType === "schedule";
  const title = isSchedule ? "지금은 금지 시간대야" : "오늘 목표 넘었어";
  const body = isSchedule
    ? `설정한 금지 시간대(${s.scheduleMode === "curfew" ? s.scheduleStart + "~" + s.scheduleEnd : "허용 윈도 밖"})야.<br>그래도 계속 쓸래?`
    : "설정한 사용 시간/메시지 한도를 초과했어.<br>그래도 계속 쓸래?";
  const dlg = openDialog(`
    <div class="gmh-modal-title">${title}</div>
    <div class="gmh-modal-body">${body}</div>
    <div class="gmh-modal-btns">
      <button id="gmh-modal-cancel">그만할게</button>
      <button id="gmh-modal-continue" class="gmh-btn-primary">그래도 계속</button>
    </div>`);
  dlg.querySelector("#gmh-modal-cancel").onclick = closeModal;
  dlg.querySelector("#gmh-modal-continue").onclick = () => {
    bypassOnce = true;
    closeModal();
    document.getElementById("send_but")?.click();
  };
}

function showBlockModal() {
  const s = getSettings();
  const isSchedule = s.limitType === "schedule";
  const nextUnlock = getNextUnlockTime();
  const bodyText = isSchedule
    ? "완전 차단 모드라 금지 시간대가 끝날 때까지는 전송이 안 돼."
    : "완전 차단 모드라 리셋 시각까지는 전송이 안 돼.";

  const dlg = openDialog(`
    <div class="gmh-modal-title">오늘은 여기까지</div>
    <div class="gmh-countdown" id="gmh-countdown">--:--:--</div>
    <div class="gmh-modal-body">${bodyText}</div>
    <div class="gmh-modal-btns">
      <button id="gmh-modal-close" class="gmh-btn-primary">알겠어</button>
    </div>`);
  dlg.querySelector("#gmh-modal-close").onclick = closeModal;

  const countdownEl = dlg.querySelector("#gmh-countdown");
  const timer = setInterval(() => {
    const diff = nextUnlock - Date.now();
    if (diff <= 0 || !document.documentElement.contains(dlg)) {
      clearInterval(timer);
      return;
    }
    const hh = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    countdownEl.textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}

// ---- 설정 패널 UI 바인딩 ----
function bindSettingsUI() {
  const panel = document.getElementById("geumanhae-panel");
  if (!panel) return;
  const s = getSettings();

  // 캐시된 예전 settings.html이 로드됐을 경우를 대비해 흐린 서브텍스트 잔재를 강제로 제거
  panel.querySelectorAll(".gmh-row-sub, .gmh-radio-desc, .gmh-label").forEach(el => el.remove());
  panel.querySelectorAll("[style*='opacity']").forEach(el => el.style.removeProperty("opacity"));

  const enabledToggle = panel.querySelector("#gmh-enabled-toggle");
  const nudgeToggle = panel.querySelector("#gmh-nudge-toggle");
  const timeLimitInput = panel.querySelector("#gmh-time-limit-input");
  const msgLimitInput = panel.querySelector("#gmh-msg-limit-input");
  const resetTimeInput = panel.querySelector("#gmh-reset-time-input");
  const nudgeIntervalInput = panel.querySelector("#gmh-nudge-interval-input");
  const modeGroup = panel.querySelector("#gmh-mode-group");
  const resetBtn = panel.querySelector("#gmh-reset-today-btn");
  const limitTypeGroup = panel.querySelector("#gmh-limittype-group");
  const scheduleModeGroup = panel.querySelector("#gmh-schedulemode-group");
  const scheduleStartInput = panel.querySelector("#gmh-schedule-start-input");
  const scheduleEndInput = panel.querySelector("#gmh-schedule-end-input");

  enabledToggle.classList.toggle("gmh-on", s.enabled);
  nudgeToggle.classList.toggle("gmh-on", s.nudgeEnabled);
  timeLimitInput.value = s.timeLimitMin;
  msgLimitInput.value = s.msgLimit;
  resetTimeInput.value = s.resetTime;
  nudgeIntervalInput.value = s.nudgeIntervalMin;
  scheduleStartInput.value = s.scheduleStart;
  scheduleEndInput.value = s.scheduleEnd;
  modeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.classList.toggle("gmh-selected", opt.dataset.mode === s.mode);
  });
  limitTypeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.classList.toggle("gmh-selected", opt.dataset.limittype === s.limitType);
  });
  scheduleModeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.classList.toggle("gmh-selected", opt.dataset.schedulemode === s.scheduleMode);
  });

  enabledToggle.addEventListener("click", () => {
    const cur = getSettings();
    if (cur.enabled && cur.mode === "block" && isOverLimit()) {
      showNudgeToast("완전 차단 중엔 활성화를 끌 수 없어. 리셋 시각까지 기다려줘.");
      return;
    }
    s.enabled = !s.enabled;
    enabledToggle.classList.toggle("gmh-on", s.enabled);
    save();
    updateSendButtonState();
  });
  nudgeToggle.addEventListener("click", () => {
    s.nudgeEnabled = !s.nudgeEnabled;
    nudgeToggle.classList.toggle("gmh-on", s.nudgeEnabled);
    save();
  });
  ["change", "input"].forEach(evt => {
    timeLimitInput.addEventListener(evt, () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        timeLimitInput.value = cur.timeLimitMin; // 완전 차단 중엔 값 되돌림
        return;
      }
      s.timeLimitMin = Math.max(0, parseInt(timeLimitInput.value) || 0);
      save();
      updateStatUI();
    });
    msgLimitInput.addEventListener(evt, () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        msgLimitInput.value = cur.msgLimit; // 완전 차단 중엔 값 되돌림
        return;
      }
      s.msgLimit = Math.max(0, parseInt(msgLimitInput.value) || 0);
      save();
      updateStatUI();
    });
    nudgeIntervalInput.addEventListener(evt, () => {
      s.nudgeIntervalMin = Math.max(1, parseInt(nudgeIntervalInput.value) || 30);
      save();
    });
  });
  resetTimeInput.addEventListener("change", () => {
    const cur = getSettings();
    if (cur.enabled && cur.mode === "block" && isOverLimit()) {
      resetTimeInput.value = cur.resetTime; // 완전 차단 중엔 되돌림
      showNudgeToast("완전 차단 중엔 리셋 시각을 바꿀 수 없어.");
      return;
    }
    s.resetTime = resetTimeInput.value || "00:00";
    save();
    checkAndRollPeriod();
    updateSendButtonState();
  });
  modeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        showNudgeToast("완전 차단 중엔 모드를 바꿀 수 없어. 리셋 시각까지 기다려줘.");
        return;
      }
      s.mode = opt.dataset.mode;
      modeGroup.querySelectorAll(".gmh-radio-option").forEach(o => o.classList.remove("gmh-selected"));
      opt.classList.add("gmh-selected");
      save();
      updateSendButtonState();
    });
  });
  resetBtn.addEventListener("click", () => {
    const cur = getSettings();
    const blocked = cur.enabled && cur.mode === "block" && isOverLimit();
    if (blocked) {
      showNudgeToast("완전 차단 중엔 초기화할 수 없어. 리셋 시각까지 기다려줘.");
      return;
    }
    cur.data.totalActiveMs = 0;
    cur.data.messageCount = 0;
    cur.data.lastNudgeAt = null;
    bypassOnce = false;
    save();
    updateStatUI();
  });

  limitTypeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        showNudgeToast("완전 차단 중엔 제한 방식을 바꿀 수 없어.");
        return;
      }
      s.limitType = opt.dataset.limittype;
      limitTypeGroup.querySelectorAll(".gmh-radio-option").forEach(o => o.classList.remove("gmh-selected"));
      opt.classList.add("gmh-selected");
      save();
      updateStatUI();
    });
  });
  scheduleModeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        showNudgeToast("완전 차단 중엔 바꿀 수 없어.");
        return;
      }
      s.scheduleMode = opt.dataset.schedulemode;
      scheduleModeGroup.querySelectorAll(".gmh-radio-option").forEach(o => o.classList.remove("gmh-selected"));
      opt.classList.add("gmh-selected");
      save();
      updateStatUI();
    });
  });
  ["change", "input"].forEach(evt => {
    scheduleStartInput.addEventListener(evt, () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        scheduleStartInput.value = cur.scheduleStart;
        return;
      }
      s.scheduleStart = scheduleStartInput.value || "23:00";
      save();
      updateStatUI();
    });
    scheduleEndInput.addEventListener(evt, () => {
      const cur = getSettings();
      if (cur.enabled && cur.mode === "block" && isOverLimit()) {
        scheduleEndInput.value = cur.scheduleEnd;
        return;
      }
      s.scheduleEnd = scheduleEndInput.value || "07:00";
      save();
      updateStatUI();
    });
  });
}

// ---- 초기화 ----
jQuery(async () => {
  const s = getSettings();
  checkAndRollPeriod();

  try {
    const html = await $.get(`scripts/extensions/third-party/${EXT_ID}/settings.html`);
    $("#extensions_settings2").append(html);
    bindSettingsUI();
    updateStatUI();
  } catch (err) {
    console.error("[그만해] 설정 패널 로드 실패:", err);
  }
  updateSendButtonState();

  // 활동 감지 (활성 시간 트래킹용)
  // scroll은 뺌: AI 응답 스트리밍될 때 자동 스크롤이 사람 활동으로 오인되는 버그 방지
  ["mousedown", "keydown", "touchstart"].forEach(evt => {
    document.addEventListener(evt, markActivity, { passive: true });
  });

  // document.hidden 하나만 믿지 않고 여러 신호를 결합해서 백그라운드 감지 견고하게
  document.addEventListener("visibilitychange", () => { isPageVisible = !document.hidden; });
  window.addEventListener("blur", () => { isPageVisible = false; });
  window.addEventListener("focus", () => { isPageVisible = !document.hidden; });
  window.addEventListener("pagehide", () => { isPageVisible = false; });
  window.addEventListener("pageshow", () => { isPageVisible = !document.hidden; });

  // 메시지 전송 카운트
  eventSource.on(event_types.MESSAGE_SENT, () => {
    checkAndRollPeriod();
    const s2 = getSettings();
    s2.data.messageCount += 1;
    save();
    updateStatUI();
  });

  // 전송 버튼 인터셉트 (document에 위임 - 버튼이 나중에 생기거나 다시 그려져도 안 끊김)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#send_but");
    if (!btn) return;
    interceptSend(e);
  }, true);

  // Enter키 전송도 동일하게 가로챔 (Shift+Enter는 줄바꿈이라 제외)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const ta = e.target.closest("#send_textarea");
    if (!ta) return;
    interceptSend(e);
  }, true);

  tickTimer = setInterval(tick, ACTIVE_TICK_MS);

  console.log(`[그만해] 초기화 완료 (v${EXT_VERSION})`);
});
