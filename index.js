// ===== 그만해 (Geumanhae) - ST 사용량 관리 확장 =====
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const EXT_ID = "geumanhae";
const EXT_VERSION = "1.0.9"; // 콘솔에 이 버전이 안 뜨면 캐시된 옛날 index.js가 실행 중인 것
const ACTIVE_TICK_MS = 30 * 1000; // 30초마다 활성 시간 누적 체크
const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3분 이상 입력/조작 없으면 비활성으로 간주

const defaultSettings = {
  enabled: true,
  timeLimitMin: 150,       // 0 = 무제한
  msgLimit: 80,            // 0 = 무제한
  resetTime: "00:00",      // HH:MM, 하루 기준 리셋 시각
  mode: "bypass",          // "bypass" | "block"
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
  const hidden = document.hidden;
  if (!idle && !hidden) {
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
  if (!toast.matches(":popover-open")) {
    try { toast.showPopover(); } catch (err) { console.error("[그만해] 넛지 토스트 표시 실패:", err); }
  }
  requestAnimationFrame(() => toast.classList.add("gmh-show"));
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove("gmh-show");
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

  const timeRatio = s.timeLimitMin > 0 ? usedMin / s.timeLimitMin : 0;
  const msgRatio = s.msgLimit > 0 ? usedMsg / s.msgLimit : 0;
  const ratio = Math.max(timeRatio, msgRatio);

  const fill = panel.querySelector("#gmh-progress-fill");
  if (fill) {
    fill.style.width = `${Math.min(ratio, 1) * 100}%`;
    fill.classList.toggle("gmh-warn", ratio >= 0.7 && ratio < 1);
    fill.classList.toggle("gmh-danger", ratio >= 1);
  }
  const timeBox = panel.querySelector("#gmh-stat-time-box");
  const msgBox = panel.querySelector("#gmh-stat-msg-box");
  if (timeBox) timeBox.classList.toggle("gmh-danger", s.timeLimitMin > 0 && usedMin >= s.timeLimitMin);
  if (msgBox) msgBox.classList.toggle("gmh-danger", s.msgLimit > 0 && usedMsg >= s.msgLimit);

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
}

// ---- 리밋 판정 ----
function isOverLimit() {
  const s = getSettings();
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
  const dlg = openDialog(`
    <div class="gmh-modal-title">오늘 목표 넘었어</div>
    <div class="gmh-modal-body">설정한 사용 시간/메시지 한도를 초과했어.<br>그래도 계속 쓸래?</div>
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
  const [h, m] = s.resetTime.split(":").map(Number);
  const now = new Date();
  const nextReset = new Date(now);
  nextReset.setHours(h, m, 0, 0);
  if (nextReset <= now) nextReset.setDate(nextReset.getDate() + 1);

  const dlg = openDialog(`
    <div class="gmh-modal-title">오늘은 여기까지</div>
    <div class="gmh-countdown" id="gmh-countdown">--:--:--</div>
    <div class="gmh-modal-body">완전 차단 모드라 리셋 시각까지는 전송이 안 돼.</div>
    <div class="gmh-modal-btns">
      <button id="gmh-modal-close" class="gmh-btn-primary">알겠어</button>
    </div>`);
  dlg.querySelector("#gmh-modal-close").onclick = closeModal;

  const countdownEl = dlg.querySelector("#gmh-countdown");
  const timer = setInterval(() => {
    const diff = nextReset - Date.now();
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

  enabledToggle.classList.toggle("gmh-on", s.enabled);
  nudgeToggle.classList.toggle("gmh-on", s.nudgeEnabled);
  timeLimitInput.value = s.timeLimitMin;
  msgLimitInput.value = s.msgLimit;
  resetTimeInput.value = s.resetTime;
  nudgeIntervalInput.value = s.nudgeIntervalMin;
  modeGroup.querySelectorAll(".gmh-radio-option").forEach(opt => {
    opt.classList.toggle("gmh-selected", opt.dataset.mode === s.mode);
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
  timeLimitInput.addEventListener("change", () => {
    s.timeLimitMin = Math.max(0, parseInt(timeLimitInput.value) || 0);
    save();
    updateStatUI();
  });
  msgLimitInput.addEventListener("change", () => {
    s.msgLimit = Math.max(0, parseInt(msgLimitInput.value) || 0);
    save();
    updateStatUI();
  });
  resetTimeInput.addEventListener("change", () => {
    s.resetTime = resetTimeInput.value || "00:00";
    save();
    checkAndRollPeriod();
    updateSendButtonState();
  });
  nudgeIntervalInput.addEventListener("change", () => {
    s.nudgeIntervalMin = Math.max(1, parseInt(nudgeIntervalInput.value) || 30);
    save();
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
  ["mousedown", "keydown", "touchstart", "scroll"].forEach(evt => {
    document.addEventListener(evt, markActivity, { passive: true });
  });

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
