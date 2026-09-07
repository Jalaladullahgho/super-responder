const SUPABASE_FUNCTION_URL = "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/super-responder";
const SUPABASE_URL = "https://quylfcqnzubxedlatzpv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";
const AUTH_STORAGE_KEY = "super_responder_anonymous_session_v1";
const NETWORK_STORAGE_KEY = "super_responder_network_number_v1";

const params = new URLSearchParams(window.location.search);
const macAddress = (params.get("mac_address") || "").trim();
const networkNumber = (params.get("network_number") || "0001").trim();

let currentConversationId = null;
let session = null;
let authReady = false;
let pollTimer = null;
let sending = false;
let lastRenderedIds = new Set();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString("ar-YE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(normalized))));
  } catch {
    return null;
  }
}

function sessionStillValid(value) {
  const exp = Number(decodeJwtPayload(value?.access_token)?.exp || 0);
  return Boolean(value?.access_token && value?.refresh_token && exp > Math.floor(Date.now() / 1000) + 30);
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return sessionStillValid(value) ? value : value?.refresh_token ? value : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  session = value;
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value));
    localStorage.setItem(NETWORK_STORAGE_KEY, networkNumber);
  } catch {}
}

async function refreshSession(refreshToken) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.msg || data?.error || `Auth refresh HTTP ${response.status}`);
  }
  saveSession(data);
  return data;
}

async function createAnonymousSession() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.msg || data?.error || `Anonymous Auth HTTP ${response.status}`);
  }
  saveSession(data);
  return data;
}

async function ensureAnonymousSession() {
  try {
    const storedNetwork = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (storedNetwork && storedNetwork !== networkNumber) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(NETWORK_STORAGE_KEY);
    }
  } catch {}

  const stored = loadStoredSession();
  if (stored?.access_token) {
    if (sessionStillValid(stored)) {
      session = stored;
      try { localStorage.setItem(NETWORK_STORAGE_KEY, networkNumber); } catch {}
      authReady = true;
      return session;
    }
    if (stored.refresh_token) {
      try {
        await refreshSession(stored.refresh_token);
        authReady = true;
        return session;
      } catch {
        try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
      }
    }
  }

  session = await createAnonymousSession();
  authReady = true;
  return session;
}

