const SUPABASE_FUNCTION_URL = "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/client-support";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";

const params = new URLSearchParams(window.location.search);
const macAddress = (params.get("mac_address") || "").trim();
const networkNumber = (params.get("network_number") || "0001").trim();

let currentConversationId = null;
let pollTimer = null;
let sending = false;
let lastRenderedIds = new Set();
let bootstrapInFlight = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
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

async function requestFunction(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
  if (!headers.has("Content-Type") && options.body) headers.set("Content-Type", "application/json");

  return fetch(url, {
    ...options,
    headers,
    cache: "no-store"
  });
}

function trimMessages(messagesEl) {
  while (messagesEl.children.length > 20) messagesEl.firstElementChild?.remove();
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
  if (!macAddress || bootstrapInFlight) return null;
  bootstrapInFlight = true;

  try {
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
  } finally {
    bootstrapInFlight = false;
  }
}

async function syncMessages(messagesEl, statusText, initial = false) {
  try {
    const data = await bootstrapConversation();
    if (!data) return false;

    const list = Array.isArray(data?.messages) ? data.messages : [];
    const hasConversation = Boolean(data?.conversation?.id);

    if (initial) {
      if (hasConversation || list.length) renderInitialMessages(messagesEl, list);
    } else if (hasConversation || list.length) {
      mergeMessages(messagesEl, list);
    }

    statusText.textContent = "متصل";
    return true;
  } catch (error) {
    console.error(error);
    statusText.textContent = `تعذر الاتصال: ${error?.message || "خطأ غير معروف"}`;
    return false;
  }
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

function startPolling(messagesEl, statusText) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!sending) syncMessages(messagesEl, statusText, false);
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
    if (!message || sending) return;

    sending = true;
    appendMessage(messages, { sender: "client", message }, true);
    input.value = "";
    sendButton.disabled = true;
    input.disabled = true;
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
    await syncMessages(messages, statusText, true);
    startPolling(messages, statusText);
  })();
});