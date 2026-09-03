const SUPABASE_FUNCTION_URL =
  "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/super-responder";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";

const params = new URLSearchParams(window.location.search);
const macAddress = params.get("mac_address")?.trim() || "";

const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const sendButton = document.getElementById("send-button");
const statusText = document.getElementById("status");

function addMessage(text, type) {
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

function extractReply(value, depth = 0) {
  if (value == null || depth > 6) return "";

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractReply(item, depth + 1);
      if (text) return text;
    }
    return "";
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "reply",
      "response",
      "message",
      "text",
      "content",
      "output_text",
      "answer"
    ];

    for (const key of preferredKeys) {
      if (key in value) {
        const text = extractReply(value[key], depth + 1);
        if (text) return text;
      }
    }

    if (Array.isArray(value.output)) {
      const text = extractReply(value.output, depth + 1);
      if (text) return text;
    }

    if (Array.isArray(value.choices)) {
      const text = extractReply(value.choices, depth + 1);
      if (text) return text;
    }
  }

  return "";
}

async function sendMessage(message) {
  const response = await fetch(SUPABASE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "apikey": SUPABASE_PUBLISHABLE_KEY
    },
    body: JSON.stringify({
      mac_address: macAddress,
      message
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
      data?.error ||
      data?.message ||
      data?.raw ||
      `HTTP ${response.status}`
    );
  }

  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = input.value.trim();
  if (!message) return;

  addMessage(message, "user");
  input.value = "";
  setLoading(true);
  statusText.textContent = "جارٍ الرد...";

  try {
    const data = await sendMessage(message);

    const reply = extractReply(data);

    addMessage(reply || "تم استلام رسالتك.", "support");
    statusText.textContent = "متصل";
  } catch (error) {
    console.error(error);
    addMessage(
      `خطأ الاتصال: ${error.message}`,
      "support"
    );
    statusText.textContent = "تعذر الاتصال";
  } finally {
    setLoading(false);
    input.focus();
  }
});
