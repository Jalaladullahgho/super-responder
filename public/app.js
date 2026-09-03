const SUPABASE_FUNCTION_URL =
  "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/super-responder";

const SUPABASE_URL = "https://quylfcqnzubxedlatzpv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";

const params = new URLSearchParams(window.location.search);
const macAddress = params.get("mac_address")?.trim() || "";

const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const sendButton = document.getElementById("send-button");
const statusText = document.getElementById("status");

let currentConversationId = null;
let loadingHistory = false;
let lastRenderedSignature = "";

function authHeaders(extra = {}) {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
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
    return new Date(value).toLocaleTimeString("ar-YE", {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function renderMessages(data) {
  const signature = JSON.stringify(data.map((m) => [
    m.id,
    m.sender,
    m.message,
    m.created_at
  ]));

  if (signature === lastRenderedSignature) return;
  lastRenderedSignature = signature;

  messages.innerHTML = "";

  for (const item of data) {
    const type = item.sender === "client" ? "user" : "support";
    const wrapper = document.createElement("div");
    wrapper.className = `message ${type}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = escapeHtml(item.message).replace(/\n/g, "<br>");

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = formatTime(item.created_at);
    bubble.appendChild(time);

    wrapper.appendChild(bubble);
    messages.appendChild(wrapper);
  }

  messages.scrollTop = messages.scrollHeight;
}

function addLocalMessage(text, type) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${type}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function setLoading(loading) {
  sendButton.disabled = loading;
  input.disabled = loading;
  sendButton.textContent = loading ? "..." : "إرسال";
}

async function supabaseGet(path) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    headers: authHeaders()
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      typeof data === "string"
        ? data
        : data?.message || data?.error || `HTTP ${response.status}`
    );
  }

  return data;
}

async function findConversation() {
  if (!macAddress) return null;

  const clients = await supabaseGet(
    `/rest/v1/clients?select=id,mac_address&mac_address=eq.${encodeURIComponent(macAddress)}&limit=1`
  );

  if (!clients.length) return null;

  const clientId = clients[0].id;

  const conversations = await supabaseGet(
    `/rest/v1/conversations?select=id,client_id,status,created_at,updated_at&client_id=eq.${clientId}&order=updated_at.desc&limit=1`
  );

  if (!conversations.length) return null;

  currentConversationId = conversations[0].id;
  return conversations[0];
}

async function loadHistory() {
  if (!macAddress || loadingHistory) return;
  loadingHistory = true;

  try {
    const conversation = await findConversation();

    if (!conversation) {
      statusText.textContent = "متصل";
      return;
    }

    const data = await supabaseGet(
      `/rest/v1/messages?select=id,conversation_id,sender,message,created_at&conversation_id=eq.${conversation.id}&order=created_at.asc`
    );

    renderMessages(data);
    statusText.textContent = "متصل";
  } catch (error) {
    console.error(error);
    statusText.textContent = "تعذر تحميل المحادثة";
  } finally {
    loadingHistory = false;
  }
}

async function sendMessage(message) {
  const response = await fetch(SUPABASE_FUNCTION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      mac_address: macAddress,
      message,
      conversation_id: currentConversationId
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.error || data?.message || data?.raw || `HTTP ${response.status}`
    );
  }

  if (data?.conversation_id) {
    currentConversationId = data.conversation_id;
  }

  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = input.value.trim();
  if (!message || !macAddress) return;

  addLocalMessage(message, "user");
  input.value = "";
  setLoading(true);
  statusText.textContent = "جاري الإرسال...";

  try {
    await sendMessage(message);
    await loadHistory();
    statusText.textContent = "متصل";
  } catch (error) {
    console.error(error);
    addLocalMessage(`تعذر إرسال الرسالة: ${error.message}`, "support");
    statusText.textContent = "تعذر الاتصال";
  } finally {
    setLoading(false);
    input.focus();
  }
});

(async () => {
  if (!macAddress) {
    statusText.textContent = "عنوان MAC غير موجود";
    input.disabled = true;
    sendButton.disabled = true;
    return;
  }

  await loadHistory();
  setInterval(loadHistory, 4000);
})();