async function authHeaders(extra = {}) {
  if (!authReady || !session?.access_token) throw new Error("جلسة المصادقة غير موجودة");
  if (!sessionStillValid(session) && session?.refresh_token) {
    await refreshSession(session.refresh_token);
  }
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function requestFunction(url, options = {}, retry = true) {
  const headers = await authHeaders(options.headers || {});
  const response = await fetch(url, { ...options, headers, cache: "no-store" });
  if (response.status === 401 && retry && session?.refresh_token) {
    await refreshSession(session.refresh_token);
    return requestFunction(url, options, false);
  }
  return response;
}

function trimMessages(messagesEl) {
  while (messagesEl.children.length > 20) {
    messagesEl.firstElementChild?.remove();
  }
}

function appendMessage(messagesEl, item, optimistic = false) {
  if (!optimistic && item?.id != null && lastRenderedIds.has(String(item.id))) return;

  const wrapper = document.createElement("div");
  wrapper.className = `message ${item?.sender === "client" ? "user" : "support"}`;
  if (item?.id != null) {
    wrapper.dataset.messageId = String(item.id);
    lastRenderedIds.add(String(item.id));
  }
  if (optimistic) wrapper.dataset.optimistic = "true";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = escapeHtml(item?.message).replace(/\n/g, "<br>");

  if (item?.created_at) {
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = formatTime(item.created_at);
    bubble.appendChild(time);
  }

  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  trimMessages(messagesEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeOptimistic(messagesEl, text) {
  [...messagesEl.querySelectorAll('[data-optimistic="true"]')].forEach(el => {
    const bubbleText = el.querySelector(".bubble")?.textContent || "";
    if (bubbleText.startsWith(text)) el.remove();
  });
}

function renderInitialMessages(messagesEl, data) {
  messagesEl.innerHTML = "";
  lastRenderedIds = new Set();
  data.slice(-20).forEach(item => appendMessage(messagesEl, item));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function mergeMessages(messagesEl, data) {
  [...messagesEl.querySelectorAll('[data-optimistic="true"]')].forEach(el => {
    const bubbleText = el.querySelector(".bubble")?.textContent || "";
    const exists = data.some(item => item?.sender === "client" && bubbleText.startsWith(String(item.message || "")));
    if (exists) el.remove();
  });

  data.slice(-20).forEach(item => appendMessage(messagesEl, item));

  if (data.length) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function bootstrapConversation() {
  if (!macAddress || !authReady) return null;

  const query = new URLSearchParams({
    action: "bootstrap",
    mac_address: macAddress,
    network_number: networkNumber
  });
  if (currentConversationId) query.set("conversation_id", String(currentConversationId));

  const response = await requestFunction(`${SUPABASE_FUNCTION_URL}?${query.toString()}`);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error || data?.message || data?.raw || `HTTP ${response.status}`);
  if (data?.conversation?.id) currentConversationId = data.conversation.id;
  return data;
}

async function sendMessage(message) {
  const response = await requestFunction(SUPABASE_FUNCTION_URL, {
    method: "POST",
    body: JSON.stringify({
      action: "client_message",
      mac_address: macAddress,
      network_number: networkNumber,
      message,
      conversation_id: currentConversationId
    })
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error || data?.message || data?.raw || `HTTP ${response.status}`);
  return data;
}

async function syncMessages(messagesEl, statusText, initial = false) {
  try {
    const data = await bootstrapConversation();
    const list = Array.isArray(data?.messages) ? data.messages : [];
    if (initial) renderInitialMessages(messagesEl, list);
    else mergeMessages(messagesEl, list);
    statusText.textContent = "متصل";
    return true;
  } catch (error) {
    console.error(error);
    statusText.textContent = `تعذر الاتصال: ${error?.message || "خطأ غير معروف"}`;
    return false;
  }
}

function startPolling(messagesEl, statusText) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (sending || !authReady || !currentConversationId) return;
    syncMessages(messagesEl, statusText, false);
  }, 2500);
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("message-input");
  const messages = document.getElementById("messages");
  const sendButton = document.getElementById("send-button");
  const statusText = document.getElementById("status");

  if (!form || !input || !messages || !sendButton || !statusText) return;

  if (!macAddress) {
    statusText.textContent = "عنوان MAC غير موجود";
    input.disabled = true;
    sendButton.disabled = true;
    return;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    event.stopPropagation();

    const message = input.value.trim();
    if (!message) return;
    if (!authReady) {
      statusText.textContent = "جاري تجهيز الاتصال...";
      return;
    }
    if (sending) return;

    sending = true;
    appendMessage(messages, { sender: "client", message }, true);
    input.value = "";
    sendButton.disabled = true;
    statusText.textContent = "جاري الإرسال...";

    try {
      const data = await sendMessage(message);
      if (data?.conversation_id) currentConversationId = data.conversation_id;
      removeOptimistic(messages, message);
      if (data?.user_message) appendMessage(messages, data.user_message);
      if (data?.response) appendMessage(messages, data.response);
      statusText.textContent = "متصل";
    } catch (error) {
      console.error(error);
      removeOptimistic(messages, message);
      appendMessage(messages, { sender: "admin", message: `تعذر إرسال الرسالة: ${error?.message || "خطأ غير معروف"}` });
      statusText.textContent = "تعذر الاتصال";
    } finally {
      sending = false;
      sendButton.disabled = false;
      input.disabled = false;
      input.focus();
    }
  });

  (async () => {
    try {
      await ensureAnonymousSession();
      await syncMessages(messages, statusText, true);
      startPolling(messages, statusText);
    } catch (error) {
      console.error(error);
      statusText.textContent = `تعذر الاتصال: ${error?.message || "خطأ غير معروف"}`;
      input.disabled = false;
      sendButton.disabled = false;
    }
  })();
});